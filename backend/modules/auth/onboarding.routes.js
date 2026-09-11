/**
 * onboarding.routes.js — how somebody who is not in the database yet gets in.
 *
 * Six sessions built a multi-company application for people who already had
 * an account. This is the door.
 *
 *     sign up  →  verify the address  →  create the first business  →  invite staff
 *
 * ── the rules, and why each one is here ───────────────────────────────────
 *
 * **Sign-up must not say whether an address is already registered.** Every
 * answer on this route is the same sentence whether the address is new, known,
 * or half-way through verifying. Anything else is an oracle for testing which
 * shopkeepers use this product, on a system holding their books. The person
 * who actually holds the address is told, by email, that somebody tried — they
 * are the only one entitled to know.
 *
 * **Verify before the first business exists.** An unverified account that
 * already owns a company is a company nobody can safely delete or reassign,
 * and an address nobody can prove belongs to the person holding the books.
 *
 * **A code, not a link.** On Android the verification email frequently opens
 * on a laptop. A six-digit code crosses devices; a deep link does not.
 *
 * **Resetting a password ends every session.** A reset is what somebody does
 * when they think another person has their password. Leaving that person
 * signed in for the next thirty days makes the reset theatre.
 *
 * **`checkCode` must never run inside `durable()`.** This one is not obvious
 * and it cost a real vulnerability to find. `durable` rolls the transaction
 * back whenever the handler refuses — deliberately, because "a refusal is not
 * a partial save" is right for every business write in this application. But
 * the guess counter on a code is written *by* the refusal. Inside a
 * transaction, every wrong guess was counted and then rolled straight back, so
 * the reply said "4 tries left" forever and a six-digit code could be walked
 * through a million times. The limit is the only thing that makes a six-digit
 * secret safe, and it was the one thing being undone. So codes are checked
 * before the transaction opens, and the rest of the handler runs inside it.
 *
 * **An invitation is the only way a membership is created.** There is no
 * "request access", and accepting one is proof of control of the address it
 * was sent to — which is why an invited person who has no account yet does not
 * also have to verify by code. The token was the code.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const router = express.Router();

const { query } = require("../../database/db");
const { durable } = require("../../shared/durable");
/* Every transaction on this route writes central rows — accounts,
   memberships, invitations — even when the request has a company in context
   (changing a password from inside the app is the obvious one). The company's
   own database is touched afterwards, by name, in `withFirm`. */
const centralDurable = (next, fn) => durable(next, fn, { central: true });
const { SECRET, revokeSessions, verifyToken } = require("../../shared/middleware/auth");
const { loginThrottle, clearLoginAttempts } = require("../../shared/middleware/loginThrottle");
const { issueCode, checkCode } = require("../../shared/authcodes");
const { deviceLabel, rememberDevice, issueBackupCodes, revokeAllDevices } = require("../../shared/devices");
const { sendEmail, emailConfigured, appUrlFor } = require("../../shared/email");
const { provisionFirm } = require("../../shared/provision");
const { ensureLocalUser } = require("../../shared/localuser");
const tenancy = require("../../database/tenancy");
const { sessionFor } = require("./auth.routes");

/* One sentence, used for every outcome of sign-up and of "forgotten password".
   Written as an instruction rather than a status, because the person cannot
   act on the status and can act on the instruction. */
const SAME_ANSWER = "If that address can be used, a six-digit code is on its way. Check your email.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** What a password has to be. Length, and not the obvious ones. */
function passwordProblem(pw, email) {
  const p = String(pw || "");
  if (p.length < 8) return "Use at least 8 characters.";
  if (p.length > 200) return "That password is too long.";
  if (email && p.toLowerCase() === String(email).toLowerCase()) return "Your password cannot be your email address.";
  if (/^(password|12345678|123456789|qwerty123|letmein1)$/i.test(p)) return "That password is too easy to guess.";
  return null;
}

