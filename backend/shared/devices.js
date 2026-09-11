/**
 * devices.js — "this computer has already proved who it is", and the way back
 * in when it cannot.
 *
 * ── the shape of the decision ─────────────────────────────────────────────
 *
 * A password that has been stolen is used from somewhere else. That is the
 * whole threat this defends against, and it is why the code is asked for once
 * per device rather than once per sign-in: asking every time would cost a
 * cashier several minutes at seven in the morning, every morning, to defend
 * against something that has already been defended against on that machine —
 * and a shop whose till cannot open because a mail server is slow is a shop
 * that switches the feature off.
 *
 * So: the first sign-in from a device needs a code. That device is then
 * remembered for thirty days, and the next one does not. Revoking a lost
 * laptop takes the trust away immediately.
 *
 * ── two kinds of secret, hashed two ways ─────────────────────────────────
 *
 * **Device tokens** are 256 bits from the OS random source and are never typed
 * by a person. They are hashed with SHA-256, which is right for two reasons:
 * there is no dictionary for bcrypt's cost factor to defend against, and a
 * hash that can be looked up by value lets a sign-in find the row in one
 * indexed query instead of bcrypt-comparing every device the account owns.
 *
 * **Backup codes** are short enough to read off a printed sheet, so bcrypt's
 * cost factor is doing real work. There are ten per account, so comparing all
 * of them costs nothing.
 *
 * Using the fast hash for the typed secret would be the classic mistake; using
 * the slow one for the machine secret would be a self-inflicted denial of
 * service on every sign-in. They are different problems.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("../database/db");

/** How long a device stays trusted before it is asked again. */
const TRUST_DAYS = Number(process.env.DEVICE_TRUST_DAYS) || 30;
/** How many backup codes are issued at a time. */
const BACKUP_CODES = 10;

/* No 0/O/1/I/L: these are read off paper and typed by somebody who did not
   choose them, and a code that cannot be transcribed reliably is a support
   call rather than a way back in. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ── devices ─────────────────────────────────────────────────────────────── */

/**
 * A name a person will recognise in a list, from the browser's own account of
 * itself. Not identification and not trusted for anything — the token is what
 * proves the device. This only has to let somebody look at "Windows · Chrome,
 * last used this morning" and know whether it is theirs.
 */
function deviceLabel(req) {
  const ua = String((req && req.headers && req.headers["user-agent"]) || "");
  if (!ua) return "Unknown device";
  const os = /Windows/i.test(ua) ? "Windows"
    : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iOS/i.test(ua) ? "iPhone or iPad"
    : /Mac OS X|Macintosh/i.test(ua) ? "Mac"
    : /Linux/i.test(ua) ? "Linux" : "";
  /* Order matters: Edge and Opera both claim to be Chrome, and Chrome claims
     to be Safari. Tested most-specific first or every browser is "Chrome". */
  const app = /Electron|GeniusPOS/i.test(ua) ? "the desktop app"
    : /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari" : "";
  const both = [os, app].filter(Boolean).join(" · ");
  return both || "Unknown device";
}

/**
 * Remember this device. Returns the token exactly once — it is never readable
 * again from here or from the database.
 */
