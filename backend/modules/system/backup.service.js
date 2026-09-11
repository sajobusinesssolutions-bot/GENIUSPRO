/**
 * backup.service.js — everything a restore has to be sure of before it
 * overwrites a business's books.
 *
 * Restore is the one feature in this app where a bug destroys data rather than
 * reporting it wrong, and until now it was four lines: check sixteen bytes of
 * magic, write the file, reload. Every guard below exists because that version
 * did something specific and provable:
 *
 *   - it replaced the whole file, so firm B restoring its own backup deleted
 *     firm A (measured: firm B's item count went 1 → 0 when firm A restored a
 *     backup taken before that item existed);
 *   - it took no lock, so a sale committing mid-restore either landed in a
 *     database that no longer existed or persisted itself over the restored
 *     file;
 *   - it accepted any SQLite file at all (an 8 KB database whose only table was
 *     `not_genius` previewed happily as "0 invoices, 0 parties");
 *   - it clobbered one `.pre-restore` file, so restoring twice destroyed the
 *     only copy of the original.
 *
 * The shape here is: inspect the candidate fully *before* touching anything,
 * keep a verified way back, swap atomically, prove the result is usable, and
 * roll back automatically if it is not.
 */
const fs = require("fs");
const path = require("path");
const { DB_PATH, query, persist, replaceDatabase, inTransaction } = require("../../database/db");
const appVersion = require("../../shared/version");

const BACKUP_DIR = path.join(path.dirname(DB_PATH), "backups");

/** How many daily copies are kept. */
const BACKUP_KEEP = 7;
/** How many pre-restore safety copies are kept (see keepSafetyCopy). */
const SAFETY_KEEP = 10;

/* Opening a database to verify it doubles it in wasm memory for the duration.
   That is nothing on a shop's 30 MB file and is a 1 GB spike on a very large
   one — which is the exact condition under which this app is already close to
   its ceiling (db.js). Above this size the verification falls back to a header
   and length check and says so, rather than being the thing that kills the
   process during a backup. */
const FULL_VERIFY_MAX_BYTES = 256 * 1024 * 1024;

/* Tables that together mean "this is a Genius POS database and not some other
   product's". Deliberately spread across the three schema files — infra,
   billing, accounting — so a file holding only a fragment does not pass. */
const IDENTITY_TABLES = [
  "firms", "users", "roles", "role_permissions", "firm_settings",
  "parties", "items", "item_stock",
  "sale_invoices", "sale_invoice_lines", "purchase_invoices",
  "payments", "chart_of_accounts", "journal_entries",
];

/** The SQLite file header, in full: 15 printable characters and a NUL,
    16 bytes in total.

    Written as the escape \0, not as a literal NUL byte. It was a literal
    one, which is functionally identical and quietly corrosive: a single NUL
    makes the whole file "binary" to grep, so `grep -rn` across the backend
    silently skipped this entire module. Several passes in this codebase have
    relied on exactly that kind of sweep to prove a selector or a call site is
    dead, and a file that cannot be searched is a file those sweeps lie about.
    `file` reported it as data and git diffs it as binary for the same reason. */
const MAGIC = "SQLite format 3\0";

function looksLikeSqlite(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 512 && buf.slice(0, 16).toString("latin1") === MAGIC;
}

/* ── reading a schema, live or candidate ─────────────────────────────────── */

