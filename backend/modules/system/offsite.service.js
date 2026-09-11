/**
 * offsite.service.js — getting a copy of the books off this machine, onto a
 * USB stick or a folder on another machine, without anybody having to remember.
 *
 * Everything backup.service.js and the auto-backup do is on one disk.
 * `backups/auto-2026-08-18.db` sits beside `data/genius.db`: a dead drive, a
 * stolen laptop, a ransomware run or a spilt Fanta takes the books and all
 * seven copies of them in the same second. The Backup screen is honest about
 * that and offers a download, but a download is a thing somebody has to
 * remember, and the whole point of a backup is that it does not depend on
 * anyone remembering.
 *
 * So: one folder, configured once, that the app copies to by itself. From
 * Node's point of view a USB stick and a LAN share are the same thing — a
 * directory path — so there is no cloud, no credentials and no new dependency
 * here. What there is, is a set of decisions about a destination that is
 * usually *not there*.
 *
 * ── cadence ───────────────────────────────────────────────────────────────
 *
 * The local backup runs at boot and every 24 hours, which is right for a
 * destination that is always present. A USB stick is present for the ten
 * minutes somebody has it in the machine, and a 24-hour timer will miss those
 * ten minutes for weeks on end. So the off-site copy is *attempted* every
 * OFFSITE_POLL_MS (15 minutes) and at boot, and *taken* at most once per
 * calendar day per destination. An attempt that finds nothing plugged in costs
 * one fs.access and stops; the copy itself only happens when there is a stick
 * there and today's copy is not already on it. Plug the stick in over lunch and
 * the day's copy is on it before the stick comes out again.
 *
 * ── "not there" is normal, "not there for weeks" is not ───────────────────
 *
 * The stick is unplugged most of the time. Treating that as a failure would
 * fill the log with 96 errors a day and teach everyone to ignore it. It is
 * recorded as a skip, silently, and it does not touch the local backup.
 *
 * What is *not* normal is the answer to "when did a copy last leave this
 * machine". That question is answered from a file beside the database, so it
 * survives a restore and can still be read when the database itself is the
 * thing that has gone wrong, and the answer drives how loud the screen is:
 * fine, then uneasy after `offsite_warn_days`, then alarmed after
 * OFFSITE_ALARM_DAYS. Eighteen days of "not plugged in" is eighteen days of no
 * insurance, whatever the reason.
 *
 * The one place absence *is* an error: a destination we have never once written
 * to. A path that has never worked is a typo — a drive letter that was never
 * right, a share name spelled wrong — and saying "not connected at the moment"
 * about it would hide the mistake forever. Once a copy has landed there, the
 * same ENOENT means the stick is out.
 */
const fs = require("fs");
const path = require("path");
const { DB_PATH, persist, pool } = require("../../database/db");
const backups = require("./backup.service");
const settings = require("../settings/settings.service");
const { query } = require("../../database/db");

/** How often an attempt is made. The destination is usually absent, and an
    absent destination costs one stat call, so this can be frequent. */
const OFFSITE_POLL_MS = 15 * 60 * 1000;
/** Past this many days with no copy off the machine, the screen stops being
    polite about it regardless of what the shop set as its warning threshold. */
const OFFSITE_ALARM_DAYS = 21;
/** Headroom demanded on the destination on top of the file itself, so a copy
    never fills the last block of a stick that something else also needs. */
const SPACE_HEADROOM = 1.15;

/** Written beside the database, deliberately outside it — same reasoning as
    restore-history.log. The question this file answers ("is anything of mine
    anywhere else?") is asked most urgently when the database is unusable. */
const STATE_FILE = path.join(path.dirname(DB_PATH), "offsite-state.json");

const PREFIX = "genius-offsite-";
const TMP_PREFIX = ".genius-offsite-tmp-";

/* ── configuration ───────────────────────────────────────────────────────── */

/** The firm whose settings hold the destination. The copier runs on a timer
    with nobody signed in, and this is a per-machine choice living in a
    per-firm table; the installation a shop runs holds one firm. */
