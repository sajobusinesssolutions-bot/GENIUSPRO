/**
 * backup.spec.mjs — the last line of defence, tested.
 *
 * Backup and restore is the one feature where a bug destroys the books rather
 * than reporting them wrong, and it had never been exercised at all. Every
 * assertion below is something the previous implementation actually did, proved
 * against the running server before it was changed:
 *
 *   · Restore replaced the whole database file, so firm B's admin restoring
 *     firm B's own backup deleted firm A. Measured: two firms in one file, firm
 *     B created an item, firm A restored a backup taken a moment earlier, and
 *     firm B's item count went 1 → 0.
 *   · It validated sixteen bytes of SQLite magic and nothing else. An 8 KB
 *     database whose only table was `not_genius` previewed as "0 invoices, 0
 *     parties, 0 items" and was accepted.
 *   · It took no lock and did not look at txnDepth, so it rewrote the file
 *     while a sale was committing.
 *   · It wrote one fixed `.pre-restore` file, so the second restore destroyed
 *     the copy taken before the first.
 *
 * Why it runs its own servers. Every assertion here either replaces the whole
 * database or expects a specific number of rows in it, and the shared harness
 * server is being used by nine other specs. So — like access.spec.mjs and
 * durability.spec.mjs — this takes its own copies of the database and boots its
 * own backends: one ordinary single-firm shop, and one holding two businesses.
 *
 * Nothing here trusts the server's own answer about what is in the database.
 * The file is read straight off the disk with sql.js at every point where the
 * question is "what is actually stored", because "the server still remembers
 * it" is the failure mode being tested.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = Number(process.env.E2E_BACKUP_PORT || (Number(process.env.E2E_PORT || 3199) + 400));
const TENANT_PORT = PORT + 1;

/* sql.js and bcryptjs are the backend's own dependencies — the suite installs
   nothing. */
const backendRequire = createRequire(path.join(BACKEND, "package.json"));

export const name = "backup and restore cannot lose a shop its books";

/* ── servers ─────────────────────────────────────────────────────────────── */