/** table -> Set(column names), for the live database. */
async function liveSchema() {
  const out = new Map();
  for (const r of (await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows) {
    const cols = new Set((await query(`PRAGMA table_info(${JSON.stringify(r.name)})`)).rows.map((c) => c.name));
    out.set(r.name, cols);
  }
  return out;
}

/** The same, for a candidate opened with sql.js. prepare/step/free, never
    exec() — see the note in db.js about exec() leaking the wasm stack. */
function probeSchema(probe) {
  const rows = (sql) => {
    const stmt = probe.prepare(sql);
    try { const out = []; while (stmt.step()) out.push(stmt.getAsObject()); return out; }
    finally { stmt.free(); }
  };
  const out = new Map();
  for (const r of rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    out.set(r.name, new Set(rows(`PRAGMA table_info(${JSON.stringify(r.name)})`).map((c) => c.name)));
  }
  return out;
}

function scalar(probe, sql, dflt = 0) {
  let stmt;
  try {
    stmt = probe.prepare(sql);
    return stmt.step() ? (stmt.get()[0] ?? dflt) : dflt;
  } catch { return dflt; }
  finally { try { stmt?.free(); } catch { /* already gone */ } }
}

/* ── inspecting a candidate backup ───────────────────────────────────────── */

/**
 * Open a candidate and say everything that can be known about it without
 * applying it: is it ours, is its schema one this build can work with, whose
 * books are in it, and how much.
 *
 * Returns `{ ok:false, error }` for anything that must be refused, or
 * `{ ok:true, summary, warnings, firms }`. Never throws on bad input — a
 * corrupt upload is a message to the shopkeeper, not a 500.
 */
async function inspectBackup(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: "No backup data was received." };
  if (!looksLikeSqlite(buf)) {
    return { ok: false, error: "That file is not a Genius POS backup — it is not a database file at all. Choose the .db file the app downloaded." };
  }

  const SQL = await require("sql.js")();
  let probe;
  try { probe = new SQL.Database(buf); }
  catch { return { ok: false, error: "That backup file is damaged and cannot be read. Try an earlier copy." }; }

  try {
    /* A SQLite file with a good header can still be corrupt further in: pages
       are read lazily, so `new SQL.Database()` succeeds and the first real
       query throws "database disk image is malformed". Measured — a backup with
       200 KB overwritten got that far and produced a 500 with a raw SQLite
       message. Anything this probe throws is the same answer: the file cannot
       be used, and nothing has been touched. */
    return await inspect(probe, buf);
  } catch (e) {
    return { ok: false, error:
      "That backup file is damaged and cannot be read (" + String(e && e.message || e) + "). " +
      "Try an earlier copy. Nothing has been changed." };
  } finally {
    try { probe.close(); } catch { /* already gone */ }
  }
}

async function inspect(probe, buf) {
  {
    const schema = probeSchema(probe);

    /* 1. Is it ours at all? */
    const missingIdentity = IDENTITY_TABLES.filter((t) => !schema.has(t));
    if (missingIdentity.length) {
      return { ok: false, error:
        "That is a database file, but it was not made by Genius POS — it is missing " +
        `${missingIdentity.slice(0, 4).join(", ")}${missingIdentity.length > 4 ? " and others" : ""}. ` +
        "Nothing has been changed." };
    }

    /* 2. Is it from a *newer* build? Extra tables mean the backup holds records
          this version does not know how to read, and restoring it would show
          the shopkeeper a partial picture of their own books while looking
          entirely normal. Missing tables and columns are the opposite case and
          are recoverable — the schema migrations run forward after the swap. */
    const live = await liveSchema();
    const extraTables = [...schema.keys()].filter((t) => !live.has(t) && t !== "sqlite_sequence");
    if (extraTables.length) {
      return { ok: false, error:
        "That backup was made by a newer version of Genius POS than the one running here " +
        `(it holds ${extraTables.slice(0, 3).join(", ")}${extraTables.length > 3 ? " and others" : ""}, which this version does not know about). ` +
        "Update the app first, then restore. Nothing has been changed." };
    }

    const warnings = [];
    const missingTables = [...live.keys()].filter((t) => !schema.has(t));
    const missingColumns = [];
    for (const [t, cols] of live) {
      const have = schema.get(t);
      if (!have) continue;
      for (const c of cols) if (!have.has(c)) missingColumns.push(`${t}.${c}`);
    }
    if (missingTables.length || missingColumns.length) {
      warnings.push(
        `This backup is from an older version (${missingTables.length} table(s) and ${missingColumns.length} column(s) added since). ` +
        "They will be added back automatically when it is restored."
      );
    }

    /* 3. Whose books. A firm row per business; the count is what decides
          whether a whole-file restore is safe. */
    const firms = [];
    {
      const stmt = probe.prepare("SELECT id, name FROM firms ORDER BY id");
      try { while (stmt.step()) firms.push(stmt.getAsObject()); } finally { stmt.free(); }
    }

    const summary = {
      size_bytes: buf.length,
      firm: firms.length ? firms[0].name : "—",
      firm_count: firms.length,
      firm_names: firms.map((f) => f.name),
      invoices: scalar(probe, "SELECT COUNT(*) FROM sale_invoices"),
      purchases: scalar(probe, "SELECT COUNT(*) FROM purchase_invoices"),
      parties: scalar(probe, "SELECT COUNT(*) FROM parties"),
      items: scalar(probe, "SELECT COUNT(*) FROM items"),
      payments: scalar(probe, "SELECT COUNT(*) FROM payments"),
      last_invoice_no: scalar(probe, "SELECT invoice_no FROM sale_invoices ORDER BY id DESC LIMIT 1", "—"),
      last_invoice_date: scalar(probe, "SELECT invoice_date FROM sale_invoices ORDER BY id DESC LIMIT 1", "—"),
      first_invoice_date: scalar(probe, "SELECT invoice_date FROM sale_invoices ORDER BY id ASC LIMIT 1", "—"),
      taken_by_version: null,
      warnings,
    };
    /* Backups made from this version onwards carry the build that wrote them,
       recorded by the same code that records restores. Older ones simply do
       not have the row, which is not an error. */
    summary.taken_by_version =
      scalar(probe, "SELECT detail FROM audit_logs WHERE module='system' AND action='backup-version' ORDER BY id DESC LIMIT 1", null) || null;

    return { ok: true, summary, warnings, firms };
  }
}