async function configFirmId(firmId) {
  if (firmId) return firmId;
  const f = (await backups.liveFirms())[0];
  return f ? f.id : null;
}

async function config(firmId) {
  const id = await configFirmId(firmId);
  if (!id) return { firm_id: null, enabled: false, dir: "", keep: 5, warn_days: 7 };
  const get = async (k) => await settings.getSetting(id, k);
  const keep = Math.max(1, Math.min(60, parseInt(await get("offsite_keep"), 10) || 5));
  const warn = Math.max(1, Math.min(90, parseInt(await get("offsite_warn_days"), 10) || 7));
  return {
    firm_id: id,
    enabled: String(await get("offsite_enabled")) === "1",
    dir: String(await get("offsite_path") || "").trim(),
    keep,
    warn_days: warn,
  };
}

/* ── the record of what has left this machine ────────────────────────────── */

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s && typeof s === "object") {
      s.destinations = s.destinations || {};
      s.events = Array.isArray(s.events) ? s.events : [];
      return s;
    }
  } catch { /* never run, or a half-written file — either way, start clean */ }
  return { destinations: {}, events: [] };
}

function writeState(s) {
  try {
    /* Written through a temp file: this is the record of where the only other
       copy is, and a torn write of it during a power cut would lose that. */
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error("off-site state not recorded:", e.message); }
}

function destKey(dir) { return path.resolve(dir); }

function destState(dir) {
  const s = readState();
  return s.destinations[destKey(dir)] || null;
}

/** Has a copy ever landed here? The difference between "unplugged" and
    "you typed the path wrong". */
function everSucceeded(dir) {
  const d = destState(dir);
  return !!(d && d.last_ok_at);
}

/** Note an outcome. Routine skips are recorded on the destination (so the
    screen can say when it last looked) but never appended to the event list —
    ninety-six "not plugged in" lines a day is how a log gets ignored. */
function record(dir, outcome) {
  const s = readState();
  const key = destKey(dir);
  const d = s.destinations[key] || { path: dir };
  d.path = dir;
  d.last_attempt_at = outcome.at;
  if (outcome.status === "ok") {
    d.last_ok_at = outcome.at;
    d.last_ok_file = outcome.file;
    d.last_ok_bytes = outcome.bytes;
    d.last_error = null;
    d.unreachable_since = null;
  } else if (outcome.status === "error") {
    d.last_error = { code: outcome.code, message: outcome.message, at: outcome.at };
  } else { // waiting — the destination simply is not here
    d.last_error = null;
    if (!d.unreachable_since) d.unreachable_since = outcome.at;
  }
  s.destinations[key] = d;
  /* The global "when did anything last leave this machine", across every
     destination the shop has ever used — changing sticks must not reset the
     clock on how long they have been unprotected. */
  if (outcome.status === "ok" && (!s.last_ok_at || outcome.at > s.last_ok_at)) {
    s.last_ok_at = outcome.at;
    s.last_ok_path = dir;
    s.last_ok_file = outcome.file;
  }
  if (outcome.status !== "waiting") {
    s.events.unshift({ at: outcome.at, status: outcome.status, path: dir,
      file: outcome.file || null, code: outcome.code || null, message: outcome.message, reason: outcome.reason });
    s.events = s.events.slice(0, 20);
  }
  writeState(s);
}

/* ── turning an errno into something a shopkeeper can act on ─────────────── */

/**
 * "EACCES" is not a sentence anybody can do anything with. Each of these is a
 * different physical thing that has happened to a stick or a share, and each
 * has a different next move.
 */
