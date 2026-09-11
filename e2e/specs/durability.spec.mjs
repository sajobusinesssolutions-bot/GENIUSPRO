/**
 * durability.spec.mjs — "saved" has to survive the power going off.
 *
 * The database lives in memory (sql.js) and is written to disk by exporting the
 * whole file. A bare `query()` write rides an end-of-turn `setImmediate` flush
 * that runs *after* the reply has already gone to the socket, so a machine that
 * dies in that window loses a write the till was told had succeeded. A write
 * made inside a transaction does not: `commit()` exports synchronously, before
 * the route answers.
 *
 * Each write below is therefore checked twice, and neither check is a race:
 *
 *   1. The moment the 200 comes back — before another request is sent — the
 *      database *file* is read straight off the disk with sql.js, behind the
 *      server's back. The row has to be in those bytes already. This is the
 *      whole property in one assertion: the flush cannot be "about to happen",
 *      because nothing has given the server another turn in which to do it.
 *   2. Then the server is SIGKILLed with no request in between — no exit
 *      handler, no final flush, exactly like the plug coming out — a fresh one
 *      is started against the same file, and the write is asked for over HTTP.
 *
 * What is asserted is the invariant, never a timing: after the kill and the
 * restart, an acknowledged write is *there*, and a refused one is *cleanly
 * absent* — no parent without its children, no half-document.
 *
 * Why it runs its own server. The harness boots one backend for the whole suite
 * and every other spec is still using it; this one has to kill its server with
 * SIGKILL — no exit handler, no final flush, exactly like the plug coming out —
 * and then reopen the same file. So, like access.spec.mjs and scale.spec.mjs,
 * it takes its own copy of the database and runs its own backend on its own
 * port.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = Number(process.env.E2E_DURABILITY_PORT || (Number(process.env.E2E_PORT || 3199) + 300));
const BASE = `http://localhost:${PORT}`;

/* sql.js is the backend's own dependency — the suite installs nothing. It is
   used here to read the database file directly, without the server, which is
   the only way to ask "is this actually on disk?" rather than "does the server
   still remember it?". */
const backendRequire = createRequire(path.join(BACKEND, "package.json"));

export const name = "an acknowledged write survives the power going off";

/* ── one backend, on its own port, against our own copy of the file ──────── */

function copyDatabase() {
  const src = path.join(BACKEND, "data", "genius.db");
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-durability-"));
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
  throw new Error("The durability-spec backend never became healthy.\n" + log.join(""));
}

