/**
 * provision.js — everything a new company needs before it can trade.
 *
 * Lifted out of `seed.js` rather than written again. A company created from
 * the Companies screen and a company created by the seeder must be identical:
 * the same chart of accounts, the same roles, the same units and party groups.
 * Two implementations would drift, and the drift would only show up months
 * later as a report that works for the first business and not the second.
 *
 * Everything here runs on a caller-supplied connection, inside the caller's
 * transaction. A half-provisioned company — a firm row with no chart of
 * accounts — cannot post a sale and cannot be repaired from the interface.
 */
const { DEFAULT_CHART } = require("./account.codes");
const { MODULES, ACTIONS, CATALOGUE } = require("./permission.catalogue");

const UNITS = [["Pieces", "PCS"], ["Kilogram", "KG"], ["Litre", "LTR"], ["Bag", "BAG"], ["Box", "BOX"], ["Dozen", "DZN"]];

/**
 * Every permission pair an Admin should hold — the MODULES × ACTIONS grid
 * **plus** anything the readable catalogue can grant that the grid does not
 * cover.
 *
 * The grid is view / create / edit / delete. Two company permissions are
 * neither — `companies.grant` (decide who may open which business) and
 * `companies.panel` (see every business at once) — so seeding from the grid
 * alone produced an Admin role that could not be given them by any means: not
 * by seeding, and not by the roles screen either, since that screen can only
 * tick what a role already has room for. Deriving the set from the catalogue
 * means a permission invented later is granted to Admin automatically instead
 * of being unreachable until somebody notices.
 */
function everyPair() {
  const seen = new Set();
  const out = [];
  const add = (m, a) => { const k = `${m}.${a}`; if (!seen.has(k)) { seen.add(k); out.push([m, a]); } };
  for (const m of MODULES) for (const a of ACTIONS) add(m, a);
  for (const [, questions] of CATALOGUE) {
    for (const q of questions) for (const g of (q[3] || [])) {
      const [m, a] = String(g).split(".");
      if (m && a) add(m, a);
    }
  }
  return out;
}

/**
 * @returns {{firmId:number, adminRoleId:number}}
 */
async function provisionFirm(conn, firm) {
  return await withCompanyStorage(conn, firm, async (c, firmId) => await fillNewCompany(c, firmId, firm));
}

/**
 * Create the company's row, and — when each company has its own file — the
 * file itself, with its schema, before anything is written into it.
 *
 * The order is the interesting part, and it is forced by there being no
 * transaction across two SQLite files:
 *
 *   1. the `firms` row, in the central database, inside the caller's
 *      transaction. This is what allocates the id, and the id names the file.
 *   2. the company's own file, created and migrated.
 *   3. everything the company needs to trade, written into that file.
 *
 * A crash between 1 and 3 leaves a company that exists and cannot be opened —
 * visible, nameable, and repairable by provisioning it again. The alternative
 * ordering leaves a fully-provisioned file that no account can reach and
 * nothing knows about, which is the same data with none of the ways to find
 * it. Repairable beats orphaned.
 */
async function withCompanyStorage(conn, firm, fill) {
  await conn.query(
    `INSERT INTO firms (name, legal_name, gstin, state_code, invoice_prefix, round_off_invoices, status,
                        address, phone, email, financial_year_start_month, created_by)
     VALUES (?,?,?,?,?,?,'active',?,?,?,?,?)`,
    [firm.name, firm.legal_name || null, firm.gstin || null, firm.state_code || "UG",
     firm.invoice_prefix || "INV", firm.round_off_invoices == null ? 1 : (firm.round_off_invoices ? 1 : 0),
     firm.address || null, firm.phone || null, firm.email || null,
     firm.financial_year_start_month || 1, firm.created_by || null]);
  const firmId = (await conn.query("SELECT id FROM firms ORDER BY id DESC LIMIT 1")).rows[0].id;

  /* The shop code, immediately. A company without one cannot be named on the
     sign-in screen, so its counter staff could not sign in at all on an
     installation holding more than one — and that would only be discovered by
     the first cashier to try. */
  try {
    const { freeShopCode } = require("../database/setup");
    await conn.query("UPDATE firms SET shop_code = ? WHERE id = ?",
      [String(firm.shop_code || "").trim() || await freeShopCode(firm.name, firmId), firmId]);
  } catch (e) { console.error("shop code not set for the new company:", e.message); }

  const tenancy = require("../database/tenancy");
  if (!tenancy.enabled()) return fill(conn, firmId);

  /* The company's own file. `setup()` is declared async but every statement in
     it is synchronous, so calling it runs the whole schema now; there is
     nothing to await and awaiting here would mean holding the caller's
     transaction open across a turn of the event loop. */
  const { query } = require("../database/db");
  const store = tenancy.storeFor(firmId);
  const { setup } = require("../database/setup");
  await tenancy.withStore(store, async () => await tenancy.withFirm(firmId, async () => await setup()));

  /* Written through `query` rather than the caller's connection, deliberately:
     that connection's transaction is on the central database, and a write to
     another file from inside it cannot commit or roll back with it. db.js
     refuses that write by name rather than letting it look atomic. */
  return tenancy.withFirm(firmId, () => fill({ query }, firmId));
}