function explain(err, dir) {
  const code = (err && err.code) || "UNKNOWN";
  const where = dir;
  switch (code) {
    case "ENOENT":
      return { code, message:
        `The off-site folder ${where} cannot be found, and no copy has ever reached it. ` +
        "Check the drive letter (a USB stick does not always get the same one) and the folder name, then test it again." };
    case "ENOTDIR":
      return { code, message: `${where} is a file, not a folder. Point the off-site copy at a folder.` };
    case "ENOSPC":
      return { code, message:
        `The off-site drive is full, so today's copy could not be written to ${where}. ` +
        "Delete something on the drive, or use a larger one — the app keeps only the newest few copies there and it is still not enough." };
    case "EROFS":
      return { code, message:
        `The off-site drive is write-protected, so nothing can be saved to ${where}. ` +
        "Check the little lock switch on the side of the USB stick." };
    case "EACCES":
    case "EPERM":
      return { code, message:
        `Windows refused permission to write to ${where}. ` +
        "If that is a shared folder on another computer, that computer has to allow this one to write to it, not just read." };
    case "EBUSY":
    case "EIO":
    case "EXDEV":
      return { code, message:
        `The off-site drive reported a fault while writing to ${where} (${code}). ` +
        "The stick may be failing or it was pulled out mid-copy — try it again, and try a different stick if it happens twice." };
    case "ENAMETOOLONG":
      return { code, message: `That path is too long for Windows to write to: ${where}.` };
    case "EHOSTDOWN":
    case "ENETDOWN":
    case "ENETUNREACH":
    case "ETIMEDOUT":
      return { code, message:
        `The other computer holding ${where} did not answer. It may be switched off, or off the shop network.` };
    default:
      return { code, message:
        `The copy to ${where} failed (${code}${err && err.message ? ": " + err.message : ""}).` };
  }
}

/* ── space ───────────────────────────────────────────────────────────────── */

/** Free bytes on the filesystem holding `dir`, or null where the platform will
    not say. A 4 GB stick and a growing database is a foreseeable collision, and
    finding out by half-writing a file onto the only off-site copy the shop has
    is the worst way to discover it. */
function freeBytes(dir) {
  try {
    if (typeof fs.statfsSync !== "function") return null;
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

/* ── retention on the destination ────────────────────────────────────────── */

function offsiteCopies(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"))
      .sort();
  } catch { return []; }
}

/** Keep the newest `keep`, oldest deleted first. Returns how many went. */
function prune(dir, keep) {
  const files = offsiteCopies(dir);
  let removed = 0;
  while (files.length > keep) {
    try { fs.unlinkSync(path.join(dir, files.shift())); removed++; }
    catch { files.shift(); }
  }
  return removed;
}

/** Anything left behind by a copy that was interrupted — a pulled stick, a
    power cut. These are not backups and must never be counted as one. */
function sweepTemps(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(TMP_PREFIX)) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        if (Date.now() - st.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(path.join(dir, f));
      } catch { /* gone already */ }
    }
  } catch { /* the destination went away mid-sweep; the caller will notice */ }
}

/* ── the source of the copy ──────────────────────────────────────────────── */

/**
 * Something consistent to copy *from*.
 *
 * Preferably today's local automatic backup: it was taken under the write lock
 * and read back afterwards, so it is already known to be a complete database,
 * and using it means the off-site copy does not take the lock at all — no till
 * waits on a slow USB stick.
 *
 * If there is not one (the app has just started, or somebody pressed "Copy
 * now"), a snapshot is taken here the same way the download route does it:
 * lock, persist, one copyFileSync onto the local disk. The lock is held for a
 * local file copy only, never for the write to the stick.
 */
