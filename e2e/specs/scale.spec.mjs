/**
 * scale.spec.mjs — what happens when the shop has actually been trading.
 *
 * Every other spec runs against the shipped database: two items, six invoices,
 * two users. On that data an unbounded report and a bounded one look identical,
 * a missing index costs nothing, and a leak that fires on the 327,680th call
 * never fires. Three things went wrong here and none of them were visible at
 * that size:
 *
 *   1. `db.exec()` in sql.js 1.14.1 takes 16 bytes off the 5 MB wasm stack on
 *      every call and never gives it back. database/db.js used it to read
 *      last_insert_rowid() after every write, so the process had a hard budget
 *      of ~328,000 writes and then died with "memory access out of bounds",
 *      whatever the database held. It read as a data-volume ceiling. It was not
 *      one — an empty database dies at the same call count.
 *   2. Reports sent their whole result set. The sale summary was 20,300 rows on
 *      a two-year shop and 64 MB of JSON on a ten-year one, with nothing to say
 *      it was large and no way to ask for less.
 *   3. Correlated subqueries keyed on a child column alone — `WHERE
 *      s.party_id = p.id` — could not use the composite `(firm_id, party_id)`
 *      indexes, so /api/accounting/integrity scanned the invoice table once per
 *      customer: 220 seconds at 300,000 invoices.
 *
 * This spec seeds a shop big enough for all three to show and asserts on
 * behaviour and shape, not milliseconds — timings are printed as information
 * because a loaded CI box makes any hard threshold a coin toss. What is
 * asserted is that a response is bounded, that the bound announces itself,
 * that bounding it did not change any number, and that nothing hangs.
 *
 * Why it runs its own server. The suite's harness copies the *shipped*
 * database, which is the small one — the point of this spec. So, like
 * access.spec.mjs, it builds its own database first and boots its own backend
 * on its own port against it.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = Number(process.env.E2E_SCALE_PORT || (Number(process.env.E2E_PORT || 3199) + 200));
const BASE = `http://localhost:${PORT}`;

/* Big enough that every bound below is actually crossed, small enough that the
   whole spec is under a minute. The wall this found was at 20,000; catching a
   regression does not need to reach it. */
const INVOICES = Number(process.env.E2E_SCALE_INVOICES || 4000);

/* Generous, and deliberately not a performance assertion. Anything that takes
   longer than this on a shop this size is hung, not slow. */
const NO_HANG_MS = 60000;

/* modules/reports/reports.routes.js caps report bodies here. Kept in step by asserting the header
   the server sends rather than this constant, wherever it can be. */
const REPORT_ROW_CAP = 5000;

/* sql.js is the backend's own dependency; the suite installs nothing. */
const backendRequire = createRequire(path.join(BACKEND, "package.json"));

export const name = "a shop that has been trading for two years";

/* ── a generated shop ────────────────────────────────────────────────────── */

function seedLargeShop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-scale-"));
  const dbPath = path.join(dir, "genius.db");
  /* seed-large.js refuses to touch backend/data/genius.db and takes its target
     from GENIUS_DB_PATH, so this cannot land anywhere but the temp dir. */
  execFileSync(process.execPath, ["seed-large.js", `--invoices=${INVOICES}`, "--quiet"], {
    cwd: BACKEND,
    env: { ...process.env, GENIUS_DB_PATH: dbPath },
    stdio: "pipe",
    timeout: 300000,
  });
  return { dir, dbPath, bytes: fs.statSync(dbPath).size };
}

async function startServer(dbPath) {
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

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return { proc, log }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error("The scale-spec backend never became healthy.\n" + log.join(""));
}

/* ── requests ────────────────────────────────────────────────────────────── */

function client(request, token) {
  return async (url) => {
    const t0 = Date.now();
    let res, body = null, text = "";
    try {
      res = await request.fetch(BASE + url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
        timeout: NO_HANG_MS,
      });
      text = await res.text();
      try { body = JSON.parse(text); } catch { /* not every reply is json */ }
    } catch (e) {
      return { url, ms: Date.now() - t0, status: 0, error: e.message, bytes: 0, headers: {} };
    }
    return {
      url,
      ms: Date.now() - t0,
      status: res.status(),
      headers: res.headers(),
      bytes: text.length,
      body,
      data: body && body.data,
      rows: Array.isArray(body?.data) ? body.data : (Array.isArray(body?.data?.rows) ? body.data.rows : null),
    };
  };
}

