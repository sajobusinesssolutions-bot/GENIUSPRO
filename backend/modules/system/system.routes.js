/**
 * system.routes.js — backup & restore of the SQLite file.
 *
 * Backup: streams a consistent snapshot of the DB file for download.
 * Restore: accepts a previous backup, checks it is one of ours and one this
 *          build can use, keeps a verified way back, and swaps the file with
 *          every other writer excluded.
 *
 * ── why a whole-file restore is refused on a multi-firm installation ───────
 *
 * `firm_id` is threaded through 60 tables and this app is genuinely
 * multi-tenant: one file, several businesses. Restore replaced the whole file,
 * which means firm B's admin restoring firm B's own backup deleted firm A. That
 * was measured before this change, not inferred: with two firms in one
 * database, firm B created an item, firm A restored a backup taken a moment
 * earlier, and firm B's item count went 1 → 0. Firm A never asked to touch firm
 * B and was never told it had.
 *
 * There were two ways out, and the choice is a product decision.
 *
 *   (a) Make restore firm-scoped: delete this firm's rows and re-import them
 *       from the backup, leaving other firms alone.
 *   (b) Keep restore as whole-file, and refuse it outright when the file holds
 *       more than one firm — leaving that case to whoever runs the server.
 *
 * (b) is implemented. (a) is the better *feature* and the wrong thing to build
 * here. A firm-scoped import has to delete and re-insert across 60 tables in
 * dependency order, renumber every primary key that collides with a surviving
 * firm's rows, and re-point every foreign key that referenced the old numbers —
 * including the ones this schema does not declare. Every one of those is a
 * chance to leave a shop's books referring to another shop's rows, and the bug
 * would be silent: an invoice line pointing at the wrong item still renders. A
 * restore path with that much machinery in it is a worse last line of defence
 * than one that says no. Restore's job is to be trusted absolutely on the
 * single-firm installation every real shop actually runs; the multi-firm case
 * belongs to an operator who can see all the firms and take a copy of each
 * first, and who gets `GENIUS_ALLOW_WHOLE_FILE_RESTORE=1` to say so deliberately.
 *
 * If per-firm restore is wanted as a feature, it should be built as a per-firm
 * *export and import* with its own tests, not bolted onto the button people
 * press when everything has already gone wrong.
 */
const fs = require("fs");
const appVersion = require("../../shared/version");
const express = require("express");
const router = express.Router();
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const path = require("path");
const { DB_PATH, persist, query, pool, dbSizeBytes, hosted } = require("../../database/db");
const backups = require("./backup.service");
const fresh = require("./startfresh.service");
const offsite = require("./offsite.service");
const cloud = require("./cloud.service");
const firmexport = require("./firmexport.service");
const firmrestore = require("./firmrestore.service");

const { BACKUP_DIR, BACKUP_KEEP } = backups;

/** Auto-backup: copy the DB, keep the last 7 days that the app actually ran.
 *
 * A copy is taken at boot and every 24h after, so a day the shop never opened
 * the app has no copy and never will — the list is "the last 7 kept", not "the
 * last 7 days". The listing below reports the dates it holds and the gaps, so
 * the screen can say which it is rather than implying an unbroken run.
 *
 * It takes the write lock. persist() declines to export while a transaction is
 * open (db.js), so the old version could quietly copy a file that was missing
 * the writes made since the transaction began — a backup a day older than it
 * claimed, with nothing said. Holding the lock means there is no transaction to
 * be inside: the copy is of a file that is complete as of the moment it was
 * taken. Then it opens the copy and reads from it, because a backup nobody has
 * ever opened is a guess. */
