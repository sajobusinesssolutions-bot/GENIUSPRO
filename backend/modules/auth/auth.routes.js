const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const { query } = require("../../database/db");
const tenancy = require("../../database/tenancy");
const { ensureLocalUser } = require("../../shared/localuser");
const { signAccess, signRefresh, verifyToken, openSession, revokeSessions, SECRET } = require("../../shared/middleware/auth");
const { loginThrottle, clearLoginAttempts } = require("../../shared/middleware/loginThrottle");
const { issueCode, checkCode } = require("../../shared/authcodes");
const { sendEmail, emailConfigured } = require("../../shared/email");
const { signChallenge, readChallenge } = require("../../shared/challenge");
const {
  deviceLabel, rememberDevice, deviceTrusted, listDevices, revokeDevice,
  revokeAllDevices, issueBackupCodes, useBackupCode, backupCodesLeft, TRUST_DAYS,
} = require("../../shared/devices");


/* The build number, so the sign-in screen can show it. `/system/version` needs
   a token, and opening a second public route for one string is worse than
   adding it to the one that is already public. */
function buildVersion() {
  try { return require("../../shared/version").manifest().version; } catch { return null; }
}

/* ── which shop ───────────────────────────────────────────────────────────
 *
 * Counter staff sign in with a username and a PIN and have no email address,
 * and since session 4.5 they live inside their company's own database. So
 * "find the user called james" cannot be answered until the shop is known —
 * and on a hosted installation it must not be answerable across shops anyway,
 * since two of them may each employ a James.
 *
 * Four ways to say which shop, in the order they are believed:
 *
 *   1. what the sign-in screen sent  (`shop` in the body or the query)
 *   2. the `X-Shop-Code` header       (an Android build can set it once)
 *   3. the subdomain                  (`kampala-hardware.example.com`)
 *   4. the only company there is      (every desktop installation shipped)
 *
 * Four is what keeps a single-shop machine exactly as it was: nobody is asked
 * for a code that could only ever have one answer.
 */
/* A hosted installation serves several shops that do not know about each
   other; a desktop installation serves one owner who may run several. The
   difference decides whether the sign-in screen may list the businesses on it,
   so it is stated deliberately rather than guessed from the firm count. */
function hosted() { return process.env.GENIUS_HOSTED === "1"; }

async function resolveShop(req) {
  const b = req.body || {};
  const given = String(b.shop || (req.query && req.query.shop) || req.get("X-Shop-Code") || "").trim();
  if (given) {
    const f = (await query("SELECT id, name, shop_code FROM firms WHERE lower(shop_code) = lower(?) AND status = 'active'",
      [given])).rows[0];
    if (f) return { firm: f };
    /* A local installation may name a business by its id, because the sign-in
       screen offers the businesses on this computer as buttons rather than
       asking a cashier for a code nobody ever gave them. Refused on a hosted
       installation, where the id of a business you may not enter is a guess
       away and the code is the thing that proves you were told about it. */
    if (!hosted() && /^\d+$/.test(given)) {
      const byId = (await query("SELECT id, name, shop_code FROM firms WHERE id = ? AND status = 'active'",
        [Number(given)])).rows[0];
      if (byId) return { firm: byId };
    }
    return { unknown: true, given };
  }

  const host = String(req.hostname || "").toLowerCase();
  const label = host.split(".")[0];
  if (label && host.includes(".") && !["www", "app", "localhost"].includes(label) && !/^\d+$/.test(label)) {
    const f = (await query("SELECT id, name, shop_code FROM firms WHERE lower(shop_code) = lower(?) AND status = 'active'",
      [label])).rows[0];
    if (f) return { firm: f };
  }

  const all = (await query("SELECT id, name, shop_code FROM firms WHERE status = 'active' ORDER BY id LIMIT 2")).rows;
  if (all.length === 1) return { firm: all[0] };
  if (!all.length) return { none: true };
  return { needsShop: true };
}