/* ── 1. Sign up ───────────────────────────────────────────────────────────
 *
 * Creates a pending account, or quietly does nothing if the address is taken.
 * Either way the answer is identical and takes a comparable amount of time.
 */
router.post("/signup", loginThrottle, async (req, res, next) => await centralDurable(next, async (conn) => {
  const b = req.body || {};
  const email = String(b.email || "").trim();
  const fullName = String(b.full_name || "").trim().slice(0, 120);

  if (!EMAIL_RE.test(email)) return res.fail("That does not look like an email address", 400);
  const pwBad = passwordProblem(b.password, email);
  if (pwBad) return res.fail(pwBad, 400);
  if (!fullName) return res.fail("What is your name?", 400);

  const existing = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [email])).rows[0];

  if (existing && existing.email_verified_at) {
    /* Taken, and proven. Nothing is created and nothing is changed — in
       particular the password is NOT overwritten, or sign-up would be a
       password reset that needs no code. The holder of the address is told. */
    return async () => await sendAndAnswer(res, { to: email, template: "exists", purpose: "signup-exists",
      data: { name: existing.full_name } });
  }

  if (existing) {
    /* Started but never verified. Re-typing the form is the ordinary way
       somebody recovers from closing the tab, so the password and name are
       replaced and a fresh code goes out. Nothing here can be reached by
       anyone but the address holder, since the account cannot be used until a
       code delivered to that address is typed back. */
    await conn.query("UPDATE accounts SET password_hash = ?, full_name = ? WHERE id = ?",
      [bcrypt.hashSync(String(b.password), 10), fullName, existing.id]);
    return async () => await issueAndSend(res, { purpose: "verify", email, accountId: existing.id, name: fullName });
  }

  await conn.query(
    `INSERT INTO accounts (email, password_hash, full_name, status, trial_ends_at)
     VALUES (?,?,?,'active', datetime('now','+30 days'))`,
    [email, bcrypt.hashSync(String(b.password), 10), fullName]);
  const id = (await conn.query("SELECT id FROM accounts ORDER BY id DESC LIMIT 1")).rows[0].id;
  return async () => await issueAndSend(res, { purpose: "verify", email, accountId: id, name: fullName });
}));

/** Issue a code, send it, answer with the one sentence. */
async function issueAndSend(res, { purpose, email, accountId, name }) {
  const made = await issueCode({ purpose, email, accountId });
  if (made.blocked) return res.fail(made.message, 429);
  const sent = await sendEmail({
    to: email, template: purpose === "reset" ? "reset" : "verify",
    purpose, data: { code: made.code, name },
  });
  /* A provider outage is reported. The alternative — the one sentence, always
     — leaves somebody waiting for a code that was never accepted by anybody,
     which is the failure people describe as "the product is broken". */
  if (!sent.ok && emailConfigured()) {
    return res.fail("We could not send the code just now. Try again in a minute.", 502);
  }
  return res.success({ sent: true, expires_in_minutes: made.minutes }, SAME_ANSWER);
}

async function sendAndAnswer(res, args) {
  await sendEmail(args);
  return res.success({ sent: true }, SAME_ANSWER);
}

/* Resend. Same limits as the first one — `issueCode` caps six per hour per
   address and kills the previous code, so this cannot be used to hold several
   live codes and multiply the guess budget. */
router.post("/resend", loginThrottle, async (req, res) => {
  const email = String((req.body || {}).email || "").trim();
  const purpose = (req.body || {}).purpose === "reset" ? "reset" : "verify";
  if (!EMAIL_RE.test(email)) return res.fail("That does not look like an email address", 400);
  const acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [email])).rows[0];
  if (!acct) return res.success({ sent: true }, SAME_ANSWER);
  if (purpose === "verify" && acct.email_verified_at) return res.success({ sent: true }, SAME_ANSWER);
  return await issueAndSend(res, { purpose, email, accountId: acct.id, name: acct.full_name });
});

