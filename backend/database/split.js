/**
 * split.js — turn one database into a central file plus one per company.
 *
 * This is the migration that makes `SPLIT_STORAGE=1` possible on data that
 * already exists. Every shop trading today has one file holding every company
 * it runs; hosting needs the arrangement `router.js` describes.
 *
 *   node database/split.js  [source.db]  [target-dir]
 *
 * ── how it copies, and why the obvious way is wrong ───────────────────────
 *
 * Not by creating an empty database and inserting rows into it. That way the
 * new file's schema comes from whatever `setup.js` builds *today*, so a shop
 * three migrations behind would silently gain columns, lose a guarded ALTER,
 * or have an index built over a column its data has not got. The schema a
 * shop's data was written under is the schema it must be read under.
 *
 * So each output starts as a **byte copy of the source** — every table, index,
 * trigger and guarded migration exactly as that shop has it — and then the
 * rows that do not belong are deleted and the file vacuumed. Copying a large
 * file once per company is real work (a 500 MB shop with four companies moves
 * 2.5 GB), and it is a one-off, run once, offline, against a copy. Correctness
 * is worth more than the minutes.
 *
 * ── it never touches the source ───────────────────────────────────────────
 *
 * The source is opened, read and closed. Everything is written into a target
 * directory that must not already hold files it would overwrite. A migration
 * that damages the thing it is migrating has no way back, and this is the one
 * operation where "run it again" must always be available.
 *
 * ── and it proves it worked ───────────────────────────────────────────────
 *
 * Round twelve's lesson was that data loss on this path is *silent*. So every
 * company's file is reopened after the split and its control totals — invoice
 * count and value, purchases, parties, items, both ledger columns, stock
 * valuation — are compared against the same figures read from the source. A
 * mismatch names the figure and fails the whole run.
 */
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const T = require("../shared/tenant.tables");
const { TENANT, CENTRAL } = require("./router");
const { controlTotals } = require("../modules/system/firmexport.service");

/** A `query`-shaped reader over a raw sql.js handle, so shared helpers work. */
function reader(db) {
  return (sql, params = []) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return { rows };
    } finally { stmt.free(); }
  };
}

const tablesOf = (db) => {
  const q = reader(db);
  return q("SELECT name FROM sqlite_master WHERE type='table'").rows.map((r) => r.name);
};

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Delete every row of `table` that this company does not own. */
function keepOnlyFirm(db, table, firmId, present) {
  if (!present.has(table)) return;
  if (T.FIRM_SCOPED.includes(table)) {
    db.run(`DELETE FROM ${table} WHERE firm_id IS NOT ? `, [firmId]);
    return;
  }
  const child = T.CHILD[table];
  if (child) {
    if (!present.has(child.parent)) return;
    db.run(`DELETE FROM ${table} WHERE ${child.fk} NOT IN (SELECT id FROM ${child.parent})`);
    return;
  }
  const keyed = T.FIRM_KEYED[table];
  if (keyed) {
    /* `sequences` is keyed "INV:firm3". A company that lost its numbering
       would start again at INV-000001 and collide with its own history. */
    db.run(`DELETE FROM ${table} WHERE ${keyed.column} NOT LIKE ?`, [`%${keyed.suffix(firmId)}`]);
    return;
  }
  if (table === "users") {
    /* Counter staff belong to the shop they work in — the boundary decision in
       router.js. `active_firm_id` is where a users row currently points. */
    db.run(`DELETE FROM users WHERE active_firm_id IS NOT ?`, [firmId]);
    return;
  }
  if (table === "audit_logs") {
    /* Keyed by user rather than by firm, so it follows the staff who stayed.
       Entries by somebody who has since moved to another company are left
       behind with them; an audit row without its actor would be worse than
       one filed under the person who made it. */
    db.run(`DELETE FROM audit_logs WHERE user_id NOT IN (SELECT id FROM users)`);
  }
}

/**
 * @param {string} sourceFile
 * @param {string} targetDir
 * @param {{quiet?:boolean}} [opts]
 * @returns {Promise<{central:string, firms:Array, checked:number}>}
 */