/* One refusal for "no such shop", "no such user" and "wrong password".
 *
 * A different message for an unknown shop code would turn this route into a
 * way to enumerate which businesses are on the installation, one guess at a
 * time. The sign-in *screen* is allowed to be more helpful than this — it asks
 * `signin-options`, which is throttled and returns nothing but a display name
 * — but the route that accepts a password says only the one thing. */
const WRONG = "Wrong username or password";

router.post("/login", loginThrottle, async (req, res) => {
  const { username, password } = req.body || {};
  const shop = await resolveShop(req);
  if (shop.needsShop) return res.fail("Which shop? Enter the shop code as well.", 400, { needs_shop: true });
  if (shop.none) return res.fail("This installation has no business set up yet", 403);
  if (shop.unknown) return res.fail(WRONG, 401);

  return await tenancy.withFirm(shop.firm.id, async () => {
    const user = (await query("SELECT * FROM users WHERE username = ? AND status = 'active'", [username])).rows[0];
    if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
      return res.fail(WRONG, 401);
    }
    /* A staff row that has drifted — restored from a backup, or created before
       the company it belongs to was settled — is pointed at the shop it was
       actually found in rather than trusted to know. */
    if (user.active_firm_id !== shop.firm.id) user.active_firm_id = shop.firm.id;
    await clearLoginAttempts(req);   // correct password — don't hold this user's mistakes against them
    return res.success(await sessionFor(user, await accountFor(user)), "Welcome back");
  });
});

/* The account a staff row belongs to, if it belongs to one.
 *
 * An owner who signs in with a username is the same person as the owner who
 * signs in with an email address, and must get the same session — otherwise
 * the company switcher and the all-businesses panel appear or vanish
 * depending on which box they typed into. */
async function accountFor(user) {
  if (!user || !user.account_id) return null;
  try {
    return (await query("SELECT * FROM accounts WHERE id = ? AND status = 'active'", [user.account_id])).rows[0] || null;
  } catch { return null; }
}

/* Everything a signed-in session needs. Shared so PIN sign-in, password
   sign-in and email sign-in cannot drift apart — one returning a permission
   set another does not would be a security bug that only shows up on one
   screen.
 *
 * `account` is present for an email sign-in and absent for counter staff. It
 * carries the companies that account may enter, which is what the company
 * switcher renders; a cashier has one company and no switcher. */
async function sessionFor(user, account) {
  const firm = (await query("SELECT id, name, gstin, state_code, status FROM firms WHERE id = ?", [user.active_firm_id])).rows[0];
  const permissions = (await query("SELECT module, action FROM role_permissions WHERE role_id = ?", [user.role_id])).rows;
  const role = (await query("SELECT name FROM roles WHERE id = ?", [user.role_id])).rows[0];
  const jti = await openSession({ accountId: account ? account.id : null, userId: user.id });
  const extra = { accountId: account ? account.id : null, jti };

  let acct = null;
  if (account) {
    const mem = (await query(
      `SELECT m.firm_id, m.is_owner, m.status, f.name, f.status AS firm_status
         FROM memberships m JOIN firms f ON f.id = m.firm_id
        WHERE m.account_id = ? AND m.status = 'active'
        ORDER BY f.name`, [account.id])).rows;
    const mine = mem.find((m) => m.firm_id === user.active_firm_id);
    acct = {
      id: account.id, email: account.email, full_name: account.full_name,
      is_owner: !!(mine && mine.is_owner),
      /* Suspended companies are listed but marked, not hidden. A shopkeeper
         whose second business vanished from the switcher would assume it had
         been deleted; "suspended" is a state they can ask about. */
      companies: mem.map((m) => ({ id: m.firm_id, name: m.name, status: m.firm_status, is_owner: !!m.is_owner })),
    };
  }
  return {
    token: signAccess(user, extra),
    refresh: signRefresh(user, extra),
    user: { id: user.id, username: user.username, full_name: user.full_name, role_id: user.role_id,
            role_name: role ? role.name : null, is_owner: acct ? acct.is_owner : false },
    account: acct,
    firm,
    permissions,
  };
}

