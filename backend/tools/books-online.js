/**
 * books-online.js — copy a shop's books from the file on this computer up to a
 * hosted database, once.
 *
 *   node backend/tools/books-online.js --from ./backend/data/genius.db \
 *        --to libsql://geniuspos-acme.turso.io --token <access token>
 *
 * ── what it does, and what it will not do ─────────────────────────────────
 *
 * It reads the local SQLite file, recreates the schema on the hosted database,
 * and copies every row. That is all. In particular:
 *
 *   · **It never writes to the local file.** If anything here goes wrong, the
 *     shop still has its books exactly where they were and can carry on
 *     trading on them. That is the whole safety model of this tool: the thing
 *     it is copying is never the thing it is risking.
 *
 *   · **It refuses a destination that already has rows in it**, unless
 *     `--force` says otherwise. Running this twice by accident would otherwise
 *     double every sale in the ledger — and a doubled ledger looks plausible,
 *     which is what makes it dangerous. There is no merge here and there
 *     cannot be one: two databases that both invented invoice id 412 cannot be
 *     reconciled by anything but a person.
 *
 *   · **It copies inside one transaction per table**, so a table is either
 *     wholly there or wholly absent. A half-copied `sale_invoice_lines` would
 *     be a set of books that adds up to the wrong number while looking
 *     complete, which is worse than an obvious failure.
 *
 * Run it with the till closed. Anything rung up after the copy starts stays in
 * the local file and will not be in the hosted one.
 */
const fs = require("fs");
const path = require("path");
const libsql = require("../database/libsql");

/* ── arguments ────────────────────────────────────────────────────────────── */
function args(argv) {
  const out = { force: false, dryRun: false, batch: 200 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--from") out.from = next();
    else if (a === "--to") out.to = next();
    else if (a === "--token") out.token = next();
    else if (a === "--batch") out.batch = Math.max(1, Number(next()) || 200);
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else { out.bad = a; }
  }
  return out;
}

const USAGE = `
Copy a shop's books from the file on this computer to a hosted database.

  node backend/tools/books-online.js --from <file.db> --to <url> --token <token>

  --from     the SQLite file to read            (never written to)
  --to       the hosted database address        (libsql://… or https://…)
  --token    the hosted database's access token
  --batch    rows per round-trip                (default 200)
  --force    write even if the destination already has rows  — see below
  --dry-run  say what would be copied, copy nothing

--force exists for the case where you have deliberately emptied the destination
and are copying again. It is not a way past a mistake: if the destination has
rows because this already ran, forcing it will duplicate every one of them.
`;

/* ── the local file ───────────────────────────────────────────────────────── */
async function openLocal(file) {
  let initSqlJs;
  try { initSqlJs = require("sql.js"); }
  catch (e) {
    throw new Error(`Reading the local database needs the sql.js engine, and it could not be loaded (${e.message}). Run this from an installation that has its dependencies installed.`);
  }
  if (!fs.existsSync(file)) throw new Error(`There is no database file at ${file}`);
  const SQL = await initSqlJs();
  return new SQL.Database(fs.readFileSync(file));
}

/** Rows out of sql.js as plain objects. */
function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally { stmt.free(); }
}