/** Pull the plug. SIGKILL cannot be trapped, so no flush-on-exit runs. */
async function pullThePlug(proc) {
  const gone = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGKILL");
  await gone;
  /* The port has to be free before the replacement can bind to it. */
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * Read the database file as it is on disk this instant, with no server in the
 * way. Called immediately after an acknowledgement and before anything else is
 * sent, so the server has had no further event-loop turn in which to flush: if
 * the row is here, the write was on disk before the client was told about it.
 */
async function onDisk(dbPath, sql, params = []) {
  const initSqlJs = backendRequire("sql.js");
  const SQL = await initSqlJs();
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

/* ── tiny request helper ─────────────────────────────────────────────────── */

function client(token, extraHeaders = {}) {
  const call = async (method, url, data) => {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not every reply is json */ }
    return { status: res.status, body, data: body && body.data, message: body && body.message };
  };
  return {
    get: (u) => call("GET", u),
    post: (u, d) => call("POST", u, d ?? {}),
    put: (u, d) => call("PUT", u, d ?? {}),
    del: (u, d) => call("DELETE", u, d ?? {}),
  };
}

async function signIn(extraHeaders) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Could not sign in: ${body?.message}`);
  return client(body.data.token, extraHeaders);
}

/* ── the spec ────────────────────────────────────────────────────────────── */

export async function run({ report }) {
  const { dir, dbPath } = copyDatabase();
  let proc = null;
  try {
    proc = await startBackend(dbPath);

    /* One kill per write. They are deliberately not batched: a kill that comes
       after three more requests proves nothing, because those requests gave the
       server the turns it needed to flush anyway. */
    for (const write of WRITES) {
      proc = await survivesThePlug(report, proc, dbPath, write);
    }

    await twoTillsOnOneLogin(report);
  } finally {
    if (proc) { proc.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 200)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One acknowledged write, checked on disk, then killed and asked for again.
 *
 * `write` supplies everything about the case: how to make it (`act`), what the
 * row looks like on disk (`disk`), how to read it back over HTTP (`check`), and
 * the sentence each assertion should be able to say.
 */
async function survivesThePlug(report, proc, dbPath, write) {
  const api = await signIn();
  const made = await write.act(api, report);
  if (made === null) { report.ok(false, `${write.what} is accepted`, "the write never got as far as being made"); return proc; }

  /* Nothing else is sent between the acknowledgement and these two lines. */
  const rows = await onDisk(dbPath, write.disk.sql, write.disk.params(made));
  report.ok(write.disk.ok(rows, made),
    `${write.what} is in the file on disk by the time the server says it saved`,
    `the database file holds ${JSON.stringify(rows)}`);

  await pullThePlug(proc);
  const restarted = await startBackend(dbPath);
  const after = await signIn();
  const found = await write.check(after, made);
  report.ok(found.pass,
    `${write.what} is still there after the power cut`,
    found.detail);
  return restarted;
}

const stamp = Date.now();

/* A representative spread: a preference, an item edit, a party edit, and one
   multi-statement document. */
const WRITES = [
  {
    what: "a settings change",
    async act(api, report) {
      const settings = (await api.get("/api/settings")).data;
      const key = "prevent_negative_stock";
      if (!report.ok(settings.catalog.some((c) => c.key === key),
        "the setting this spec writes is one the app actually offers",
        `${key} is not in the settings catalogue — pick another key`)) return null;
      const was = settings.values[key];
      const want = was === "1" ? "0" : "1";
      const saved = await api.put("/api/settings", { [key]: want });
      if (saved.status !== 200) return null;
      return { key, want, was };
    },
    disk: {
      sql: "SELECT svalue FROM firm_settings WHERE firm_id = 1 AND skey = ?",
      params: (m) => [m.key],
      ok: (rows, m) => rows.length === 1 && rows[0].svalue === m.want,
    },
    async check(api, m) {
      const v = (await api.get("/api/settings")).data.values[m.key];
      return { pass: v === m.want, detail: `${m.key} is "${v}", expected "${m.want}" (was "${m.was}")` };
    },
  },
  {
    what: "an item edit",
    async act(api) {
      const items = (await api.get("/api/items")).data;
      const item = (items.rows || items)[0];
      const name = `Durable Item ${stamp}`;
      const saved = await api.put(`/api/items/${item.id}`, { name });
      if (saved.status !== 200) return null;
      return { id: item.id, name };
    },
    disk: {
      sql: "SELECT name FROM items WHERE id = ?",
      params: (m) => [m.id],
      ok: (rows, m) => rows.length === 1 && rows[0].name === m.name,
    },
    async check(api, m) {
      const got = (await api.get(`/api/items/${m.id}`)).data;
      const name = (got.item || got).name;
      return { pass: name === m.name, detail: `item ${m.id} is named "${name}", expected "${m.name}"` };
    },
  },
  {
    what: "a party edit",
    async act(api) {
      const parties = (await api.get("/api/parties")).data;
      const party = (parties.rows || parties)[0];
      const phone = `0700${String(stamp).slice(-6)}`;
      const saved = await api.put(`/api/parties/${party.id}`, { name: party.name, phone });
      if (saved.status !== 200) return null;
      return { id: party.id, phone };
    },
    disk: {
      sql: "SELECT phone FROM parties WHERE id = ?",
      params: (m) => [m.id],
      ok: (rows, m) => rows.length === 1 && rows[0].phone === m.phone,
    },
    async check(api, m) {
      const got = (await api.get(`/api/parties/${m.id}`)).data;
      const phone = (got.party || got).phone;
      return { pass: phone === m.phone, detail: `party ${m.id} has phone "${phone}", expected "${m.phone}"` };
    },
  },
  {
    /* The multi-statement one: a header row and two line rows, which have to
       arrive together or not at all. */
    what: "a purchase order and both of its lines",
    async act(api, report) {
      const items = (await api.get("/api/items")).data;
      const item = (items.rows || items)[0];
      const parties = (await api.get("/api/parties")).data;
      const party = (parties.rows || parties)[0];

      /* Refused first, and never acknowledged: whatever the next request does,
         this one must have left nothing behind. */
      const refused = await api.post("/api/purchase-orders", { party_id: party.id, lines: [] });
      report.ok(refused.status >= 400,
        "an order with no lines is refused rather than half-written", refused.message);

      const saved = await api.post("/api/purchase-orders", {
        party_id: party.id, note: `Durability ${stamp}`,
        lines: [{ item_id: item.id, quantity: 3, rate: 100 },
                { item_id: item.id, quantity: 2, rate: 250 }],
      });
      if (saved.status !== 200 || !saved.data?.po_no) return null;
      return { id: saved.data.id, po_no: saved.data.po_no, note: `Durability ${stamp}` };
    },
    disk: {
      sql: `SELECT (SELECT COUNT(*) FROM purchase_orders WHERE po_no = ?) AS header,
                   (SELECT COUNT(*) FROM purchase_order_lines WHERE po_id = ?) AS lines`,
      params: (m) => [m.po_no, m.id],
      ok: (rows) => rows.length === 1 && rows[0].header === 1 && rows[0].lines === 2,
    },
    async check(api, m) {
      const list = (await api.get("/api/purchase-orders")).data;
      const orders = list.rows || list;
      const po = orders.find((o) => o.po_no === m.po_no);
      if (!po) return { pass: false, detail: `${m.po_no} is not among the ${orders.length} order(s) on disk` };
      const lines = (await api.get(`/api/purchase-orders/${po.id}`)).data.lines || [];
      const strays = orders.filter((o) => o.note === m.note && o.po_no !== m.po_no).length;
      return {
        pass: lines.length === 2 && strays === 0,
        detail: `${m.po_no} came back with ${lines.length} line(s) (expected 2)` +
                (strays ? `, and ${strays} order(s) survived from a request that was refused` : ""),
      };
    },
  },
];

/**
 * Two browsers signed in as the same account are two tills, and only one of
 * them may resume a held bill. The claim used to be keyed on the user id alone,
 * so both won and table 4's order was rung up twice.
 */
async function twoTillsOnOneLogin(report) {
  const tillA = await signIn({ "X-Client-Id": `till-a-${Date.now()}` });
  const tillB = await signIn({ "X-Client-Id": `till-b-${Date.now()}` });
  const legacy = await signIn();   // an old client that sends no header at all

  const hold = async (label) => {
    const r = await tillA.post("/api/pos/held", {
      label, total_hint: 1000,
      payload: { lines: [{ description: "Durability", quantity: 1, rate: 1000 }] },
    });
    if (r.status !== 200) throw new Error(`Could not hold a bill: ${r.message}`);
    const held = (await tillA.get("/api/pos/held")).data;
    return held.find((h) => h.label === label);
  };

  /* ── the bug ── */
  const bill = await hold(`Durability A ${Date.now()}`);
  const first = await tillA.get(`/api/pos/held/${bill.id}`);
  report.ok(first.status === 200, "the till that presses a held bill first gets it", first.message);
  const second = await tillB.get(`/api/pos/held/${bill.id}`);
  report.ok(second.status === 409,
    "a second till on the same login is refused the bill the first one is resuming",
    `it answered ${second.status}: ${second.message}`);
  report.ok(/another till/i.test(second.message || ""),
    "the refusal says another till has it, not that the user has it",
    second.message);

  /* ── the retry that must still work ── */
  const retry = await tillA.get(`/api/pos/held/${bill.id}`);
  report.ok(retry.status === 200,
    "the till that holds the claim can still retry its own resume", retry.message);
  const removed = await tillA.del(`/api/pos/held/${bill.id}`);
  report.ok(removed.status === 200, "the till that won the claim can finish the resume", removed.message);

  /* ── the old client ── */
  const oldBill = await hold(`Durability B ${Date.now()}`);
  const oldFirst = await legacy.get(`/api/pos/held/${oldBill.id}`);
  report.ok(oldFirst.status === 200,
    "a client that sends no client id can still resume a held bill", oldFirst.message);
  const oldRetry = await legacy.get(`/api/pos/held/${oldBill.id}`);
  report.ok(oldRetry.status === 200,
    "a client that sends no client id can still retry its own resume", oldRetry.message);
  await legacy.del(`/api/pos/held/${oldBill.id}`);
}