async function autoBackup() {
  const conn = await pool.getConnection();
  let dest = null;
  try {
    persist();
    if (!fs.existsSync(DB_PATH)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `auto-${new Date().toISOString().slice(0, 10)}.db`;
    dest = path.join(BACKUP_DIR, name);
    fs.copyFileSync(DB_PATH, dest);
    /* Prune by date, oldest first — the names sort chronologically because they
       are ISO dates, and one file per day means the count is the age. */
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error("auto-backup failed:", e.message);
    return;
  } finally { conn.release(); }

  /* Outside the lock: reading the copy back does not need to hold the tills up,
     and a copy that turns out to be unreadable must not be left in the list
     looking like something the shop could fall back on. */
  const v = await backups.verifyBackupFileDeep(dest);
  if (!v.ok) {
    console.error(`*** Today's automatic backup could not be read back (${v.error}). It has been removed rather than left looking usable. Check the disk. ***`);
    try { fs.unlinkSync(dest); } catch { /* already gone */ }
  }
}
/* Both of these copy THE database file — one file, the shop's whole
 * installation. With storage split there is no such file: there is a central
 * one holding no books and a file per company, and a "backup" of the central
 * one would restore an installation with every shop's data missing while
 * looking, in the list, exactly like a backup.
 *
 * So they do not run in that mode, and the log says so rather than leaving a
 * shop believing in copies nobody is taking. The per-company equivalent
 * already exists as far as the manual export goes (session five's
 * `firmexport`); scheduling it per company is named in the session report as
 * the next piece of this, and is deliberately not faked here.
 */
/* Also off when the books are hosted. There is no database file on this
   computer to copy at all then, so the timer would take a copy of nothing
   every day and the list would fill with backups that restore an empty
   shop. A hosted database is backed up by whoever hosts it — the Sync
   screen says so, and per-company exports still work. */
const wholeFileBackups = process.env.SPLIT_STORAGE !== "1" && !hosted();
if (wholeFileBackups) {
  /* `.catch` on both: a backup that throws must be logged, not left as an
     unhandled rejection that ends the process at five seconds past boot. */
  setTimeout(() => {
    autoBackup().then(async () => await offsite.copyOffsite({ reason: "startup" }))
      .catch((e) => console.error("startup backup failed:", e && e.message));
  }, 5000);
  setInterval(() => {
    autoBackup().then(async () => await offsite.copyOffsite({ reason: "daily" }))
      .catch((e) => console.error("daily backup failed:", e && e.message));
  }, 24 * 60 * 60 * 1000);
} else if (hosted()) {
  console.warn(
    "Automatic whole-file backups are OFF: this installation's books are on a hosted\n" +
    "database, so there is no database file on this computer to copy. Backups are the\n" +
    "hosting provider's — check that point-in-time restore is switched on there.\n" +
    "Per-company copies still work: Companies → the business → Download a copy.");
} else {
  console.warn(
    "Automatic whole-file backups are OFF: storage is split into one file per company,\n" +
    "and a copy of the central file would not contain any company's books.\n" +
    "Take per-company copies from Companies → the business → Download a copy until\n" +
    "the scheduled per-company backup is built.");
}

/* The off-site copy runs on its own, much shorter, clock.
 *
 * 24 hours is the right cadence for a destination that is always there. A USB
 * stick is there for the ten minutes somebody has it in the machine, and a
 * daily timer will miss those ten minutes for weeks running. So the copy is
 * *attempted* every quarter of an hour and *taken* at most once a day: an
 * attempt that finds nothing plugged in costs one stat call and stops, and the
 * day the stick does appear, the day's copy is on it before it comes out again.
 * copyOffsite never throws — a stick must not be able to break the local
 * backup or the process. */
if (wholeFileBackups) setInterval(() => {
  /* Caught here rather than left to float: nothing holds the promise a timer
     callback returns, and an unhandled rejection ends the process. */
  offsite.copyOffsite({ reason: "scheduled" })
    .catch((e) => console.error("off-site copy failed:", e && e.message));
}, offsite.OFFSITE_POLL_MS);

/* Whatever the interface could not survive.
 *
 * The screen going blank used to leave nothing behind anywhere: no message on
 * the page, nothing in the black window, nothing in the log. This is the other
 * half of the root error boundary — the browser posts what broke, and it lands
 * where support already asks people to look.
 *
 * Deliberately open: an error happens before sign-in as often as after, and a
 * crash report that requires a working session is a crash report you never get
 * for the crashes that matter most. It writes to the log and nothing else, and
 * is capped so a render loop cannot fill a disk.
 */
let clientErrors = 0;
router.post("/client-error", express.json({ limit: "16kb" }), (req, res) => {
  if (clientErrors++ < 200) {
    const b = req.body || {};
    console.error(
      `interface ${b.kind || "error"} at ${b.url || "?"}: ${b.message || "(no message)"}` +
      (b.stack ? "\n" + String(b.stack).split("\n").slice(0, 8).join("\n") : ""));
  }
  /* 204 whatever happens: the page is already broken, and an error about the
     error report helps nobody. */
  res.status(204).end();
});

router.use(verifyToken);

/* ── how a backup arrives ────────────────────────────────────────────────────
 *
 * A database is binary. Sending it as base64 inside a JSON body inflates it by
 * a third and then meets `express.json({ limit: "50mb" })` in server.js, so a
 * shop whose file is over about 37 MB — a few years of ordinary trading — got a
 * bare 413 from the body parser before any of this code ran, and in production
 * the error handler turns that into "Something went wrong. Reference: k3f9a2".
 * No mention of size, nothing to act on, at the exact moment someone is trying
 * to recover their books. Measured: a 45 MB payload returns 413 "request entity
 * too large".
 *
 * So these two routes take the file as a raw binary body, at a limit that is
 * the app's own ceiling rather than an arbitrary one. The base64 form is still
 * accepted for anything that already speaks it, and the message below explains
 * the limit when it is hit here.
 */
const RAW_LIMIT = "1200mb";
const rawBackupBody = express.raw({
  type: ["application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"],
  limit: RAW_LIMIT,
});

/** The candidate database, however it was sent. */
function candidateBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body.length ? req.body : null;
  const b64 = (req.body || {}).data;
  if (!b64) return null;
  const buf = Buffer.from(String(b64), "base64");
  return buf.length ? buf : null;
}

