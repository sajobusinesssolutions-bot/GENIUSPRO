/**
 * firmrestore.service.js — put one company back, without touching the others.
 *
 * The companion to firmexport.service.js; read its header first for why the
 * id-preserving approach is sound.
 *
 * ── the order of operations, and why each step is where it is ─────────────
 *
 *  1. Open and check the file BEFORE anything is touched. Round twelve found
 *     an 8 KB SQLite file whose only table was `not_genius` previewed as
 *     "0 invoices, 0 parties" and was accepted.
 *  2. Take a whole-file safety copy. A per-company restore still mutates the
 *     shared file, so the existing timestamped ten-deep copies are exactly the
 *     right net and are reused rather than reinvented.
 *  3. Hold the write mutex for the whole thing. Round twelve proved a restore
 *     racing an in-flight sale either lands in a database that no longer
 *     exists or is overwritten by it.
 *  4. One transaction: delete the company's rows, reinsert them verbatim.
 *  5. Recompute the control totals and compare. **Roll back on any mismatch.**
 *     This is the step that makes a silent failure loud.
 *  6. Only then commit, and record what happened where a later restore cannot
 *     erase it.
 */
const fs = require("fs");
const path = require("path");
const { query, pool, openBytes, persist, DB_PATH } = require("../../database/db");
const T = require("../../shared/tenant.tables");
const { controlTotals, rowCounts, writeRows, MANIFEST, FORMAT } = require("./firmexport.service");
const backups = require("./backup.service");

/* Children before parents, so a delete never strands a row it was meant to
   take with it. Anything not named keeps its position in FIRM_SCOPED, which
   is already roughly parent-last. */
const DELETE_FIRST = [
  "sale_invoice_lines", "sale_return_lines", "purchase_invoice_lines",
  "purchase_return_lines", "purchase_order_lines", "estimate_lines", "challan_lines",
  "stock_take_lines", "payment_allocations", "journal_entry_lines", "price_list_items",
];

/**
 * Read an export and say plainly whether it can be used, before touching
 * anything.
 */
async function inspect(bytes) {
  if (!bytes || bytes.length < 512) return { ok: false, why: "That file is too small to be a backup." };
  /* Every SQLite file starts with this. Checking it first means a PDF or a zip
     is refused by its first sixteen bytes rather than by a parse error. */
  if (bytes.slice(0, 15).toString("utf8") !== "SQLite format 3") {
    return { ok: false, why: "That is not a database file." };
  }
  let db;
  try { db = openBytes(bytes); }
  catch { return { ok: false, why: "That file could not be opened — it may be damaged." }; }
  try {
    /* `_sajo_export` is what this table was called before the product was
       renamed. A shopkeeper's backup from last month must still restore, so
       both names are tried. */
    let got = [];
    for (const table of [MANIFEST, "_sajo_export"]) {
      try {
        got = await db.exec(`SELECT v FROM ${table} WHERE k='manifest'`);
        if (got.length) break;
      } catch { /* that table is not in this file; try the other */ }
    }
    if (!got.length) {
      return { ok: false, why: "That is a database, but not a single-business backup made by this app." };
    }
    const m = JSON.parse(got[0].values[0][0]);
    if (m.format > FORMAT) {
      return { ok: false, why: `That backup was made by a newer version of the app (format ${m.format}).` };
    }
    const live = (await query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")).rows;
    const liveFp = live.map((s) => s.sql).join("\n").length + ":" + live.length;
    return {
      ok: true,
      manifest: m,
      /* Not a refusal. A backup from an older build is the normal case for a
         restore, and the tables it does not know about simply come back empty
         — which is what they were. The caller shows this so nobody is
         surprised by it afterwards. */
      older_schema: m.schema_fingerprint !== liveFp,
    };
  } catch (e) {
    return { ok: false, why: `That file could not be read — ${e.message}` };
  } finally { try { db.close(); } catch { /* already gone */ } }
}

/** Read one company's rows out of an export. */
async function readFromExport(db, firmId) {
  const data = {};
  const all = async (table, sql, args) => {
    try {
      const res = await db.exec(sql, args);
      if (!res.length) { data[table] = []; return; }
      const { columns, values } = res[0];
      data[table] = values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    } catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; }
  };
  for (const t of T.FIRM_SCOPED) await all(t, `SELECT * FROM ${t} WHERE firm_id = ${Number(firmId)}`);
  for (const [t, c] of Object.entries(T.CHILD)) {
    await all(t, `SELECT * FROM ${t} WHERE ${c.fk} IN (SELECT id FROM ${c.parent} WHERE firm_id = ${Number(firmId)})`);
  }
  for (const [t, k] of Object.entries(T.FIRM_KEYED)) {
    await all(t, `SELECT * FROM ${t} WHERE ${k.column} LIKE '%${k.suffix(Number(firmId))}'`);
  }
  await all("firms", `SELECT * FROM firms WHERE id = ${Number(firmId)}`);
  await all("audit_logs", `SELECT * FROM audit_logs WHERE 0`);   // appended separately
  return data;
}

/**
 * Restore one company in place.
 *
 * @param bytes   the export file
 * @param opts.intoFirmId  which company to overwrite. Must be the one the
 *                         export was taken from: restoring company B's backup
 *                         over company C would put B's ids into C's slot, and
 *                         every id in the file would then be wrong for its new
 *                         home. That is the renumbering problem, and this path
 *                         exists precisely because it does not have to solve it.
 * @param opts.userId      who asked, for the record
 */
