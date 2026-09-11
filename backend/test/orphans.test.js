/**
 * orphans.test.js — the referential integrity this schema does not declare.
 *
 * There is not one REFERENCES clause in any of the three setup files, so
 * `PRAGMA foreign_keys = ON` — which db.js is careful to re-apply after every
 * save — enforces nothing and never has. Declaring the keys properly would mean
 * a table rebuild per constraint, and any orphan already sitting in a shop's
 * data would start hard-failing writes at the till.
 *
 * So the check lives here instead, where it can find the same problems and say
 * so without refusing a sale.
 *
 * It runs against a real database when one is present — `GENIUS_DB_PATH`, or
 * `data/genius.db` once the server has created it. On a machine with neither
 * it BUILDS one, by running the seed into a temporary file, rather than
 * reporting that it had nothing to check: a green tick for a check that did
 * not run is worse than no check, and this suite gates whether the app starts
 * at all.
 *
 * That is not a weaker test. A freshly seeded database is exactly what a new
 * shop gets on its first run, so checking it proves the thing most worth
 * proving — that what we hand a new customer is referentially sound — and it
 * does so on every machine rather than only on one where somebody happened to
 * leave a .db lying about.
 */
const fs = require("fs");
const path = require("path");
const { describe, it, expect } = require("./tiny-test");

/* child table → [column, parent table]. Only relationships whose breakage
   would actually mislead somebody: a line pointing at a document that is not
   there, or stock movement against an item that no longer exists. */
const LINKS = [
  ["sale_invoice_lines", "invoice_id", "sale_invoices"],
  ["sale_return_lines", "return_id", "sale_returns"],
  ["purchase_invoice_lines", "bill_id", "purchase_invoices"],
  ["purchase_return_lines", "return_id", "purchase_returns"],
  ["purchase_order_lines", "po_id", "purchase_orders"],
  ["estimate_lines", "estimate_id", "estimates"],
  ["challan_lines", "challan_id", "challans"],
  ["stock_take_lines", "take_id", "stock_takes"],
  ["journal_entry_lines", "entry_id", "journal_entries"],
  ["payment_allocations", "payment_id", "payments"],
  ["price_list_items", "list_id", "price_lists"],
  ["role_permissions", "role_id", "roles"],
  ["bom_components", "bom_id", "boms"],
  ["installment_lines", "plan_id", "installment_plans"],
  ["recurring_lines", "recurring_id", "recurring_docs"],
  ["item_stock", "item_id", "items"],
  ["item_barcodes", "item_id", "items"],
  ["memberships", "firm_id", "firms"],
];

function dbPath() {
  const env = process.env.GENIUS_DB_PATH;
  if (env && fs.existsSync(env)) return env;
  const here = path.join(__dirname, "..", "data", "genius.db");
  if (fs.existsSync(here)) return here;
  return buildOne();
}

/**
 * No database on this machine yet — make one.
 *
 * In a child process, because `database/db.js` reads GENIUS_DB_PATH once when
 * it is first required, and this suite may already have required it for
 * another test. The temporary file is left behind on purpose: it costs a few
 * hundred kilobytes in the OS temp folder and makes a failure reproducible by
 * hand, which a file deleted in a `finally` never is.
 */
let built;                 /* undefined = not tried, null = tried and failed */
let buildFailure = "";
function buildOne() {
  if (built !== undefined) return built;
  const os = require("os");
  const { spawnSync } = require("child_process");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "genius-check-")), "genius.db");
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "seed.js")], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      GENIUS_DB_PATH: tmp,
      /* The suite must not depend on a secret being exported to run it. */
      JWT_SECRET: process.env.JWT_SECRET || "orphans-test-only-not-a-production-secret",
      NODE_ENV: "test",
    }),
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.status !== 0 || !fs.existsSync(tmp)) {
    buildFailure = (r.stderr || r.error || `seed exited ${r.status}`).toString().trim().split("\n").slice(-3).join(" ");
    built = null;
    return null;
  }
  built = tmp;
  return built;
}

/* One scan, memoised, awaited by each check.
 *
 * The first version had the two later checks synchronous, reading variables
 * the async scan had not yet set — so "checked a meaningful number of
 * relationships" saw zero and failed for a reason that had nothing to do with
 * the data. Every check awaits the same promise now, so each one runs against
 * a finished scan. */
let scanning = null;
let checked = 0;
const once = () => (scanning || (scanning = scan()));

async function scan() {
  const p = dbPath();
  if (!p) {
    return { skipped: buildFailure
      ? "could not build a database to check: " + buildFailure
      : "no database file to check" };
  }
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(p));
  const out = [];
  try {
    const tables = new Set(
      (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0] || { values: [] })
        .values.map((r) => r[0]));
    for (const [child, col, parent] of LINKS) {
      if (!tables.has(child) || !tables.has(parent)) continue;
      try {
        const res = db.exec(
          `SELECT COUNT(*) FROM ${child} WHERE ${col} IS NOT NULL ` +
          `AND ${col} NOT IN (SELECT id FROM ${parent})`);
        checked++;
        const n = res.length ? res[0].values[0][0] : 0;
        if (n > 0) out.push(`${child}.${col} → ${parent}: ${n} orphan${n === 1 ? "" : "s"}`);
      } catch (e) {
        if (!/no such column/i.test(e.message)) throw e;
      }
    }
  } finally { db.close(); }
  return { findings: out };
}

describe("referential integrity (the schema declares none, so this does)", () => {
  it("has a database to check", async () => {
    const r = await once();
    /* Reported, not silently skipped: a green tick for a check that did not
       run is worse than no check. */
    expect(r.skipped || "checked").toBe("checked");
  });

  it("checked a meaningful number of relationships", async () => {
    await once();
    expect(checked >= 10).toBe(true);
  });

  it("finds no orphaned rows", async () => {
    const findings = (await once()).findings;
    /* If this fails, the message names every broken relationship and how many
       rows are affected. An orphan is not necessarily a bug to fix by deleting
       — some may be deliberate — but it is always something to look at, and
       until now nothing in this application would ever have mentioned it. */
    expect((findings || []).join(" | ")).toBe("");
  });
});