/* Download a copy of the database.
 *
 * Same mechanism as the auto-backup above: persist() flushes pending writes and
 * renames a complete file into place, then a single copyFileSync takes a
 * snapshot and we stream *that*. Streaming DB_PATH directly would read the live
 * file for as long as the download takes, and a save landing mid-stream swaps
 * the file underneath — the far end would get half of one database and half of
 * another. The snapshot cannot move.
 *
 * It is written beside the DB (same filesystem) under a dotted name outside
 * backups/, so it never appears in the auto-backup list, and is removed once
 * the response is finished. */
router.get("/backup", requirePermission("settings", "edit"), async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const tmp = path.join(path.dirname(DB_PATH), `.download-${process.pid}-${Date.now()}.db`);
  /* The write lock, for the same reason the auto-backup takes it: persist()
     declines while a transaction is open, and a snapshot taken then is silently
     out of date. */
  const conn = await pool.getConnection();
  try {
    await backups.stampBackupVersion(); // so a future restore can say which build wrote this
    persist();                     // flush any pending writes first
    fs.copyFileSync(DB_PATH, tmp); // consistent snapshot — what we send cannot change
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return await res.fail("Could not prepare the backup: " + e.message);
  } finally { conn.release(); }

  /* Prove the bytes we are about to hand over are a database that opens. The
     shop is being told "here is your safety copy"; that sentence should be
     true before it is said, not on the day they need it. */
  const v = await backups.verifyBackupFileDeep(tmp);
  if (!v.ok) {
    try { fs.unlinkSync(tmp); } catch {}
    return await res.fail("The backup was written but could not be read back (" + v.error + "), so it has not been sent. Check the disk on this machine.", 500);
  }

  const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", fs.statSync(tmp).size);
  res.setHeader("Content-Disposition", `attachment; filename="genius-backup-${stamp}.db"`);
  const stream = fs.createReadStream(tmp);
  stream.on("error", () => { cleanup(); res.destroy(); });
  res.on("close", cleanup);
  stream.pipe(res);
});

/* Inspect a backup WITHOUT applying it — so nobody restores blind.
 *
 * This used to accept any SQLite file whatsoever: an 8 KB database whose only
 * table was `not_genius` previewed as "0 invoices, 0 parties, 0 items" and the
 * Restore button was then offered. The checks now live in backup.service.js and
 * are the same ones /restore applies, so a preview that says yes is a preview
 * the restore will honour, and a preview that says no explains why. */
router.post("/restore/preview", requirePermission("settings", "edit"), rawBackupBody, async (req, res, next) => {
  try {
    const buf = candidateBuffer(req);
    if (!buf) return await res.fail("No backup data provided");

    const looked = await backups.inspectBackup(buf);
    if (!looked.ok) return await res.fail(looked.error);

    const refusal = await backups.multiTenantRefusal(looked.firms);

    // what's live right now, for a side-by-side comparison
    const live = {
      invoices: (await query("SELECT COUNT(*) n FROM sale_invoices WHERE firm_id=?", [req.user.firm_id])).rows[0].n,
      parties: (await query("SELECT COUNT(*) n FROM parties WHERE firm_id=?", [req.user.firm_id])).rows[0].n,
      items: (await query("SELECT COUNT(*) n FROM items WHERE firm_id=?", [req.user.firm_id])).rows[0].n,
      last_invoice_no: ((await query("SELECT invoice_no FROM sale_invoices WHERE firm_id=? ORDER BY id DESC LIMIT 1", [req.user.firm_id])).rows[0] || {}).invoice_no || "—",
      firm_count: (await backups.liveFirms()).length,
    };
    /* `restorable` is the whole point of a preview: the screen must not offer a
       button that the next request is going to refuse. */
    res.success({
      backup: looked.summary,
      live,
      warnings: looked.warnings,
      restorable: !refusal,
      blocked_reason: refusal || null,
    });
  } catch (err) { next(err); }
});