async function tokenFor(request, username, password) {
  const res = await request.fetch(`${BASE}/api/auth/login`, {
    method: "POST", data: { username, password }, failOnStatusCode: false,
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Could not sign in as ${username}: ${body?.message}`);
  return body.data.token;
}

/** Every report the catalog exposes, read from the router itself so a report
 *  added later is covered without anybody remembering to add it here. */
function reportPaths() {
  const src = fs.readFileSync(path.join(BACKEND, "modules", "reports", "reports.routes.js"), "utf8");
  const found = [...src.matchAll(/router\.get\(\s*"(\/[^"]*)"/g)].map((m) => m[1]);
  /* Two take a path parameter; they are covered by the party statement check. */
  return [...new Set(found.filter((p) => !p.includes(":")))];
}

/* ── the spec ────────────────────────────────────────────────────────────── */

export async function run({ browser, report }) {
  const ctx = await browser.newContext();
  let shop, server;
  try {
    report.info(`Generating ${INVOICES} invoices of trading…`);
    const tSeed = Date.now();
    shop = seedLargeShop();
    report.info(`seeded ${(shop.bytes / 1048576).toFixed(1)} MB in ${((Date.now() - tSeed) / 1000).toFixed(0)}s`);

    /* The seed used to die part-way through a 20,000-invoice run and leave a
       truncated file behind, so "it produced a database at all" is the first
       thing worth asserting. */
    report.ok(shop.bytes > 3 * 1024 * 1024,
      "the seeder builds a multi-megabyte shop without running out of wasm memory",
      `file is ${(shop.bytes / 1048576).toFixed(1)} MB`);

    const tBoot = Date.now();
    server = await startServer(shop.dbPath);
    const bootMs = Date.now() - tBoot;
    report.ok(true, "the app opens a two-year database and answers", `boot ${(bootMs / 1000).toFixed(1)}s`);

    const get = client(ctx.request, await tokenFor(ctx.request, "admin", "admin123"));

    await writesDoNotRunOut(report);
    await listsAnnounceTheirBound(get, report);
    await reportsAreBoundedAndStillCorrect(get, report);
    await nothingHangs(get, report);
  } finally {
    server?.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
    if (server && !server.proc.killed) server.proc.kill("SIGKILL");
    if (shop) fs.rmSync(shop.dir, { recursive: true, force: true });
    await ctx.close();
  }
}

/* ── 1. the write budget ─────────────────────────────────────────────────── */

/**
 * The leak was in how db.js read back the row id after a write, and it fired
 * at a fixed call count with no relation to the data. Driving 328,000 writes
 * over HTTP would take the whole afternoon, so this exercises the same two
 * calls db.js makes — the write, then the row-id read — directly against
 * sql.js, past the point where the old code died.
 *
 * If someone reintroduces db.exec() on that path, this fails in about ten
 * seconds with the exact error the scale work started from.
 */
async function writesDoNotRunOut(report) {
  const initSqlJs = backendRequire("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE t (a INTEGER)");

  /* The old ceiling was 327,680 calls (5 MB of wasm stack, 16 bytes a call);
     measured, an empty database died on call 328,905. Going past 400,000
     proves the budget is gone rather than merely larger. */
  const CALLS = 400000;
  const t0 = Date.now();
  let done = 0, failure = null;
  try {
    for (; done < CALLS; done++) {
      db.run("INSERT INTO t VALUES (1)");
      const stmt = db.prepare("SELECT last_insert_rowid() AS id");
      try { stmt.step(); stmt.get(); } finally { stmt.free(); }
    }
  } catch (e) { failure = e.message; }
  db.close();

  report.ok(failure === null && done === CALLS,
    "the storage layer can write for ever, not 328,000 times",
    failure ? `died after ${done} writes: ${failure}` : undefined);
  report.info(`${CALLS.toLocaleString()} writes + row-id reads in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* Comments stripped first — this file's own explanation of the bug names it. */
  const source = fs.readFileSync(path.join(BACKEND, "database", "db.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  report.ok(!/\bdb\.exec\(/.test(source),
    "the storage layer does not call sql.js's leaking exec()",
    "database/db.js must use prepare()/step()/free(); exec() never restores the wasm stack");
}

/* ── 2. list endpoints ───────────────────────────────────────────────────── */

/**
 * A list that quietly returns its first 500 of 4,000 rows reads as "this is all
 * of it", which is the worst answer a books system can give. shared/paginate.js
 * already says so on a header; this checks the shop-sized case actually trips it,
 * and that asking for a page instead gives an honest total.
 */
async function listsAnnounceTheirBound(get, report) {
  for (const url of ["/api/sales", "/api/items", "/api/parties"]) {
    const r = await get(url);
    if (!report.ok(r.status === 200 && Array.isArray(r.rows), `${url} answers with a list`,
      `status ${r.status}${r.error ? ` — ${r.error}` : ""}`)) continue;

    const cap = Number(r.headers["x-result-limit"]);
    report.ok(r.rows.length <= cap,
      `${url} sends no more rows than the limit it declares`,
      `${r.rows.length} rows against a declared limit of ${cap}`);
    report.ok(r.rows.length < cap || r.headers["x-result-truncated"] === "true",
      `${url} says so when it has left rows out`,
      `${r.rows.length} rows at the cap with no X-Result-Truncated header`);
    report.info(`${url}: ${r.rows.length} rows, ${(r.bytes / 1024).toFixed(0)} KB, ${r.ms}ms`);
  }

  const paged = await get("/api/sales?page=1&limit=50");
  report.ok(paged.status === 200 && Array.isArray(paged.data?.rows) && paged.data.rows.length === 50,
    "a paged sales request returns exactly the page asked for",
    `got ${paged.data?.rows?.length} rows`);
  report.ok(paged.data?.total > 500 && paged.data?.pages > 10,
    "a paged sales request reports the true total, not the page",
    `total ${paged.data?.total}, pages ${paged.data?.pages}`);
}

/* ── 3. reports ──────────────────────────────────────────────────────────── */

/**
 * The bound on a report body is only acceptable if it changed no number. The
 * check is direct: ask for the sale summary twice, once cut down to 25 rows and
 * once at the full cap, and require the totals block to be identical. Totals are
 * computed over the whole query and only the listing is cut; if that ever stops
 * being true, this fails.
 */
async function reportsAreBoundedAndStillCorrect(get, report) {
  const full = await get("/api/reports/sale-summary");
  const tiny = await get("/api/reports/sale-summary?limit=25");

  report.ok(full.status === 200 && tiny.status === 200, "the sale summary answers on a two-year shop",
    `full ${full.status}, limited ${tiny.status}`);
  report.ok(tiny.rows?.length === 25 && tiny.headers["x-result-truncated"] === "true",
    "a report cut short says so on X-Result-Truncated",
    `${tiny.rows?.length} rows, truncated header ${tiny.headers?.["x-result-truncated"]}`);
  report.ok(JSON.stringify(tiny.data?.totals) === JSON.stringify(full.data?.totals),
    "cutting a report's row list does not change its totals",
    `25 rows totalled ${JSON.stringify(tiny.data?.totals)} but the full report totalled ${JSON.stringify(full.data?.totals)}`);
  report.info(`sale-summary: ${full.rows?.length} rows, ${(full.bytes / 1024).toFixed(0)} KB, ${full.ms}ms`);

  /* And every report in the catalog, not just the one that was noticed. */
  const paths = reportPaths();
  const bad = [], oversize = [], slow = [];
  for (const p of paths) {
    const r = await get(`/api/reports${p}`);
    if (r.status !== 200) { bad.push(`${p} → ${r.status}${r.error ? ` ${r.error}` : ""}`); continue; }
    const declared = Number(r.headers["x-result-limit"] || REPORT_ROW_CAP);
    if (r.rows && r.rows.length > declared) oversize.push(`${p} sent ${r.rows.length} of a declared ${declared}`);
    if (r.bytes > 8 * 1024 * 1024) oversize.push(`${p} sent ${(r.bytes / 1048576).toFixed(1)} MB`);
    if (r.ms > 5000) slow.push(`${p} ${r.ms}ms`);
  }
  report.ok(bad.length === 0, `all ${paths.length} reports answer on a shop this size`, bad.slice(0, 6).join("\n      "));
  report.ok(oversize.length === 0, "no report sends an unbounded body", oversize.slice(0, 6).join("\n      "));
  if (slow.length) report.info(`slowest reports: ${slow.sort().slice(0, 5).join(", ")}`);
}

/* ── 4. the endpoints that used to scan the whole table ──────────────────── */

/**
 * These are the ones the new indexes in database/setup.js exist for. The
 * assertion is "it came back", not "it came back in 400ms" — on a loaded box
 * the second is a coin toss, and the failure being guarded against is not a
 * slow report but a report that scans the invoice table once per customer and
 * effectively never returns. The measured times are printed so a regression is
 * visible to a human reading the log even when the assertion passes.
 */
async function nothingHangs(get, report) {
  const heavy = [
    "/api/accounting/integrity",
    "/api/reports/stock-summary",
    "/api/reports/profit-margin",
    "/api/reports/item-sales",
    "/api/reports/general-ledger",
    "/api/reports/slow-moving",
    "/api/dashboard",
    "/api/dashboard/badges",
  ];
  const timings = [];
  for (const url of heavy) {
    const r = await get(url);
    timings.push(`${url.replace("/api/", "")} ${r.ms}ms`);
    report.ok(r.status === 200, `${url} completes rather than scanning for ever`,
      `status ${r.status} after ${r.ms}ms${r.error ? ` — ${r.error}` : ""}`);
  }
  report.info(timings.join(", "));
}
