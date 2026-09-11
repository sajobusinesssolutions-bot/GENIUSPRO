/**
 * seed-large.js — a two-year-old shop, generated.
 *
 * Every verification pass this app has had ran against 2 items, 6 invoices and
 * 2 users. On that data a missing index and a report with no bound both look
 * identical to a correct one. This builds the other case: ~2,000 items, ~500
 * parties, ~20,000 sale invoices spread over two years, with purchases,
 * payments, adjustments and the general ledger that all of it implies.
 *
 * Usage
 *   GENIUS_DB_PATH=/tmp/big.db node seed-large.js
 *   GENIUS_DB_PATH=/tmp/small.db node seed-large.js --invoices=2000
 *   ... --items=500 --parties=200 --months=12 --seed=7 --quiet
 *
 * Everything but --invoices defaults to a proportion of it, so one argument
 * scales the whole shop.
 *
 * Two rules this script keeps:
 *
 *   1. It never writes `backend/data/genius.db`. GENIUS_DB_PATH must be set and
 *      must point somewhere else; the shipped database is what the e2e harness
 *      copies and what an installer ships.
 *   2. It is deterministic. The generator is a seeded mulberry32 — there is no
 *      bare Math.random() anywhere below — so a query that is slow on run one
 *      is slow on run two, with the same rows, and can be bisected.
 *
 * How it writes. The base shop (firm, roles, admin/sales users, chart of
 * accounts, units) comes from `seed.js`, run as a child process, so the
 * conventions stay in one place. The bulk then goes in through the real
 * posters — `postJournal`, `templates`, `postMovement`, `nextSeq` — against a
 * connection shim over raw sql.js. Using the real posting code is the point:
 * the trial balance balances because the same engine that balances it in
 * production wrote it. Bypassing `database/db.js` is only about the save
 * debounce, which would otherwise export the whole (growing) database to disk
 * every three seconds for the length of the run.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");
const { postJournal, templates, round2 } = require("./shared/accounting.poster");
const { postMovement } = require("./shared/stock.poster");
const { nextSeq, pad } = require("./shared/sequences");
const { CODES } = require("./shared/account.codes");

/* ── arguments ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = hit.includes("=") ? hit.split("=").slice(1).join("=") : "1";
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};
const QUIET = argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

const INVOICES = Math.max(1, Math.round(arg("invoices", 20000)));
const scale = INVOICES / 20000;
const ITEMS = Math.max(4, Math.round(arg("items", Math.max(40, 2000 * scale))));
const PARTIES = Math.max(4, Math.round(arg("parties", Math.max(20, 500 * scale))));
const SUPPLIERS = Math.max(2, Math.round(PARTIES * 0.12));
const PURCHASES = Math.max(2, Math.round(arg("purchases", Math.max(20, 1800 * scale))));
const MONTHS = Math.max(1, Math.round(arg("months", 24)));
const STAFF = Math.max(1, Math.round(arg("staff", 6)));
const SEED = Math.round(arg("seed", 20240815));

/* ── the database file ───────────────────────────────────────────────────── */

const SHIPPED = path.resolve(__dirname, "data", "genius.db");
const target = process.env.GENIUS_DB_PATH;
if (!target) {
  console.error(
    "GENIUS_DB_PATH is not set.\n" +
    "This script generates tens of thousands of rows; it will not do that to the\n" +
    "shipped database. Point it at a scratch file:\n\n" +
    "  GENIUS_DB_PATH=/tmp/genius-large.db node seed-large.js\n");
  process.exit(1);
}
const DB_PATH = path.resolve(target);
if (DB_PATH === SHIPPED) {
  console.error(`Refusing to write ${SHIPPED} — that is the shipped database.`);
  process.exit(1);
}

/* ── deterministic generator ─────────────────────────────────────────────── */