/** Everything a company needs before it can trade, inside its own database. */
async function fillNewCompany(conn, firmId, firm) {
  /* Already provisioned — a retry after something failed part-way through.
   *
   * The ordering above deliberately leaves a company that exists and is not
   * yet furnished, so that it can be provisioned again. That only works if
   * doing it again is safe, and the first version was not: it inserted a
   * second Admin role, read back the first, and then collided on
   * `role_permissions`' UNIQUE — turning a repairable company into one that
   * refused to be repaired. */
  const existing = (await conn.query("SELECT id FROM roles WHERE firm_id = ? AND name = 'Admin'", [firmId])).rows[0];
  if (existing) {
    const sales = (await conn.query("SELECT id FROM roles WHERE firm_id = ? AND name = 'Salesman'", [firmId])).rows[0];
    return { firmId, adminRoleId: existing.id, salesRoleId: sales ? sales.id : null, reused: true };
  }

  /* Roles. Admin holds everything; Salesman is the counter role. Both are
     per-firm rows, so one company's permissions can never widen another's. */
  await conn.query("INSERT INTO roles (firm_id, name, is_system) VALUES (?, 'Admin', 1)", [firmId]);
  const adminRoleId = (await conn.query("SELECT id FROM roles WHERE firm_id=? AND name='Admin'", [firmId])).rows[0].id;
  for (const [m, a] of everyPair()) {
    await conn.query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [adminRoleId, m, a]);
  }
  await conn.query("INSERT INTO roles (firm_id, name, is_system) VALUES (?, 'Salesman', 0)", [firmId]);
  const salesRoleId = (await conn.query("SELECT id FROM roles WHERE firm_id=? AND name='Salesman'", [firmId])).rows[0].id;
  for (const [m, a] of [["parties", "view"], ["parties", "create"], ["items", "view"],
                        ["sales", "view"], ["sales", "create"], ["payments", "view"]]) {
    await conn.query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [salesRoleId, m, a]);
  }

  for (const [code, name, type, cashBank, control] of DEFAULT_CHART) {
    await conn.query("INSERT INTO chart_of_accounts (firm_id, code, name, type, is_cash_bank, is_control) VALUES (?,?,?,?,?,?)",
      [firmId, code, name, type, cashBank, control]);
  }
  for (const [n, sh] of UNITS) await conn.query("INSERT INTO item_units (firm_id, name, short) VALUES (?,?,?)", [firmId, n, sh]);
  await conn.query("INSERT INTO item_categories (firm_id, name) VALUES (?,?)", [firmId, "General"]);
  for (const g of ["Retail", "Wholesale"]) await conn.query("INSERT INTO party_groups (firm_id, name) VALUES (?,?)", [firmId, g]);

  /* The walk-in customer. Every till sale needs a party, and a new company with
     no parties cannot ring up its first sale — which is the first thing anyone
     does. */
  await conn.query(
    `INSERT INTO parties (firm_id, name, party_type, state_code, opening_balance)
     VALUES (?,?,?,?,0)`, [firmId, "Cash Sale", "customer", firm.state_code || "UG"]);

  /* No tax rules. A shop picks its tax treatment deliberately; shipping rules
     nobody asked for is how sales came out taxed unexpectedly — the reason
     seed.js only pre-loads them for the demo. */

  /* The first-run wizard is marked done for a company created this way.
     It asks for the business name, tax number, address and invoice prefix —
     every one of which the Companies form has just collected. Leaving it unset
     dropped the owner into a wizard asking them to type again what they had
     typed thirty seconds earlier, on a screen with no way back to the business
     they came from. A company created by `seed.js` is untouched by this; it
     sets `setup_done` on its own terms. */
  if (firm.mark_setup_done) {
    await conn.query("INSERT INTO firm_settings (firm_id, skey, svalue) VALUES (?,?,?) " +
               "ON CONFLICT(firm_id, skey) DO UPDATE SET svalue = excluded.svalue",
      [firmId, "setup_done", "1"]);
  }
  return { firmId, adminRoleId, salesRoleId };
}

module.exports = { provisionFirm, everyPair };