/**
 * Apply a backup.
 *
 * Everything difficult about this is in backup.service.js. What happens here is
 * the ordering, and the ordering is the safety:
 *
 *   1. take the write lock, so no sale, payment or stock movement can be
 *      running. The old code took nothing: it rewrote the file and reloaded
 *      while a commit was in flight, so a sale either landed in a database that
 *      no longer existed or its own persist() wrote the pre-restore database
 *      back over the restored one. The till was told "saved" either way.
 *   2. inspect and refuse *before* anything on disk is touched.
 *   3. hand over to applyRestore, which keeps a read-verified safety copy, swaps
 *      atomically, migrates an older schema forward, proves the result is
 *      usable, and puts the old data straight back if it is not.
 */
router.post("/restore", requirePermission("settings", "edit"), rawBackupBody, async (req, res, next) => {
  const buf = candidateBuffer(req);
  if (!buf) return await res.fail("No backup data provided");

  const conn = await pool.getConnection();
  try {
    const looked = await backups.inspectBackup(buf);
    if (!looked.ok) return await res.fail(looked.error);

    const refusal = await backups.multiTenantRefusal(looked.firms);
    if (refusal) return await res.fail(refusal, 409);

    const out = await backups.applyRestore(buf, {
      user: req.user,
      source: (req.query.filename && String(req.query.filename).slice(0, 120)) || "uploaded file",
    });
    return res.success({ ok: true, ...out }, "Backup restored");
  } catch (err) {
    if (err && err.status) return await res.fail(err.message, err.status);
    return next(err);
  } finally { conn.release(); }
});

/* What has been restored into this database, and by whom.
 *
 * A restore used to leave no trace at all, in any file. "Everything from last
 * week has gone" and "someone put an old backup back on Tuesday" look identical
 * from the outside and have opposite remedies. */
router.get("/restore-log", requirePermission("settings", "view"), async (req, res) => {
  res.success({
    entries: await backups.restoreHistory(),
    /* The screen says this out loud: every automatic copy is on the same disk
       as the live data, so one disk failure takes all of them together. */
    backups_are_local: true,
    backup_dir: BACKUP_DIR,
    db_size: dbSizeBytes(),
    firm_count: (await backups.liveFirms()).length,
    whole_file_restore_allowed: (await backups.liveFirms()).length <= 1 || backups.operatorOverride(),
  });
});

/* ── Cloud copy ───────────────────────────────────────────────────────────
 *
 * Uploading and downloading a company's books, through the licence server the
 * installation already talks to. The service holds the argument for why this
 * is a copy and a handover rather than live replication; these routes are the
 * three things a person does with it.
 *
 * `settings.edit` on all three, and not by inheritance: uploading exposes a
 * shop's entire books to whoever holds the licence key, and downloading
 * replaces them. Neither is something a cashier does.
 */
router.get("/cloud", requirePermission("settings", "edit"), async (req, res, next) => {
  try { res.success(await cloud.status(req.user.firm_id)); }
  catch (err) { next(err); }
});

router.post("/cloud/upload", requirePermission("settings", "edit"), async (req, res, next) => {
  try {
    const out = await cloud.upload({
      firmId: req.user.firm_id,
      exportFirm: firmexport.exportFirm,
      force: !!(req.body || {}).force,
      userId: req.user.id,
    });
    /* A refusal is an answer, not a fault: the screen shows what would have
       been overwritten and offers the override. 409 rather than 400 because
       the request was well formed and the state is what refused it. */
    if (!out.ok) return res.status(409).json({ success: false, message: out.why, errors: out });
    res.success(out, "Your books are on the server");
  } catch (err) {
    if (err && err.status) return await res.fail(err.message, err.status);
    next(err);
  }
});

router.post("/cloud/download", requirePermission("settings", "edit"), async (req, res, next) => {
  try {
    const out = await cloud.download({
      firmId: req.user.firm_id,
      restoreFirm: firmrestore.restoreFirm,
      force: !!(req.body || {}).force,
      userId: req.user.id,
    });
    if (!out.ok) return res.status(409).json({ success: false, message: out.why, errors: out });
    res.success(out, "Your books have been brought back from the server");
  } catch (err) {
    if (err && err.status) return await res.fail(err.message, err.status);
    next(err);
  }
});