async function split(sourceFile, targetDir, opts = {}) {
  const say = opts.quiet ? () => {} : (...a) => console.log(...a);
  if (!fs.existsSync(sourceFile)) throw new Error(`No such database: ${sourceFile}`);
  const centralFile = path.join(targetDir, "central.db");
  if (fs.existsSync(centralFile)) {
    throw new Error(`${centralFile} already exists. Point this at an empty directory — it will not overwrite a database.`);
  }

  const SQL = await initSqlJs();
  const bytes = fs.readFileSync(sourceFile);

  /* **`new SQL.Database(buf)` does not copy `buf`.** It hands the same memory
     to wasm, so writes through the returned handle mutate the caller's buffer
     — and every later database opened from that buffer starts from the
     previous one's deletions.
     *
     * This cost an hour and would have cost a shop its books. The first
     * version of this file opened the central copy from `bytes`, emptied every
     * company table out of it, and then built each company's file from the
     * same `bytes` — which by then held a database with no company data in it
     * at all. Every company file came out empty, and the run reported success
     * up to the point the control totals refused it: "invoices 6 → 0". That
     * check is the only reason this is a paragraph rather than a support call.
     *
     * So every handle gets its own copy, and `fresh()` is the only way one is
     * opened in this file. */
  const fresh = () => new SQL.Database(Uint8Array.from(bytes));
  const src = fresh();
  const q = reader(src);

  const present = new Set(tablesOf(src));
  const firms = q("SELECT id, name FROM firms ORDER BY id").rows;
  if (!firms.length) throw new Error("That database has no companies in it.");
  say(`${firms.length} compan${firms.length === 1 ? "y" : "ies"} in ${path.basename(sourceFile)} (${(bytes.length / 1048576).toFixed(1)} MB)`);

  /* What each company should look like afterwards, read from the source while
     it is still whole. Compared against the copy at the end. */
  const expected = new Map(firms.map((f) => [f.id, controlTotals(q, f.id)]));
  src.close();

  /* ── the central file: everything except the companies' own tables ──────── */
  const centre = fresh();
  for (const t of tablesOf(centre)) {
    if (TENANT.has(t)) centre.run(`DELETE FROM ${t}`);
  }
  centre.run("VACUUM");
  writeFile(centralFile, Buffer.from(centre.export()));
  centre.close();
  say(`central.db  ${(fs.statSync(centralFile).size / 1024).toFixed(0)} KB  — accounts, memberships, sessions, the list of companies`);

  /* ── one file per company ───────────────────────────────────────────────── */
  const out = [];
  for (const f of firms) {
    const one = fresh();
    for (const t of tablesOf(one)) {
      if (CENTRAL.has(t) && t !== "firms") { one.run(`DELETE FROM ${t}`); continue; }
      keepOnlyFirm(one, t, f.id, present);
    }
    /* The company's own row travels with it — a file that did not know its own
       name could not answer `GET /firms` from inside itself. Every other
       company's row goes. */
    one.run("DELETE FROM firms WHERE id IS NOT ?", [f.id]);
    one.run("VACUUM");
    const file = path.join(targetDir, "firms", `firm-${f.id}.db`);
    writeFile(file, Buffer.from(one.export()));
    one.close();

    /* Reopened from disk, not verified in memory: the check has to cover the
       write as well as the copy. */
    const back = new SQL.Database(Uint8Array.from(fs.readFileSync(file)));
    const got = controlTotals(reader(back), f.id);
    back.close();
    const want = expected.get(f.id);
    const wrong = Object.keys(want).filter((k) => String(want[k]) !== String(got[k]));
    if (wrong.length) {
      throw new Error(
        `${f.name}: the copy does not match the original — ` +
        wrong.map((k) => `${k} ${want[k]} → ${got[k]}`).join(", "));
    }
    out.push({ firm_id: f.id, name: f.name, file, bytes: fs.statSync(file).size, totals: got });
    say(`firm-${f.id}.db   ${(fs.statSync(file).size / 1024).toFixed(0)} KB  — ${f.name}: ` +
        `${got.invoices} invoices, ${got.items} items, ledger ${got.ledger_debit}/${got.ledger_credit} ✓`);
  }

  return { central: centralFile, firms: out, checked: out.length };
}

module.exports = { split };

if (require.main === module) {
  const source = process.argv[2] || require("./db").DB_PATH;
  const target = process.argv[3] || path.join(path.dirname(source), "split");
  split(source, target)
    .then((r) => {
      console.log(`\nDone. ${r.checked} compan${r.checked === 1 ? "y" : "ies"} verified against the original.`);
      console.log(`Point the server at it:  GENIUS_DB_PATH=${r.central} SPLIT_STORAGE=1 npm start`);
    })
    .catch((e) => { console.error("\nSplit failed:", e.message); process.exit(1); });
}