async function withSource(fn) {
  const today = path.join(backups.BACKUP_DIR, `auto-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(today) && backups.verifyBackupFile(today).ok) return fn(today);

  const tmp = path.join(path.dirname(DB_PATH), `.offsite-src-${process.pid}-${Date.now()}.db`);
  const conn = await pool.getConnection();
  try {
    persist();
    fs.copyFileSync(DB_PATH, tmp);
  } finally { conn.release(); }
  try { return await fn(tmp); }
  finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
}

/* ── the copy itself ─────────────────────────────────────────────────────── */

function todayName() { return `${PREFIX}${new Date().toISOString().slice(0, 10)}.db`; }

/**
 * Try to put a copy on the destination.
 *
 * Returns `{ status }` where status is one of:
 *   "off"     — nothing is configured; not an event
 *   "waiting" — the destination is not attached right now (the normal case)
 *   "current" — today's copy is already there and reads back
 *   "ok"      — a copy was written and read back
 *   "error"   — something the shopkeeper has to do something about
 *
 * Never throws. A failure to reach a USB stick must not be able to break the
 * daily local backup that calls this.
 */
async function copyOffsite({ firmId = null, force = false, reason = "scheduled" } = {}) {
  const cfg = await config(firmId);
  if (!cfg.enabled || !cfg.dir) return { status: "off", message: "No off-site copy is set up." };
  const dir = cfg.dir;
  const at = new Date().toISOString();

  /* 1. Is the destination there at all, and can we write to it? An unplugged
        stick stops here, having cost one stat. */
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    const known = everSucceeded(dir);
    if (known && (e.code === "ENOENT" || e.code === "EHOSTDOWN" || e.code === "ENETDOWN" || e.code === "ENETUNREACH" || e.code === "ETIMEDOUT")) {
      /* Been here before, gone now. This is the stick being out of the machine
         and it is the ordinary state of affairs — no log line, no error. */
      const out = { status: "waiting", at, reason,
        message: `The off-site drive is not connected at the moment (${dir}).` };
      record(dir, out);
      return out;
    }
    const ex = explain(e, dir);
    const out = { status: "error", at, reason, ...ex };
    record(dir, out);
    console.error("off-site copy:", ex.message);
    return out;
  }

  sweepTemps(dir);

  const name = todayName();
  const target = path.join(dir, name);

  /* 2. Today's copy may already be there — and having a file with the right
        name is not the same as having a backup, so it is read back before it
        is believed. */
  if (!force && fs.existsSync(target)) {
    const v = await backups.verifyBackupFileDeep(target);
    if (v.ok) {
      const out = { status: "current", at, reason, file: name,
        message: `Today's copy is already on ${dir}.` };
      record(dir, { ...out, status: "ok", bytes: v.size });
      return out;
    }
    /* It is there and it is not readable. That is worse than nothing, because
       it looks like insurance. Replace it. */
    try { fs.unlinkSync(target); } catch { /* about to be overwritten anyway */ }
  }

  return withSource(async (src) => {
    const size = fs.statSync(src).size;

    /* 3. Room? Prune first — the retention policy exists precisely so the
          stick does not fill — and only give up if it is still short. */
    let free = freeBytes(dir);
    if (free != null && free < size * SPACE_HEADROOM) prune(dir, Math.max(1, cfg.keep - 1));
    free = freeBytes(dir);
    if (free != null && free < size * SPACE_HEADROOM) {
      const mb = (n) => Math.round(n / 1048576).toLocaleString();
      const out = { status: "error", at, reason, code: "ENOSPC", message:
        `The off-site drive is full: ${mb(free)} MB free at ${dir} and a copy needs ${mb(size * SPACE_HEADROOM)} MB. ` +
        `The oldest copies there have already been deleted and it is still not enough — use a larger drive, or free space on this one.` };
      record(dir, out);
      console.error("off-site copy:", out.message);
      return out;
    }

    /* 4. Write to a temporary name and rename into place. A stick pulled
          half-way through then leaves a `.genius-offsite-tmp-…` file, which is
          swept above and is never mistaken for a backup — rather than a
          truncated `genius-offsite-2026-08-18.db` that looks like one. */
    const tmp = path.join(dir, `${TMP_PREFIX}${process.pid}-${Date.now()}.db`);
    try {
      fs.copyFileSync(src, tmp);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
      const ex = explain(e, dir);
      const out = { status: "error", at, reason, ...ex };
      record(dir, out);
      console.error("off-site copy:", ex.message);
      return out;
    }

    /* 5. Read it back off the destination — the same depth the local backup is
          verified to. A copy nobody has ever opened is a guess, and a guess on
          a USB stick is the one that gets found out on the worst day. */
    const v = await backups.verifyBackupFileDeep(tmp);
    if (!v.ok) {
      try { fs.unlinkSync(tmp); } catch { /* leave it to the sweep */ }
      const out = { status: "error", at, reason, code: "UNREADABLE", message:
        `A copy was written to ${dir} but could not be read back afterwards (${v.error}). ` +
        "It has been deleted rather than left looking like a backup. The drive is probably failing — try a different one." };
      record(dir, out);
      console.error("off-site copy:", out.message);
      return out;
    }

    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* swept later */ }
      const ex = explain(e, dir);
      const out = { status: "error", at, reason, ...ex };
      record(dir, out);
      return out;
    }

    const removed = prune(dir, cfg.keep);
    const out = { status: "ok", at, reason, file: name, bytes: v.size, pruned: removed,
      message: `A copy of everything is now on ${dir} (${name}).` };
    record(dir, out);
    return out;
  }).catch((e) => {
    /* withSource itself can fail — a full local disk, a database mid-restore. */
    const ex = explain(e, dir);
    const out = { status: "error", at, reason, code: ex.code,
      message: "The copy could not be prepared on this machine: " + (e.message || ex.message) };
    record(dir, out);
    return out;
  });
}