/* ── the audit log ────────────────────────────────────────────────────────
 *
 * Twenty-five places in this codebase write to `audit_logs`. Until now nothing
 * read it. Every void, every price change, every deleted invoice, every
 * restore has been recorded faithfully into a table with no screen — which is
 * the same, from the shopkeeper's chair, as not recording it at all. The first
 * time it is wanted is the morning the till is short and somebody needs to
 * know who voided what.
 *
 * Read-only, and deliberately so: an audit log a user can edit is not one.
 * There is no delete route and no update route, here or anywhere.
 *
 * Scoped to the caller's own company through `users.active_firm_id`, because
 * the log itself has no firm column — it was written before the app held more
 * than one business, and adding one now would leave every existing row
 * unattributed. Joining through the user who did it is both correct and
 * honest about what is actually known.
 */
router.get("/audit", requirePermission("settings", "view"), async (req, res) => {
  const firm = req.user.firm_id;
  const q = String(req.query.q || "").trim();
  const mod = String(req.query.module || "").trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100));
  const page = Math.max(1, Number(req.query.page) || 1);

  const where = ["u.active_firm_id = ?"];
  const args = [firm];
  if (mod) { where.push("a.module = ?"); args.push(mod); }
  if (from) { where.push("date(a.created_at) >= date(?)"); args.push(from); }
  if (to) { where.push("date(a.created_at) <= date(?)"); args.push(to); }
  if (q) {
    where.push("(a.detail LIKE ? OR a.action LIKE ? OR u.username LIKE ? OR u.full_name LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const sql = where.join(" AND ");

  const total = (await query(
    `SELECT COUNT(*) n FROM audit_logs a JOIN users u ON u.id = a.user_id WHERE ${sql}`, args)).rows[0].n;
  const rows = (await query(
    `SELECT a.id, a.module, a.action, a.entity_id, a.detail, a.created_at,
            u.username, COALESCE(u.full_name, u.username) AS who
       FROM audit_logs a JOIN users u ON u.id = a.user_id
      WHERE ${sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...args, limit, (page - 1) * limit])).rows;

  /* The module list comes from what is actually in the log, not from a list
     written here — a filter offering a module nothing ever wrote to is a
     filter that returns nothing and looks broken. */
  const modules = (await query(
    `SELECT DISTINCT a.module FROM audit_logs a JOIN users u ON u.id = a.user_id
      WHERE u.active_firm_id = ? AND a.module IS NOT NULL ORDER BY a.module`, [firm]
  )).rows.map((r) => r.module);

  res.success({ rows, total, pages: Math.max(1, Math.ceil(total / limit)), page, limit, modules });
});

/* ── the second destination ──────────────────────────────────────────────────
 *
 * Where the off-site copy goes, and — the part that actually matters — whether
 * the shop is protected right now. "Backups are local" was a true sentence with
 * nothing behind it; this is the sentence with a date on it.
 */
router.get("/offsite", requirePermission("settings", "view"), async (req, res) => {
  res.success(await offsite.offsiteStatus(req.user.firm_id));
});

/* Save the destination. The path is checked here rather than at the next
   scheduled attempt: a typo found on the screen costs ten seconds, and a typo
   found by the copier costs however many weeks pass before anyone looks. */
router.put("/offsite", requirePermission("settings", "edit"), async (req, res) => {
  const saved = await offsite.saveConfig(req.user.firm_id, req.body || {});
  if (!saved.ok) return await res.fail(saved.message);
  persist();
  /* Try it immediately. Being told "saved" and being told "and there is now a
     copy of everything on that drive" are different sentences, and the second
     is the one somebody came here for. */
  const attempt = (req.body || {}).enabled
    ? await offsite.copyOffsite({ firmId: req.user.firm_id, force: true, reason: "settings saved" })
    : { status: "off" };
  res.success({ ...await offsite.offsiteStatus(req.user.firm_id), attempt }, "Off-site copy settings saved");
});

/* Prove it works now, rather than finding out tomorrow that the drive letter
   was wrong. Forces a copy even if today's is already there. */
router.post("/offsite/test", requirePermission("settings", "edit"), async (req, res) => {
  const cfg = await offsite.config(req.user.firm_id);
  if (!cfg.enabled || !cfg.dir) return await res.fail("Set a folder for the off-site copy first.");
  const attempt = await offsite.copyOffsite({ firmId: req.user.firm_id, force: true, reason: "tested by hand" });
  const status = await offsite.offsiteStatus(req.user.firm_id);
  if (attempt.status === "error") return await res.fail(attempt.message);
  if (attempt.status === "waiting") return await res.fail(attempt.message + " Plug it in and try again.");
  res.success({ ...status, attempt }, attempt.message);
});

/* A file too large for the raw body limit, said in words.
 *
 * This catches the raw parser's own 413. It cannot catch the one thrown by
 * `express.json({ limit: "50mb" })` in server.js, which runs before any router
 * — that is why the Backup screen now uploads binary rather than base64. */
router.use(async (err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return await res.fail(
      `That file is larger than this app can accept in one request (${RAW_LIMIT}). ` +
      "A database that size is past what this app can hold at all — ask whoever set the system up to look at it.", 413);
  }
  return next(err);
});

/* App + environment info for Settings → About & updates */
function lanIp() {
  try {
    const nets = require("os").networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name]) {
        if (n.family === "IPv4" && !n.internal) return n.address;
      }
    }
  } catch {}
  return null;
}

router.get("/info", (req, res) => {
  let dbSize = 0;
  try { dbSize = fs.statSync(DB_PATH).size; } catch {}
  res.success({
    app: "Genius POS",
    version: appVersion.version(),
    node: process.version,
    platform: process.platform,
    db_size: dbSize,
    lan_ip: lanIp(),
    port: process.env.PORT || 3000,
    update_howto: [
      "1. Download the new genius-pos.zip from SALJO TECH.",
      "2. Close the app window (and the black server window).",
      "3. Run update.bat next to start.bat and pick the downloaded zip.",
      "4. Your data (backend/data) is kept — only program files are replaced.",
    ],
  });
});

/* List the copies held on this machine.
 *
 * Each entry carries the day it covers, when the file was written and whether
 * the day before it also has a copy, so the screen can say "3 kept, on
 * 4, 6 and 11 August" instead of promising seven consecutive days. Still an
 * array, because that is what the Backup screen reads.
 *
 * `kind` was added with the timestamped safety copies. A file named
 * `pre-restore-…` is the state of the books immediately before somebody
 * restored, and it is the single most valuable thing in this folder on the day
 * a restore turns out to have been the wrong one — it must not be listed as an
 * anonymous "made by hand" copy that nobody recognises. */
/* ── Start fresh ─────────────────────────────────────────────────────────
 *
 * A shop that bought a demonstration copy, or an installation that shipped
 * with somebody else's test trading in it, had no way to get to a clean set
 * of books but to find a file in AppData and delete it. This is that, done
 * safely: a verified safety copy first, one transaction, and the walk-in
 * customer left alone because the till cannot ring a sale without it.
 *
 * GET says what would go. POST does it, and only if the caller types the
 * business name back — the same confirmation the delete-company path asks
 * for, because this is nearly as final.
 */
router.get("/start-fresh", requirePermission("settings", "edit"), async (req, res) => {
  const firmId = req.user.firm_id;
  const firm = (await query("SELECT name FROM firms WHERE id = ?", [firmId])).rows[0] || {};
  res.success({
    firm: firm.name || "",
    trading: await fresh.preview(query, firmId, {}),
    withCatalogue: await fresh.preview(query, firmId, { alsoCatalogue: true }),
  });
});

router.post("/start-fresh", requirePermission("settings", "edit"), async (req, res, next) => {
  const firmId = req.user.firm_id;
  const b = req.body || {};
  const firm = (await query("SELECT name FROM firms WHERE id = ?", [firmId])).rows[0] || {};
  if (String(b.confirm || "").trim() !== String(firm.name || "").trim()) {
    return await res.fail("Type the business name exactly to confirm", 400);
  }
  /* Not offered — taken. This is the one button in the product that destroys
     a year of trading, and it is no place to trust that the dialog was read. */
  let safety = null;
  try {
    safety = await backups.keepSafetyCopy();
  } catch (e) {
    return await res.fail("Could not take a safety copy first, so nothing was emptied: " + e.message, 500);
  }
  return await durable(next, async (conn) => {
    const r = await fresh.startFresh(conn, firmId, {
      alsoCatalogue: !!b.alsoCatalogue,
      alsoTaxRules: !!b.alsoTaxRules,
      reopenSetup: b.reopenSetup !== false,
    });
    return () => res.success({
      ok: true, safety, tables: r.wiped,
      message: "The books are empty. The setup wizard will run when you sign in again.",
    });
  });
});

router.get("/backups", requirePermission("settings", "view"), (req, res) => {
  let files = [];
  try {
    const names = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse();
    const dates = new Set(names.filter((f) => /^auto-/.test(f)).map((f) => (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean));
    files = names.map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      const day = (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
      const prev = day ? new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10) : null;
      const automatic = /^auto-/.test(f);
      const safety = /^pre-restore-/.test(f);
      return {
        name: f,
        size: st.size,
        day,
        taken_at: st.mtime.toISOString(),
        automatic,
        kind: automatic ? "daily" : safety ? "pre-restore" : "manual",
        /* True when the day before this one has no copy — the app was not run
           that day. Only meaningful for the daily series. */
        gap_before: automatic && day ? !dates.has(prev) : false,
        keep: BACKUP_KEEP,
      };
    });
  } catch {}
  res.success(files);
});

/* Restore one of the copies held on this machine.
 *
 * Exactly the same pipeline as /restore — lock, inspect, refuse, verified
 * safety copy, atomic swap, prove, record. It used to be its own three lines
 * with none of that, which meant the button the shopkeeper is most likely to
 * press was the one with the fewest guards behind it. */
router.post("/restore-file", requirePermission("settings", "edit"), async (req, res, next) => {
  const name = String((req.body || {}).name || "");
  if (!/^[\w-]+(\.[\w-]+)*\.db$/.test(name) || name.includes("..")) return await res.fail("Bad backup name");
  const src = path.join(BACKUP_DIR, name);
  /* Belt and braces on top of the pattern: the resolved path has to still be
     inside the backups folder. */
  if (path.dirname(path.resolve(src)) !== path.resolve(BACKUP_DIR)) return await res.fail("Bad backup name");
  if (!fs.existsSync(src)) return res.notFound("Backup not found");

  const conn = await pool.getConnection();
  try {
    const buf = fs.readFileSync(src);
    const looked = await backups.inspectBackup(buf);
    if (!looked.ok) return await res.fail(looked.error);

    const refusal = await backups.multiTenantRefusal(looked.firms);
    if (refusal) return await res.fail(refusal, 409);

    const out = await backups.applyRestore(buf, { user: req.user, source: name });
    return res.success({ ok: true, ...out }, "Backup restored");
  } catch (err) {
    if (err && err.status) return await res.fail(err.message, err.status);
    return next(err);
  } finally { conn.release(); }
});


/* ─────────── In-app updater ───────────
   Accepts a release .zip (the same bundle shipped for manual updates),
   backs up whatever it will overwrite, applies the new files, and logs
   the cycle. Business data (backend/data) and node_modules are never touched. */
const AdmZip = require("adm-zip");
const APP_ROOT = path.resolve(__dirname, "..", "..", "..");
const UPDATE_DIR = path.join(APP_ROOT, "updates");

function currentVersion() { return appVersion.version(); }
const SKIP = (rel) =>
  rel.includes("node_modules/") ||
  rel === "backend/data" || rel.startsWith("backend/data/") ||
  rel.endsWith(".db") || rel.includes(".db-") ||
  rel.startsWith("updates/");

/* What is running, for the About box. No permission gate: a user who can see
   the app is entitled to know which build they are looking at. */
router.get("/version", (req, res) => res.success(appVersion.manifest()));

/* Update history — the visible update cycle */
router.get("/updates", requirePermission("settings", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT u.*, (SELECT username FROM users WHERE id = u.applied_by) AS applied_by_name
       FROM app_updates u WHERE u.firm_id = ? ORDER BY u.id DESC LIMIT 50`,
    [req.user.firm_id]
  )).rows;
  res.success({ current_version: currentVersion(), history: rows });
});

