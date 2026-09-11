/**
 * seed.js — Uganda demo: Kampala firm (TIN), UGX, tax chain WHT 6% → VAT 18%,
 * chart of accounts, roles, masters, items.
 */
const bcrypt = require("bcryptjs");
const { init, query, persist } = require("./database/db");
const { setup } = require("./database/setup");
const { DEFAULT_CHART } = require("./shared/account.codes");

const MODULES = ["parties", "items", "sales", "payments", "purchases", "expenses", "accounting", "reports", "settings", "users"];
const ACTIONS = ["view", "create", "edit", "delete"];

const DEMO = process.argv.includes("--demo");

/**
 * Seeding is a function rather than only a script because the desktop build
 * has to do it on the first run, in-process. Spawning it as a child cannot
 * work there: a packaged app lives inside an asar archive, and a child
 * process cannot chdir into one.
 *
 * `passwords` lets the caller decide what the first two accounts get. The
 * command line keeps the well-known demo pair.
 *
 * `withUsers: false` seeds everything a shop needs — the company, the roles
 * and their permissions, the chart of accounts, the units, the walk-in
 * customer — and **no logins at all**. That is what the desktop build asks
 * for: the person setting the till up names themselves and chooses their own
 * password on the first screen, instead of reading a generated one out of a
 * console window. See `POST /auth/first-user`.
 */
