/**
 * reversal.test.js — a journal entry may be reversed once, and only once.
 *
 * The fault this pins down was silent. Amending a document is "reverse what
 * was posted, then post again under the same source", which leaves an
 * already-reversed entry filed there. Voiding the document later reversed it a
 * second time, putting an amount into the accounts that no document ever
 * justified. Every reversal is itself a balanced entry, so the trial balance
 * agreed throughout and nothing anywhere raised a flag.
 *
 * Run against a real SQLite file rather than a mock, because the guard IS a
 * WHERE clause — a fake that returns whatever the test hands it would prove
 * nothing about whether the query filters.
 */
const { describe, it, expect } = require("./tiny-test");

/* A minimal `conn` over sql.js directly, rather than the app's db module.
 *
 * The poster only ever needs `query(sql, params) -> { rows, insertId }`, and
 * building that here keeps this a real unit test: it cannot be knocked over by
 * an unrelated migration, and it does not fight the other suites in this
 * process for the single shared database handle that db.js keeps.
 */
let ready = null;
function db() {
  if (ready) return ready;
  ready = (async () => {
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs();
    const d = new SQL.Database();
    const run = (sql, params = []) => {
      const head = sql.trimStart().toUpperCase();
      if (head.startsWith("SELECT")) {
        const st = d.prepare(sql);
        try {
          st.bind(params);
          const rows = [];
          while (st.step()) rows.push(st.getAsObject());
          return { rows, insertId: null };
        } finally { st.free(); }
      }
      d.run(sql, params);
      const r = d.exec("SELECT last_insert_rowid() AS id");
      return { rows: [], insertId: r.length ? r[0].values[0][0] : null };
    };
    run(`CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, firm_id INTEGER, entry_no TEXT, entry_date TEXT,
      description TEXT, reference TEXT, source_module TEXT, source_id INTEGER,
      created_by INTEGER, reversed_at TEXT, client_ref TEXT)`);
    run(`CREATE TABLE journal_entry_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, firm_id INTEGER, entry_id INTEGER,
      account_code TEXT, debit REAL, credit REAL, narration TEXT)`);
    run(`CREATE TABLE account_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, firm_id INTEGER, account_code TEXT, balance REAL)`);
    run(`CREATE TABLE chart_of_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, firm_id INTEGER, code TEXT, name TEXT)`);
    run(`CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER)`);
    for (const c of ["4001", "1001"]) run("INSERT INTO chart_of_accounts (firm_id, code, name) VALUES (1,?,?)", [c, c]);
    const poster = require("../shared/accounting.poster");
    return { query: run, conn: { query: run }, ...poster };
  })();
  return ready;
}

const balanceOf = async (query, code) =>
  Math.round(((await query("SELECT COALESCE(balance,0) b FROM account_balances WHERE firm_id=1 AND account_code=?",
    [code])).rows[0] || { b: 0 }).b * 100) / 100;

const sale = (c, amount) => c.postJournal(c.conn, {
  firmId: 1, date: "2026-01-01", description: `Sale ${amount}`, sourceModule: "sales", sourceId: 7,
  lines: [{ account_code: "1001", debit: amount }, { account_code: "4001", credit: amount }],
});
const reverse = (c, id = 7) => c.reverseJournal(c.conn, {
  firmId: 1, sourceModule: "sales", sourceId: id, date: "2026-01-02", description: "Void INV-1",
});

describe("reverseJournal", () => {
  it("posts what it was given", async () => {
    const c = await db();
    await sale(c, 100000);
    expect(await balanceOf(c.query, "4001")).toBe(-100000);   // income is credit-natured
  });

  it("an amendment leaves the corrected figure, not the sum of both", async () => {
    const c = await db();
    await reverse(c);          // the amend's first half
    await sale(c, 80000);      // and its second
    expect(await balanceOf(c.query, "4001")).toBe(-80000);
  });

  it("voiding afterwards reverses only the entry still standing", async () => {
    /* The whole bug in one line: there are two `sales/7` entries by now and
       one of them has already been taken back. */
    const c = await db();
    expect(await reverse(c)).toBe(1);
    expect(await balanceOf(c.query, "4001")).toBe(0);
  });

  it("and reversing again does nothing at all", async () => {
    const c = await db();
    expect(await reverse(c)).toBe(0);
    expect(await balanceOf(c.query, "4001")).toBe(0);
  });

  it("stamps every entry it reverses", async () => {
    const c = await db();
    expect((await c.query("SELECT COUNT(*) n FROM journal_entries WHERE source_module='sales' AND reversed_at IS NULL"))
      .rows[0].n).toBe(0);
  });

  it("never stamps the reversals themselves — they are entries too", async () => {
    const c = await db();
    expect((await c.query("SELECT COUNT(*) n FROM journal_entries WHERE source_module='sales_void' AND reversed_at IS NOT NULL"))
      .rows[0].n).toBe(0);
  });

  it("leaves debits equal to credits throughout", async () => {
    const c = await db();
    const t = (await c.query("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) cr FROM journal_entry_lines")).rows[0];
    expect(Math.round((t.d - t.cr) * 100) / 100).toBe(0);
    /* And this is why the fault went unseen for so long: it was balanced
       while it was wrong. Balance alone was never proof of a right reversal. */
    expect(t.d > 0).toBe(true);
  });

  it("keeps two documents' reversals apart", async () => {
    const c = await db();
    await c.postJournal(c.conn, { firmId: 1, date: "2026-01-03", description: "Sale 8",
      sourceModule: "sales", sourceId: 8,
      lines: [{ account_code: "1001", debit: 5000 }, { account_code: "4001", credit: 5000 }] });
    expect(await reverse(c, 8)).toBe(1);
    /* Document 7 was settled long ago and must not be touched by document 8. */
    expect(await reverse(c, 7)).toBe(0);
    expect(await balanceOf(c.query, "4001")).toBe(0);
  });
});
