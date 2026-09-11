/**
 * storage.router.test.js — no statement may straddle the two databases.
 *
 * Going online puts each company's books in their own SQLite file with a small
 * central file for identity (ONLINE-ONBOARDING.md, option A). A statement that
 * names tables from both cannot be answered by either — and the failure is
 * quiet, which is what makes it worth a test rather than a code review: a
 * LEFT JOIN across the boundary does not error, it returns the other side
 * blank, and the screen renders a missing cashier's name as "Unknown" rather
 * than as broken.
 *
 * So this walks every SQL literal in the backend and classifies it. It is the
 * check that made the boundary decision: the first run reported **36**
 * straddling statements, **33 of them the same shape** — a company's rows
 * joined to `users` to print who did it. That is what moved `users` into the
 * company's file rather than the central one, and took the count to zero.
 */
const fs = require("fs");
const path = require("path");
const { describe, it, expect } = require("./tiny-test");
const { homeOf, unknownTables, CROSS_HOME } = require("../database/router");

const ROOT = path.join(__dirname, "..");
/* The application, not the tests. A test may create a scratch table with no
   home — that is what a test is for — and reporting it would make this check
   the sort that gets muted. Everything the server actually runs is here. */
const ROOTS = ["modules", "shared", "database"].map((d) => path.join(ROOT, d));
const SKIP = new Set(["node_modules", "data", ".git"]);

function jsFiles(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) jsFiles(p, out);
    else if (f.endsWith(".js")) out.push(p);
  }
  return out;
}

/* A string literal that begins with a SQL verb **and** carries a clause
   keyword. The verb alone is not enough: "Update failed while writing files"
   and "Update the app first, then restore" are English, and reading "the" as a
   table name is how a check like this starts crying wolf and gets ignored. */
const LITERAL = /(["'`])((?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[\s\S]*?)\1/gi;
const LOOKS_SQL = /\b(FROM|INTO|SET|VALUES|WHERE|TABLE)\b/i;

function statements() {
  const out = [];
  const files = ROOTS.flatMap((d) => jsFiles(d)).concat([path.join(ROOT, "server.js"), path.join(ROOT, "seed.js")]);
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    let m;
    LITERAL.lastIndex = 0;
    while ((m = LITERAL.exec(src))) {
      const sql = m[2];
      if (!LOOKS_SQL.test(sql) || sql.length > 8000) continue;
      out.push({ file: path.relative(ROOT, file), line: src.slice(0, m.index).split("\n").length, sql });
    }
  }
  return out;
}

const all = statements();

describe("storage boundary (one SQLite file per company)", () => {
  it("found the SQL to check", () => {
    /* A scan that matched nothing would pass every check below for the worst
       possible reason. */
    expect(all.length > 200).toBe(true);
  });

  it("**no statement reads from both databases**", () => {
    const bad = all
      .filter((s) => homeOf(s.sql).home === CROSS_HOME)
      .map((s) => {
        const h = homeOf(s.sql);
        return `${s.file}:${s.line} [${h.tenant.join("+")}] × [${h.central.join("+")}]`;
      });
    expect(bad.join("\n")).toBe("");
  });

  it("every table named has a home", () => {
    /* An unclassified table is not a straddle — it is worse. It would be
       routed by whatever the rest of the statement said, so the same table
       could be written to one file today and another tomorrow. */
    const seen = new Map();
    for (const s of all) for (const t of unknownTables(s.sql)) {
      if (!seen.has(t)) seen.set(t, `${s.file}:${s.line}`);
    }
    expect([...seen.entries()].map(([t, w]) => `${t} (${w})`).join(", ")).toBe("");
  });
});