/* Apply an uploaded release zip (raw body, Content-Type: application/zip) */
router.post("/update", requirePermission("settings", "edit"),
  express.raw({ type: ["application/zip", "application/octet-stream"], limit: "300mb" }),
  async (req, res) => {
    const firmId = req.user.firm_id;
    const filename = (req.query.filename || "update.zip").toString().slice(0, 120);
    const buf = req.body;
    if (!buf || !buf.length) return await res.fail("No file received — choose a .zip release file");

    const fail = async (msg) => {
      await query("INSERT INTO app_updates (firm_id, version_from, version_to, filename, size_bytes, status, note, applied_by) VALUES (?,?,?,?,?,?,?,?)",
        [firmId, currentVersion(), null, filename, buf.length, "failed", msg, req.user.id]);
      return await res.fail(msg);
    };

    let zip, entries;
    try { zip = new AdmZip(buf); entries = zip.getEntries(); }
    catch { return await fail("That file isn't a readable .zip archive"); }

    // find the folder inside the zip that holds backend/ (releases are wrapped in one folder)
    const names = entries.map((e) => e.entryName.replace(/\\/g, "/"));
    let prefix = "";
    if (!names.some((n) => n.startsWith("backend/"))) {
      const root = names.find((n) => /^[^/]+\/backend\//.test(n));
      if (!root) return await fail("This zip doesn't look like a release — no backend folder inside");
      prefix = root.split("/")[0] + "/";
    }
    const pkgEntry = entries.find((e) => e.entryName.replace(/\\/g, "/") === prefix + "backend/package.json");
    if (!pkgEntry) return await fail("This zip is missing backend/package.json — not a valid release");

    let newVersion = "?", newDeps = {};
    try { const pj = JSON.parse(zip.readAsText(pkgEntry)); newVersion = pj.version || "?"; newDeps = pj.dependencies || {}; }
    catch { return await fail("Could not read the version from the release"); }

    const oldVersion = currentVersion();
    let oldDeps = {};
    try { oldDeps = require(path.join(APP_ROOT, "backend", "package.json")).dependencies || {}; } catch {}
    const depsChanged = JSON.stringify(oldDeps) !== JSON.stringify(newDeps);

    // back up every file we are about to overwrite, so the update can be undone
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(UPDATE_DIR, "backup-" + stamp);
    let written = 0; const added = [];
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      for (const e of entries) {
        if (e.isDirectory) continue;
        const rel = e.entryName.replace(/\\/g, "/").slice(prefix.length);
        if (!rel || SKIP(rel)) continue;
        const target = path.join(APP_ROOT, rel);
        if (fs.existsSync(target)) {
          const bTarget = path.join(backupDir, rel);
          fs.mkdirSync(path.dirname(bTarget), { recursive: true });
          fs.copyFileSync(target, bTarget);
        } else added.push(rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, e.getData());
        written++;
      }
      fs.writeFileSync(path.join(backupDir, "__added.json"), JSON.stringify(added));
    } catch (err) {
      return await fail("Update failed while writing files: " + err.message);
    }

    const note = depsChanged
      ? "Dependencies changed — run update.bat (npm install) before restarting."
      : "Restart the app to finish.";
    await query("INSERT INTO app_updates (firm_id, version_from, version_to, filename, size_bytes, status, note, backup_dir, applied_by) VALUES (?,?,?,?,?,?,?,?,?)",
      [firmId, oldVersion, newVersion, filename, buf.length, "applied", note, backupDir, req.user.id]);

    res.success({ version_from: oldVersion, version_to: newVersion, files: written, deps_changed: depsChanged, restart_required: true, note }, `Updated to ${newVersion}`);
  });