/* mulberry32: 32-bit state, uniform enough for test data, and identical on
   every platform and Node version — which is the property that matters here. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
/* Weighted pick over an ascending-cumulative-weight table. */
const pickw = (pairs) => {
  const total = pairs.reduce((a, p) => a + p[1], 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
};

/* ── base shop, from seed.js ─────────────────────────────────────────────── */

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
log(`Base shop → ${DB_PATH}`);
execFileSync(process.execPath, ["seed.js"], {
  cwd: __dirname,
  env: { ...process.env, GENIUS_DB_PATH: DB_PATH },
  stdio: QUIET ? "ignore" : "inherit",
});

/* ── a connection over raw sql.js, shaped like the posters expect ────────── */

(async () => {
  const t0 = Date.now();
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  db.run("PRAGMA foreign_keys = ON;");

  /* Never db.exec(): sql.js 1.14.1 leaks 16 bytes of the 5 MB wasm stack on
     every exec() call and never gives it back, so the 327,680th one takes the
     stack pointer off the end of the heap and SQLite dies with "memory access
     out of bounds". This script used to make one exec() per insert and so had
     a hard budget of ~328,000 writes — which is what "20,000 invoices dies at
     8,000" actually was. See database/db.js for the full note. */
  const conn = {
    query(sql, params = []) {
      const p = Array.isArray(params) ? params.map((v) => (v === undefined ? null : v)) : params;
      const head = sql.trimStart().slice(0, 6).toUpperCase();
      if (head.startsWith("SELECT") || head.startsWith("WITH") || head.startsWith("PRAGMA")) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(p);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return { rows, insertId: null, changes: 0 };
        } finally { stmt.free(); }
      }
      db.run(sql, p);
      const rowid = db.prepare("SELECT last_insert_rowid() AS id");
      try {
        return {
          rows: [],
          insertId: rowid.step() ? rowid.get()[0] : null,
          changes: db.getRowsModified(),
        };
      } finally { rowid.free(); }
    },
  };
  const q = async (sql, params) => (await conn.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  const firmId = (await one("SELECT id FROM firms ORDER BY id LIMIT 1")).id;
  const adminRole = (await one("SELECT id FROM roles WHERE firm_id=? AND name='Admin'", [firmId])).id;
  const salesRole = (await one("SELECT id FROM roles WHERE firm_id=? AND name='Salesman'", [firmId])).id;
  const adminUser = (await one("SELECT id FROM users WHERE username='admin'")).id;

  db.run("BEGIN");

  /* ── dates ──────────────────────────────────────────────────────────────
     The window ends today and runs back MONTHS months, so ageing buckets are
     measured against a real "now" and the monthly reports have a current
     month to show. */
  const DAY = 86400000;
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = end - Math.round(MONTHS * 30.44) * DAY;
  const SPAN_DAYS = Math.round((end - start) / DAY);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const stamp = (ms, h, m) =>
    `${iso(ms)} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

  /* A shop is not uniform. Trade grows over the two years, Saturday is the big
     day and Sunday is thin, and the day has a lunchtime peak. Reports that
     bucket by month, weekday or hour are only exercised if the data has shape. */
  function tradingDay() {
    /* growth: later days are likelier, sqrt-biased so it is a trend not a cliff */
    const d = Math.floor(SPAN_DAYS * Math.sqrt(rnd()));
    const ms = start + d * DAY;
    const dow = new Date(ms).getUTCDay();
    const weight = [0.25, 0.9, 0.95, 1.0, 1.05, 1.25, 1.5][dow];
    if (rnd() > weight / 1.5) return tradingDay();
    return ms;
  }
  const tradingHour = () => pickw([[8, 3], [9, 6], [10, 9], [11, 11], [12, 13], [13, 12],
    [14, 10], [15, 9], [16, 9], [17, 8], [18, 6], [19, 3], [20, 1]]);

  /* ── categories, groups, staff ─────────────────────────────────────────── */

  const CATEGORIES = ["General", "Groceries", "Beverages", "Hardware", "Electronics",
    "Stationery", "Household", "Cosmetics", "Building", "Agro"];
  for (const c of CATEGORIES) {
    if (!await one("SELECT id FROM item_categories WHERE firm_id=? AND name=?", [firmId, c]))
      await conn.query("INSERT INTO item_categories (firm_id, name) VALUES (?,?)", [firmId, c]);
  }
  const catIds = await q("SELECT id, name FROM item_categories WHERE firm_id=?", [firmId]);

  for (const g of ["Retail", "Wholesale", "Distributor", "Staff"]) {
    if (!await one("SELECT id FROM party_groups WHERE firm_id=? AND name=?", [firmId, g]))
      await conn.query("INSERT INTO party_groups (firm_id, name) VALUES (?,?)", [firmId, g]);
  }
  const groupIds = (await q("SELECT id FROM party_groups WHERE firm_id=?", [firmId])).map((r) => r.id);

  /* Staff. Every rep hash is the same bcrypt cost as the real one — a slow
     hash 6 times is nothing, and a shortcut here would make the per-user
     reports test something the login page does not. */
  const STAFF_NAMES = ["Nakato Grace", "Mugisha Peter", "Achieng Sarah", "Kato Daniel",
    "Namusoke Irene", "Odongo Brian", "Tumusiime Joan", "Ssempijja Eric"];
  const staffHash = bcrypt.hashSync("staff123", 10);
  for (let i = 0; i < STAFF; i++) {
    const name = STAFF_NAMES[i % STAFF_NAMES.length] + (i >= STAFF_NAMES.length ? ` ${i}` : "");
    await conn.query(
      `INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id, status, commission_pct)
       VALUES (?,?,?,?,?,'active',?)`,
      [`staff${i + 1}`, staffHash, name, i === 0 ? adminRole : salesRole, firmId, rint(0, 3)]);
  }
  /* Every user of this firm can ring up a sale, admin included — the per-rep
     reports are only meaningful if the attribution spreads. */
  const repIds = (await q("SELECT id FROM users WHERE active_firm_id=? ORDER BY id", [firmId])).map((u) => u.id);
  log(`  staff: ${repIds.length} users`);

  /* ── items ─────────────────────────────────────────────────────────────── */

  const NOUNS = ["Flour", "Rice", "Sugar", "Salt", "Cooking Oil", "Soap", "Detergent",
    "Cement", "Nails", "Paint", "Bulb", "Cable", "Notebook", "Pen", "Battery", "Charger",
    "Bucket", "Basin", "Blanket", "Mattress", "Tea", "Coffee", "Milk", "Soda", "Water",
    "Juice", "Biscuit", "Bread", "Maize", "Beans", "Millet", "Groundnuts", "Timber",
    "Iron Sheet", "Hoe", "Panga", "Seedling", "Fertiliser", "Lotion", "Shampoo"];
  const BRANDS = ["Kabira", "Nile", "Rwenzori", "Victoria", "Ssese", "Elgon", "Bwindi",
    "Kigezi", "Acholi", "Buganda", "Karamoja", "Mbale"];
  const SIZES = ["500g", "1kg", "2kg", "5kg", "10kg", "250ml", "500ml", "1L", "5L", "20L",
    "Small", "Medium", "Large", "Pack of 6", "Pack of 12"];
  const UNITS = ["PCS", "KG", "LTR", "BAG", "BOX", "DZN"];

  const items = [];
  for (let i = 0; i < ITEMS; i++) {
    const cat = pick(catIds);
    const name = `${pick(BRANDS)} ${pick(NOUNS)} ${pick(SIZES)} #${i + 1}`;
    const cost = round2(500 + Math.floor(rnd() * 240) * 500);       // UGX 500 … 120,000
    const price = round2(cost * (1.12 + rnd() * 0.5));
    const isService = rnd() < 0.03;
    /* ~1 item in 12 is dual-unit, so the base_quantity paths are exercised at
       scale and not only by the two demo rows. */
    const dual = !isService && rnd() < 0.08;
    await conn.query(
      `INSERT INTO items (firm_id, item_code, name, item_type, is_inventory, category_id, unit,
                          secondary_unit, conversion_rate, barcode, sale_price, purchase_price,
                          wholesale_price, mrp, reorder_level, status, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1)`,
      [firmId, `SKU-${pad(i + 1, 5)}`, name, isService ? "service" : "product",
       isService ? 0 : 1, cat.id, pick(UNITS), dual ? "PCS" : null, dual ? rint(6, 50) : 0,
       `62${pad(i + 1, 11)}`, price, cost, round2(price * 0.92), round2(price * 1.1),
       isService ? 0 : rint(0, 25)]);
    const id = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;
    items.push({ id, cost, price, inventory: isService ? 0 : 1 });
  }
  log(`  items: ${items.length}`);

  /* Opening stock, dated to the start of the window. Written through
     postMovement so item_stock and stock_movements agree the way they do in
     production, rather than being two lists that happen to match. */
  let openingValue = 0;
  for (const it of items) {
    if (!it.inventory) continue;
    const qty = rint(0, 400);
    if (!qty) continue;
    await postMovement(conn, { firmId, itemId: it.id, direction: "in", quantity: qty,
      unitCost: it.cost, sourceModule: "opening", sourceId: 0, userId: adminUser });
    openingValue = round2(openingValue + qty * it.cost);
  }
  if (openingValue > 0) {
    await postJournal(conn, { firmId, date: iso(start), description: "Opening stock",
      reference: "opening", sourceModule: "opening", sourceId: 0, userId: adminUser,
      lines: [{ account_code: CODES.STOCK, debit: openingValue },
              { account_code: CODES.CAPITAL, credit: openingValue }] });
  }
  /* seed.js already posted its own (empty-shop) opening entry and balances;
     the amounts are zero there, so nothing double-counts. */

  /* ── parties ───────────────────────────────────────────────────────────── */

  const FIRST = ["Okello", "Nakato", "Mugisha", "Achieng", "Kato", "Namusoke", "Odongo",
    "Tumusiime", "Ssempijja", "Auma", "Kirabo", "Wasswa", "Nabirye", "Byaruhanga", "Alupo"];
  const LAST = ["James", "Grace", "Peter", "Sarah", "Daniel", "Irene", "Brian", "Joan",
    "Eric", "Betty", "Moses", "Ruth", "Samuel", "Esther", "Isaac"];
  const TRADE = ["Traders", "Enterprises", "Hardware", "Supermarket", "Wholesalers",
    "Stores", "Agencies", "Distributors", "General Merchandise"];
  const TOWNS = ["Kampala", "Jinja", "Mbarara", "Gulu", "Mbale", "Masaka", "Arua",
    "Fort Portal", "Soroti", "Lira", "Hoima", "Entebbe"];

  const customers = [];
  for (let i = 0; i < PARTIES; i++) {
    const business = rnd() < 0.35;
    const name = business
      ? `${pick(TOWNS)} ${pick(TRADE)} ${i + 1}`
      : `${pick(FIRST)} ${pick(LAST)} ${i + 1}`;
    const days = pickw([[0, 5], [7, 3], [14, 4], [30, 5], [45, 2], [60, 1]]);
    await conn.query(
      `INSERT INTO parties (firm_id, party_no, name, party_type, phone, email, billing_address,
                            group_id, credit_limit, credit_days, opening_balance, balance, status)
       VALUES (?,?,?,'customer',?,?,?,?,?,?,0,0,'active')`,
      [firmId, `CUST-${pad(i + 1)}`, name, `07${rint(10, 79)}${pad(rint(0, 999999), 6)}`,
       business ? `sales${i + 1}@${pick(TOWNS).toLowerCase()}.co.ug` : null,
       `${pick(TOWNS)}, Uganda`, pick(groupIds), rint(0, 20) * 500000, days]);
    customers.push({ id: (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id, days });
  }
  const cashParty = await one("SELECT id FROM parties WHERE firm_id=? AND name='Cash Sale'", [firmId]);

  const suppliers = [];
  for (let i = 0; i < SUPPLIERS; i++) {
    await conn.query(
      `INSERT INTO parties (firm_id, party_no, name, party_type, phone, billing_address,
                            credit_days, opening_balance, balance, status)
       VALUES (?,?,?,'supplier',?,?,?,0,0,'active')`,
      [firmId, `SUPP-${pad(i + 1)}`, `${pick(TOWNS)} ${pick(TRADE)} Ltd ${i + 1}`,
       `07${rint(10, 79)}${pad(rint(0, 999999), 6)}`, `${pick(TOWNS)}, Uganda`,
       pickw([[0, 2], [14, 3], [30, 4]])]);
    suppliers.push({ id: (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id });
  }
  log(`  parties: ${customers.length} customers, ${suppliers.length} suppliers`);

  /* ── purchases ─────────────────────────────────────────────────────────── */

  const stocked = items.filter((i) => i.inventory);
  const openBills = [];
  for (let n = 0; n < PURCHASES; n++) {
    const ms = tradingDay();
    const date = iso(ms);
    const supplier = pick(suppliers);
    const lineCount = rint(2, 8);
    const lines = [];
    let sub = 0;
    for (let l = 0; l < lineCount; l++) {
      const it = pick(stocked);
      const qty = rint(5, 120);
      const rate = round2(it.cost * (0.92 + rnd() * 0.12));
      const value = round2(qty * rate);
      sub = round2(sub + value);
      lines.push({ it, qty, rate, value });
    }
    const billNo = `PUR-${pad(await nextSeq(conn, `PUR:firm${firmId}`))}`;
    const paidFully = rnd() < 0.7;
    const paid = paidFully ? sub : round2(sub * (rnd() < 0.5 ? 0 : rnd() * 0.6));
    const due = round2(sub - paid);
    await conn.query(
      `INSERT INTO purchase_invoices (firm_id, bill_no, doc_type, party_id, bill_date, due_date,
              sub_total, tax_total, grand_total, paid_amount, balance_due, status, created_by,
              sales_rep_id, created_at)
       VALUES (?,?,'purchase',?,?,?,?,0,?,?,?,?,?,?,?)`,
      [firmId, billNo, supplier.id, date, iso(ms + 30 * DAY), sub, sub, paid, due,
       due <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid", adminUser, adminUser,
       stamp(ms, tradingHour(), rint(0, 59))]);
    const billId = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;

    for (const ln of lines) {
      await conn.query(
        `INSERT INTO purchase_invoice_lines (firm_id, bill_id, item_id, quantity, rate,
                taxable_value, line_total) VALUES (?,?,?,?,?,?,?)`,
        [firmId, billId, ln.it.id, ln.qty, ln.rate, ln.value, ln.value]);
      await postMovement(conn, { firmId, itemId: ln.it.id, direction: "in", quantity: ln.qty,
        unitCost: ln.rate, sourceModule: "purchases", sourceId: billId, userId: adminUser });
    }
    await postJournal(conn, { firmId, date, description: `Purchase ${billNo}`, reference: billNo,
      sourceModule: "purchases", sourceId: billId, userId: adminUser,
      lines: templates.purchaseCredit({ subTotal: sub }) });
    if (paid > 0) {
      const payNo = `PAY-${pad(await nextSeq(conn, `PAY:firm${firmId}`))}`;
      await conn.query(
        `INSERT INTO payments (firm_id, payment_no, direction, party_id, payment_date, amount,
                mode, unallocated, created_by, created_at, status)
         VALUES (?,?,'out',?,?,?,?,0,?,?, 'paid')`,
        [firmId, payNo, supplier.id, date, paid, pick(["cash", "bank", "cheque"]),
         adminUser, stamp(ms, tradingHour(), rint(0, 59))]);
      const payId = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;
      await conn.query(
        `INSERT INTO payment_allocations (firm_id, payment_id, doc_table, doc_id, amount)
         VALUES (?,?,'purchase_invoices',?,?)`, [firmId, payId, billId, paid]);
      await postJournal(conn, { firmId, date, description: `Payment out ${payNo}`, reference: payNo,
        sourceModule: "payments", sourceId: payId, userId: adminUser,
        lines: templates.paymentOut({ amount: paid }) });
    }
    if (due > 0) openBills.push({ partyId: supplier.id, due });
  }
  log(`  purchases: ${PURCHASES} bills`);

  /* ── sales ─────────────────────────────────────────────────────────────── */

  /* A real book is not evenly settled. Roughly: most cash sales close on the
     spot, credit sales settle late or not at all, and a tail stays open long
     enough to land in every ageing bucket including Over 90 days. */
  let repIdx = 0;
  let invCount = 0, lineCount = 0;
  const progressEvery = Math.max(1000, Math.round(INVOICES / 20));

  for (let n = 0; n < INVOICES; n++) {
    const ms = tradingDay();
    const date = iso(ms);
    const hour = tradingHour();
    const createdAt = stamp(ms, hour, rint(0, 59));
    const cash = rnd() < 0.62;
    const customer = cash && rnd() < 0.55 ? { id: cashParty.id, days: 0 } : pick(customers);
    const rep = repIds[repIdx++ % repIds.length];

    const nLines = pickw([[1, 30], [2, 25], [3, 18], [4, 12], [5, 8], [6, 4], [8, 2], [12, 1]]);
    const lines = [];
    let sub = 0, cost = 0;
    for (let l = 0; l < nLines; l++) {
      const it = pick(stocked);
      const qty = pickw([[1, 40], [2, 20], [3, 12], [5, 10], [10, 8], [20, 4], [50, 1]]);
      const rate = round2(it.price * (rnd() < 0.15 ? 0.9 + rnd() * 0.08 : 1));
      const discPct = rnd() < 0.18 ? pick([2, 5, 10]) : 0;
      const gross = round2(qty * rate);
      const disc = round2(gross * discPct / 100);
      const value = round2(gross - disc);
      sub = round2(sub + value);
      cost = round2(cost + qty * it.cost);
      lines.push({ it, qty, rate, discPct, disc, value });
    }

    const invNo = `INV-${pad(await nextSeq(conn, `INV:firm${firmId}`))}`;
    const dueDate = iso(ms + (cash ? 0 : customer.days) * DAY);
    /* settlement */
    let paid;
    if (cash) paid = sub;
    else paid = pickw([[1, 45], [0.5, 15], [0.25, 10], [0, 30]]) * sub;
    paid = round2(Math.min(paid, sub));
    const balance = round2(sub - paid);
    const status = balance <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

    await conn.query(
      `INSERT INTO sale_invoices (firm_id, invoice_no, doc_type, party_id, invoice_date, due_date,
              sub_total, discount_total, tax_total, grand_total, paid_amount, balance_due,
              status, payment_type, created_by, sales_rep_id, created_at)
       VALUES (?,?,'invoice',?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
      [firmId, invNo, customer.id, date, dueDate, sub,
       round2(lines.reduce((a, l) => a + l.disc, 0)), sub, paid, balance, status,
       cash ? "cash" : "credit", rep, rep, createdAt]);
    const invId = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;

    for (const ln of lines) {
      await conn.query(
        `INSERT INTO sale_invoice_lines (firm_id, invoice_id, item_id, quantity, base_quantity,
                unit, rate, discount_pct, discount_amt, taxable_value, line_total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [firmId, invId, ln.it.id, ln.qty, ln.qty, null, ln.rate, ln.discPct, ln.disc,
         ln.value, ln.value]);
      await postMovement(conn, { firmId, itemId: ln.it.id, direction: "out", quantity: ln.qty,
        unitCost: ln.it.cost, sourceModule: "sales", sourceId: invId, userId: rep });
      lineCount++;
    }

    await postJournal(conn, { firmId, date, description: `Sale ${invNo}`, reference: invNo,
      sourceModule: "sales", sourceId: invId, userId: rep,
      lines: cash ? templates.saleCash({ subTotal: sub }) : templates.saleCredit({ subTotal: sub }) });
    if (cost > 0) {
      await postJournal(conn, { firmId, date, description: `COGS ${invNo}`, reference: invNo,
        sourceModule: "sales_cogs", sourceId: invId, userId: rep,
        lines: templates.cogs({ totalCost: cost }) });
    }

    /* Cash sales settle in the same breath; credit sales get their own receipt
       so the payments list, the cash-flow report and the party statement all
       have something to show. */
    if (paid > 0) {
      const payMs = cash ? ms : ms + rint(1, 45) * DAY;
      const payDate = iso(Math.min(payMs, end));
      const payNo = `PAY-${pad(await nextSeq(conn, `PAY:firm${firmId}`))}`;
      const mode = cash ? pickw([["cash", 6], ["upi", 2], ["card", 1]])
                        : pickw([["bank", 4], ["cash", 3], ["cheque", 1], ["upi", 2]]);
      await conn.query(
        `INSERT INTO payments (firm_id, payment_no, direction, party_id, payment_date, amount,
                mode, unallocated, created_by, created_at, status)
         VALUES (?,?,'in',?,?,?,?,0,?,?, 'paid')`,
        [firmId, payNo, customer.id, payDate, paid, mode, rep, stamp(ms, hour, rint(0, 59))]);
      const payId = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;
      await conn.query(
        `INSERT INTO payment_allocations (firm_id, payment_id, doc_table, doc_id, amount)
         VALUES (?,?,'sale_invoices',?,?)`, [firmId, payId, invId, paid]);
      await postJournal(conn, { firmId, date: payDate, description: `Payment in ${payNo}`,
        reference: payNo, sourceModule: "payments", sourceId: payId, userId: rep,
        lines: templates.paymentIn({ amount: paid, cashCode: mode === "cash" ? CODES.CASH : CODES.BANK }) });
    }

    invCount++;
    if (invCount % progressEvery === 0) log(`    …${invCount}/${INVOICES} invoices`);
    /* Commit periodically so the rollback journal is released and a crashed
       run leaves something inspectable. This is *not* what fixed the 8,000-
       invoice wall — that was db.exec()'s wasm stack leak, see the conn shim
       above. Committing every 500 alone did not help, which was the clue. */
    if (invCount % 500 === 0) { db.run("COMMIT"); db.run("BEGIN"); }
  }
  log(`  sales: ${invCount} invoices, ${lineCount} lines`);

  /* ── expenses, adjustments, a few estimates ────────────────────────────── */

  const EXPENSE_KINDS = ["Rent", "Electricity", "Water", "Transport", "Airtime", "Wages",
    "Repairs", "Licences", "Security", "Packaging"];
  const expenseCount = Math.max(10, Math.round(240 * scale));
  for (let i = 0; i < expenseCount; i++) {
    const ms = tradingDay();
    const amount = round2(rint(20, 4000) * 500);
    const kind = pick(EXPENSE_KINDS);
    const no = `EXP-${pad(await nextSeq(conn, `EXP:firm${firmId}`))}`;
    await conn.query(
      `INSERT INTO expenses (firm_id, expense_no, expense_date, category, amount, tax_amount,
              mode, notes, created_by, created_at)
       VALUES (?,?,?,?,?,0,?,?,?,?)`,
      [firmId, no, iso(ms), kind, amount, pick(["cash", "bank"]), kind, adminUser,
       stamp(ms, tradingHour(), rint(0, 59))]);
    const eid = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;
    await postJournal(conn, { firmId, date: iso(ms), description: `${kind} ${no}`, reference: no,
      sourceModule: "expenses", sourceId: eid, userId: adminUser,
      lines: templates.expense({ amount }) });
  }

  /* Shrinkage and breakage — the stock ledger is not only sales and purchases,
     and the adjustment reports need rows to be worth looking at. */
  const adjustCount = Math.max(10, Math.round(400 * scale));
  for (let i = 0; i < adjustCount; i++) {
    const ms = tradingDay();
    const it = pick(stocked);
    const qty = rint(1, 12);
    await postMovement(conn, { firmId, itemId: it.id, direction: rnd() < 0.75 ? "out" : "in",
      quantity: qty, unitCost: it.cost, sourceModule: "adjustment", sourceId: i + 1,
      userId: adminUser });
    const value = round2(qty * it.cost);
    await postJournal(conn, { firmId, date: iso(ms), description: "Stock adjustment",
      reference: `ADJ-${pad(i + 1)}`, sourceModule: "adjustment", sourceId: i + 1,
      userId: adminUser,
      lines: [{ account_code: CODES.STOCK_ADJ, debit: value },
              { account_code: CODES.STOCK, credit: value }] });
  }

  /* Estimates share the sale_invoices table via doc_type, and quote-details
     reads nothing else — with none of these that report is permanently blank. */
  const quoteCount = Math.max(5, Math.round(300 * scale));
  for (let i = 0; i < quoteCount; i++) {
    const ms = tradingDay();
    const it = pick(stocked);
    const qty = rint(1, 30);
    const sub = round2(qty * it.price);
    const no = `EST-${pad(await nextSeq(conn, `EST:firm${firmId}`))}`;
    await conn.query(
      `INSERT INTO sale_invoices (firm_id, invoice_no, doc_type, party_id, invoice_date, due_date,
              sub_total, tax_total, grand_total, paid_amount, balance_due, status, payment_type,
              created_by, sales_rep_id, created_at)
       VALUES (?,?,'estimate',?,?,?,?,0,?,0,0,?,'credit',?,?,?)`,
      [firmId, no, pick(customers).id, iso(ms), iso(ms + 14 * DAY), sub, sub,
       pick(["open", "converted", "expired"]), adminUser, adminUser,
       stamp(ms, tradingHour(), rint(0, 59))]);
    const qid = (await conn.query("SELECT last_insert_rowid() AS id")).rows[0].id;
    await conn.query(
      `INSERT INTO sale_invoice_lines (firm_id, invoice_id, item_id, quantity, base_quantity,
              rate, taxable_value, line_total) VALUES (?,?,?,?,?,?,?,?)`,
      [firmId, qid, it.id, qty, qty, it.price, sub, sub]);
  }

  /* ── derived caches, computed once at the end ──────────────────────────── */

  /* Party balances are maintained per-transaction in production; here they are
     recomputed in one statement from the documents that define them, which is
     both faster and a check that the generated documents are self-consistent. */
  await conn.query(
    `UPDATE parties SET balance = opening_balance
       + COALESCE((SELECT SUM(balance_due) FROM sale_invoices s
                    WHERE s.firm_id = parties.firm_id AND s.party_id = parties.id
                      AND COALESCE(s.doc_type,'invoice') = 'invoice'), 0)
       - COALESCE((SELECT SUM(balance_due) FROM purchase_invoices b
                    WHERE b.firm_id = parties.firm_id AND b.party_id = parties.id), 0)
     WHERE firm_id = ?`, [firmId]);

  db.run("COMMIT");

  const counts = {};
  for (const t of ["items", "parties", "users", "sale_invoices", "sale_invoice_lines",
    "purchase_invoices", "purchase_invoice_lines", "payments", "payment_allocations",
    "stock_movements", "item_stock", "journal_entries", "journal_entry_lines", "expenses"]) {
    counts[t] = (await one(`SELECT COUNT(*) c FROM ${t}`)).c;
  }

  /* A generated book that does not balance is a generated book that will make
     every accounting report look broken for reasons that are not the app's. */
  const tb = await one("SELECT ROUND(SUM(debit) - SUM(credit), 2) AS diff FROM journal_entry_lines WHERE firm_id = ?", [firmId]);
  if (Math.abs(Number(tb.diff) || 0) > 0.05) {
    console.error(`Generated ledger does not balance: Dr − Cr = ${tb.diff}`);
    process.exitCode = 1;
  }

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log("");
  log(`Seeded ${DB_PATH} in ${secs}s  (seed=${SEED}, ${MONTHS} months to ${iso(end)})`);
  for (const [t, c] of Object.entries(counts)) log(`  ${String(c).padStart(8)}  ${t}`);
  log(`  ${String((fs.statSync(DB_PATH).size / 1048576).toFixed(1)).padStart(8)}  MB on disk`);
  log("\nadmin/admin123  ·  staff1…staffN/staff123");
})().catch((e) => { console.error(e); process.exit(1); });
