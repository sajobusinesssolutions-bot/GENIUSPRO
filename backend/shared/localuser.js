/**
 * localuser.js — the `users` row an account signs in as.
 *
 * There are two tiers of identity in this application and one of them is
 * older than the other. Every `req.user.id` in the codebase is a `users.id`:
 * audit rows, sales reps, held-bill claims, stock movements and shift
 * ownership all key on it. Accounts arrived later, are global, and key on
 * nothing.
 *
 * Rather than rewrite every one of those references — a change touching
 * dozens of files to alter what an integer means, which is the kind of
 * migration that goes wrong quietly — an account resolves to exactly one
 * `users` row, and that row's `active_firm_id` moves as the account switches
 * company. `login-email` already assumed this row exists. This is what makes
 * it exist for an account that was never adopted from an older installation.
 *
 * The password on that row is deliberately unusable. An account signs in with
 * its email and the password on `accounts`; a `users` row whose password also
 * worked would be a second door to the same books, opened with a credential
 * the owner does not know they have and can never change.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../database/db");

/** A username nobody else has. `users.username` is UNIQUE across the file. */
async function freeUsername(base) {
  const root = String(base || "user").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "user";
  if (!(await query("SELECT 1 FROM users WHERE lower(username) = ?", [root])).rows.length) return root;
  for (let i = 2; i < 200; i++) {
    const t = `${root}${i}`;
    if (!(await query("SELECT 1 FROM users WHERE lower(username) = ?", [t])).rows.length) return t;
  }
  return `${root}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * The `users` row for this account, created if it is not there, pointed at
 * `firmId` with `roleId`.
 *
 * @param {{query:Function}} conn  the caller's transaction
 * @returns {object} the users row
 */
async function ensureLocalUser(conn, account, firmId, roleId) {
  let user = (await query("SELECT * FROM users WHERE account_id = ?", [account.id])).rows[0];
  if (!user) {
    const username = await freeUsername(String(account.email || "").split("@")[0]);
    /* Random, discarded, never sent anywhere. `password_hash` is NOT NULL and
       a row with an empty hash would let `bcrypt.compareSync("", "")` decide
       something important. */
    const dead = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
    await conn.query(
      `INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id, status, account_id)
       VALUES (?,?,?,?,?,'active',?)`,
      [username, dead, account.full_name || account.email, roleId || null, firmId, account.id]);
    user = (await query("SELECT * FROM users WHERE account_id = ?", [account.id])).rows[0];
  } else {
    await conn.query("UPDATE users SET active_firm_id = ?, role_id = ?, status = 'active' WHERE id = ?",
      [firmId, roleId || user.role_id, user.id]);
    user = { ...user, active_firm_id: firmId, role_id: roleId || user.role_id, status: "active" };
  }
  return user;
}

module.exports = { ensureLocalUser, freeUsername };
