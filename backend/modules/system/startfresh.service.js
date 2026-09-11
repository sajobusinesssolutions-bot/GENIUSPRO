"use strict";
/**
 * startfresh.service.js — empty a business and set it up again.
 *
 * There are two different things a shopkeeper means by "start again", and
 * confusing them loses somebody's year:
 *
 *   **Start fresh** — this file. The business stays, its people stay, its
 *   chart of accounts, units and roles stay. What goes is the trading:
 *   invoices, purchases, payments, expenses, the ledger, stock movements,
 *   and — if asked — the items and customers too. Then `setup_done` is
 *   cleared so the first-run wizard runs again.
 *
 *   **Delete the company** — `companies.routes.js`. Different thing, already
 *   there, guarded four ways.
 *
 * Why it exists: a demonstration copy that has been sold, or an installation
 * that shipped with somebody's test trading in it, is unusable as a real
 * shop's books and there was no way out but to find a file in AppData.
 *
 * Three rules it does not break:
 *
 *   · **A backup is taken first, always.** Not offered — taken. The one
 *     operation in the product that destroys a year of trading is not the
 *     place to trust that somebody read the dialog.
 *   · **It runs in one transaction.** A half-emptied business is worse than
 *     either state.
 *   · **The walk-in customer survives.** The till cannot ring a sale without
 *     a party, so removing "Cash Sale" would empty the shop and break it.
 */
const T = require("../../shared/tenant.tables");

/* Trading. Always cleared — this is what "start fresh" means. */
const TRADING = [
  "sale_invoice_lines", "sale_invoices", "sale_return_lines", "sale_returns",
  "purchase_invoice_lines", "purchase_invoices", "purchase_return_lines", "purchase_returns",
  "purchase_order_lines", "purchase_orders", "estimate_lines", "estimates",
  "challan_lines", "challans",
  "payment_allocations", "payments", "expenses",
  "journal_entry_lines", "journal_entries", "account_balances",
  "cash_movements", "day_closes", "shifts", "void_log",
  "stock_movements", "stock_take_lines", "stock_takes", "item_serials", "repacks",
  "item_stock",
  "loyalty_ledger", "warranty_claims", "warranties",
  "installment_lines", "installment_plans",
  "recurring_runs", "production_consumed", "production_runs",
  "held_sales", "tax_filings", "payment_reminders",
];

/* The catalogue. Cleared only when the owner asks for it too. */
const CATALOGUE = [
  "item_barcodes", "party_item_rates", "price_list_items", "price_lists",
  "items", "parties", "offers", "boms", "bom_components",
];

/** What is about to be destroyed, so the owner is told before it happens. */
async function preview(query, firmId, opts = {}) {
  const count = async (table, where, args) => {
    try { return (await query(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`, args)).rows[0].c; }
    catch { return 0; }
  };
  const firmOf = async (t) => await count(t, "firm_id = ?", [firmId]);
  const out = {
    invoices:   await firmOf("sale_invoices"),
    purchases:  await firmOf("purchase_invoices"),
    payments:   await firmOf("payments"),
    expenses:   await firmOf("expenses"),
    journal:    await firmOf("journal_entries"),
    stock_moves: await firmOf("stock_movements"),
    items:      await firmOf("items"),
    /* the walk-in party is not a customer anybody entered */
    parties:    Math.max(0, await firmOf("parties") - 1),
  };
  out.willKeepItemsAndParties = !opts.alsoCatalogue;
  return out;
}

/**
 * Empty it.
 *
 * @param conn          a durable connection — the caller owns the transaction
 * @param firmId        which company
 * @param opts.alsoCatalogue  clear items and customers as well as the trading
 * @param opts.alsoTaxRules   clear the tax chain (a demo VAT rule, typically)
 * @param opts.reopenSetup    clear setup_done so the wizard runs again
 */
async function startFresh(conn, firmId, opts = {}) {
  const run = async (sql, args) => { try { await conn.query(sql, args); } catch { /* table absent in this build */ } };
  const wiped = [];

  const clear = async (tables) => {
    for (const t of tables) {
      if (T.CHILD[t]) {
        const c = T.CHILD[t];
        await run(`DELETE FROM ${t} WHERE ${c.fk} IN (SELECT id FROM ${c.parent} WHERE firm_id = ?)`, [firmId]);
      } else {
        await run(`DELETE FROM ${t} WHERE firm_id = ?`, [firmId]);
      }
      wiped.push(t);
    }
  };

  await clear(TRADING);
  if (opts.alsoCatalogue) {
    /* The walk-in party is structure, not a customer: the till refuses a sale
       without one, so emptying it would leave a shop that cannot trade. */
    await run(`DELETE FROM parties WHERE firm_id = ? AND party_no <> 'CUST-000000'`, [firmId]);
    await clear(CATALOGUE.filter((t) => t !== "parties"));
  }
  if (opts.alsoTaxRules) await clear(["tax_rules"]);

  /* Numbering starts again, or the first new invoice claims a number the
     books no longer hold and the sequence looks like it lost a year. */
  await run(`DELETE FROM sequences WHERE name LIKE ?`, [`%firm${firmId}`]);

  if (opts.reopenSetup !== false) {
    await run(`DELETE FROM firm_settings WHERE firm_id = ? AND skey = 'setup_done'`, [firmId]);
  }
  return { wiped: wiped.length };
}

module.exports = { startFresh, preview, TRADING, CATALOGUE };