/* ── 2. Verify the address ────────────────────────────────────────────────
 *
 * On success the account is proven but owns nothing, so there is no company to
 * sign into and no session to hand out. It gets a short-lived onboarding
 * ticket instead, which can do exactly one thing: create the first business.
 */
/**
 * What a newly-confirmed account gets, once and only once.
 *
 * Two things happen the moment somebody proves they can read the address:
 *
 *   · **This device is trusted.** They have just done, by hand, exactly what
 *     the sign-in code asks for — making them do it again on the next screen
 *     would be theatre.
 *   · **Ten backup codes are issued and shown.** This is the only moment the
 *     person is definitely paying attention to their own security, and a
 *     backup code offered later is a backup code nobody ever fetches. Without
 *     them, a mail outage or a changed address is a shop that cannot open its
 *     own books.
 *
 * Deliberately called AFTER the transaction has committed, not inside it —
 * the same rule the code check at the top of each route follows, and for the
 * same reason: these are writes about a person and a device, not about the
 * account row, and they must not be rolled back by something unrelated.
 */
async function setUpSecondFactor(req, acct) {
  return {
    device_token: await rememberDevice(acct.id, deviceLabel(req)),
    backup_codes: await issueBackupCodes(acct.id),
  };
}

router.post("/verify", loginThrottle, async (req, res, next) => {
  /* The code check happens OUTSIDE the transaction, deliberately, and this is
     not a stylistic choice — see the note above `checkCode` calls in this
     file. */
  const email0 = String((req.body || {}).email || "").trim();
  const r0 = await checkCode({ purpose: "verify", email: email0, code: (req.body || {}).code });
  if (!r0.ok) return res.fail(r0.message, 400);
  return await centralDurable(next, async (conn) => {
  const email = email0;
  const acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [email])).rows[0];
  if (!acct) return res.fail("That code is wrong or has expired. Ask for a new one.", 400);

  if (!acct.email_verified_at) {
    await conn.query("UPDATE accounts SET email_verified_at = datetime('now') WHERE id = ?", [acct.id]);
  }
  await clearLoginAttempts(req);

  /* Already has a business — verifying late, or verifying a second time. Hand
     back a real session rather than an onboarding ticket, or the screen would
     ask them to create a business they already have. */
  const mem = (await query(
    `SELECT m.*, f.status AS firm_status FROM memberships m JOIN firms f ON f.id = m.firm_id
      WHERE m.account_id = ? AND m.status = 'active' AND f.status = 'active' ORDER BY m.id LIMIT 1`,
    [acct.id])).rows[0];
  if (mem) {
    return async () => await tenancy.withFirm(mem.firm_id, async () => {
      const user = await ensureLocalUser({ query }, acct, mem.firm_id, mem.role_id);
      const second = await setUpSecondFactor(req, acct);
      return res.success({ verified: true, ...await sessionFor(user, acct), ...second }, "Address confirmed");
    });
  }

  return async () => res.success({
    verified: true, needs_company: true,
    ticket: jwt.sign({ t: "onboard", acct: acct.id }, SECRET, { expiresIn: "45m" }),
    email: acct.email, full_name: acct.full_name,
    ...await setUpSecondFactor(req, acct),
  }, "Address confirmed. Now tell us about your business.");
  });
});

/* ── 3. The first business ────────────────────────────────────────────────
 *
 * The only route that accepts an onboarding ticket, and the ticket is refused
 * the moment the account has a company — so it cannot be kept and replayed to
 * mint businesses. Afterwards it is a normal session and every later company
 * goes through `POST /companies`, which is where the limits and the audit
 * trail already live.
 */
