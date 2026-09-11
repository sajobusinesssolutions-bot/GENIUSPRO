/**
 * email.js — one way out of this application for a message to a human.
 *
 * Verification codes, invitations and password resets all go through
 * `sendEmail()`. One module, for three reasons:
 *
 *   1. The provider is a decision that has not been made yet. Postmark,
 *      Resend and SES differ in price and in setup time and in nothing else
 *      that matters here; behind one function, choosing later costs an
 *      afternoon rather than a search across the codebase.
 *   2. It has to be a no-op in tests. A test suite that sends real email is a
 *      test suite nobody runs twice.
 *   3. Every attempt is recorded. "The code never arrived" is the commonest
 *      onboarding support call, and `email_outbox` is what turns it from a
 *      shrug into an answer.
 *
 * Configure with:
 *
 *   EMAIL_PROVIDER   console (default) | postmark | resend | smtp | none
 *   EMAIL_FROM       "Genius POS <no-reply@yourdomain.co.ug>"
 *   POSTMARK_TOKEN / RESEND_API_KEY / SMTP_URL
 *   APP_URL          the base a shopkeeper's browser can reach, for invitation links
 *
 * **On deliverability, which is not a detail.** A verification code in a spam
 * folder looks to the shopkeeper like a broken product, and they do not ring
 * up about it — they leave. Two things decide whether the code arrives: SPF,
 * DKIM and DMARC published on the sending domain, and never sending from a
 * free Gmail address. `EMAIL_FROM` on a domain you control is not optional.
 */
const { query } = require("../database/db");

const PROVIDER = (process.env.EMAIL_PROVIDER || "console").toLowerCase();
const FROM = process.env.EMAIL_FROM || "Genius POS <no-reply@example.invalid>";
const APP_URL = (process.env.APP_URL || "http://localhost:5173").replace(/\/+$/, "");

/* ── Templates ─────────────────────────────────────────────────────────────
 *
 * Plain text. A shop's email may open in anything, and a code that renders as
 * a broken image is worse than one in an ugly font. Each says who it is from,
 * what it is for, how long it lasts, and what to do if it was not you — the
 * last of which is the only defence a person has against somebody trying their
 * address.
 */
const TEMPLATES = {
  verify: ({ code, name }) => ({
    subject: `${code} is your Genius POS code`,
    body:
`Hello${name ? " " + name : ""},

Your code is:

    ${code}

Type it into the sign-up screen. It expires in 15 minutes and can only be
used once.

If you did not try to create a Genius POS account, you can ignore this
message — nothing has been created and nobody has your address.

— SALJO TECH`,
  }),

  /* Sent when an account signs in from a device it has not used before.
     The "if that was not you" line carries more weight here than in the others:
     receiving this unexpectedly means somebody else already has the password,
     and the only useful thing the person can do is change it now. Saying so
     plainly is the difference between a warning and a notification. */
  signin: ({ code, name, device }) => ({
    subject: `${code} is your Genius POS sign-in code`,
    body:
`Hello${name ? " " + name : ""},

Somebody is signing in to your Genius POS account from a device that has not
been used before${device ? ` (${device})` : ""}. Your code is:

    ${code}

It expires in 10 minutes and can only be used once.

If that was not you, somebody else has your password. Do not pass on this
code. Change your password now, and sign out the devices you do not
recognise under Settings.

— SALJO TECH`,
  }),

  reset: ({ code, name }) => ({
    subject: `${code} is your Genius POS reset code`,
    body:
`Hello${name ? " " + name : ""},

Someone asked to reset the password on this account. Your code is:

    ${code}

It expires in 30 minutes and can only be used once. Using it will also sign
this account out everywhere.

If that was not you, do nothing. Your password has not changed and nobody
can change it without this code.

— SALJO TECH`,
  }),

  /* Deliberately sent to an address that already has an account, when somebody
     tries to sign up with it again. The sign-up screen must answer identically
     whether or not the address is known — otherwise it is an oracle for
     testing whether a given shopkeeper uses this product — so the person who
     actually holds the address is the only one who learns anything. */
  exists: ({ name }) => ({
    subject: "You already have a Genius POS account",
    body:
`Hello${name ? " " + name : ""},

Somebody just tried to create a Genius POS account with this address. You
already have one, so nothing has changed.

If that was you, sign in instead: ${APP_URL}
If you have forgotten your password, use "Forgotten your password?" on that
screen.

If it was not you, no action is needed.

— SALJO TECH`,
  }),

  invite: ({ inviter, company, url, role }) => ({
    subject: `${inviter || "Someone"} has invited you to ${company} on Genius POS`,
    body:
`Hello,

${inviter || "Someone"} has invited you to help run ${company} on Genius POS${role ? `, as ${role}` : ""}.

Open this link to accept:

${url}

The invitation expires in 7 days and can only be used once. If you do not
already have a Genius POS account, the link will help you create one.

If you were not expecting this, ignore it — nothing happens until the link
is opened.

— SALJO TECH`,
  }),
};

