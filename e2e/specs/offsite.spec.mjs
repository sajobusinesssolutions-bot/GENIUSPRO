/**
 * offsite.spec.mjs — the copy that leaves the machine.
 *
 * Every backup this app takes lands on the same disk as the live database:
 * `backups/auto-2026-08-18.db` beside `data/genius.db`. One dead drive takes
 * the books and all seven copies of them together. The off-site destination —
 * a USB stick, or a folder on another machine on the shop LAN, which to Node
 * are the same thing — is the answer to that, and it is only an answer if it
 * behaves sensibly on the days it is *not* there, which is most days.
 *
 * So what is tested here is almost entirely the unhappy path:
 *
 *   - a stick that is out of the machine is normal: a skip, no error, no log
 *     entry, and the local daily backup carries on;
 *   - a path that has *never* worked is not normal: that is a typo in a drive
 *     letter, and saying "not connected at the moment" about it would hide the
 *     mistake for however many weeks pass before anyone looks;
 *   - full, write-protected, permission-refused, a file where a folder should
 *     be, and a drive that writes bytes it cannot read back — each has to
 *     produce a sentence a shopkeeper can act on, not an errno;
 *   - and the screen has to be uncomfortable when the honest answer is
 *     uncomfortable: five weeks with nothing off the machine is an alarm, not
 *     a neutral row in a list.
 *
 * Nothing here needs a real USB stick. Temp directories stand in for the
 * destination; "unplugged" is `fs.rename` of that directory; the ages that
 * drive the warnings are set by writing the state file the app keeps beside
 * the database (which is also a test that the state lives outside the database
 * where a restore cannot take it with it).
 *
 * Two failure modes cannot be produced by a filesystem in CI — a full drive
 * and a write-protected one — because the suite runs as root, where the
 * permission bits do not apply, and because no test may mount a tiny volume.
 * Those are driven through the real `copyOffsite()` in a child process, with
 * `fs.statfsSync` / `fs.copyFileSync` replaced so the operating system reports
 * exactly what a full or locked stick reports. The code under test is the
 * shipped code; only the disk is a stand-in.
 *
 * Like access.spec.mjs and durability.spec.mjs, this runs its own backend on
 * its own port against its own copy of the database — it writes state files
 * beside the database and changes settings, and the shared server is in use by
 * every other spec.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn as signInBrowser, go, watchErrors } from "../harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = Number(process.env.E2E_OFFSITE_PORT || (Number(process.env.E2E_PORT || 3199) + 400));
const BASE = `http://localhost:${PORT}`;
const backendRequire = createRequire(path.join(BACKEND, "package.json"));

export const name = "an off-site copy that survives the drive not being there";

/* ── a backend of our own ────────────────────────────────────────────────── */

function copyDatabase(tag) {
  const src = path.join(BACKEND, "data", "genius.db");
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genius-offsite-${tag}-`));
  const dbPath = path.join(dir, "genius.db");
  fs.copyFileSync(src, dbPath);
  return { dir, dbPath };
}

async function startBackend(dbPath) {
  const proc = spawn("node", ["server.js"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      GENIUS_DB_PATH: dbPath,
      JWT_SECRET: process.env.JWT_SECRET || "e2e-only-not-a-production-secret",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return proc; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error("The offsite-spec backend never became healthy.\n" + log.join(""));
}

async function signIn() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Could not sign in: ${body?.message}`);
  const call = async (method, url, data) => {
    const r = await fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.data.token}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    let b = null;
    try { b = await r.json(); } catch { /* not every reply is json */ }
    return { status: r.status, body: b, data: b && b.data, message: b && b.message };
  };
  return { get: (u) => call("GET", u), post: (u, d) => call("POST", u, d ?? {}), put: (u, d) => call("PUT", u, d ?? {}) };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const copiesIn = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => f.startsWith("genius-offsite-") && f.endsWith(".db")).sort(); }
  catch { return []; }
};
const tempsIn = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(".genius-offsite-tmp-")); }
  catch { return []; }
};