router.post("/first-company", async (req, res, next) => await centralDurable(next, async (conn) => {
  const b = req.body || {};
  let claims;
  try { claims = jwt.verify(String(b.ticket || ""), SECRET); }
  catch { return res.fail("That took too long. Ask for a new code and try again.", 401); }
  if (claims.t !== "onboard" || !claims.acct) return res.fail("Start again from the sign-up screen", 401);

  const acct = (await query("SELECT * FROM accounts WHERE id = ?", [claims.acct])).rows[0];
  if (!acct) return res.fail("Start again from the sign-up screen", 401);
  if (!acct.email_verified_at) return res.fail("Confirm your email address first", 403);
  if (acct.status !== "active") return res.fail("This account has been suspended", 403);

  const already = (await query("SELECT id FROM memberships WHERE account_id = ? AND status = 'active'", [acct.id])).rows[0];
  if (already) return res.fail("This account already has a business. Sign in.", 409);

  const name = String(b.name || "").trim();
  if (!name) return res.fail("Name the business", 400);

  const { firmId, adminRoleId } = await provisionFirm(conn, {
    ...b, name, state_code: b.state_code || "UG", mark_setup_done: true,
  });
  await conn.query("INSERT INTO memberships (account_id, firm_id, role_id, is_owner, status) VALUES (?,?,?,1,'active')",
    [acct.id, firmId, adminRoleId]);

  /* The staff row, the audit entry and the session are built AFTER the commit,
     inside the new company.
     *
     * They belong to the company's database, and this transaction is on the
     * central one — once each company has its own file those writes cannot
     * join this transaction, and `db.js` refuses them rather than letting them
     * look as though they had. Doing them after the commit is the honest
     * ordering: the company and the membership are safe on disk first, and the
     * worst a crash in between can do is leave an owner who has to sign in
     * again to get their staff row created, which sign-in does anyway. */
  return async () => await tenancy.withFirm(firmId, async () => {
    const user = await ensureLocalUser({ query }, acct, firmId, adminRoleId);
    /* `provisionFirm` stamps `created_by` from what it was handed; this
       account had no users row until a moment ago, so it is set now. */
    await query("UPDATE firms SET created_by = ? WHERE id = ?", [user.id, firmId]);
    await query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [user.id, "companies", "create", firmId, name]);
    return res.success({ ...await sessionFor(user, acct), firm_id: firmId }, `${name} is ready`);
  });
}));

/* ── 4. Forgotten password ────────────────────────────────────────────────
 *
 * Identical answer for a known and an unknown address, for the same reason as
 * sign-up. Unverified accounts are allowed through: somebody who signed up,
 * never verified and forgot the password they chose is a real person, and the
 * code proves the address either way.
 */
router.post("/forgot", loginThrottle, async (req, res) => {
  const email = String((req.body || {}).email || "").trim();
  if (!EMAIL_RE.test(email)) return res.fail("That does not look like an email address", 400);
  const acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [email])).rows[0];
  if (!acct || acct.status !== "active") return res.success({ sent: true }, SAME_ANSWER);
  return await issueAndSend(res, { purpose: "reset", email, accountId: acct.id, name: acct.full_name });
});

router.post("/reset", loginThrottle, async (req, res, next) => {
  const b0 = req.body || {};
  const email0 = String(b0.email || "").trim();
  const bad0 = passwordProblem(b0.password, email0);
  if (bad0) return res.fail(bad0, 400);
  const r0 = await checkCode({ purpose: "reset", email: email0, code: b0.code });   // outside the transaction — see below
  if (!r0.ok) return res.fail(r0.message, 400);
  return await centralDurable(next, async (conn) => {
  const b = b0;
  const email = email0;
  const acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [email])).rows[0];
  if (!acct) return res.fail("That code is wrong or has expired. Ask for a new one.", 400);

  await conn.query("UPDATE accounts SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?",
    [bcrypt.hashSync(String(b.password), 10), acct.id]);
  /* Every session, everywhere. A reset is what somebody does when they think
     another person has their password; leaving that person signed in for the
     next thirty days would make it a gesture. */
  await revokeSessions({ accountId: acct.id });
  await clearLoginAttempts(req);
  /* And every trusted device, for the same reason as the sessions above. A
     reset is what somebody does when they believe another person has their
     password — and that other person's computer may well be one of the ones
     allowed to skip the sign-in code. Leaving it trusted would mean the reset
     locked the thief out of the password and left them a way in around it. */
  return async () => {
    await revokeAllDevices(acct.id);
    return res.success({ ok: true }, "Password changed. Sign in with the new one.");
  };
  });
});