/* Roll back a previous update from its backup */
router.post("/updates/:id/rollback", requirePermission("settings", "edit"), async (req, res, next) => {
  const row = (await query("SELECT * FROM app_updates WHERE id=? AND firm_id=?", [req.params.id, req.user.firm_id])).rows[0];
  if (!row) return await res.fail("Update not found", 404);
  if (!row.backup_dir || !fs.existsSync(row.backup_dir)) return await res.fail("The backup for this update is no longer on disk");
  let restored = 0, removed = 0;
  try {
    const manifest = path.join(row.backup_dir, "__added.json");
    if (fs.existsSync(manifest)) {
      for (const rel of JSON.parse(fs.readFileSync(manifest, "utf8"))) {
        const t = path.join(APP_ROOT, rel);
        if (fs.existsSync(t)) { fs.unlinkSync(t); removed++; }
      }
    }
  } catch {}
  const walk = (dir, base) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.join(base, name);
      if (name === "__added.json") continue;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else {
        const target = path.join(APP_ROOT, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        restored++;
      }
    }
  };
  try { walk(row.backup_dir, ""); } catch (e) { return await res.fail("Rollback failed: " + e.message); }
  /* The files are already back; the two rows that say so go together, and they
     go to disk before the operator is told to restart — a restart is exactly
     when an unflushed write is lost. */
  return await durable(next, async (conn) => {
    await conn.query("UPDATE app_updates SET status='rolled_back' WHERE id=?", [row.id]);
    await conn.query("INSERT INTO app_updates (firm_id, version_from, version_to, filename, size_bytes, status, note, applied_by) VALUES (?,?,?,?,?,?,?,?)",
      [req.user.firm_id, row.version_to, row.version_from, row.filename, 0, "applied", `Rolled back update #${row.id}`, req.user.id]);
    return () => res.success({ restored, removed, version: row.version_from, restart_required: true }, `Rolled back to ${row.version_from}`);
  });
});

module.exports = router;