/* ── how protected is this shop, in one answer ───────────────────────────── */

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * What the Backup screen shows without anybody having to ask a person.
 *
 * `level` is the whole point: "ok" | "waiting" | "warn" | "alarm" | "error" |
 * "never" | "off". The screen changes colour on it, and it is deliberately
 * uncomfortable when the honest answer is uncomfortable.
 */
async function offsiteStatus(firmId) {
  const cfg = await config(firmId);
  const s = readState();
  const d = cfg.dir ? (s.destinations[destKey(cfg.dir)] || null) : null;
  const lastOk = (d && d.last_ok_at) || null;
  const age = daysSince(lastOk);
  const anyEverAt = s.last_ok_at || null;

  let level, headline, detail;
  if (!cfg.enabled || !cfg.dir) {
    level = "off";
    headline = "No copy of your books ever leaves this computer.";
    detail = anyEverAt
      ? `A copy did once reach ${s.last_ok_path} (${fmtWhen(anyEverAt)}), but automatic off-site copying is switched off now.`
      : "Every backup you have is on this disk, next to the live data. One failed drive, one theft, one spilt drink takes all of them at once. " +
        "Point this at a USB stick or a folder on another computer and the app will keep it up to date by itself.";
  } else if (!lastOk) {
    level = "never";
    headline = `No copy has ever reached ${cfg.dir}.`;
    detail = (d && d.last_error && d.last_error.message)
      || "The app has not managed to write there yet. Press “Copy now” to find out why, rather than waiting until tomorrow.";
  } else if (d && d.last_error) {
    level = "error";
    headline = d.last_error.message;
    detail = `The last copy that did work was ${fmtWhen(lastOk)} (${age} day${age === 1 ? "" : "s"} ago).`;
  } else if (age >= OFFSITE_ALARM_DAYS) {
    level = "alarm";
    headline = `Nothing has left this computer for ${age} days.`;
    detail = `The last copy on ${cfg.dir} is from ${fmtWhen(lastOk)}. Everything since then exists in exactly one place. ` +
      "Plug the drive in — the app copies to it by itself within a quarter of an hour.";
  } else if (age >= cfg.warn_days) {
    level = "warn";
    headline = `The last copy off this machine was ${age} day${age === 1 ? "" : "s"} ago.`;
    detail = `Everything recorded since then is only on this disk. Plug ${cfg.dir} in when you can.`;
  } else if (d && d.unreachable_since && age >= 1) {
    level = "waiting";
    headline = `Last copied ${fmtWhen(lastOk)}. The drive is not connected right now.`;
    detail = "That is normal — the copy is taken automatically the next time it is plugged in.";
  } else {
    level = "ok";
    headline = `A copy of everything is on ${cfg.dir}, from ${fmtWhen(lastOk)}.`;
    detail = `${(d && d.last_ok_file) || ""} · ${cfg.keep} copies are kept there; the oldest is deleted to make room.`;
  }

  return {
    enabled: cfg.enabled,
    path: cfg.dir,
    keep: cfg.keep,
    warn_days: cfg.warn_days,
    poll_minutes: Math.round(OFFSITE_POLL_MS / 60000),
    alarm_days: OFFSITE_ALARM_DAYS,
    level, headline, detail,
    last_ok_at: lastOk,
    last_ok_file: (d && d.last_ok_file) || null,
    last_ok_bytes: (d && d.last_ok_bytes) || null,
    last_attempt_at: (d && d.last_attempt_at) || null,
    last_error: (d && d.last_error) || null,
    days_since: age,
    copies: cfg.dir ? offsiteCopies(cfg.dir).slice(-cfg.keep).reverse() : [],
    events: s.events.slice(0, 8),
  };
}