async function seedDatabase(opts) {
  const o = opts || {};
  const demo = o.demo !== undefined ? o.demo : DEMO;
  const adminPass = o.adminPassword || "admin123";
  const salesPass = o.salesPassword || "sales123";
  const withUsers = o.withUsers !== false;
  const say = o.quiet ? () => {} : console.log;
  const DEMO_LOCAL = demo;

  await init();
  await setup();

  /* "Is this already set up?" is a question about the company, not about the
     logins — a build that seeds without users would otherwise seed again on
     every start and pile up a new company each time. */
  const already = (await query("SELECT 1 FROM firms LIMIT 1")).rows.length
    || (await query("SELECT 1 FROM users LIMIT 1")).rows.length;
  if (already) {
    say("Already seeded. Skipping.");
    persist();
    return { seeded: false };
  }

  /* The firm row has to exist before anyone can log in, but its name is the
     shop's to choose — the first-run wizard asks for it. Only the demo seed
     ships a pre-filled business, so a real install no longer opens branded as
     someone else's shop. gstin holds the URA TIN. */
  const FIRM = DEMO_LOCAL
    ? ["Kampala Traders", "Kampala Traders Ltd", "1000123456", "UG", "INV", 1, "active"]
    : ["My Business", null, null, "UG", "INV", 1, "active"];
  await query(
    `INSERT INTO firms (name, legal_name, gstin, state_code, invoice_prefix, round_off_invoices, status)
     VALUES (?,?,?,?,?,?,?)`,
    FIRM
  );
  const firmId = (await query("SELECT id FROM firms ORDER BY id DESC LIMIT 1")).rows[0].id;

  /* Uganda tax chain — only pre-loaded for the demo. A real shop picks its tax
     treatment in the setup wizard, which writes the rules it needs; shipping
     rules it never asked for is how sales came out taxed unexpectedly. */
  if (DEMO_LOCAL) {
    await query("INSERT INTO tax_rules (firm_id, name, rate, mode, apply_order, is_active) VALUES (?,?,?,?,?,1)",
      [firmId, "Income Tax (WHT)", 6, "deduct", 1]);
    await query("INSERT INTO tax_rules (firm_id, name, rate, mode, apply_order, is_active) VALUES (?,?,?,?,?,1)",
      [firmId, "VAT", 18, "deduct", 2]);
  }

  // Roles
  await query("INSERT INTO roles (firm_id, name, is_system) VALUES (?, 'Admin', 1)", [firmId]);
  const adminRole = (await query("SELECT id FROM roles WHERE firm_id=? AND name='Admin'", [firmId])).rows[0].id;
  /* The same set provisionFirm gives a company created from the interface —
     the grid plus anything else the catalogue can grant. Two copies of this
     loop is how a seeded Admin and a created Admin come to differ. */
  for (const [m, a] of require("./shared/provision").everyPair()) {
    await query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [adminRole, m, a]);
  }
  await query("INSERT INTO roles (firm_id, name, is_system) VALUES (?, 'Salesman', 0)", [firmId]);
  const salesRole = (await query("SELECT id FROM roles WHERE firm_id=? AND name='Salesman'", [firmId])).rows[0].id;
  for (const [m, a] of [["parties","view"],["parties","create"],["items","view"],["sales","view"],["sales","create"],["payments","view"]])
    await query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [salesRole, m, a]);

  // Users — unless the first screen is going to ask for them
  if (withUsers) {
    await query("INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id) VALUES (?,?,?,?,?)",
      ["admin", bcrypt.hashSync(adminPass, 10), "Administrator", adminRole, firmId]);
    await query("INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id) VALUES (?,?,?,?,?)",
      ["sales", bcrypt.hashSync(salesPass, 10), "Sales Rep", salesRole, firmId]);
  }

  // Chart of accounts
  for (const [code, name, type, cashBank, control] of DEFAULT_CHART) {
    await query("INSERT INTO chart_of_accounts (firm_id, code, name, type, is_cash_bank, is_control) VALUES (?,?,?,?,?,?)",
      [firmId, code, name, type, cashBank, control]);
  }

  // Masters
  for (const [n, s] of [["Pieces","PCS"],["Kilogram","KG"],["Litre","LTR"],["Bag","BAG"],["Box","BOX"],["Dozen","DZN"]])
    await query("INSERT INTO item_units (firm_id, name, short) VALUES (?,?,?)", [firmId, n, s]);
  for (const c of (DEMO_LOCAL ? ["General", "Electronics", "Groceries", "Hardware"] : ["General"])) await query("INSERT INTO item_categories (firm_id, name) VALUES (?,?)", [firmId, c]);
  for (const g of (DEMO_LOCAL ? ["Retail", "Wholesale", "Distributor"] : ["Retail", "Wholesale"])) await query("INSERT INTO party_groups (firm_id, name) VALUES (?,?)", [firmId, g]);

  // Items (prices in UGX)
  async function addItem(name, price, cost, stock, reorder) {
    await query(`INSERT INTO items (firm_id, name, item_type, is_inventory, unit, sale_price, purchase_price, reorder_level)
           VALUES (?,?,?,?,?,?,?,?)`, [firmId, name, "product", 1, "PCS", price, cost, reorder]);
    const id = (await query("SELECT id FROM items WHERE firm_id=? AND name=?", [firmId, name])).rows[0].id;
    await query("INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module) VALUES (?,?,?,?,?,?)", [firmId, id, "in", stock, cost, "opening"]);
    await query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)", [firmId, id, "", stock, cost]);
  }
  if (DEMO_LOCAL) {
  await addItem("Maize Flour 10kg", 38000, 30000, 120, 20);
  // Demo unit conversion: cement sold by BAG or KG (1 BAG = 50 KG)
  await query(`INSERT INTO items (firm_id, name, item_type, is_inventory, unit, secondary_unit, conversion_rate, sale_price, purchase_price, reorder_level)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, [firmId, "Cement 50kg Bag", "product", 1, "BAG", "KG", 50, 42000, 35000, 10]);
  const cid = (await query("SELECT id FROM items WHERE firm_id=? AND name='Cement 50kg Bag'", [firmId])).rows[0].id;
  await query("INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module) VALUES (?,?,?,?,?,?)", [firmId, cid, "in", 40, 35000, "opening"]);
  await query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)", [firmId, cid, "", 40, 35000]);
  await addItem("Cooking Oil 5L", 52000, 42000, 80, 15);
  await addItem("Sugar 1kg", 5000, 4000, 8, 10);
  }

  // Walk-in customer for POS billing (the built-in "Cash Sale" counterparty)
  await query(`INSERT INTO parties (firm_id, party_no, name, party_type, balance) VALUES (?,?,?,?,0)`,
    [firmId, "CUST-000000", "Cash Sale", "customer"]);
  if (DEMO_LOCAL) {
    await query(`INSERT INTO parties (firm_id, party_no, name, party_type, phone, credit_limit, balance) VALUES (?,?,?,?,?,?,?)`,
      [firmId, "CUST-000001", "Okello James", "customer", "0772123456", 5000000, 0]);
    await query(`INSERT INTO parties (firm_id, party_no, name, party_type, phone, balance) VALUES (?,?,?,?,?,?)`,
      [firmId, "SUPP-000001", "Jinja Wholesale Ltd", "supplier", "0701998877", 0]);
  }

  // Opening stock is owner-funded, not an expense: put its value on the balance
  // sheet as Inventory against Owner's Capital, so the books start honest.
  const openingValue = (await query(
    "SELECT COALESCE(SUM(quantity * avg_cost),0) v FROM item_stock WHERE firm_id = ?", [firmId]
  )).rows[0].v;
  if (openingValue > 0) {
    await query("INSERT INTO journal_entries (firm_id, entry_no, entry_date, description, reference, source_module, source_id) VALUES (?,?,?,?,?,?,?)",
      [firmId, "JE-OPENING", new Date().toISOString().slice(0, 10), "Opening stock", "opening", "opening", 0]);
    const eid = (await query("SELECT id FROM journal_entries WHERE firm_id=? AND entry_no='JE-OPENING'", [firmId])).rows[0].id;
    await query("INSERT INTO journal_entry_lines (firm_id, entry_id, account_code, debit, credit, narration) VALUES (?,?,?,?,?,?)",
      [firmId, eid, "1020", openingValue, 0, "Opening stock"]);
    await query("INSERT INTO journal_entry_lines (firm_id, entry_id, account_code, debit, credit, narration) VALUES (?,?,?,?,?,?)",
      [firmId, eid, "3001", 0, openingValue, "Owner's capital"]);
    await query("INSERT INTO account_balances (firm_id, account_code, balance) VALUES (?,?,?)", [firmId, "1020", openingValue]);
    await query("INSERT INTO account_balances (firm_id, account_code, balance) VALUES (?,?,?)", [firmId, "3001", -openingValue]);
  }

  persist();
  if (!withUsers) {
    say("Ready for a real shop. No logins yet — the first screen asks who you are.");
  } else {
    say(DEMO_LOCAL
      ? `Seeded WITH demo data. admin/${adminPass} (full)  ·  sales/${salesPass} (limited)`
      : `Ready for a real shop — no demo items or customers. admin/${adminPass} (full)  ·  sales/${salesPass} (limited)\n  (run: node seed.js --demo  for sample data)`);
  }
  return { seeded: true, demo: DEMO_LOCAL, withUsers,
           adminPassword: withUsers ? adminPass : null,
           salesPassword: withUsers ? salesPass : null };
}

module.exports = { seedDatabase };

/* Run as a script: seed and exit. Required as a module: do nothing until asked. */
if (require.main === module) {
  seedDatabase().catch((e) => {
    console.error("Seeding failed:", e && e.stack || e);
    process.exit(1);
  });
}
