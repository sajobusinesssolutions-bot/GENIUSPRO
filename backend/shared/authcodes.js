/**
 * authcodes.js — six-digit codes that are worth something.
 *
 * A verification code grants an account, and a reset code grants somebody
 * else's books. Six digits is a million possibilities, which sounds like a
 * lot and is not: unlimited guesses against a million-to-one secret is a
 * matter of minutes. Four things make it safe, and all four are needed:
 *
 *   1. **Random from a cryptographic source.** `Math.random()` is predictable
 *      from a handful of outputs; a code generator seeded that way can be
 *      predicted rather than guessed.
 *   2. **Hashed at rest.** Read access to this table must not be read access
 *      to every account being created this quarter-hour.
 *   3. **A guess limit.** Five wrong attempts burns the code. This is the one
 *      that actually stops brute force — the others only raise the cost.
 *   4. **Short-lived and single-use.** Fifteen minutes to verify, thirty to
 *      reset, consumed on success.
 *
 * Issuing a new code invalidates the previous one for the same address and
 * purpose, so "resend" cannot be used to keep five live codes in flight and
 * multiply the guess budget by five.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../database/db");

const MAX_ATTEMPTS = 5;
const MAX_ISSUES_PER_HOUR = 6;     // resend, generously, without becoming a mail cannon
/* Minutes a code is good for. `signin` is the shortest of the three on
   purpose: the person asking for it is sitting in front of the screen waiting
   for it to arrive, so ten minutes is generous, and a sign-in code is the one
   an attacker is most likely to be racing for. */
const TTL = { verify: 15, reset: 30, signin: 10 };

/** Six digits, uniformly, from the OS random source. Leading zeros kept. */
function sixDigits() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/**
 * Issue a code. Returns the plaintext exactly once — it is never readable
 * again, here or anywhere else.
 *
 * @returns {{code:string}|{blocked:true, message:string}}
 */
async function issueCode({ purpose, email, accountId = null }) {
  const addr = String(email || "").trim();
  const mins = TTL[purpose] || 15;

  const recent = (await query(
    `SELECT COUNT(*) AS n FROM auth_codes
      WHERE lower(email) = lower(?) AND purpose = ?
        AND created_at > datetime('now', '-1 hour')`, [addr, purpose])).rows[0];
  if (recent && recent.n >= MAX_ISSUES_PER_HOUR) {
    return { blocked: true, message: "Too many codes requested for this address. Try again in an hour." };
  }

  /* The previous code stops working the moment a new one is sent. Otherwise
     "resend" is a way to hold several live codes at once, and the guess limit
     is per code. */
  await query(
    `UPDATE auth_codes SET consumed_at = datetime('now')
      WHERE lower(email) = lower(?) AND purpose = ? AND consumed_at IS NULL`, [addr, purpose]);

  const code = sixDigits();
  await query(
    `INSERT INTO auth_codes (purpose, email, account_id, code_hash, expires_at)
     VALUES (?,?,?,?, datetime('now', ?))`,
    [purpose, addr, accountId, bcrypt.hashSync(code, 10), `+${mins} minutes`]);
  return { code, minutes: mins };
}

/**
 * Check a code and consume it if it is right.
 *
 * Every failure returns the same shape and a message that says what to do
 * rather than what happened internally. The one distinction worth drawing is
 * expiry, because "that code has expired — we've sent a new one" is a
 * different action from "that code is wrong", and getting a person to retype
 * a code that can never work is its own kind of cruelty.
 *
 * @returns {{ok:true, row:object}|{ok:false, message:string, expired?:boolean}}
 */
async function checkCode({ purpose, email, code }) {
  const addr = String(email || "").trim();
  const given = String(code || "").replace(/\D/g, "");
  const row = (await query(
    `SELECT * FROM auth_codes
      WHERE lower(email) = lower(?) AND purpose = ? AND consumed_at IS NULL
      ORDER BY id DESC LIMIT 1`, [addr, purpose])).rows[0];

  /* No code on file reads the same as a wrong one. A different answer here
     would say whether a given address has a reset in flight. */
  if (!row) return { ok: false, message: "That code is wrong or has expired. Ask for a new one." };

  const expired = (await query("SELECT (expires_at < datetime('now')) AS e FROM auth_codes WHERE id = ?", [row.id])).rows[0];
  if (expired && expired.e) {
    await query("UPDATE auth_codes SET consumed_at = datetime('now') WHERE id = ?", [row.id]);
    return { ok: false, expired: true, message: "That code has expired. Ask for a new one." };
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    await query("UPDATE auth_codes SET consumed_at = datetime('now') WHERE id = ?", [row.id]);
    return { ok: false, message: "Too many wrong tries. Ask for a new code." };
  }

  if (!bcrypt.compareSync(given, row.code_hash)) {
    await query("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      message: left > 0
        ? `That code is wrong. ${left} ${left === 1 ? "try" : "tries"} left.`
        : "That code is wrong, and that was the last try. Ask for a new code.",
    };
  }

  await query("UPDATE auth_codes SET consumed_at = datetime('now') WHERE id = ?", [row.id]);
  return { ok: true, row };
}

/** Housekeeping. Consumed and expired codes are of no use to anybody. */
async function pruneCodes() {
  try {
    await query("DELETE FROM auth_codes WHERE expires_at < datetime('now', '-1 day')");
  } catch { /* not fatal */ }
}

module.exports = { issueCode, checkCode, pruneCodes, MAX_ATTEMPTS, sixDigits };