function fmtWhen(iso) {
  try { return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
  catch { return String(iso); }
}

/* ── saving the destination ──────────────────────────────────────────────── */

/**
 * Check a path before it is saved, so a typo is caught while somebody is
 * looking at the screen rather than silently costing them three weeks of
 * insurance.
 */
function checkPath(dir) {
  const d = String(dir || "").trim();
  if (!d) return { ok: false, message: "Enter the folder to copy to — a USB drive, or a shared folder on another computer." };
  if (!path.isAbsolute(d) && !/^[a-zA-Z]:[\\/]/.test(d) && !/^\\\\/.test(d)) {
    return { ok: false, message: "Give the full path, for example E:\\genius-backups or \\\\officepc\\backups — not a folder name on its own." };
  }
  /* Inside the app's own data folder is not off-site, and pointing at it would
     look protected while being exactly the thing this feature exists to fix. */
  const here = path.resolve(path.dirname(DB_PATH));
  const there = path.resolve(d);
  if (there === here || there.startsWith(here + path.sep) || there === path.resolve(backups.BACKUP_DIR)) {
    return { ok: false, message:
      "That folder is on this same computer, inside the app's own data — a copy there is lost with everything else if this disk fails. " +
      "Choose a USB drive or a folder on another computer." };
  }
  return { ok: true, dir: there };
}

async function saveConfig(firmId, body) {
  const id = await configFirmId(firmId);
  if (!id) return { ok: false, message: "No business is set up yet." };
  const enabled = body.enabled ? "1" : "0";
  let dir = String(body.path == null ? (await config(id)).dir : body.path).trim();

  if (enabled === "1") {
    const c = checkPath(dir);
    if (!c.ok) return { ok: false, message: c.message };
    dir = c.dir;
  }
  const keep = Math.max(1, Math.min(60, parseInt(body.keep, 10) || (await config(id)).keep));
  const warn = Math.max(1, Math.min(90, parseInt(body.warn_days, 10) || (await config(id)).warn_days));

  await settings.setSetting(id, "offsite_enabled", enabled);
  await settings.setSetting(id, "offsite_path", dir);
  await settings.setSetting(id, "offsite_keep", String(keep));
  await settings.setSetting(id, "offsite_warn_days", String(warn));
  try {
    await query("INSERT INTO audit_logs (user_id, module, action, detail) VALUES (NULL,'system','offsite-config',?)",
      [JSON.stringify({ enabled: enabled === "1", path: dir, keep, warn_days: warn })]);
  } catch { /* a note, never a reason to fail the save */ }
  return { ok: true };
}

module.exports = {
  OFFSITE_POLL_MS, OFFSITE_ALARM_DAYS, STATE_FILE, PREFIX, TMP_PREFIX,
  config, saveConfig, checkPath, copyOffsite, offsiteStatus,
  readState, offsiteCopies, prune, explain, freeBytes,
};