/* ── Sign in with an email address ────────────────────────────────────────
 *
 * The owner's path. An account is global; the company it opens is whichever it
 * was last using, or the first it may enter.
 *
 * Deliberately indistinguishable from a wrong password when the address is
 * unknown: a different message for "no such account" is an oracle for testing
 * whether a given shopkeeper uses this product, on a system holding shops'
 * books.
 */
/* ── the sign-in code, and the devices that do not have to type one ───────
 *
 * A password proves what somebody knows. A code sent to the address on the
 * account proves they can still read it, and the two together are what stops a
 * stolen password from being enough. This is only asked on a device that has
 * not signed in before: see shared/devices.js for why "every time" was the
 * wrong trade for a shop counter.
 *
 * **PIN sign-in is deliberately untouched.** It is a shop-floor convenience,
 * switched on per shop, for staff standing at a till — sending a cashier to
 * their email between customers would be absurd, and most have no address on
 * file at all (the `users` table has no email column). It follows that PIN
 * sign-in remains a way into a shop that does not pass through this check: on
 * an installation where that matters, leave PIN sign-in switched off.
 */
/** Issue a sign-in code and mail it. Returns a message if it could not go. */
async function sendSigninCode(req, acct) {
  const made = await issueCode({ purpose: "signin", email: acct.email, accountId: acct.id });
  if (made.blocked) return { blocked: made.message };
  const sent = await sendEmail({
    to: acct.email, template: "signin", purpose: "signin",
    data: { code: made.code, name: acct.full_name, device: deviceLabel(req) },
  });
  /* Reported rather than swallowed. The alternative leaves somebody staring at
     a code box waiting for a message no server ever accepted, which is the
     failure people describe as "it just doesn't work". */
  if (!sent.ok && emailConfigured()) return { failed: true };
  return { ok: true, minutes: made.minutes };
}

/* Enough of the address to recognise, not enough to learn. Shown on the code
   screen so somebody with two addresses knows which one to open. */