/* ── the multi-tenant question ───────────────────────────────────────────── */

/**
 * A whole-file restore replaces every firm in the installation, so it is only
 * ever safe when the installation holds one firm. See the long note in
 * system.routes.js for why this is a refusal and not a firm-scoped import.
 *
 * `GENIUS_ALLOW_WHOLE_FILE_RESTORE=1` is the deployment-level operator's escape
 * hatch: someone with shell access on the server, who can see every firm and
 * has taken their own copy first, may still do it. A firm admin clicking
 * Restore in the browser cannot.
 */
/* SAJO_… is the pre-rename spelling; a deployed box should not break on it. */
function operatorOverride() {
  return process.env.GENIUS_ALLOW_WHOLE_FILE_RESTORE === "1" ||
         process.env.SAJO_ALLOW_WHOLE_FILE_RESTORE   === "1";
}

async function liveFirms() {
  try { return (await query("SELECT id, name FROM firms ORDER BY id")).rows; } catch { return []; }
}

async function multiTenantRefusal(candidateFirms) {
  if (operatorOverride()) return null;
  const here = await liveFirms();
  if (here.length > 1) {
    /* This refusal used to be a dead end: correct, and with nowhere to go. It
       now names the path that does work. Companies → the business → Restore
       puts one business back without touching the others, which is what
       somebody reaching this message actually wants. */
    return "This installation holds " + here.length + " businesses (" +
      here.map((f) => f.name).join(", ") + "), and restoring a whole-file backup replaces " +
      "everything — it would delete the other businesses' records along with yours. " +
      "Restore just the one business instead: go to Companies, choose it, and use " +
      "Restore there. That puts it back exactly as it was and leaves the others alone.";
  }
  if (candidateFirms && candidateFirms.length > 1) {
    return "That backup contains " + candidateFirms.length + " businesses (" +
      candidateFirms.map((f) => f.name).join(", ") + "). Restoring it here would bring all of them in, " +
      "including books that are not yours. Ask whoever runs this server to restore it.";
  }
  return null;
}

/* ── safety copies ───────────────────────────────────────────────────────── */

/**
 * Copy the live database somewhere it will still be there after the *next*
 * restore too.
 *
 * The old code wrote one fixed `genius.db.pre-restore`, so a second restore
 * overwrote the copy taken before the first, and the original state was gone
 * with no way back and nothing in the UI to reach it. These are timestamped,
 * live in backups/ where the Backup screen already lists and can restore them,
 * and the last SAFETY_KEEP are kept.
 *
 * Returns the file name, or throws — a restore with no verified way back does
 * not proceed.
 */
async function keepSafetyCopy() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  /* Milliseconds, and then a counter if even that collides. Two restores
     inside the same second is not a hypothetical — it is what "that was the
     wrong backup, put the other one on" looks like, and it is precisely the
     case where losing the earlier safety copy costs the shop its books. */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  let name = `pre-restore-${stamp}.db`;
  for (let n = 2; fs.existsSync(path.join(BACKUP_DIR, name)); n++) name = `pre-restore-${stamp}-${n}.db`;
  const dest = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DB_PATH, dest);

  const v = await verifyBackupFileDeep(dest);
  if (!v.ok) {
    try { fs.unlinkSync(dest); } catch { /* nothing to remove */ }
    throw new Error("Could not take a safety copy of the current data (" + v.error + "), so nothing was restored.");
  }

  const olds = fs.readdirSync(BACKUP_DIR).filter((f) => /^pre-restore-.*\.db$/.test(f)).sort();
  while (olds.length > SAFETY_KEEP) { try { fs.unlinkSync(path.join(BACKUP_DIR, olds.shift())); } catch { /* gone */ } }
  return name;
}

