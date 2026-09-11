/**
 * challenge.js — the ticket that says "the password was already given".
 *
 * The sign-in code is a second step, and a second step needs to know that the
 * first one happened. This is that proof: a short-lived token handed out when
 * the password checks out, and required back when the code is submitted.
 *
 * ── why it is not simply "email plus code" ────────────────────────────────
 *
 * Without it, `POST /login-verify { email, code }` would be a complete sign-in
 * on its own — six digits and an address, no password anywhere. Anyone who
 * could read the mailbox, or who got lucky against a million-to-one code
 * inside its ten minutes, would be in. The whole point of the second factor is
 * that it is a *second* one; a route that accepts it alone makes the account
 * weaker than it was with a password and nothing else.
 *
 * ── why the `t` claim is checked and not assumed ─────────────────────────
 *
 * Every token this application issues is signed with the same secret: access
 * tokens, refresh tokens, the onboarding ticket, and this. A signature check
 * alone therefore proves only that *we* minted it, not what for. Without the
 * type check below, an ordinary access token — which any signed-in cashier
 * has, and which is sent to the server on every request — would be accepted
 * here as proof that somebody had passed a password check they had never
 * seen.
 *
 * That class of fault is quiet: everything works, every test about signing in
 * passes, and the second factor is simply not there for anyone who has ever
 * held any token. So the type is part of what is verified, and there is a test
 * that feeds this function an access token and expects it to be refused.
 *
 * It lives in its own file, rather than beside the route that uses it, because
 * a route file needs Express and this needs to be testable without it.
 */
const jwt = require("jsonwebtoken");
const { SECRET } = require("./middleware/auth");

/** What this token is for. Anything else signed with the same secret is not. */
const KIND = "otp";

/* Two minutes longer than the code itself (authcodes: signin = 10 minutes), so
   a code that is still valid always has a live challenge to go with it. The
   other way round produces "that code is correct but your sign-in expired",
   which is true, useless, and infuriating. */
const TTL = "12m";

/** Issue a challenge for an account that has just passed its password check. */
function signChallenge(accountId) {
  return jwt.sign({ t: KIND, acct: Number(accountId) }, SECRET, { expiresIn: TTL });
}

/**
 * Read one back.
 *
 * @returns {{acct:number}|null} — null for anything expired, unsigned, signed
 *   with another key, or of any other kind. The caller cannot tell which, and
 *   should not: every one of them means "start again".
 */
function readChallenge(token) {
  let c;
  try { c = jwt.verify(String(token || ""), SECRET); }
  catch { return null; }
  if (!c || c.t !== KIND) return null;
  const acct = Number(c.acct);
  if (!Number.isInteger(acct) || acct <= 0) return null;
  return { acct };
}

module.exports = { signChallenge, readChallenge, KIND, TTL };