async function rememberDevice(accountId, label) {
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO trusted_devices (account_id, token_hash, label, last_seen_at, expires_at)
     VALUES (?,?,?, datetime('now'), datetime('now', ?))`,
    [accountId, sha(token), label || "Unknown device", `+${TRUST_DAYS} days`]);
  return token;
}

/**
 * Has this account already proved itself on this device?
 *
 * The account id is part of the lookup, not just the token. A token is bound
 * to the account that earned it: without this, one person's trusted laptop
 * would answer "yes, trusted" for somebody else's email address, and the code
 * step would be skipped for an account that had never been near the machine.
 */
async function deviceTrusted(accountId, token) {
  if (!accountId || !token) return false;
  const row = (await query(
    `SELECT id FROM trusted_devices
      WHERE account_id = ? AND token_hash = ? AND revoked_at IS NULL
        AND expires_at > datetime('now')
      LIMIT 1`, [accountId, sha(token)])).rows[0];
  if (!row) return false;
  /* Last seen, so the list means something to whoever is deciding which of
     these to revoke. Not the expiry: a device trusted in March is asked again
     in April whether or not it was used every day in between. */
  await query("UPDATE trusted_devices SET last_seen_at = datetime('now') WHERE id = ?", [row.id]);
  return true;
}

/** The devices an account can see, newest first. Never the hashes. */
async function listDevices(accountId) {
  return (await query(
    `SELECT id, label, created_at, last_seen_at, expires_at,
            (expires_at <= datetime('now')) AS expired
       FROM trusted_devices
      WHERE account_id = ? AND revoked_at IS NULL
      ORDER BY COALESCE(last_seen_at, created_at) DESC`, [accountId])).rows;
}

/** Take the trust away from one device. It will be asked for a code again. */
async function revokeDevice(accountId, id) {
  const r = await query(
    `UPDATE trusted_devices SET revoked_at = datetime('now')
      WHERE id = ? AND account_id = ? AND revoked_at IS NULL`, [id, accountId]);
  return r.changes > 0;
}

/** Every device, for a password change or a laptop that has gone missing. */
async function revokeAllDevices(accountId) {
  const r = await query(
    `UPDATE trusted_devices SET revoked_at = datetime('now')
      WHERE account_id = ? AND revoked_at IS NULL`, [accountId]);
  return r.changes || 0;
}

/** Housekeeping. A device long past its expiry is of no use to anybody. */
async function pruneDevices() {
  try {
    await query("DELETE FROM trusted_devices WHERE expires_at < datetime('now', '-30 days')");
  } catch { /* not fatal */ }
}

/* ── backup codes ────────────────────────────────────────────────────────── */

function oneCode() {
  const pick = () => ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  const part = (n) => Array.from({ length: n }, pick).join("");
  /* Grouped, because a person is copying this onto paper and back off it. */
  return `${part(4)}-${part(4)}`;
}

/** How a typed code is compared: case and dashes are the typist's business. */
const normalise = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Issue a fresh set, replacing any that exist.
 *
 * Replacing rather than adding is the point: somebody asking for new codes has
 * usually lost the sheet, and codes they can no longer account for must stop
 * working. Returns the plaintext once.
 */
async function issueBackupCodes(accountId) {
  await query("DELETE FROM backup_codes WHERE account_id = ?", [accountId]);
  const codes = [];
  for (let i = 0; i < BACKUP_CODES; i++) {
    const c = oneCode();
    codes.push(c);
    await query("INSERT INTO backup_codes (account_id, code_hash) VALUES (?,?)",
      [accountId, bcrypt.hashSync(normalise(c), 10)]);
  }
  return codes;
}

/**
 * Spend one. Single-use: a code that has let somebody in must never let anyone
 * in again, including whoever is reading over their shoulder.
 */
async function useBackupCode(accountId, code) {
  const given = normalise(code);
  if (given.length < 6) return false;
  const rows = (await query(
    "SELECT id, code_hash FROM backup_codes WHERE account_id = ? AND used_at IS NULL", [accountId])).rows;
  for (const r of rows) {
    if (!bcrypt.compareSync(given, r.code_hash)) continue;
    await query("UPDATE backup_codes SET used_at = datetime('now') WHERE id = ?", [r.id]);
    return true;
  }
  return false;
}

/** How many are left, so the screen can say "2 left" before it is nought. */
async function backupCodesLeft(accountId) {
  const r = (await query(
    "SELECT COUNT(*) AS n FROM backup_codes WHERE account_id = ? AND used_at IS NULL", [accountId])).rows[0];
  return Number(r && r.n) || 0;
}

module.exports = {
  deviceLabel, rememberDevice, deviceTrusted, listDevices, revokeDevice,
  revokeAllDevices, pruneDevices,
  issueBackupCodes, useBackupCode, backupCodesLeft,
  TRUST_DAYS, BACKUP_CODES,
};