/**
 * The cheap half of verification: the file exists, is long enough, and starts
 * with the SQLite header. Catches a truncated copy, a full disk and a torn
 * write without reading the whole file.
 */
function verifyBackupFile(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { return { ok: false, error: "it is not on disk: " + e.message }; }
  if (size < 512) return { ok: false, error: "it is empty or truncated" };

  let head;
  try {
    const fd = fs.openSync(file, "r");
    try { head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  } catch (e) { return { ok: false, error: "it could not be read back: " + e.message }; }
  if (head.toString("latin1") !== MAGIC) return { ok: false, error: "it is not a database file" };
  return { ok: true, depth: "header", size };
}

/**
 * The whole of it: open the copy and read from it.
 *
 * A backup nobody has ever opened is a guess, not a backup — a file of
 * plausible size that fails only on the day it is needed. Above
 * FULL_VERIFY_MAX_BYTES this stops at the header check and says so, rather
 * than being the thing that exhausts the wasm heap during a routine backup.
 */
async function verifyBackupFileDeep(file) {
  const shallow = verifyBackupFile(file);
  if (!shallow.ok) return shallow;
  if (shallow.size > FULL_VERIFY_MAX_BYTES) return shallow;
  try {
    const SQL = await require("sql.js")();
    const db = new SQL.Database(fs.readFileSync(file));
    try {
      for (const t of ["firms", "sale_invoices", "items"]) {
        const stmt = db.prepare(`SELECT COUNT(*) FROM ${t}`);
        try { stmt.step(); } finally { stmt.free(); }
      }
    } finally { db.close(); }
    return { ok: true, depth: "read", size: shallow.size };
  } catch (e) {
    return { ok: false, error: "it cannot be opened as a database: " + String(e && e.message || e) };
  }
}

/* ── the restore itself ──────────────────────────────────────────────────── */

/**
 * Apply a candidate database, having already inspected and accepted it.
 *
 * The caller holds the write lock. This function is the sequence that makes a
 * restore survivable:
 *
 *   flush → verified safety copy → snapshot the live schema → atomic swap →
 *   run the schema migrations forward → prove the result reads → record it.
 *
 * If the proof fails the safety copy goes straight back, so a restore that
 * cannot work leaves the shop exactly where it started rather than in a
 * database the app cannot use.
 */
async function applyRestore(buf, { user, source }) {
  if (inTransaction()) {
    throw Object.assign(new Error("A sale is being recorded at this moment. Wait a few seconds and restore again."), { status: 409 });
  }

  persist();                             // the safety copy must include everything written so far
  const safety = await keepSafetyCopy(); // throws if it cannot be taken or cannot be read back
  const safetyPath = path.join(BACKUP_DIR, safety);
  const before = await liveSchema();

  replaceDatabase(buf);            // parses first, writes atomically, then swaps

  /* An older backup is missing the columns added since it was taken. This is
     the same migration the app runs at boot against the same file, so it is not
     new machinery — it is the thing that would have happened at the next
     restart, run now instead of leaving the app broken until then. */
  let migrationError = null;
  try { await require("../../database/setup").setup(); }
  catch (e) { migrationError = e; }

  const problem = migrationError ? migrationError.message : await verifyRestored(before);
  if (problem) {
    /* Put it back. The safety copy was read-verified before we started, so this
       path is the one thing here that is known to work. */
    try { replaceDatabase(fs.readFileSync(safetyPath)); }
    catch (e) {
      throw new Error(
        "The backup could not be used (" + problem + "), and putting the previous data back also failed (" + e.message + "). " +
        "The previous data is still on this machine at " + safetyPath + ". Do not use the app until someone has looked at it.");
    }
    throw Object.assign(new Error(
      "That backup could not be used: " + problem + ". Your data has been put back exactly as it was."), { status: 400 });
  }

  await recordRestore({ user, source, safety, size: buf.length });
  persist();
  return { safety_copy: safety };
}

/**
 * Is the restored database one this build can actually work with?
 *
 * Not a checksum — a check that every table and column the running code was
 * using a moment ago is still there, plus a read of the tables the first screen
 * touches. This is what turns "the file loaded" into "the app works".
 */
async function verifyRestored(before) {
  let now;
  try { now = await liveSchema(); } catch (e) { return "the restored database cannot be read (" + e.message + ")"; }

  const missingTables = [...before.keys()].filter((t) => !now.has(t));
  if (missingTables.length) return `it is missing ${missingTables.length} table(s), including ${missingTables[0]}`;
  for (const [t, cols] of before) {
    const have = now.get(t);
    for (const c of cols) if (!have.has(c)) return `it is missing the column ${t}.${c}`;
  }
  try {
    for (const t of ["firms", "users", "items", "parties", "sale_invoices", "chart_of_accounts"]) {
      await query(`SELECT COUNT(*) c FROM ${t}`);
    }
    if (!(await query("SELECT COUNT(*) c FROM firms")).rows[0].c) return "it contains no business at all";
    if (!(await query("SELECT COUNT(*) c FROM users")).rows[0].c) return "it contains no users, so nobody could sign in again";
  } catch (e) { return "the restored database cannot be queried (" + e.message + ")"; }
  return null;
}

/**
 * Who restored what, when, and from where — written into the *restored*
 * database, which is the only copy that survives the operation.
 *
 * Before this, a restore left no trace anywhere. A shopkeeper phoning to say
 * "everything from last week has gone" could not be told whether someone had
 * restored an old backup or whether the data had never been saved, and those
 * two have opposite remedies.
 */
const HISTORY_FILE = path.join(path.dirname(DB_PATH), "restore-history.log");

async function recordRestore({ user, source, safety, size }) {
  const entry = {
    at: new Date().toISOString(),
    by: (user && (user.username || user.full_name)) || "unknown",
    source, size_bytes: size, safety_copy: safety,
    app_version: appVersion.version(),
  };
  try {
    await query("INSERT INTO audit_logs (user_id, module, action, detail) VALUES (?,?,?,?)",
      [(user && user.id) || null, "system", "restore", JSON.stringify(entry)]);
  } catch (e) { console.error("restore not recorded in the database:", e.message); }
  /* And in a file beside the database, because the database is the thing that
     was just replaced. A row written into the restored file is a record of this
     restore only — the restore before it went into the copy that was overwritten
     and is gone. A restore that keeps being repeated with the wrong file is
     exactly the situation where the *sequence* is what someone needs to see. */
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n"); }
  catch (e) { console.error("restore not recorded on disk:", e.message); }
}

/** The last 20 restores, newest first — from the file that survives them. */
async function restoreHistory() {
  const seen = [];
  try {
    const lines = fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean).slice(-20).reverse();
    for (const l of lines) { try { seen.push(JSON.parse(l)); } catch { /* a half-written line */ } }
  } catch { /* no restore has ever happened here */ }
  if (seen.length) return seen;
  /* Fall back to the row inside the database, for an installation whose file
     was lost or which restored a backup taken elsewhere. */
  try {
    return (await query(
      `SELECT a.created_at, a.detail, (SELECT username FROM users WHERE id = a.user_id) AS username
         FROM audit_logs a WHERE a.module='system' AND a.action='restore' ORDER BY a.id DESC LIMIT 20`
    )).rows.map((r) => {
      let d = {};
      try { d = JSON.parse(r.detail || "{}"); } catch { /* hand-written row */ }
      return { at: d.at || r.created_at, by: r.username || d.by || "unknown",
        source: d.source || "—", size_bytes: d.size_bytes || 0,
        safety_copy: d.safety_copy || null, app_version: d.app_version || null };
    });
  } catch { return []; }
}

/** Stamp the build that took this backup, so a future restore can say so. */
async function stampBackupVersion() {
  try {
    const v = appVersion.version();
    const have = (await query("SELECT detail FROM audit_logs WHERE module='system' AND action='backup-version' ORDER BY id DESC LIMIT 1")).rows[0];
    /* Only when it changes. A write per download would put a row — and an
       export of the whole database — behind every click of a read-only
       button. */
    if (have && have.detail === v) return;
    await query("DELETE FROM audit_logs WHERE module='system' AND action='backup-version'");
    await query("INSERT INTO audit_logs (user_id, module, action, detail) VALUES (NULL,'system','backup-version',?)", [v]);
  } catch { /* a stamp is a nicety; never fail a backup over it */ }
}

module.exports = {
  BACKUP_DIR, BACKUP_KEEP, SAFETY_KEEP,
  inspectBackup, multiTenantRefusal, liveFirms, operatorOverride,
  applyRestore, keepSafetyCopy, verifyBackupFile, verifyBackupFileDeep,
  restoreHistory, stampBackupVersion, looksLikeSqlite,
};