/**
 * Send one message. Never throws.
 *
 * A failure to send is recorded and reported to the caller as `{ok:false}`,
 * and the caller decides. It must not throw: a provider outage during sign-up
 * would otherwise unwind the transaction that created the account, so the
 * shopkeeper would be told sign-up failed, try again, and hit "that address is
 * already registered" — the worst possible pairing.
 *
 * @returns {Promise<{ok:boolean, id:number|null, provider:string, error?:string}>}
 */
async function sendEmail({ to, template, purpose, data = {} }) {
  const t = TEMPLATES[template];
  if (!t) return { ok: false, id: null, provider: PROVIDER, error: `no template ${template}` };
  const { subject, body } = t(data);
  const address = String(to || "").trim();

  /* The body is stored only when there is no real provider — that is the
     development case, and it is what lets a developer (or a test) read the
     code back without a mail server. With a provider configured the body may
     hold a live code, and this table is inside the shop's backup. */
  const keepBody = PROVIDER === "console" || PROVIDER === "none";
  let id = null;
  try {
    await query("INSERT INTO email_outbox (to_email, subject, purpose, provider, status, body) VALUES (?,?,?,?,?,?)",
      [address, subject, purpose || template, PROVIDER, "queued", keepBody ? body : null]);
    id = (await query("SELECT id FROM email_outbox ORDER BY id DESC LIMIT 1")).rows[0].id;
  } catch { /* the outbox is a record, not a prerequisite */ }

  const finish = async (ok, error) => {
    if (id) {
      try {
        await query("UPDATE email_outbox SET status = ?, error = ?, sent_at = datetime('now') WHERE id = ?",
          [ok ? "sent" : "failed", error || null, id]);
      } catch { /* ignore */ }
    }
    return { ok, id, provider: PROVIDER, ...(error ? { error } : {}) };
  };

  try {
    if (PROVIDER === "none") return await finish(true);

    if (PROVIDER === "console") {
      /* Loud on purpose. On a development machine this IS the delivery
         mechanism, and a code printed quietly among request logs is a code
         nobody finds. */
      console.log(`\n┌─ email → ${address}\n│  ${subject}\n│\n${body.split("\n").map((l) => "│  " + l).join("\n")}\n└─\n`);
      return await finish(true);
    }

    if (PROVIDER === "postmark") {
      const r = await post("https://api.postmarkapp.com/email",
        { "X-Postmark-Server-Token": process.env.POSTMARK_TOKEN || "" },
        { From: FROM, To: address, Subject: subject, TextBody: body, MessageStream: "outbound" });
      return await finish(r.ok, r.error);
    }

    if (PROVIDER === "resend") {
      const r = await post("https://api.resend.com/emails",
        { Authorization: `Bearer ${process.env.RESEND_API_KEY || ""}` },
        { from: FROM, to: [address], subject, text: body });
      return await finish(r.ok, r.error);
    }

    if (PROVIDER === "smtp") {
      /* Optional dependency, resolved at call time. Requiring nodemailer at
         the top of the file would make every installation that does not use
         SMTP — which is all of them today — fail to start. */
      let nodemailer;
      try { nodemailer = require("nodemailer"); }
      catch { return await finish(false, "EMAIL_PROVIDER=smtp needs nodemailer installed"); }
      const tx = nodemailer.createTransport(process.env.SMTP_URL);
      await tx.sendMail({ from: FROM, to: address, subject, text: body });
      return await finish(true);
    }

    return await finish(false, `unknown EMAIL_PROVIDER "${PROVIDER}"`);
  } catch (e) {
    return await finish(false, String(e && e.message ? e.message : e).slice(0, 300));
  }
}

async function post(url, headers, payload) {
  if (typeof fetch !== "function") return { ok: false, error: "this Node build has no fetch" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true };
  let detail = "";
  try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
  return { ok: false, error: `${res.status} ${detail}` };
}

/** Whether a real provider is configured. The sign-up screen says so when not. */
const emailConfigured = () => PROVIDER !== "console" && PROVIDER !== "none";

/**
 * The base address to put in a link, for this request.
 *
 * `APP_URL` when it is set, because a server behind a proxy knows its public
 * name and the request headers may not. When it is not set, the address the
 * request actually arrived on — which is right far more often than the
 * development default. An installation that forgets to set APP_URL used to
 * email invitations pointing at `localhost:5173`: a link that works on the
 * machine that sent it and nowhere else, which is the worst kind of broken
 * because the person who sent it sees it work.
 */
function appUrlFor(req) {
  if (process.env.APP_URL) return APP_URL;
  const origin = req && req.headers && req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, "");
  const host = req && req.headers && req.headers.host;
  if (host) return `${(req.headers["x-forwarded-proto"] || req.protocol || "http")}://${host}`;
  return APP_URL;
}

module.exports = { sendEmail, emailConfigured, APP_URL, appUrlFor, PROVIDER, TEMPLATES };
