/**
 * Tests for shared/tenant.tables.js — the company-backup classification map.
 *
 * This test exists to fail. Its whole job is to break the build the day
 * somebody adds a table without deciding what a per-company backup does with
 * it, because the alternative is a shop restoring a company that has silently
 * lost whatever that table held.
 *
 * It reads the live DDL out of database/setup*.js rather than opening a
 * database, so it runs in the ordinary unit suite with no fixture and no server.
 */
const fs = require("fs");
const path = require("path");
const { describe, it, expect } = require("./tiny-test");
const T = require("../shared/tenant.tables");

/** Every table the app would create on a fresh install. */
function liveTables() {
  const dir = path.join(__dirname, "..", "database");
  const ddl = fs.readdirSync(dir)
    .filter((f) => /^setup.*\.js$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  const names = [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

describe("tenant table classification", () => {
  it("has an opinion about every table in the schema", () => {
    const missing = T.unclassified(liveTables());
    /* The message names them, so the fix is obvious from the failure alone:
       add each to FIRM_SCOPED, CHILD, FIRM_KEYED or EXCLUDED in
       shared/tenant.tables.js, and write down why if it is excluded. */
    expect(missing.join(", ")).toBe("");
  });

  it("names no table the schema does not have", () => {
    /* The other direction, and easier to miss: a table renamed without
       updating the map would be exported as nothing at all, quietly, and the
       export would still report success. */
    expect(T.missingFromSchema(liveTables()).join(", ")).toBe("");
  });

  it("classifies each table exactly once", () => {
    const seen = new Set(), dupes = [];
    for (const t of [...T.FIRM_SCOPED, ...Object.keys(T.CHILD),
                     ...Object.keys(T.FIRM_KEYED), ...Object.keys(T.EXCLUDED)]) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
    expect(dupes.join(", ")).toBe("");
  });

  it("gives every excluded table a written reason", () => {
    const bare = Object.entries(T.EXCLUDED)
      .filter(([, why]) => !why || String(why).trim().length < 20)
      .map(([t]) => t);
    expect(bare.join(", ")).toBe("");
  });

  it("points every child table at a firm-scoped parent", () => {
    const scoped = new Set(T.FIRM_SCOPED);
    const orphans = Object.entries(T.CHILD)
      .filter(([, c]) => !scoped.has(c.parent))
      .map(([t, c]) => `${t}→${c.parent}`);
    expect(orphans.join(", ")).toBe("");
  });

  it("keeps people out of company data", () => {
    /* The decision from the backup proposal, asserted rather than remembered:
       roles and permissions travel with a company; accounts, staff logins and
       access grants do not. */
    for (const t of ["accounts", "users", "memberships", "invitations", "sessions"]) {
      expect(Object.prototype.hasOwnProperty.call(T.EXCLUDED, t)).toBe(true);
    }
    expect(T.FIRM_SCOPED.includes("roles")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(T.CHILD, "role_permissions")).toBe(true);
  });

  it("carries invoice numbering with the company", () => {
    /* A restored company that started numbering at INV-000001 again would
       collide with its own history, and UNIQUE(firm_id, invoice_no) would
       refuse the sale at the till. */
    expect(Object.prototype.hasOwnProperty.call(T.FIRM_KEYED, "sequences")).toBe(true);
    expect(T.FIRM_KEYED.sequences.suffix(3)).toBe("firm3");
  });
});