/** Can this file actually be opened and read as the shop's database? The whole
    argument for verifying a copy: a plausible file on a stick is not a backup. */
async function opensAsDatabase(file) {
  try {
    const SQL = await backendRequire("sql.js")();
    const db = new SQL.Database(fs.readFileSync(file));
    try {
      const stmt = db.prepare("SELECT COUNT(*) FROM sale_invoices");
      try { stmt.step(); return true; } finally { stmt.free(); }
    } finally { db.close(); }
  } catch { return false; }
}

const stateFile = (dbPath) => path.join(path.dirname(dbPath), "offsite-state.json");

/** Wind the record of the last successful copy back by `days`, exactly as if
    the stick had not been plugged in since. The state lives in a file beside
    the database on purpose; this both exercises the ageing and proves the file
    is where the app says it is. */
function ageLastCopy(dbPath, days) {
  const s = JSON.parse(fs.readFileSync(stateFile(dbPath), "utf8"));
  const when = new Date(Date.now() - days * 86400000).toISOString();
  for (const k of Object.keys(s.destinations)) {
    if (s.destinations[k].last_ok_at) s.destinations[k].last_ok_at = when;
  }
  if (s.last_ok_at) s.last_ok_at = when;
  fs.writeFileSync(stateFile(dbPath), JSON.stringify(s));
}

/* ── the modes a real filesystem will not produce in CI ──────────────────── */

/**
 * Run the shipped copyOffsite() in a child process against its own copy of the
 * database, with one operating-system call replaced so the disk reports what a
 * full or write-protected stick reports. Everything else — the classification,
 * the temp-then-rename, the read-back, the state file — is the real code.
 */
const CHILD = `
const fs = require("fs");
const mode = process.argv[2], dest = process.argv[3];
if (mode === "full") {
  fs.statfsSync = () => ({ bavail: 1, bsize: 512, blocks: 1, bfree: 1 });
} else if (mode === "readonly" || mode === "denied" || mode === "fault") {
  const code = mode === "readonly" ? "EROFS" : mode === "denied" ? "EACCES" : "EIO";
  const real = fs.copyFileSync;
  fs.copyFileSync = (src, to, ...rest) => {
    if (String(to).startsWith(dest)) throw Object.assign(new Error(code), { code });
    return real(src, to, ...rest);
  };
} else if (mode === "garbage") {
  const real = fs.copyFileSync;
  fs.copyFileSync = (src, to, ...rest) => {
    if (String(to).startsWith(dest)) return fs.writeFileSync(to, Buffer.alloc(4096, 0x7f));
    return real(src, to, ...rest);
  };
} else if (mode === "corrupt-existing") {
  const today = "genius-offsite-" + new Date().toISOString().slice(0, 10) + ".db";
  fs.writeFileSync(require("path").join(dest, today), Buffer.alloc(4096, 0x7f));
}
(async () => {
  const B = process.env.GENIUS_BACKEND;
  const db = require(B + "/database/db");
  await db.init();
  const settings = require(B + "/modules/settings/settings.service");
  const offsite = require(B + "/modules/system/offsite.service");
  settings.setSetting(1, "offsite_enabled", "1");
  settings.setSetting(1, "offsite_path", dest);
  settings.setSetting(1, "offsite_keep", "3");
  db.persist();
  const r = await offsite.copyOffsite({ firmId: 1, force: mode !== "corrupt-existing" });
  process.stdout.write("RESULT " + JSON.stringify(r) + "\\n");
  process.exit(0);
})().catch((e) => { process.stdout.write("RESULT " + JSON.stringify({ status: "threw", message: String(e && e.stack || e) }) + "\\n"); process.exit(0); });
`;