function maskEmail(addr) {
  const [name, domain] = String(addr || "").split("@");
  if (!domain) return "your email";
  const shown = name.length <= 2 ? name.slice(0, 1) : name.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(3, name.length - shown.length))}@${domain}`;
}

/**
 * The part of an account sign-in that happens once the person has proved
 * whatever they had to prove. Shared by the password path (on a device already
 * trusted) and by the code path — so there is exactly one place that decides
 * which company opens and what a session contains, and the two cannot drift.
 */
async function finishAccountLogin(req, res, acct, usable, extra = {}) {
  /* The business this account has chosen to open, if it has chosen one; the
     one it was last in otherwise. Stated in that order deliberately — a
     default that the last visit could override would not be a default. */
  const last = usable.find((m) => m.firm_id === (acct.default_firm_id || 0))
    || usable.find((m) => m.firm_id === (acct.last_firm_id || 0))
    || usable[0];

  return await tenancy.withFirm(last.firm_id, async () => {
    /* The local users row is what the rest of the app records against — audit
       entries, sales reps, held-bill claims all key on a user id — so an
       account signing in resolves to one. A shop adopted by the migration
       already has one; an invited account is given one when it accepts.
       *
       * The company has to be settled BEFORE that row is looked for. Counter
       * staff live in the company's own database (database/router.js), so
       * "which users row" is a question only a company can answer. */
    let user = (await query("SELECT * FROM users WHERE account_id = ? AND status = 'active'", [acct.id])).rows[0];
    if (!user) {
      user = (await query("SELECT * FROM users WHERE lower(username) = lower(?) AND status = 'active'",
        [String(acct.email).split("@")[0]])).rows[0];
    }
    if (!user) {
      /* No staff row for this account in this company yet. With a file per
         company an owner of three shops needs to exist in three of them, so it
         is created on first entry. */
      user = await ensureLocalUser({ query }, acct, last.firm_id, last.role_id || null);
    }
    if (!user) return res.fail("This account is not set up to sign in here yet", 403);

    if (user.active_firm_id !== last.firm_id) {
      await query("UPDATE users SET active_firm_id = ? WHERE id = ?", [last.firm_id, user.id]);
      user.active_firm_id = last.firm_id;
    }
    if (last.role_id) user.role_id = last.role_id;

    await clearLoginAttempts(req);
    await query("UPDATE accounts SET last_seen_at = datetime('now'), last_firm_id = ? WHERE id = ?",
      [last.firm_id, acct.id]);
    return res.success({ ...await sessionFor(user, acct), ...extra }, "Welcome back");
  });
}

/** The companies this account may actually open, or a sentence saying why not. */
async function usableCompanies(acct) {
  const mems = (await query(
    `SELECT m.*, f.status AS firm_status FROM memberships m JOIN firms f ON f.id = m.firm_id
      WHERE m.account_id = ? AND m.status = 'active' ORDER BY m.id`, [acct.id])).rows;
  const usable = mems.filter((m) => m.firm_status === "active");
  if (usable.length) return { usable };
  return { why: mems.length
    ? "Every business on this account is suspended. Ask the administrator."
    : "This account has no business yet." };
}

router.post("/login-email", loginThrottle, async (req, res) => {
  const { email, password, device_token: deviceToken } = req.body || {};
  const acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [String(email || "").trim()])).rows[0];
  const bad = () => res.fail("Wrong email or password", 401);
  if (!acct || !bcrypt.compareSync(password || "", acct.password_hash)) return bad();
  if (acct.status !== "active") return res.fail("This account has been suspended", 403);

  const { usable, why } = await usableCompanies(acct);
  if (why) return res.fail(why, 403);

  /* Already proved itself on this device: straight in, as before. */
  if (await deviceTrusted(acct.id, deviceToken)) {
    return await finishAccountLogin(req, res, acct, usable);
  }

  /* Not a failure — the password was right. The sign-in simply is not finished
     yet, and the screen has a second step to show. Answering with `fail` here
     would put a red error in front of somebody who has done nothing wrong. */
  const code = await sendSigninCode(req, acct);
  if (code.blocked) return res.fail(code.blocked, 429);
  if (code.failed) return res.fail("We could not send your sign-in code just now. Try again in a minute.", 502);

  return res.success({
    needs_code: true,
    challenge: signChallenge(acct.id),
    sent_to: maskEmail(acct.email),
    expires_in_minutes: code.minutes,
    backup_codes_left: await backupCodesLeft(acct.id),
  }, "We have sent a code to your email.");
});

/**
 * Second step: the code, or a backup code in its place.
 *
 * The challenge is what proves the password was already given. Without it this
 * route would let anybody who could read the email — or guess six digits —
 * sign in without knowing the password at all, which would make the whole
 * thing weaker than the password alone.
 */
router.post("/login-verify", loginThrottle, async (req, res) => {
  const b = req.body || {};
  const c = readChallenge(b.challenge);
  if (!c) return res.fail("That sign-in has expired. Enter your password again.", 401, { restart: true });

  const acct = (await query("SELECT * FROM accounts WHERE id = ?", [c.acct])).rows[0];
  if (!acct || acct.status !== "active") return res.fail("This account has been suspended", 403);

  /* One or the other, never both, and the backup code is checked only when no
     emailed code was given — so a wrong guess at one cannot be used to probe
     the other for free. */
  const typed = String(b.code || "").trim();
  if (typed) {
    const r = await checkCode({ purpose: "signin", email: acct.email, code: typed });
    if (!r.ok) return res.fail(r.message, 401, { expired: !!r.expired });
  } else if (String(b.backup_code || "").trim()) {
    const ok = await useBackupCode(acct.id, b.backup_code);
    if (!ok) return res.fail("That backup code is wrong, or has already been used.", 401);
  } else {
    return res.fail("Enter the code from your email.", 400);
  }

  const { usable, why } = await usableCompanies(acct);
  if (why) return res.fail(why, 403);

  /* Remembering is the default and can be declined — a shared or borrowed
     computer should not be trusted for thirty days because somebody signed in
     on it once. */
  const remember = b.remember_device !== false;
  const token = remember ? await rememberDevice(acct.id, deviceLabel(req)) : null;

  return await finishAccountLogin(req, res, acct, usable, {
    device_token: token,
    backup_codes_left: await backupCodesLeft(acct.id),
  });
});

/** Another code for the same sign-in. `issueCode` caps six an hour per address. */
router.post("/login-resend", loginThrottle, async (req, res) => {
  const c = readChallenge((req.body || {}).challenge);
  if (!c) return res.fail("That sign-in has expired. Enter your password again.", 401, { restart: true });
  const acct = (await query("SELECT * FROM accounts WHERE id = ?", [c.acct])).rows[0];
  if (!acct || acct.status !== "active") return res.fail("This account has been suspended", 403);
  const code = await sendSigninCode(req, acct);
  if (code.blocked) return res.fail(code.blocked, 429);
  if (code.failed) return res.fail("We could not send your sign-in code just now. Try again in a minute.", 502);
  return res.success({ sent: true, sent_to: maskEmail(acct.email), expires_in_minutes: code.minutes },
    "We have sent another code.");
});

/* ── managing the devices, once signed in ────────────────────────────────── */

/** The devices this account may skip the code on. */
router.get("/devices", verifyToken, async (req, res) => {
  if (!req.user.accountId) return res.success({ rows: [], backup_codes_left: 0, supported: false });
  return res.success({
    rows: await listDevices(req.user.accountId),
    backup_codes_left: await backupCodesLeft(req.user.accountId),
    trust_days: TRUST_DAYS,
    supported: true,
  });
});

/** Take the trust away from one. It is asked for a code the next time. */
router.delete("/devices/:id", verifyToken, async (req, res) => {
  if (!req.user.accountId) return res.fail("This sign-in is not an account", 400);
  const ok = await revokeDevice(req.user.accountId, Number(req.params.id));
  return ok ? res.success({ removed: true }, "That device will be asked for a code next time")
            : res.notFound("Device not found");
});

/** Every device at once — for a laptop that has gone missing. */
router.post("/devices/revoke-all", verifyToken, async (req, res) => {
  if (!req.user.accountId) return res.fail("This sign-in is not an account", 400);
  const n = await revokeAllDevices(req.user.accountId);
  return res.success({ removed: n },
    n ? `${n} ${n === 1 ? "device" : "devices"} will be asked for a code next time` : "There were none to remove");
});

/**
 * A fresh set of backup codes, shown once.
 *
 * The password is asked for again even though the caller is already signed in:
 * this hands ten ways past the code step to whoever is at the keyboard, and an
 * unattended till with a session open should not be one of them.
 */
router.post("/backup-codes", verifyToken, async (req, res) => {
  if (!req.user.accountId) return res.fail("This sign-in is not an account", 400);
  const acct = (await query("SELECT * FROM accounts WHERE id = ?", [req.user.accountId])).rows[0];
  if (!acct) return res.notFound("Account not found");
  if (!bcrypt.compareSync(String((req.body || {}).password || ""), acct.password_hash)) {
    return res.fail("Wrong password", 401);
  }
  const codes = await issueBackupCodes(acct.id);
  return res.success({ codes },
    "Print these and keep them safe. The ones you had before no longer work.");
});

/* Signing out ends the session on the server, not just in the browser. */
router.post("/logout", verifyToken, async (req, res) => {
  if (req.user.jti) await query("UPDATE sessions SET revoked_at = datetime('now') WHERE jti = ?", [req.user.jti]);
  res.success({ ok: true }, "Signed out");
});

/* Who to offer on the sign-in screen, and how they may sign in.
 *
 * Unauthenticated by necessity — it is what the sign-in screen reads before
 * anyone has signed in. It therefore returns names only when the shop has
 * turned that on, and never anything that would help someone guess a way in.
 */
/* ── Claiming a new installation ──────────────────────────────────────────
 *
 * A till that has just been installed has a company, roles and a chart of
 * accounts, and **no logins**. Rather than generating a password and printing
 * it in a console window for somebody to find and type back, the first screen
 * asks who they are.
 *
 * Two rules make that safe:
 *
 *   · It works only while there is nobody. The moment one user exists the
 *     route is closed for good, so it can never be used to add a second
 *     administrator to a shop that is trading.
 *   · It answers only the machine it is running on. An installation left
 *     unclaimed on a shop's Wi-Fi would otherwise be claimable by whoever
 *     opened the address first, and the person setting a till up is sitting
 *     at it. GENIUS_CLAIM_ANYWHERE=1 lifts that for anyone with a genuine
 *     reason, which is a deliberate act rather than a default.
 */
async function unclaimed() {
  try { return (await query("SELECT 1 FROM users LIMIT 1")).rows.length === 0; }
  catch { return false; }          /* no schema yet — nothing to claim */
}
function atTheMachine(req) {
  if (process.env.GENIUS_CLAIM_ANYWHERE === "1") return true;
  const ip = String(req.ip || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "";
}

router.get("/first-run", async (req, res) => {
  const firm = (await query("SELECT id, name FROM firms ORDER BY id LIMIT 1")).rows[0] || null;
  res.success({
    needed: await unclaimed(),
    here: atTheMachine(req),
    firm: firm ? firm.name : null,
    version: buildVersion(),
  });
});

router.post("/first-user", loginThrottle, async (req, res) => {
  if (!await unclaimed()) return res.fail("This installation has already been set up", 403);
  if (!atTheMachine(req)) {
    return res.fail("Set this up at the computer it is installed on", 403);
  }
  const b = req.body || {};
  const full_name = String(b.full_name || "").trim();
  const username = String(b.username || "").trim().toLowerCase();
  const password = String(b.password || "");
  const business = String(b.business || "").trim();
  const email = String(b.email || "").trim();

  if (!full_name) return res.fail("What is your name?", 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.fail("That does not look like an email address", 400);
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return res.fail("A username is 3 to 32 letters, numbers, dots, dashes or underscores", 400);
  }
  if (password.length < 8) return res.fail("Use at least 8 characters for the password", 400);

  const firm = (await query("SELECT id, name FROM firms ORDER BY id LIMIT 1")).rows[0];
  if (!firm) return res.fail("This installation has no business set up yet", 500);

  return await tenancy.withFirm(firm.id, async () => {
    /* Belt and braces: the check above and this one bracket the write, so two
       browsers racing to claim the same fresh install cannot both succeed. */
    if (!await unclaimed()) return res.fail("This installation has already been set up", 403);

    const role = (await query("SELECT id FROM roles WHERE firm_id = ? AND name = 'Admin'", [firm.id])).rows[0]
      || (await query("SELECT id FROM roles WHERE firm_id = ? ORDER BY id LIMIT 1", [firm.id])).rows[0];
    if (!role) return res.fail("This installation is missing its roles — reinstall it", 500);

    if (business && business !== firm.name) {
      await query("UPDATE firms SET name = ? WHERE id = ?", [business, firm.id]);
    }
    const hash = bcrypt.hashSync(password, 10);

    /* The person who claims the till is its owner, and an owner is an
     * *account* — not just a staff row. Without one there is no membership,
     * and without a membership `/companies/panel` refuses the only person
     * entitled to it ("Could not load the all-businesses figures"), the
     * company switcher has nothing to switch between, and a second business
     * can be created but never opened.
     *
     * An address is optional here — a shop on a counter has no email and
     * should not be made to invent one — so a local-only address stands in.
     * It is never sent anywhere; it exists because an account is keyed by one.
     */
    const addr = email || `${username}@this-till.local`;
    let acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [addr])).rows[0];
    if (!acct) {
      await query("INSERT INTO accounts (email, password_hash, full_name, status) VALUES (?,?,?,'active')",
        [addr, hash, full_name]);
      acct = (await query("SELECT * FROM accounts WHERE lower(email) = lower(?)", [addr])).rows[0];
    }

    await query(`INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id, account_id)
           VALUES (?,?,?,?,?,?)`,
      [username, hash, full_name, role.id, firm.id, acct.id]);
    const user = (await query("SELECT * FROM users WHERE username = ?", [username])).rows[0];

    await query(`INSERT INTO memberships (account_id, firm_id, role_id, is_owner, status)
           VALUES (?,?,?,1,'active')`, [acct.id, firm.id, role.id]);

    await clearLoginAttempts(req);
    console.log(`first run: this installation was claimed by "${username}"`);
    return res.success(await sessionFor(user, acct), "Welcome to Genius POS");
  });
});

router.get("/signin-options", async (req, res) => {
  /* Which shop this screen is for. On a single-shop machine it is the only
     one there is and nobody is asked anything; on a hosted installation the
     screen asks for a code first and sends it here. */
  const shop = await resolveShop(req);
  if (shop.needsShop) {
    /* Several businesses on one computer. Asking a cashier to type a shop code
       is asking for something nobody gave them — the businesses are right
       here, so the screen offers them. A hosted installation still asks,
       because there the list would be every shop on the server. */
    const businesses = hosted() ? [] : (await query(
      "SELECT id, name, shop_code FROM firms WHERE status = 'active' ORDER BY name")).rows;
    return res.success({ needs_shop: true, businesses, firm: null, showStaff: false,
      pinEnabled: false, staff: [], version: buildVersion() });
  }
  if (shop.unknown) {
    /* Named, and not found. Said plainly: the code is on the counter, not in a
       vault, and a cashier who mistyped it needs to know that rather than
       being told their password is wrong. The route that accepts a password
       stays silent on the difference; this one is throttled and returns
       nothing but a display name. */
    return res.success({ needs_shop: true, unknown_shop: true, firm: null, showStaff: false,
      pinEnabled: false, staff: [], version: buildVersion() });
  }
  /* An installation nobody has claimed yet: the screen shows the set-up form
     instead of asking for a password nobody has been given. */
  if (await unclaimed()) {
    const f = (await query("SELECT name FROM firms ORDER BY id LIMIT 1")).rows[0];
    return res.success({ needs_first_user: true, here: atTheMachine(req),
      firm: f ? f.name : null, showStaff: false, pinEnabled: false, staff: [],
      version: buildVersion() });
  }

  const firm = shop.firm || {};
  /* Both the settings and the staff list belong to that company's own
     database, so everything below runs inside it. `firms` is central and the
     lookup above is not. */
  const one = async (k, d) => {
    if (!firm.id) return d;
    const r = await tenancy.withFirm(firm.id, async () =>
      (await query("SELECT svalue FROM firm_settings WHERE firm_id = ? AND skey = ?", [firm.id, k])).rows[0]);
    return r ? r.svalue : d;
  };
  /* Choosing your face and typing a PIN is what a till screen should be, so it
     is the default rather than a setting somebody has to find. A shop that
     would rather not name its people still turns it off in Settings. */
  const showStaff = await one("login_show_staff", "1") === "1";

  let staff = [];
  if (showStaff && firm.id) {
    /* Counter staff belong to a company's own database, and nobody has signed
       in yet — so the company is the one resolved above, and never "all of
       them". A shop that has turned the list on has chosen to show its own
       people on its own screen; it has not volunteered them to anyone who
       guesses a different shop code. */
    staff = await tenancy.withFirm(firm.id, async () => (await query(
      `SELECT u.id, u.username, u.full_name, r.name AS role_name,
              CASE WHEN u.pin_hash IS NOT NULL AND u.pin_hash <> '' THEN 1 ELSE 0 END AS has_pin
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE COALESCE(u.status,'active') = 'active'
        ORDER BY u.id LIMIT 12`)).rows);
  }

  /* A PIN pad offered on a shop where nobody has a PIN is a door with no key
     behind it: every attempt is refused and the refusal blames the person
     typing. So the pad appears when the shop has switched PINs on **and**
     somebody can actually use one. */
  const anyPin = firm.id ? await tenancy.withFirm(firm.id, async () => (await query(
    "SELECT 1 FROM users WHERE COALESCE(status,'active') = 'active' AND pin_hash IS NOT NULL AND pin_hash <> '' LIMIT 1"
  )).rows.length > 0) : false;
  const pinEnabled = await one("login_pin_enabled", "0") === "1" && anyPin;

  res.success({ firm: firm.name || null, shop_code: firm.shop_code || null,
    showStaff, pinEnabled, staff, version: buildVersion() });
});

/* Sign in with a counter PIN. Deliberately requires the username as well —
   a four-digit number alone is 10,000 guesses, and the throttle is the only
   thing standing in the way. */
router.post("/login-pin", loginThrottle, async (req, res) => {
  const { username, pin } = req.body || {};
  const shop = await resolveShop(req);
  if (shop.needsShop) return res.fail("Which shop? Enter the shop code as well.", 400, { needs_shop: true });
  if (shop.none) return res.fail("This installation has no business set up yet", 403);
  if (shop.unknown) return res.fail("Wrong PIN", 401);

  return await tenancy.withFirm(shop.firm.id, async () => {
    const enabled = (await query(
      "SELECT svalue FROM firm_settings WHERE firm_id = ? AND skey = 'login_pin_enabled'", [shop.firm.id])).rows[0];
    if (!enabled || enabled.svalue !== "1") return res.fail("PIN sign-in is switched off for this shop", 400);

    const user = (await query("SELECT * FROM users WHERE username = ? AND status = 'active'", [username])).rows[0];
    if (!user || !user.pin_hash || !bcrypt.compareSync(String(pin || ""), user.pin_hash)) {
      return res.fail("Wrong PIN", 401);
    }
    if (user.active_firm_id !== shop.firm.id) user.active_firm_id = shop.firm.id;
    await clearLoginAttempts(req);
    return res.success(await sessionFor(user, await accountFor(user)), "Welcome back");
  });
});

/* Refreshing checks the same three things a request does.
 *
 * The version this replaces verified the signature and minted a new pair. That
 * made the whole revocation mechanism ornamental: an ended session, a
 * suspended business or a removed membership all bit on the access token, and
 * the holder simply refreshed past every one of them for the next thirty days.
 * The `jti` is carried through, so the new access token belongs to the same
 * session the old one did and revoking that session still ends it. */
router.post("/refresh", async (req, res) => {
  try {
    const claims = jwt.verify((req.body || {}).refresh, SECRET);
    if (claims.t !== "refresh") return res.fail("Session expired", 401);
    const user = (await query("SELECT * FROM users WHERE id = ? AND status = 'active'", [claims.id])).rows[0];
    if (!user) return res.fail("Session expired", 401);

    if (claims.jti) {
      const sess = (await query("SELECT revoked_at FROM sessions WHERE jti = ?", [claims.jti])).rows[0];
      if (!sess || sess.revoked_at) return res.fail("This session has been ended. Sign in again.", 401);
    }
    const firm = (await query("SELECT status FROM firms WHERE id = ?", [user.active_firm_id])).rows[0];
    if (!firm) return res.fail("That business no longer exists", 403);
    if (firm.status !== "active") {
      return res.fail("This business has been suspended. Ask the administrator.", 403);
    }
    if (claims.acct) {
      const mem = (await query(
        "SELECT m.status, a.status AS acct_status FROM memberships m JOIN accounts a ON a.id = m.account_id " +
        "WHERE m.account_id = ? AND m.firm_id = ?", [claims.acct, user.active_firm_id])).rows[0];
      if (!mem || mem.status !== "active") return res.fail("Your access to this business has been removed", 403);
      if (mem.acct_status !== "active") return res.fail("This account has been suspended", 403);
    }

    const extra = { accountId: claims.acct || null, jti: claims.jti || null };
    res.success({ token: signAccess(user, extra), refresh: signRefresh(user, extra) });
  } catch {
    res.fail("Session expired", 401);
  }
});

router.get("/me", verifyToken, async (req, res) => {
  const firm = (await query("SELECT id, name, gstin, state_code FROM firms WHERE id = ?", [req.user.firm_id])).rows[0];
  const perms = (await query("SELECT module, action FROM role_permissions WHERE role_id = ?", [req.user.role_id])).rows;
  res.success({ user: req.user, firm, permissions: perms });
});

module.exports = router;
module.exports.sessionFor = sessionFor;
