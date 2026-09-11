/**
 * firmexport.service.js — one company, in and out.
 *
 * ── why this exists ───────────────────────────────────────────────────────
 *
 * Round twelve made whole-file restore refuse on any installation holding more
 * than one company, and the argument was sound: a whole-file restore replaces
 * everything, so firm B restoring its own backup deleted firm A. That was
 * measured, not inferred. The refusal never fired in practice because every
 * installation had one company — until Companies shipped, at which point the
 * first shop to add a second business loses its recovery button.
 *
 * This is the path that gives it back.
 *
 * ── the finding the design rests on ───────────────────────────────────────
 *
 * Round twelve declined to build per-firm restore because an import must
 * "renumber every primary key that collides with a surviving firm's rows, and
 * re-point every foreign key that referenced the old numbers". True — for
 * importing a company as a NEW company.
 *
 * It is not true for restoring a company in place. Primary keys here are
 * `INTEGER PRIMARY KEY AUTOINCREMENT` on shared tables, so ids are unique
 * across the whole file, not per company: firm B's item #412 is the only row
 * anywhere with item id 412. So
 *
 *     delete firm B's rows → reinsert them with their original ids
 *
 * leaves every foreign key that was valid before valid again. Nothing
 * collides, because the ids being written are ids no other company ever held.
 * Nothing needs re-pointing, because nothing moved. The entire class of silent
 * corruption round twelve feared — "an invoice line pointing at the wrong item
 * still renders" — is structurally unreachable on this path.
 *
 * ── the safety mechanism ──────────────────────────────────────────────────
 *
 * Round twelve's real lesson was not "renumbering is hard". It was that the
 * failure is SILENT. So the export carries control totals, and the restore
 * recomputes them before committing: row counts per table, invoice count and
 * the sum of invoice grand totals, ledger debits and credits, and the stock
 * valuation. A mismatch on any of them rolls back and names which. That turns
 * a silent class of bug into a loud one for the price of a few queries.
 */
const fs = require("fs");
const { query, pool, newDatabase, openBytes, persist } = require("../../database/db");
const T = require("../../shared/tenant.tables");
const appVersion = require("../../shared/version");

const MANIFEST = "_genius_export";
const FORMAT = 1;

/* ── control totals ─────────────────────────────────────────────────────── */

/**
 * The figures a restore has to reproduce exactly.
 *
 * Deliberately drawn from different parts of the schema — documents, the
 * ledger, and stock — because a bug that lost rows from one of them would
 * otherwise be invisible in the other two.
 */
function controlTotals(q, firmId) {
  const one = (sql, dflt = 0) => {
    try { const r = q(sql, [firmId]).rows[0]; return r ? (Object.values(r)[0] ?? dflt) : dflt; }
    catch { return dflt; }
  };
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    invoices:      one("SELECT COUNT(*) FROM sale_invoices WHERE firm_id = ?"),
    invoice_total: r2(one("SELECT SUM(grand_total) FROM sale_invoices WHERE firm_id = ?")),
    purchases:     one("SELECT COUNT(*) FROM purchase_invoices WHERE firm_id = ?"),
    parties:       one("SELECT COUNT(*) FROM parties WHERE firm_id = ?"),
    items:         one("SELECT COUNT(*) FROM items WHERE firm_id = ?"),
    ledger_debit:  r2(one("SELECT SUM(debit) FROM journal_entry_lines WHERE firm_id = ?")),
    ledger_credit: r2(one("SELECT SUM(credit) FROM journal_entry_lines WHERE firm_id = ?")),
    stock_value:   r2(one("SELECT SUM(quantity * avg_cost) FROM item_stock WHERE firm_id = ?")),
  };
}

/** Per-table row counts for this company, in the same order every time. */
function rowCounts(q, firmId) {
  const out = {};
  for (const t of T.FIRM_SCOPED) {
    try { out[t] = q(`SELECT COUNT(*) c FROM ${t} WHERE firm_id = ?`, [firmId]).rows[0].c; }
    catch { /* a table this build does not have */ }
  }
  for (const [t, c] of Object.entries(T.CHILD)) {
    try {
      out[t] = q(
        `SELECT COUNT(*) c FROM ${t} WHERE ${c.fk} IN (SELECT id FROM ${c.parent} WHERE firm_id = ?)`,
        [firmId]).rows[0].c;
    } catch { /* likewise */ }
  }
  for (const [t, k] of Object.entries(T.FIRM_KEYED)) {
    try {
      out[t] = q(`SELECT COUNT(*) c FROM ${t} WHERE ${k.column} LIKE ?`,
        [`%${k.suffix(firmId)}`]).rows[0].c;
    } catch { /* likewise */ }
  }
  return out;
}

