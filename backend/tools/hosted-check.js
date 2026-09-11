/**
 * hosted-check.js — can this computer reach the hosted database, and how fast?
 *
 *   node backend/tools/hosted-check.js --to libsql://your-db.turso.io --token …
 *
 * or, with the app already configured:
 *
 *   node backend/tools/hosted-check.js          (reads GENIUS_DB_URL / GENIUS_DB_TOKEN)
 *
 * ── why this exists ──────────────────────────────────────────────────────
 *
 * Two questions get answered before anybody moves a shop's books anywhere,
 * and both of them are worth answering *before* rather than after:
 *
 *   1. **Do these credentials work from this computer?** A refusal can come
 *      from the database (wrong or expired token) or from something in
 *      between (a proxy, a company firewall, a captive network). Those look
 *      identical from the outside — both are a 403 — and confusing them costs
 *      an afternoon of issuing new tokens that also do not work. This says
 *      which.
 *
 *   2. **How far away is it?** Every query is now a round-trip. A screen that
 *      runs twelve queries costs twelve times whatever is printed below, so a
 *      database on the wrong side of the world turns a till that felt instant
 *      into one that feels broken. The number matters more than the region
 *      name on the dashboard, so this measures it rather than assuming.
 *
 * It writes nothing. Every statement it sends is a read.
 */
const libsql = require("../database/libsql");

function parse(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--to") o.to = argv[++i];
    else if (argv[i] === "--token") o.token = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") o.help = true;
  }
  return o;
}

async function main() {
  const o = parse(process.argv);
  if (o.help) {
    console.log("\n  node backend/tools/hosted-check.js [--to <url> --token <token>]\n" +
                "  With no arguments it reads GENIUS_DB_URL and GENIUS_DB_TOKEN.\n");
    return;
  }
  const url = o.to || process.env.GENIUS_DB_URL;
  const token = o.token || process.env.GENIUS_DB_TOKEN;
  if (!url) {
    console.error("\n  No database address. Pass --to, or set GENIUS_DB_URL.\n");
    process.exit(1);
  }

  const client = libsql.createClient({ url, token, timeoutMs: 20000 });
  console.log(`\n  Asking ${client.base}\n`);

  /* 1) can we talk to it at all */
  try {
    const t0 = Date.now();
    const r = await client.execute("SELECT sqlite_version() AS v", []);
    console.log(`  reached it            yes  (SQLite ${r.rows[0] && r.rows[0].v}, ${Date.now() - t0} ms)`);
  } catch (e) {
    console.error(`  reached it            NO\n`);
    console.error(`  ${e.message}\n`);
    if (e.network) {
      console.error("  That answer came from the network, not from the database. The address and\n" +
                    "  token may be perfectly good — check a proxy, firewall or host allowlist first.\n");
    } else if (e.status === 401 || e.status === 403) {
      console.error("  Make a fresh token with:  turso db tokens create <database>\n");
    }
    process.exit(1);
  }

  /* 2) how far away is it — the number that decides whether this is usable */
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await client.execute("SELECT 1", []);
    runs.push(Date.now() - t);
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  console.log(`  one query takes       ${median} ms   (${runs.join(", ")} ms over five tries)`);

  /* A busy screen is a dozen queries. That is the number people actually feel. */
  const screen = median * 12;
  console.log(`  a busy screen ≈       ${screen} ms of waiting, before the database does any work`);
  if (median > 250) {
    console.log("\n  That is a long way away. A till at this distance will feel slow to use.\n" +
                "  Check whether the provider has a region nearer the shop and move the database\n" +
                "  there — it is one command while the database is still empty, and a migration\n" +
                "  once it is not.");
  } else if (median > 120) {
    console.log("\n  Workable, but not local. Worth checking for a nearer region before the shop\n" +
                "  starts trading on it.");
  } else {
    console.log("\n  Close enough to feel immediate.");
  }

  /* 3) what is in there already — so nobody copies books over a live database */
  const t = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", []);
  if (!t.rows.length) {
    console.log("\n  what is in it         nothing yet — an empty database, ready for a fresh shop\n" +
                "                        or for books-online.js to copy an existing one into\n");
  } else {
    console.log(`\n  what is in it         ${t.rows.length} tables already`);
    let rows = 0;
    for (const name of ["sale_invoices", "items", "parties"]) {
      if (!t.rows.some((r) => r.name === name)) continue;
      try {
        const c = await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`, []);
        rows += Number((c.rows[0] || {}).n) || 0;
      } catch { /* not our schema; leave it alone */ }
    }
    console.log(rows
      ? `                        and ${rows} rows across sales, items and customers — this database\n` +
        `                        is in use. Do not copy another shop's books into it.\n`
      : `                        but no trading data yet.\n`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n  ${e.message}\n`); process.exit(1); });
}