/* ── the copy ─────────────────────────────────────────────────────────────── */
async function main() {
  const o = args(process.argv);
  if (o.help || !o.from || !o.to) { console.log(USAGE); process.exit(o.help ? 0 : 1); }
  if (o.bad) { console.error(`Unknown option: ${o.bad}\n${USAGE}`); process.exit(1); }

  const from = path.resolve(o.from);
  console.log(`Reading   ${from}`);
  const local = await openLocal(from);
  const client = libsql.createClient({ url: o.to, token: o.token, timeoutMs: 120000 });
  console.log(`Writing   ${client.base}`);

  /* Everything the schema declares, in the order SQLite itself lists it. Views
     and triggers are not copied: this schema has none, and silently creating
     something that was not verified here would be worse than leaving it out
     loudly. */
  const tables = rows(local,
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY name`);
  const indexes = rows(local,
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`);

  console.log(`          ${tables.length} tables, ${indexes.length} indexes\n`);

  /* ── refuse a destination that is already in use ───────────────────────── */
  if (!o.force) {
    const busy = [];
    for (const t of tables) {
      let there;
      try { there = await client.execute(`SELECT COUNT(*) AS n FROM "${t.name}"`, []); }
      catch { continue; }                       // table not there yet: nothing to lose
      const n = there.rows[0] && there.rows[0].n;
      if (Number(n) > 0) busy.push(`${t.name} (${n} rows)`);
    }
    if (busy.length) {
      console.error(
        `\nThe destination already holds data:\n  ${busy.slice(0, 8).join("\n  ")}` +
        (busy.length > 8 ? `\n  …and ${busy.length - 8} more tables` : "") +
        `\n\nNothing has been copied. Copying into these would add a second set of the same\n` +
        `rows, not replace them — every sale would appear twice and the ledger would still\n` +
        `look plausible. Empty the destination first, or pass --force if you meant this.\n`);
      process.exit(1);
    }
  }

  if (o.dryRun) {
    let total = 0;
    for (const t of tables) {
      const n = rows(local, `SELECT COUNT(*) AS n FROM "${t.name}"`)[0].n;
      total += n;
      if (n) console.log(`  ${String(n).padStart(8)}  ${t.name}`);
    }
    console.log(`\n  ${total} rows would be copied. Nothing was written.`);
    return;
  }

  /* ── schema ───────────────────────────────────────────────────────────── */
  for (const t of tables) {
    /* The CREATE statement SQLite itself stored, so the hosted copy has the
       same columns, types and defaults — not a second definition written here
       that could drift from the real one. */
    await client.execute(t.sql.replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS "), []);
  }
  console.log("schema    created");

  /* ── rows ─────────────────────────────────────────────────────────────── */
  let copied = 0;
  for (const t of tables) {
    const all = rows(local, `SELECT * FROM "${t.name}"`);
    if (!all.length) continue;
    const cols = Object.keys(all[0]);
    const colList = cols.map((c) => `"${c}"`).join(",");
    const marks = cols.map(() => "?").join(",");
    const sql = `INSERT INTO "${t.name}" (${colList}) VALUES (${marks})`;

    /* One transaction per table, on one connection, so the table lands whole
       or not at all. */
    const sess = client.session();
    try {
      await sess.execute("BEGIN", []);
      for (let i = 0; i < all.length; i += o.batch) {
        const slice = all.slice(i, i + o.batch);
        /* A batch is one round-trip carrying many statements — the difference
           between a shop with 300,000 rows finishing in minutes and finishing
           in hours. */
        await sess.executeMany(slice.map((r) => ({ sql, params: cols.map((c) => r[c]), wantRows: false })));
        process.stdout.write(`\r  ${t.name.padEnd(28)} ${Math.min(i + o.batch, all.length)}/${all.length}   `);
      }
      await sess.execute("COMMIT", []);
      copied += all.length;
      process.stdout.write(`\r  ${t.name.padEnd(28)} ${all.length} rows\n`);
    } catch (e) {
      try { await sess.execute("ROLLBACK", []); } catch { /* connection gone; nothing committed */ }
      throw new Error(`Copying ${t.name} failed after ${copied} rows in earlier tables: ${e.message}\n` +
        `The local file is untouched. Empty the destination before trying again.`);
    } finally { await sess.close(); }
  }

  /* ── indexes last ─────────────────────────────────────────────────────── */
  for (const ix of indexes) {
    try { await client.execute(ix.sql.replace(/^CREATE (UNIQUE )?INDEX /i, (m, u) => `CREATE ${u || ""}INDEX IF NOT EXISTS `), []); }
    catch (e) { console.warn(`  index ${ix.name} was not created: ${e.message}`); }
  }
  console.log(`indexes   created\n`);
  console.log(`Done. ${copied} rows are now on ${client.base}.`);
  console.log(`\nPoint the app at it and restart:\n  GENIUS_DB_URL=${o.to}\n  GENIUS_DB_TOKEN=<the token>\n`);
  console.log("Keep the local file. Until the hosted database has been trading for a few days,");
  console.log("it is the only copy of these books that you hold yourself.");
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
}

module.exports = { args };