/* Changing a password from inside. The current one is required — a signed-in
   session left open on a counter must not be enough to lock the owner out of
   their own books. */
router.post("/change-password", verifyToken, async (req, res, next) => await centralDurable(next, async (conn) => {
  const b = req.body || {};
  if (!req.user.acct) return res.fail("Counter staff passwords are changed under Users & roles", 400);
  const acct = (await query("SELECT * FROM accounts WHERE id = ?", [req.user.acct])).rows[0];
  if (!acct) return res.fail("Account not found", 404);
  if (!bcrypt.compareSync(String(b.current || ""), acct.password_hash)) {
    return res.fail("That is not your current password", 401);
  }
  const bad = passwordProblem(b.password, acct.email);
  if (bad) return res.fail(bad, 400);
  await conn.query("UPDATE accounts SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(String(b.password), 10), acct.id]);

  /* Every other session ends; this one continues. Somebody changing their
     password because a laptop was stolen wants the laptop signed out, and
     being signed out of the screen they are typing on teaches them nothing. */
  await query("UPDATE sessions SET revoked_at = datetime('now') WHERE account_id = ? AND revoked_at IS NULL AND jti <> ?",
    [acct.id, req.user.jti || ""]);
  /* The trusted devices go too, for the same reason the other sessions do —
     but this one is left trusted, because the person is sitting at it and has
     just proved they know the old password. */
  return async () => {
    await revokeAllDevices(acct.id);
    return res.success({ ok: true, device_token: await rememberDevice(acct.id, deviceLabel(req)) },
      "Password changed. Other devices have been signed out and will be asked for a code.");
  };
}));

/* ── 5. Invitations ───────────────────────────────────────────────────────
 *
 * Both routes are public by necessity: the person opening the link may have no
 * account at all. The token is the whole secret, so it is 32 random bytes,
 * stored as a SHA-256 digest, single-use, and expires.
 *
 * The digest is not for slowing down guessing — 256 bits is not guessable —
 * it is so that a copy of the database is not a folder of working invitations.
 */
const digest = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

async function liveInvitation(token) {
  const row = (await query("SELECT * FROM invitations WHERE token = ?", [digest(token)])).rows[0];
  if (!row) return { error: "That invitation link is not valid." };
  if (row.accepted_at) return { error: "That invitation has already been used." };
  if (row.revoked_at) return { error: "That invitation was withdrawn." };
  const dead = (await query("SELECT (expires_at < datetime('now')) AS e FROM invitations WHERE id = ?", [row.id])).rows[0];
  if (dead && dead.e) return { error: "That invitation has expired. Ask for a new one." };
  return { row };
}

/** What the accept screen shows before anybody types anything. */
router.get("/invitation/:token", async (req, res) => {
  const { row, error } = await liveInvitation(req.params.token);
  if (error) return res.fail(error, 400);
  const firm = (await query("SELECT name FROM firms WHERE id = ?", [row.firm_id])).rows[0] || {};
  const role = row.role_id ? (await query("SELECT name FROM roles WHERE id = ?", [row.role_id])).rows[0] : null;
  const acct = (await query("SELECT id, email_verified_at FROM accounts WHERE lower(email) = lower(?)", [row.email])).rows[0];
  res.success({
    company: firm.name || "a business",
    email: row.email,
    role: role ? role.name : null,
    is_owner: !!row.is_owner,
    /* Which form to show: sign in, or choose a password. Not a secret — the
       person already holds a token sent to that address. */
    have_account: !!(acct && acct.email_verified_at),
  });
});

router.post("/invitation/accept", loginThrottle, async (req, res, next) => await centralDurable(next, async (conn) => {
  const b = req.body || {};
  const { row, error } = await liveInvitation(b.token);
  if (error) return res.fail(error, 400);

  const firm = (await query("SELECT * FROM firms WHERE id = ?", [row.firm_id])).rows[0];
  if (!firm || firm.status !== "active") return res.fail("That business is not open at the moment.", 403);

  let acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [row.email])).rows[0];

  if (acct && acct.email_verified_at) {
    /* An existing account has to prove it is still theirs. Otherwise anybody
       who intercepted the link could attach an established account — with
       whatever else it holds — to a company of their choosing. */
    if (!bcrypt.compareSync(String(b.password || ""), acct.password_hash)) {
      return res.fail("Wrong password for that account", 401);
    }
    if (acct.status !== "active") return res.fail("This account has been suspended", 403);
  } else if (acct) {
    /* Signed up, never verified, and now holds a token sent to the address.
       That token is stronger proof than the code would have been, so the
       address is marked verified and the password they choose here stands. */
    const bad = passwordProblem(b.password, row.email);
    if (bad) return res.fail(bad, 400);
    await conn.query("UPDATE accounts SET password_hash = ?, full_name = COALESCE(NULLIF(?,''), full_name), email_verified_at = datetime('now') WHERE id = ?",
      [bcrypt.hashSync(String(b.password), 10), String(b.full_name || "").trim(), acct.id]);
    acct = (await query("SELECT * FROM accounts WHERE id = ?", [acct.id])).rows[0];
  } else {
    const bad = passwordProblem(b.password, row.email);
    if (bad) return res.fail(bad, 400);
    await conn.query(
      `INSERT INTO accounts (email, password_hash, full_name, status, email_verified_at)
       VALUES (?,?,?,'active', datetime('now'))`,
      [row.email, bcrypt.hashSync(String(b.password), 10),
       String(b.full_name || row.full_name || "").trim() || row.email]);
    acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [row.email])).rows[0];
  }

  const roleId = row.role_id || null;
  const have = (await query("SELECT id FROM memberships WHERE account_id = ? AND firm_id = ?", [acct.id, row.firm_id])).rows[0];
  if (have) {
    await conn.query("UPDATE memberships SET role_id = ?, is_owner = ?, status = 'active' WHERE id = ?",
      [roleId, row.is_owner ? 1 : 0, have.id]);
  } else {
    await conn.query("INSERT INTO memberships (account_id, firm_id, role_id, is_owner, status) VALUES (?,?,?,?,'active')",
      [acct.id, row.firm_id, roleId, row.is_owner ? 1 : 0]);
  }
  await conn.query("UPDATE invitations SET accepted_at = datetime('now') WHERE id = ?", [row.id]);

  await clearLoginAttempts(req);
  /* Same ordering as the first company, for the same reason: the account and
     the membership are central and commit here; the staff row and the audit
     entry belong to the company's own database and are written after. */
  return async () => await tenancy.withFirm(row.firm_id, async () => {
    const user = await ensureLocalUser({ query }, acct, row.firm_id, roleId);
    await query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [row.invited_by || user.id, "companies", "invite-accepted", row.firm_id, acct.email]);
    return res.success({ ...await sessionFor(user, acct), firm_id: row.firm_id },
      `Welcome to ${firm.name}`);
  });
}));

/* Used by the Companies screen when it sends one. Kept here so the token, its
   digest and its lifetime are described in exactly one place. */
function newInvitationToken(req) {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: digest(token), url: `${appUrlFor(req)}/#/invitation/${token}` };
}

module.exports = router;
module.exports.newInvitationToken = newInvitationToken;
module.exports.digest = digest;
module.exports.passwordProblem = passwordProblem;
module.exports.EMAIL_RE = EMAIL_RE;