async function runChild(mode) {
  const { dir, dbPath } = copyDatabase(`child-${mode}`);
  const script = path.join(dir, "child.cjs");
  fs.writeFileSync(script, CHILD);
  /* Away from the database, for the reason above. */
  const driveDir = fs.mkdtempSync(path.join(os.tmpdir(), `genius-offsite-drive-${mode}-`));
  const dest = path.join(driveDir, "usb");
  fs.mkdirSync(dest);
  const out = await new Promise((resolve) => {
    const p = spawn("node", [script, mode, dest], {
      cwd: BACKEND,
      env: { ...process.env, GENIUS_BACKEND: BACKEND, GENIUS_DB_PATH: dbPath, NODE_ENV: "test", JWT_SECRET: "e2e-only-not-a-production-secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    p.stdout.on("data", (d) => { buf += d; });
    p.stderr.on("data", () => {});
    p.on("exit", () => resolve(buf));
  });
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  const result = line ? JSON.parse(line.slice(7)) : { status: "no-output", message: out.slice(0, 300) };
  return { result, dest, dir, driveDir };
}

/* ── the screen ──────────────────────────────────────────────────────────── */

/**
 * The Backup screen, in a browser, against the suite's shared server — where
 * nothing off-site is configured, which is the state every existing
 * installation is in and the one the card has to be loudest about.
 */
async function theScreenItself(browser, report) {
  const page = await browser.newPage();
  const errs = watchErrors(page);
  try {
    await signInBrowser(page);
    await go(page, "Settings");
    await page.getByRole("button", { name: "Backup" }).click();
    await page.waitForTimeout(1200);
    const body = await page.locator(".dk-set-body").innerText();
    report.ok(/never leaves this computer|leaves this computer/i.test(body),
      "the Backup screen leads with whether anything leaves this machine at all",
      body.split("\n").slice(0, 4).join(" / "));
    report.ok(/USB drive|another computer/i.test(body),
      "and offers the two destinations a shop actually has — a stick, or a machine on the shop network");
    report.ok(await page.getByRole("button", { name: /Save and copy now/i }).count() > 0,
      "with a control that saves and proves it in one press, rather than waiting a day to find out");
    report.ok(errs.length === 0, "the card renders without a script error", errs.join(" | "));
  } finally { await page.close(); }
}

/* ── the spec ────────────────────────────────────────────────────────────── */

export async function run({ browser, report }) {
  await theScreenItself(browser, report);
  const { dir, dbPath } = copyDatabase("server");
  /* The destination lives in its own temp root, not beside the database — the
     app refuses a "off-site" folder that is inside its own data directory, and
     it is right to. This is the same shape as a stick on E: while the data is
     on C:. */
  const away = fs.mkdtempSync(path.join(os.tmpdir(), "genius-offsite-drive-"));
  const usb = path.join(away, "usb-stick");
  const gone = path.join(away, "usb-stick-unplugged");
  const never = path.join(away, "drive-Z-that-does-not-exist");
  const notAFolder = path.join(away, "a-file-not-a-folder.db");
  fs.mkdirSync(usb);
  fs.writeFileSync(notAFolder, "this is a file");

  let proc = null;
  const scratch = [];
  try {
    proc = await startBackend(dbPath);
    const api = await signIn();

    /* ── nothing set up ─────────────────────────────────────────────────── */
    let st = (await api.get("/api/system/offsite")).data;
    report.ok(st && st.level === "off",
      "with nothing configured the screen says outright that no copy ever leaves this computer",
      st && `${st.level}: ${st.headline}`);
    report.ok(st && /never leaves|not this computer|leaves this computer/i.test(st.headline || ""),
      "and says it in words a shopkeeper reads, not as a status code", st && st.headline);

    /* ── a path that cannot be right ────────────────────────────────────── */
    let r = await api.put("/api/system/offsite", { enabled: true, path: "backups" });
    report.ok(r.body && r.body.success === false && /full path/i.test(r.message || ""),
      "a bare folder name is refused with the shape of path that would work", r.message);

    r = await api.put("/api/system/offsite", { enabled: true, path: path.dirname(dbPath) });
    report.ok(r.body && r.body.success === false && /same computer/i.test(r.message || ""),
      "pointing the off-site copy back at the app's own data folder is refused — that is not off-site", r.message);

    /* ── a destination that has never worked is a typo, not an unplugged stick ── */
    r = await api.put("/api/system/offsite", { enabled: true, path: never, keep: 3, warn_days: 7 });
    const first = (r.data || {}).attempt || {};
    report.ok(first.status === "error" && /cannot be found/i.test(first.message || ""),
      "a folder that has never once been written to is reported as a mistake, not as 'not connected'", first.message);
    report.ok(/drive letter/i.test(first.message || ""),
      "and the message names the thing that is actually wrong on Windows — the drive letter", first.message);
    st = (await api.get("/api/system/offsite")).data;
    report.ok(st.level === "never", "the screen shows it as never having worked", st.headline);

    /* ── the happy path ─────────────────────────────────────────────────── */
    r = await api.put("/api/system/offsite", { enabled: true, path: usb, keep: 3, warn_days: 7 });
    const ok = (r.data || {}).attempt || {};
    report.ok(ok.status === "ok", "saving a real folder copies to it immediately rather than waiting for tomorrow", ok.message);
    const copies = copiesIn(usb);
    report.ok(copies.length === 1 && /^genius-offsite-\d{4}-\d{2}-\d{2}\.db$/.test(copies[0]),
      "one dated copy is on the drive", copies.join(", "));
    report.ok(await opensAsDatabase(path.join(usb, copies[0])),
      "and it opens and reads as the shop's database — the copy is verified where it landed, not where it came from");
    report.ok(tempsIn(usb).length === 0, "nothing half-written is left behind", tempsIn(usb).join(", "));

    st = (await api.get("/api/system/offsite")).data;
    report.ok(st.level === "ok" && (st.last_ok_at || "").length > 0,
      "the screen can now say when a copy last left this machine, and to where", `${st.level}: ${st.headline}`);

    /* ── prove it works now ─────────────────────────────────────────────── */
    r = await api.post("/api/system/offsite/test");
    report.ok(r.status === 200 && ((r.data || {}).attempt || {}).status === "ok",
      "‘Copy now’ writes a copy on demand, so a wrong path is found while somebody is looking at the screen", r.message);
    report.ok(copiesIn(usb).length === 1,
      "copying twice in one day still leaves one copy for the day, not two", copiesIn(usb).join(", "));

    /* ── retention on a small stick ─────────────────────────────────────── */
    for (const day of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]) {
      fs.copyFileSync(path.join(usb, copiesIn(usb)[0]), path.join(usb, `genius-offsite-${day}.db`));
    }
    await api.post("/api/system/offsite/test");
    const kept = copiesIn(usb);
    report.ok(kept.length === 3, "only the newest few copies are kept — a 4 GB stick and a growing database is a collision", kept.join(", "));
    report.ok(kept.includes(`genius-offsite-${new Date().toISOString().slice(0, 10)}.db`),
      "and today's is one of them", kept.join(", "));

    /* ── the stick comes out ────────────────────────────────────────────── */
    const eventsBefore = ((await api.get("/api/system/offsite")).data.events || []).length;
    fs.renameSync(usb, gone);
    r = await api.post("/api/system/offsite/test");
    report.ok(r.body.success === false && /not connected at the moment/i.test(r.message || ""),
      "with the drive out, asking for a copy says the drive is out — in those words", r.message);
    st = (await api.get("/api/system/offsite")).data;
    report.ok(st.level === "waiting" || st.level === "ok",
      "an unplugged stick is not an error state on a drive that has worked before", `${st.level}: ${st.headline}`);
    report.ok((st.events || []).length === eventsBefore,
      "and it writes nothing to the list of things that have happened — 96 of these a day is how a log stops being read",
      `${(st.events || []).length} vs ${eventsBefore}`);

    /* The local daily backup must be entirely unaffected by any of this. It is
       taken five seconds after boot, so wait for it rather than racing it. */
    let local = [];
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
      local = (await api.get("/api/system/backups")).data || [];
      if (local.some((b) => b.automatic)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    report.ok(local.some((b) => b.automatic),
      "the local daily backup is untouched by the drive being missing", `${local.length} local copies`);

    /* ── unplugged for weeks is a different sentence ────────────────────── */
    ageLastCopy(dbPath, 9);
    st = (await api.get("/api/system/offsite")).data;
    report.ok(st.level === "warn" && /9 days ago/.test(st.headline || ""),
      "nine days with nothing off the machine is said plainly, with the number of days", st.headline);

    ageLastCopy(dbPath, 37);
    st = (await api.get("/api/system/offsite")).data;
    report.ok(st.level === "alarm",
      "five weeks with nothing off the machine is an alarm, not a neutral line", `${st.level}: ${st.headline}`);
    report.ok(/only place|exactly one place/i.test(st.detail || "") || /37 days/.test(st.headline || ""),
      "and it says what that actually means for the shop's records", `${st.headline} ${st.detail}`);

    /* ── a file where a folder should be ────────────────────────────────── */
    r = await api.put("/api/system/offsite", { enabled: true, path: notAFolder, keep: 3, warn_days: 7 });
    const nf = (r.data || {}).attempt || {};
    report.ok(nf.status === "error" && /file, not a folder/i.test(nf.message || ""),
      "a file chosen where a folder was meant says exactly that", nf.message);

    /* ── switching it off is honest about what is left ──────────────────── */
    await api.put("/api/system/offsite", { enabled: false });
    st = (await api.get("/api/system/offsite")).data;
    report.ok(st.level === "off" && /switched off/i.test(st.detail || ""),
      "turning it off says a copy did once reach the drive but is no longer being kept up to date", st.detail);

    /* ── the disks CI cannot give us ────────────────────────────────────── */
    const full = await runChild("full"); scratch.push(full.dir, full.driveDir);
    report.ok(full.result.status === "error" && full.result.code === "ENOSPC" && /full/i.test(full.result.message),
      "a full drive says the drive is full, with the space it has and the space a copy needs", full.result.message);
    report.ok(copiesIn(full.dest).length === 0 && tempsIn(full.dest).length === 0,
      "and it stops before writing anything, rather than leaving a truncated file that looks like a backup",
      copiesIn(full.dest).concat(tempsIn(full.dest)).join(", "));

    const ro = await runChild("readonly"); scratch.push(ro.dir, ro.driveDir);
    report.ok(ro.result.code === "EROFS" && /write-protected/i.test(ro.result.message) && /lock switch/i.test(ro.result.message),
      "a write-protected stick names the little lock switch, not EROFS", ro.result.message);

    const denied = await runChild("denied"); scratch.push(denied.dir, denied.driveDir);
    report.ok(denied.result.code === "EACCES" && /permission/i.test(denied.result.message) && /shared folder/i.test(denied.result.message),
      "a refused network share explains that the other computer has to allow writing, not just reading", denied.result.message);

    const fault = await runChild("fault"); scratch.push(fault.dir, fault.driveDir);
    report.ok(fault.result.code === "EIO" && /fault/i.test(fault.result.message),
      "a drive that faults mid-copy says the stick may be failing", fault.result.message);

    const garbage = await runChild("garbage"); scratch.push(garbage.dir, garbage.driveDir);
    report.ok(garbage.result.code === "UNREADABLE" && /read back/i.test(garbage.result.message),
      "a drive that accepts bytes it cannot read back is caught by opening the copy where it landed", garbage.result.message);
    report.ok(copiesIn(garbage.dest).length === 0,
      "and the unreadable copy is deleted rather than left looking like insurance — that is worse than no file at all",
      copiesIn(garbage.dest).join(", "));

    const stale = await runChild("corrupt-existing"); scratch.push(stale.dir, stale.driveDir);
    report.ok(stale.result.status === "ok",
      "a copy already on the drive that no longer opens is replaced, not counted", stale.result.message);
    report.ok(await opensAsDatabase(path.join(stale.dest, copiesIn(stale.dest)[0] || "none")),
      "and what replaces it opens");
  } finally {
    if (proc) { proc.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 200)); }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(away, { recursive: true, force: true });
    for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
  }
}