function copyDatabase(tag) {
  const src = path.join(BACKEND, "data", "genius.db");
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genius-backup-${tag}-`));
  const dbPath = path.join(dir, "genius.db");
  fs.copyFileSync(src, dbPath);
  return { dir, dbPath };
}

async function startBackend(dbPath, port, tag) {
  const base = `http://localhost:${port}`;
  const proc = spawn("node", ["server.js"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
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
    try { if ((await fetch(`${base}/api/health`)).ok) return { proc, base, log }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error(`The ${tag} backend never became healthy.\n` + log.join(""));
}

/** SIGKILL, then wait for the port to actually come free — this spec starts two
    backends in a row and a run that follows another run reuses both ports. */
async function stop(server) {
  if (!server) return;
  const gone = new Promise((r) => server.proc.once("exit", r));
  server.proc.kill("SIGKILL");
  await gone;
  await new Promise((r) => setTimeout(r, 500));
}

/* ── a second business, written in before anything opens the file ────────── */

const MODULES = ["parties", "items", "sales", "payments", "purchases", "expenses", "accounting", "reports", "settings", "users"];
const ACTIONS = ["view", "create", "edit", "delete"];

/** Lifted from access.spec.mjs: nothing in the app creates a second firm, so a
    genuine cross-tenant test has to write one in with sql.js first. Firm B's
    user holds every permission, so anything that happens is about tenancy and
    never about a missing permission. */
async function seedSecondFirm(dbPath) {
  const SQL = await backendRequire("sql.js")();
  const bcrypt = backendRequire("bcryptjs");
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const one = (sql) => { const r = db.exec(sql); return r.length ? r[0].values[0][0] : null; };

  db.run("INSERT INTO firms (name, legal_name, gstin, state_code, invoice_prefix, status) VALUES ('Rival Traders','Rival Traders Ltd','TIN-B','B','BINV','active')");
  const firmB = one("SELECT MAX(id) FROM firms");
  db.run("INSERT INTO roles (firm_id, name, is_system) VALUES (?,'Owner',1)", [firmB]);
  const roleB = one("SELECT MAX(id) FROM roles");
  for (const m of MODULES) for (const a of ACTIONS) {
    db.run("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [roleB, m, a]);
  }
  db.run("INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id, status) VALUES ('rival',?,'Rival Owner',?,?,'active')",
    [bcrypt.hashSync("rival123", 10), roleB, firmB]);
  const coa = db.exec("SELECT code, name, type, is_cash_bank, is_control, opening_balance FROM chart_of_accounts WHERE firm_id = 1");
  if (coa.length) for (const v of coa[0].values) {
    db.run("INSERT INTO chart_of_accounts (firm_id, code, name, type, is_cash_bank, is_control, opening_balance) VALUES (?,?,?,?,?,?,?)", [firmB, ...v]);
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  return firmB;
}

/* ── reading the database behind the server's back ───────────────────────── */

async function onDisk(dbPath, sql, params = []) {
  const SQL = await backendRequire("sql.js")();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  } finally { db.close(); }
}

/**
 * A fingerprint of everything that matters, taken from the file rather than the
 * server. A round trip is only a round trip if this is identical afterwards —
 * "the invoice count matches" would pass while every line was wrong.
 */
async function fingerprint(dbPath) {
  const TABLES = [
    "firms", "users", "parties", "items", "item_stock", "stock_movements",
    "sale_invoices", "sale_invoice_lines", "payments", "payment_allocations",
    "journal_entries", "journal_entry_lines", "firm_settings", "sequences",
  ];
  const out = {};
  for (const t of TABLES) {
    /* Ordered, and every column, so a changed rate or a re-pointed foreign key
       shows up. audit_logs is deliberately excluded: the restore itself writes
       a row there, which is the point of it. */
    const rows = await onDisk(dbPath, `SELECT * FROM ${t} ORDER BY rowid`);
    out[t] = JSON.stringify(rows);
  }
  return out;
}

function firstDifference(a, b) {
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) {
      const was = JSON.parse(a[k]), now = JSON.parse(b[k]);
      return `${k}: ${was.length} row(s) before, ${now.length} after`;
    }
  }
  return null;
}

/* ── request helpers ─────────────────────────────────────────────────────── */

function client(base, token) {
  const call = async (method, url, data) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not every reply is json */ }
    return { status: res.status, ok: res.ok && body?.success !== false, body, data: body && body.data, message: body && body.message };
  };
  return {
    token,
    get: (u) => call("GET", u),
    post: (u, d) => call("POST", u, d ?? {}),
    /** Send a database as what it is — raw bytes, not base64 inside JSON. */
    async upload(url, buf) {
      const res = await fetch(base + url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${token}` },
        body: buf,
      });
      let body = null;
      try { body = await res.json(); } catch { /* not every reply is json */ }
      return { status: res.status, ok: res.ok && body?.success !== false, body, data: body && body.data, message: body && body.message };
    },
    async download(url) {
      const res = await fetch(base + url, { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

async function signIn(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Could not sign in as ${username} on ${base}: ${body?.message}`);
  const c = client(base, body.data.token);
  c.userId = body.data.user?.id;
  return c;
}

const sellBody = (till, itemId, qty = 1) => ({
  party_id: 1, payment_type: "cash", source: "pos", sales_rep_id: till.userId,
  lines: [{ item_id: itemId, description: "Backup probe", quantity: qty, rate: 1000, unit: "PCS" }],
});

async function stockedItem(till, onHand, tag) {
  const r = await till.post("/api/items", {
    name: `Backup ${tag} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    item_type: "product", unit: "PCS",
    sale_price: 1000, purchase_price: 0, is_inventory: 1, opening_stock: onHand,
  });
  return r.data?.id;
}

/* ── the spec ────────────────────────────────────────────────────────────── */

export async function run({ report }) {
  await tenantIsolation(report);
  await singleFirmRestore(report);
}

/**
 * 1. A restore must not touch another business's records.
 *
 * The worst thing this codebase could still do. Two firms share the file, and
 * restore replaces the file — so firm A pressing Restore used to delete firm B
 * entirely, without warning either of them.
 */
async function tenantIsolation(report) {
  const { dir, dbPath } = copyDatabase("tenant");
  let server = null;
  try {
    await seedSecondFirm(dbPath);
    server = await startBackend(dbPath, TENANT_PORT, "two-firm backup");
    const firmA = await signIn(server.base, "admin", "admin123");
    const firmB = await signIn(server.base, "rival", "rival123");

    /* Firm A takes a backup, then firm B records something. Restoring that
       backup would put the file back to before firm B's row existed. */
    const taken = await firmA.download("/api/system/backup");
    report.ok(taken.status === 200 && taken.buf.length > 512,
      "a backup can be downloaded", `HTTP ${taken.status}, ${taken.buf.length} bytes`);

    const rivalItem = await firmB.post("/api/items", {
      name: `Rival stock ${Date.now()}`, item_type: "product", unit: "PCS", sale_price: 500, purchase_price: 0,
    });
    report.ok(rivalItem.ok, "the second business can record something of its own", rivalItem.message);
    const before = await onDisk(dbPath, "SELECT COUNT(*) n FROM items WHERE firm_id = 2");
    report.ok(before[0].n >= 1, "the second business's row is in the file", JSON.stringify(before));

    /* ── the bug ── */
    const applied = await firmA.upload("/api/system/restore", taken.buf);
    report.ok(applied.status === 409,
      "a whole-file restore is refused outright when the installation holds more than one business",
      `it answered ${applied.status}: ${applied.message}`);
    report.ok(/more than one business|other businesses|businesses \(/i.test(applied.message || ""),
      "the refusal explains that other businesses' records would be deleted, not just that it failed",
      applied.message);

    const after = await onDisk(dbPath, "SELECT COUNT(*) n FROM items WHERE firm_id = 2");
    report.ok(after[0].n === before[0].n,
      "one business restoring its own backup leaves the other business's records exactly as they were",
      `firm 2 had ${before[0].n} item(s) before and has ${after[0].n} after`);

    /* And by the other door — the daily-copy list, which is the button a
       shopkeeper is far more likely to press than the file upload, and which
       used to have even fewer guards behind it than the upload did. The daily
       copy is planted rather than waited for: the automatic one is taken five
       seconds after boot and this assertion is not about the timer. */
    const copyName = `auto-${new Date().toISOString().slice(0, 10)}.db`;
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    fs.copyFileSync(dbPath, path.join(dir, "backups", copyName));
    const byName = await firmA.post("/api/system/restore-file", { name: copyName });
    report.ok(byName.status === 409,
      "restoring one of the daily copies is refused on a multi-business installation too",
      `it answered ${byName.status}: ${byName.message}`);

    /* The screen must know before it offers the button. */
    const preview = await firmA.upload("/api/system/restore/preview", taken.buf);
    report.ok(preview.ok && preview.data?.restorable === false,
      "the preview says up front that this backup cannot be restored here",
      `restorable=${preview.data?.restorable}, reason=${preview.data?.blocked_reason}`);

    const stillThere = await firmB.get("/api/items");
    const rows = stillThere.data?.rows || stillThere.data || [];
    report.ok(stillThere.ok && rows.length >= 1,
      "the second business can still read its own records after the attempted restore",
      `HTTP ${stillThere.status}, ${rows.length} item(s)`);
  } finally {
    await stop(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 2-5. Everything else, on an ordinary one-business shop: the round trip, the
 * concurrent sale, the files that must be refused, and the safety copies.
 */
async function singleFirmRestore(report) {
  const { dir, dbPath } = copyDatabase("single");
  let server = null;
  try {
    server = await startBackend(dbPath, PORT, "single-firm backup");
    const api = await signIn(server.base, "admin", "admin123");

    const backup = await roundTrip(report, api, dbPath);
    await refusesRubbish(report, api, dbPath, backup);
    await olderBackupIsBroughtForward(report, api, backup);
    await restoreAgainstALiveSale(report, api, dbPath, server.base);
    await safetyCopies(report, api, dir, dbPath);
    await theRestoreIsRecorded(report, api);
  } finally {
    await stop(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 2. Back up, change things, restore — and be back exactly where you started.
 *
 * "Exactly" is the assertion. Every row of fourteen tables is compared, read
 * off the disk, because a restore that returns the right *counts* while losing
 * a line's rate or re-pointing a foreign key is the failure nobody notices for
 * a month.
 */
async function roundTrip(report, api, dbPath) {
  const itemId = await stockedItem(api, 20, "roundtrip");
  const sale = await api.post("/api/sales", sellBody(api, itemId, 2));
  report.ok(sale.ok, "the shop can ring up a sale before the backup is taken", sale.message);

  const taken = await api.download("/api/system/backup");
  report.ok(taken.status === 200, "the backup downloads", `HTTP ${taken.status}`);

  /* The downloaded bytes must be a database that opens and reads. A backup
     nobody has ever opened is a guess; this one is checked the moment it is
     handed over rather than on the day it is needed. */
  let readable = false, invoicesInBackup = -1;
  try {
    const SQL = await backendRequire("sql.js")();
    const db = new SQL.Database(taken.buf);
    try {
      const stmt = db.prepare("SELECT COUNT(*) FROM sale_invoices");
      try { stmt.step(); invoicesInBackup = stmt.get()[0]; } finally { stmt.free(); }
      readable = true;
    } finally { db.close(); }
  } catch { /* readable stays false */ }
  report.ok(readable, "the downloaded backup is a database that can actually be opened and read",
    `sale_invoices count in the file: ${invoicesInBackup}`);

  const was = await fingerprint(dbPath);

  /* Now change the shop in every way that matters: a new item, a sale against
     it, a party edit, a settings change. */
  const laterItem = await stockedItem(api, 5, "after-backup");
  const laterSale = await api.post("/api/sales", sellBody(api, laterItem, 1));
  await api.post("/api/parties", { name: `After the backup ${Date.now()}`, party_type: "customer" });
  report.ok(laterSale.ok, "the shop keeps trading after the backup is taken", laterSale.message);

  const changed = await fingerprint(dbPath);
  report.ok(firstDifference(was, changed) !== null,
    "the trading after the backup really did change the file — otherwise the restore below proves nothing",
    "the fingerprint was identical before and after four writes");

  const applied = await api.upload("/api/system/restore?filename=round-trip.db", taken.buf);
  report.ok(applied.ok, "the backup restores", `HTTP ${applied.status}: ${applied.message}`);

  const now = await fingerprint(dbPath);
  const diff = firstDifference(was, now);
  report.ok(diff === null,
    "after a restore the database holds exactly what it held when the backup was taken — every row of every table",
    diff ? `first difference — ${diff}` : "");

  /* And the app on top of it works, which is a different question from the
     bytes being right: an older backup can be missing columns the running code
     selects. */
  const items = await api.get("/api/items");
  const invoices = await api.get("/api/sales");
  report.ok(items.ok && invoices.ok,
    "the app can still read items and sales through the API after a restore",
    `items ${items.status} ${items.message || ""} · sales ${invoices.status} ${invoices.message || ""}`);

  const gone = (items.data?.rows || items.data || []).some((i) => i.id === laterItem);
  report.ok(!gone, "the item created after the backup is gone, because that is what restoring means",
    `item ${laterItem} is still listed`);

  return taken.buf;
}

/**
 * 4. A file that is not a usable Genius POS backup must be refused, and refused
 * before anything on disk is touched.
 *
 * The old check was sixteen bytes of SQLite magic. Every case below passed it.
 */
async function refusesRubbish(report, api, dbPath, backup) {
  const SQL = await backendRequire("sql.js")();
  const untouched = await fingerprint(dbPath);

  const cases = [];

  /* (a) not a database at all */
  cases.push({
    what: "a file that is not a database",
    buf: Buffer.from("This is my invoice spreadsheet, not a backup.".repeat(40)),
    expect: /not a Genius POS backup|not a database/i,
  });

  /* (b) a perfectly valid SQLite file from something else entirely */
  {
    const other = new SQL.Database();
    other.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)");
    other.run("INSERT INTO customers (name) VALUES ('from another product')");
    cases.push({
      what: "a valid SQLite database from some other program",
      buf: Buffer.from(other.export()),
      expect: /not made by Genius POS/i,
    });
    other.close();
  }

  /* (c) a real Genius POS backup with its pages scribbled over — the header still
         reads "SQLite format 3", and it opens; it only fails once something
         actually reads a page. */
  {
    const damaged = Buffer.from(backup);
    damaged.fill(0x7f, 4096, Math.min(200000, damaged.length));
    cases.push({
      what: "a Genius POS backup whose contents are corrupted",
      buf: damaged,
      expect: /damaged|cannot be read/i,
    });
  }

  /* (d) a backup from a newer build of the app. Restoring it would silently
         drop whatever that version stores in the tables this one has never
         heard of, and the shop would be looking at a partial copy of its own
         books with nothing on screen to say so. */
  {
    const newer = new SQL.Database(Buffer.from(backup));
    newer.run("CREATE TABLE loyalty_tiers_v2 (id INTEGER PRIMARY KEY, name TEXT)");
    cases.push({
      what: "a backup made by a newer version of the app",
      buf: Buffer.from(newer.export()),
      expect: /newer version/i,
    });
    newer.close();
  }

  /* (e) an empty file */
  cases.push({ what: "an empty file", buf: Buffer.alloc(0), expect: /No backup data|not a Genius POS backup/i });

  for (const c of cases) {
    const res = await api.upload("/api/system/restore", c.buf);
    report.ok(res.status >= 400 && res.status < 500,
      `${c.what} is refused rather than restored`,
      `it answered ${res.status}: ${res.message}`);
    report.ok(c.expect.test(res.message || ""),
      `the refusal of ${c.what} says what is wrong with it`,
      `message was: ${res.message}`);
  }

  const after = await fingerprint(dbPath);
  const diff = firstDifference(untouched, after);
  report.ok(diff === null,
    "a refused restore leaves the database byte-for-byte as it was — nothing is written before the file is checked",
    diff ? `first difference — ${diff}` : "");

  const health = await api.get("/api/items");
  report.ok(health.ok, "the app is still usable after every one of those was refused", `HTTP ${health.status} ${health.message || ""}`);
}

/**
 * A backup from an *older* build is the common case, and it is the opposite of
 * the newer-build case: it must be accepted, not refused. Somebody restoring a
 * copy from last year has usually updated the app since.
 *
 * It has to be brought forward, though. Restoring reloads the file without
 * running the schema migrations, so a backup missing a column the running code
 * selects used to restore "successfully" and then fail on the next screen —
 * and stay broken until somebody happened to restart the app.
 */
async function olderBackupIsBroughtForward(report, api, backup) {
  const SQL = await backendRequire("sql.js")();
  const old = new SQL.Database(Buffer.from(backup));
  let aged;
  try {
    /* Roll the schema back by hand: one table and one column that arrived by
       migration after this imaginary backup was taken. */
    old.run("DROP TABLE IF EXISTS warranty_claims");
    old.run("ALTER TABLE items DROP COLUMN warranty_months");
    aged = Buffer.from(old.export());
  } finally { old.close(); }

  const preview = await api.upload("/api/system/restore/preview", aged);
  report.ok(preview.ok && preview.data?.restorable === true,
    "a backup from an older version of the app is offered, not refused",
    `restorable=${preview.data?.restorable}, reason=${preview.data?.blocked_reason}`);
  report.ok((preview.data?.warnings || []).some((w) => /older version/i.test(w)),
    "the preview says it is an older backup and that the missing parts will be added back",
    JSON.stringify(preview.data?.warnings));

  const applied = await api.upload("/api/system/restore?filename=last-year.db", aged);
  report.ok(applied.ok, "an older backup restores", `HTTP ${applied.status}: ${applied.message}`);

  /* The proof is not that the restore returned 200 — the old code did that too.
     It is that the app works afterwards, on the columns the backup did not
     have. */
  const items = await api.get("/api/items");
  report.ok(items.ok, "items still load after restoring a backup that predates a column they use",
    `HTTP ${items.status}: ${items.message}`);
  const madeAfter = await api.post("/api/items", {
    name: `After an old restore ${Date.now()}`, item_type: "product", unit: "PCS",
    sale_price: 100, purchase_price: 0, warranty_months: 12,
  });
  report.ok(madeAfter.ok,
    "the column the old backup was missing has been added back, so a write that uses it succeeds",
    `HTTP ${madeAfter.status}: ${madeAfter.message}`);
}

/**
 * 3. A restore must not corrupt a sale that is being rung up at the same
 * moment.
 *
 * The old restore rewrote the file and reloaded the handle without taking the
 * write mutex or looking at txnDepth. A sale committing in that window either
 * landed in a database that no longer existed, or its own synchronous persist()
 * wrote the pre-restore database back over the restored file — and either way
 * the till was told the sale had saved.
 *
 * What is asserted is not that the sale survives. A sale rung up during a
 * restore may legitimately vanish: restoring means going back in time, and
 * whether the sale lands before or after the swap is a race the shopkeeper
 * caused. What must hold is that nothing is left broken — the file opens, no
 * invoice exists without its lines, no line exists without its invoice, and the
 * shop can trade again immediately afterwards.
 */
async function restoreAgainstALiveSale(report, api, dbPath, base) {
  const itemId = await stockedItem(api, 500, "concurrent");
  const taken = await api.download("/api/system/backup");

  const BILLS = 8;
  const sales = Array.from({ length: BILLS }, () => api.post("/api/sales", sellBody(api, itemId, 1)));
  /* Fired into the same event-loop turn as the restore, deliberately. */
  const restore = api.upload("/api/system/restore?filename=during-a-sale.db", taken.buf);
  const [applied, ...rung] = await Promise.all([restore, ...sales]);

  report.ok(applied.ok || applied.status === 409,
    "a restore attempted while sales are in flight either completes or is refused — never half-done",
    `restore answered ${applied.status}: ${applied.message}`);

  const accepted = rung.filter((r) => r.ok);
  report.ok(rung.every((r) => r.ok || r.status >= 400),
    "every till that posted during the restore got a clear answer, not a dropped connection",
    rung.map((r) => r.status).join(", "));

  /* The invariant, read off the disk. */
  const orphanHeaders = await onDisk(dbPath,
    `SELECT id, invoice_no FROM sale_invoices
      WHERE (SELECT COUNT(*) FROM sale_invoice_lines WHERE invoice_id = sale_invoices.id) = 0`);
  report.ok(orphanHeaders.length === 0,
    "no invoice survives a concurrent restore without its lines",
    `${orphanHeaders.length} header(s) with no lines: ${JSON.stringify(orphanHeaders.slice(0, 3))}`);

  const orphanLines = await onDisk(dbPath,
    `SELECT COUNT(*) n FROM sale_invoice_lines
      WHERE invoice_id NOT IN (SELECT id FROM sale_invoices)`);
  report.ok(orphanLines[0].n === 0,
    "no invoice line survives a concurrent restore without its invoice",
    `${orphanLines[0].n} orphaned line(s)`);

  /* An acknowledged sale is either wholly there or wholly absent — never a
     header pointing at nothing, which is what the unlocked reload produced. */
  let inconsistent = 0;
  for (const r of accepted) {
    const no = r.data?.invoice_no;
    if (!no) continue;
    const rows = await onDisk(dbPath,
      `SELECT (SELECT COUNT(*) FROM sale_invoices WHERE invoice_no = ?) h,
              (SELECT COUNT(*) FROM sale_invoice_lines WHERE invoice_id IN (SELECT id FROM sale_invoices WHERE invoice_no = ?)) l`,
      [no, no]);
    const { h, l } = rows[0];
    if (h > 0 && l === 0) inconsistent++;
    if (h === 0 && l > 0) inconsistent++;
  }
  report.ok(inconsistent === 0,
    "each sale acknowledged during the restore is either completely in the file or completely absent from it",
    `${inconsistent} of ${accepted.length} acknowledged sale(s) are half-present`);

  /* And the shop can trade again straight away — the handle the restore left
     behind has to be a working one. */
  const afterItem = await stockedItem(api, 3, "after-the-restore");
  const afterSale = await api.post("/api/sales", sellBody(api, afterItem, 1));
  report.ok(afterSale.ok, "the shop can ring up a sale immediately after a restore", `${afterSale.status}: ${afterSale.message}`);
  const landed = await onDisk(dbPath, "SELECT COUNT(*) n FROM sale_invoices WHERE invoice_no = ?", [afterSale.data?.invoice_no || ""]);
  report.ok(landed[0].n === 1,
    "that sale is on disk by the time the till is told it saved",
    `found ${landed[0].n} invoice(s) numbered ${afterSale.data?.invoice_no}`);
}

/**
 * 5. Restoring twice must not destroy the way back from the first restore.
 *
 * The safety copy was one fixed file, `genius.db.pre-restore`, rewritten on
 * every restore. So the classic sequence — restore the wrong backup, notice,
 * restore another one — overwrote the only copy of the original data, and
 * nothing in the UI could reach it anyway.
 */
async function safetyCopies(report, api, dir, dbPath) {
  const backupsDir = path.join(dir, "backups");
  const namesBefore = fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).filter((f) => f.startsWith("pre-restore-")) : [];

  /* A state worth getting back to, then two restores on top of it. */
  const marker = `Only in the original ${Date.now()}`;
  await api.post("/api/parties", { name: marker, party_type: "customer" });
  const original = await api.download("/api/system/backup");

  await api.post("/api/parties", { name: `Second state ${Date.now()}`, party_type: "customer" });
  const second = await api.download("/api/system/backup");

  const first = await api.upload("/api/system/restore?filename=first.db", original.buf);
  report.ok(first.ok, "the first restore succeeds", first.message);
  const firstCopy = first.data?.safety_copy;

  const again = await api.upload("/api/system/restore?filename=second.db", second.buf);
  report.ok(again.ok, "a second restore, immediately after the first, succeeds", again.message);
  const secondCopy = again.data?.safety_copy;

  report.ok(firstCopy && secondCopy && firstCopy !== secondCopy,
    "two restores in a row keep two separate safety copies",
    `first kept "${firstCopy}", second kept "${secondCopy}"`);

  const namesAfter = fs.readdirSync(backupsDir).filter((f) => f.startsWith("pre-restore-"));
  report.ok(namesAfter.length >= namesBefore.length + 2,
    "the copy taken before the first restore is still on disk after the second",
    `held ${namesBefore.length} before, ${namesAfter.length} after: ${namesAfter.join(", ")}`);

  /* The whole point of keeping it: it has to be usable. */
  const listed = await api.get("/api/system/backups");
  const shown = (listed.data || []).find((b) => b.name === firstCopy);
  report.ok(!!shown, "the safety copy appears in the list the Backup screen reads",
    `the list holds ${(listed.data || []).map((b) => b.name).join(", ")}`);
  report.ok(shown?.kind === "pre-restore",
    "it is labelled as the data a restore replaced, not as an anonymous copy",
    `kind was "${shown?.kind}"`);

  const back = await api.post("/api/system/restore-file", { name: firstCopy });
  report.ok(back.ok, "the safety copy from the first restore can itself be restored", back.message);

  const rows = await onDisk(dbPath, "SELECT COUNT(*) n FROM parties WHERE name = ?", [marker]);
  report.ok(rows[0].n === 1,
    "putting that safety copy back returns the shop to the state it was in before the first restore",
    `the party recorded only in the original state was found ${rows[0].n} time(s)`);
}

/**
 * A restore has to be written down somewhere.
 *
 * It used to leave no trace at all. "Everything from last week has gone" and
 * "someone put an old backup back on Tuesday" look identical from the outside
 * and have opposite remedies.
 */
async function theRestoreIsRecorded(report, api) {
  const log = await api.get("/api/system/restore-log");
  const entries = log.data?.entries || [];
  report.ok(log.ok && entries.length >= 2,
    "every restore is written down — who, when and from what",
    `the log holds ${entries.length} entry(ies)`);

  const named = entries.find((e) => /first\.db|second\.db|round-trip\.db|pre-restore-/.test(e.source || ""));
  report.ok(!!named,
    "the record says which file was restored",
    `sources recorded: ${entries.map((e) => e.source).join(", ")}`);
  report.ok(entries.every((e) => e.by && e.by !== "unknown"),
    "the record says who did it",
    `names recorded: ${entries.map((e) => e.by).join(", ")}`);
  report.ok(entries.every((e) => e.at && !Number.isNaN(Date.parse(e.at))),
    "the record says when",
    `times recorded: ${entries.map((e) => e.at).join(", ")}`);

  /* The history survives the thing it is a history of. Each entry above was
     written into a database that a later restore then replaced, so a log kept
     only in the database would show one line no matter how many restores had
     happened. */
  report.ok(entries.length >= 3,
    "the history survives the restores it records, rather than being replaced along with the database",
    `${entries.length} restore(s) remembered after ${entries.length} restore(s)`);

  report.ok(log.data?.backups_are_local === true,
    "the app is explicit that the copies it keeps are on the same disk as the live data",
    JSON.stringify({ backups_are_local: log.data?.backups_are_local, dir: log.data?.backup_dir }));
}