/* ── reading a company out ──────────────────────────────────────────────── */

/** Every row of one company, table by table, ids untouched. */
function readCompany(q, firmId) {
  const data = {};
  const read = (table, sql, args) => {
    try { data[table] = q(sql, args).rows; }
    catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; }
  };
  for (const t of T.FIRM_SCOPED) read(t, `SELECT * FROM ${t} WHERE firm_id = ?`, [firmId]);
  for (const [t, c] of Object.entries(T.CHILD)) {
    read(t, `SELECT * FROM ${t} WHERE ${c.fk} IN (SELECT id FROM ${c.parent} WHERE firm_id = ?)`, [firmId]);
  }
  for (const [t, k] of Object.entries(T.FIRM_KEYED)) {
    read(t, `SELECT * FROM ${t} WHERE ${k.column} LIKE ?`, [`%${k.suffix(firmId)}`]);
  }
  /* The company row itself. Not content, but the export is useless without it. */
  read("firms", "SELECT * FROM firms WHERE id = ?", [firmId]);
  /* The audit log travels, and is appended on the way in rather than replacing
     what is there. Scoped by the company's own entries: rows written by users
     whose active company this is, plus anything logged against the company. */
  read("audit_logs",
    "SELECT * FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE active_firm_id = ?) " +
    "OR (module = 'companies' AND entity_id = ?)", [firmId, firmId]);
  return data;
}

/** Insert rows verbatim into a target connection. */
function writeRows(exec, table, rows) {
  if (!rows || !rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const marks = cols.map(() => "?").join(",");
  const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${marks})`;
  for (const r of rows) exec(sql, cols.map((c) => r[c]));
  return rows.length;
}

/* ── export ─────────────────────────────────────────────────────────────── */

/**
 * One company as a real SQLite file.
 *
 * The schema is copied from the live database rather than rebuilt from
 * `setup.js`, so an export made by an older build carries exactly the schema
 * that build had — which is what the restore's column comparison then has
 * something honest to compare against.
 */
async function exportFirm(firmId) {
  const conn = await pool.getConnection();
  try {
    const firm = (await query("SELECT * FROM firms WHERE id = ?", [firmId])).rows[0];
    if (!firm) throw new Error("Business not found");

    const schema = (await query(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")).rows;
    const data = readCompany(query, firmId);
    const totals = controlTotals(query, firmId);
    const counts = rowCounts(query, firmId);

    const out = newDatabase();
    try {
      for (const s of schema) {
        try { out.run(s.sql); } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
      }
      out.run("BEGIN");
      const exec = (sql, args) => out.run(sql, args);
      for (const [table, rows] of Object.entries(data)) writeRows(exec, table, rows);

      out.run(`CREATE TABLE IF NOT EXISTS ${MANIFEST} (k TEXT PRIMARY KEY, v TEXT)`);
      const manifest = {
        format: FORMAT,
        app_version: appVersion.version(),
        firm_id: firmId,
        firm_name: firm.name,
        taken_at: new Date().toISOString(),
        /* What the schema looked like when this was written. The restore
           compares it against the live one and says plainly when a backup is
           from a newer build, rather than failing on a missing column with a
           message only a developer can read. */
        schema_fingerprint: schema.map((s) => s.sql).join("\n").length + ":" + schema.length,
        totals,
        counts,
      };
      out.run(`INSERT INTO ${MANIFEST} (k, v) VALUES ('manifest', ?)`, [JSON.stringify(manifest)]);
      out.run("COMMIT");

      const bytes = Buffer.from(out.export());

      /* Prove it opens and reads before anybody is told it is a backup. Round
         twelve found downloads were never verified; a file nobody has opened
         is a guess, and the moment to find out is now, not in a year. */
      const check = openBytes(bytes);
      try {
        const got = check.exec(`SELECT v FROM ${MANIFEST} WHERE k='manifest'`);
        if (!got.length) throw new Error("the manifest did not read back");
        const back = JSON.parse(got[0].values[0][0]);
        if (back.firm_id !== firmId) throw new Error("the manifest names a different business");
        const inv = check.exec("SELECT COUNT(*) FROM sale_invoices WHERE firm_id = " + Number(firmId));
        const n = inv.length ? inv[0].values[0][0] : 0;
        if (n !== totals.invoices) {
          throw new Error(`the copy holds ${n} invoices where the company has ${totals.invoices}`);
        }
      } finally { check.close(); }

      return { bytes, manifest };
    } finally { out.close(); }
  } finally { conn.release(); }
}

module.exports = { exportFirm, controlTotals, rowCounts, readCompany, writeRows, MANIFEST, FORMAT };
