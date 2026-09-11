"use strict";
/**
 * firstrun.js — the two things every way of starting this app has to do once.
 *
 * There are three ways in: `start.bat`, the Electron shell, and a hosted
 * `npm start`. Each of them needs a session-signing secret and, on a brand-new
 * machine, an account somebody can sign in with. That was written twice and
 * missing from the third, which is how `start.bat` came to run with the
 * insecure development key **while printing the shop's LAN address on the
 * screen above it** — anyone on that Wi-Fi could forge an admin token.
 *
 * So it lives here once, and all three call it.
 *
 * Run directly, it prints the secret and nothing else, so a batch file can do:
 *
 *     for /f %%k in ('node shared\firstrun.js --key') do set JWT_SECRET=%%k
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Where the books and their keys live. */
function dataDir() {
  const db = process.env.GENIUS_DB_PATH;
  return db ? path.dirname(db) : path.join(__dirname, "..", "data");
}

/**
 * The key that signs sessions. Generated once on this machine and never shown.
 *
 * A shipped default would let anyone who unzipped the installer forge an admin
 * token on every copy sold — which is exactly what the development fallback in
 * `middleware/auth.js` is, and why it warns.
 */
function sessionKey(dir) {
  const d = dir || dataDir();
  const file = path.join(d, "session.key");
  try {
    const k = fs.readFileSync(file, "utf8").trim();
    if (k.length >= 32) return k;
  } catch { /* first run */ }
  const k = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(file, k, { encoding: "utf8", mode: 0o600 });
  return k;
}

/** A password a person can read down a phone line but nobody can guess. */
function readablePassword() {
  const A = "abcdefghjkmnpqrstuvwxyz";        // no i, l, o
  const D = "23456789";                        // no 0, 1
  const pick = (set, n) => Array.from(crypto.randomBytes(n))
    .map((b) => set[b % set.length]).join("");
  return `${pick(A, 4)}-${pick(A, 4)}-${pick(D, 3)}`;
}

/**
 * Set the shop up, if it has not been.
 *
 * Everything a till needs — the company, the roles and their permissions, the
 * chart of accounts, the units, the walk-in customer — and deliberately **no
 * logins**. The first screen asks the person sitting at the machine who they
 * are and what password they want, which is better than generating one,
 * printing it in a console window, and hoping they read it back correctly.
 *
 * `withUsers: true` restores the old behaviour for anyone who wants it —
 * a hosted installation being provisioned by a script, for instance.
 *
 * Returns `{seeded:false}` when there was already a shop here.
 */
async function ensureSeeded({ quiet = false, demo = false, withUsers = false } = {}) {
  const { seedDatabase } = require("../seed");
  const adminPassword = withUsers ? readablePassword() : null;
  const salesPassword = withUsers ? readablePassword() : null;
  const r = await seedDatabase({ demo, withUsers, adminPassword, salesPassword, quiet: true });
  if (!r || !r.seeded) return { seeded: false };

  if (!withUsers) {
    if (!quiet) {
      process.stdout.write(
        "\n============================================\n" +
        "  Ready. The browser will ask who you are.\n" +
        "============================================\n\n" +
        "  There is no password to look up: you choose your own\n" +
        "  name and password on the first screen.\n\n");
    }
    return { seeded: true, withUsers: false };
  }

  const note =
    "Genius POS — this till's first sign-in\n" +
    "============================================\n\n" +
    `Owner     admin / ${adminPassword}\n` +
    `Salesman  sales / ${salesPassword}\n\n` +
    "Change them under Settings > Users as soon as you are in,\n" +
    "then delete this file.\n\n" +
    `Created ${new Date().toLocaleString()}\n` +
    "Powered by SALJO TECH\n";
  const file = path.join(dataDir(), "first-run.txt");
  try { fs.writeFileSync(file, note, { encoding: "utf8", mode: 0o600 }); } catch { /* shown anyway */ }

  if (!quiet) {
    process.stdout.write(
      "\n============================================\n" +
      "  This till has been set up. Write these down.\n" +
      "============================================\n\n" +
      `  Owner     admin / ${adminPassword}\n` +
      `  Salesman  sales / ${salesPassword}\n\n` +
      `  Also saved to: ${file}\n` +
      "  Change them under Settings > Users, then delete that file.\n\n");
  }
  return { seeded: true, withUsers: true, adminPassword, salesPassword, file };
}

/**
 * Set somebody's password from the machine itself.
 *
 * The way back in when a password is lost. Without it the only options were
 * deleting the database — every sale the shop has made — or editing a bcrypt
 * hash by hand, and neither is something to ask of a shopkeeper.
 *
 * It runs on the machine, not over the network, so it is not a way past the
 * sign-in screen: whoever can run it can already read the database file.
 */
async function setPassword(username, password) {
  const bcrypt = require("bcryptjs");
  const { init, query, persist } = require("../database/db");
  const { setup } = require("../database/setup");
  await init();
  await setup();

  const users = (await query("SELECT id, username, full_name FROM users ORDER BY id")).rows;
  if (!users.length) {
    return { ok: false, why: "There are no accounts on this installation yet — start it and the first screen will ask." };
  }
  const who = username
    ? users.find((u) => u.username.toLowerCase() === String(username).toLowerCase())
    : users[0];
  if (!who) {
    return { ok: false, why: `No account called "${username}". There is: ` + users.map((u) => u.username).join(", ") };
  }
  const pw = password || readablePassword();
  await query("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(pw, 10), who.id]);
  persist();
  return { ok: true, username: who.username, full_name: who.full_name, password: pw };
}

async function listUsers() {
  const { query } = require("../database/db");
  try { return (await query("SELECT username, full_name FROM users ORDER BY id")).rows; }
  catch { return []; }
}

module.exports = { sessionKey, readablePassword, ensureSeeded, dataDir, setPassword, listUsers };

/* Run directly. `--key` prints the secret for a shell to pick up, and nothing
   else — any other output would end up in the variable. */
if (require.main === module) {
  if (process.argv.includes("--key")) {
    process.stdout.write(sessionKey());
  } else if (process.argv.includes("--password")) {
    const at = process.argv.indexOf("--password");
    const rest = process.argv.slice(at + 1).filter((a) => !a.startsWith("--"));
    setPassword(rest[0], rest[1]).then((r) => {
      if (!r.ok) { console.error("\n  " + r.why + "\n"); process.exit(1); }
      console.log("\n  ============================================");
      console.log("    " + r.username + " can now sign in with:  " + r.password);
      console.log("  ============================================\n");
      process.exit(0);
    }).catch((e) => { console.error("\n  " + (e.message || e) + "\n"); process.exit(1); });
  }
}