async function restoreFirm(bytes, { intoFirmId, userId }) {
  const check = await inspect(bytes);
  if (!check.ok) throw new Error(check.why);
  const m = check.manifest;

  if (Number(m.firm_id) !== Number(intoFirmId)) {
    throw new Error(
      `That backup is of "${m.firm_name}". It can only be restored over the same business, ` +
      `not over a different one.`);
  }
  const target = (await query("SELECT * FROM firms WHERE id = ?", [intoFirmId])).rows[0];
  if (!target) throw new Error("That business no longer exists on this installation");

  /* Step 2: a whole-file safety copy, before the mutex, using the machinery
     round twelve already built — timestamped, collision-suffixed, read back
     before it is trusted, ten kept, and already listed on the Backup screen as
     restorable. A per-company restore mutates the shared file, so the copy has
     to be of the whole thing.
     `keepSafetyCopy` throws if it cannot verify what it wrote, and that throw
     is left to propagate: a restore with no verified way back does not
     proceed. */
  let safety = null;
  try { safety = await backups.keepSafetyCopy(); }
  catch (e) { throw new Error(`Could not take a safety copy first, so nothing was restored — ${e.message}`); }

  const conn = await pool.getConnection();
  const src = openBytes(bytes);
  try {
    const incoming = await readFromExport(src, intoFirmId);

    await conn.beginTransaction();
    try {
      /* Children first. */
      const order = [
        ...DELETE_FIRST,
        ...Object.keys(T.CHILD),
        ...T.FIRM_SCOPED.filter((t) => !DELETE_FIRST.includes(t)),
      ];
      for (const t of order) {
        try {
          if (T.CHILD[t]) {
            const c = T.CHILD[t];
            await conn.query(`DELETE FROM ${t} WHERE ${c.fk} IN (SELECT id FROM ${c.parent} WHERE firm_id = ?)`, [intoFirmId]);
          } else {
            await conn.query(`DELETE FROM ${t} WHERE firm_id = ?`, [intoFirmId]);
          }
        } catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; }
      }
      for (const [t, k] of Object.entries(T.FIRM_KEYED)) {
        try { await conn.query(`DELETE FROM ${t} WHERE ${k.column} LIKE ?`, [`%${k.suffix(intoFirmId)}`]); }
        catch (e) { if (!/no such table/i.test(e.message)) throw e; }
      }

      /* Reinsert, ids untouched. Parents before children this time. */
      const exec = async (sql, args) => await conn.query(sql, args);
      const writeOrder = [
        "firms",
        ...T.FIRM_SCOPED.filter((t) => !DELETE_FIRST.includes(t)),
        ...DELETE_FIRST,
        ...Object.keys(T.CHILD),
        ...Object.keys(T.FIRM_KEYED),
      ];
      /* The company row is replaced rather than inserted beside itself. */
      await conn.query("DELETE FROM firms WHERE id = ?", [intoFirmId]);
      for (const t of writeOrder) {
        if (!incoming[t]) continue;
        try { writeRows(exec, t, incoming[t]); }
        catch (e) {
          throw new Error(`Restoring ${t} failed — ${e.message}. Nothing has been changed.`);
        }
      }

      /* Step 5: prove it. */
      const got = controlTotals(conn.query.bind(conn), intoFirmId);
      const want = m.totals || {};
      const off = Object.keys(want).filter((k) => {
        const a = Number(want[k] || 0), b = Number(got[k] || 0);
        return Math.abs(a - b) > 0.005;
      });
      if (off.length) {
        await conn.rollback();
        const detail = off.map((k) => `${k}: expected ${want[k]}, got ${got[k]}`).join("; ");
        throw new Error(
          `The restored figures do not match the backup, so nothing was changed. ${detail}`);
      }
      /* The ledger must also still balance with itself, which the totals above
         would not catch if both sides were short by the same amount. */
      if (Math.abs(Number(got.ledger_debit) - Number(got.ledger_credit)) > 0.005) {
        await conn.rollback();
        throw new Error(
          `The restored ledger does not balance (${got.ledger_debit} against ${got.ledger_credit}), ` +
          `so nothing was changed.`);
      }

      await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
        [userId || null, "companies", "restore", intoFirmId,
         `${m.firm_name} restored from a backup taken ${m.taken_at}`]);

      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* already rolled back */ }
      throw e;
    }

    /* Step 6: outside the database, because a row written into a restored
       database is destroyed by the NEXT restore — round twelve's reason for
       keeping a restore history in a file. */
    try {
      fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
      fs.appendFileSync(historyPath(),
        `${new Date().toISOString()}\tfirm=${intoFirmId}\tname=${m.firm_name}\t` +
        `backup_taken=${m.taken_at}\tby_user=${userId || "?"}\tsafety=${safety || "none"}\n`);
    } catch { /* the restore stands even if the note does not */ }

    persist();
    return { firm_id: intoFirmId, firm_name: m.firm_name, taken_at: m.taken_at, safety, totals: m.totals };
  } finally {
    try { src.close(); } catch { /* already gone */ }
    conn.release();
  }
}

/* The same file round twelve's whole-file restore appends to, deliberately.
   One restore history, whichever path wrote the entry — two would mean looking
   in two places to answer "what happened to this data". */
function historyPath() {
  return path.join(path.dirname(DB_PATH), "restore-history.log");
}

module.exports = { inspect, restoreFirm, readFromExport };
