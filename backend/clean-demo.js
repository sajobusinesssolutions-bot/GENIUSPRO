/**
 * clean-demo.js — strip the sample data out of a database that was seeded with
 * `node seed.js --demo`.
 *
 *   node clean-demo.js            # show what would go, change nothing
 *   node clean-demo.js --apply    # actually remove it
 *   node clean-demo.js --apply --demo-user   # also remove the sales/sales123 login
 *
 * SAFETY RULES, in order of importance:
 *   1. Nothing is deleted unless --apply is given.
 *   2. A demo item or party that has been used in a real transaction is KEPT
 *      and reported. Deleting it would leave invoices pointing at nothing and
 *      silently unbalance the ledger — a wrong total is far worse than a
 *      leftover row you can rename.
 *   3. A timestamped backup of the database file is written before any change.
 *
 * Anything this script keeps can still be removed by hand from Items / Parties
 * once you've dealt with the transactions holding it.
 */
const fs = require("fs");
const path = require("path");
const { init, query, persist, DB_PATH } = require("./database/db");

const APPLY = process.argv.includes("--apply");
const DROP_DEMO_USER = process.argv.includes("--demo-user");

/* Exactly what seed.js --demo inserts. Nothing else is touched, so a real
   product that happens to be called "Sugar 1kg" is only removed if it is
   genuinely the untouched seed row (no transactions against it). */
const DEMO_ITEMS = ["Maize Flour 10kg", "Cement 50kg Bag", "Cooking Oil 5L", "Sugar 1kg"];
const DEMO_PARTIES = ["Okello James", "Jinja Wholesale Ltd"];
const DEMO_CATEGORIES = ["Electronics", "Groceries", "Hardware"];   // "General" stays as the fallback
const DEMO_PARTY_GROUPS = ["Distributor"];                          // Retail / Wholesale are useful defaults

const kept = [];
const removed = [];

/* Count of rows anywhere that would be orphaned by deleting this item. */
async function itemUsage(id) {
  const tables = [
    ["sale_invoice_lines", "item_id"], ["purchase_invoice_lines", "item_id"],
    ["estimate_lines", "item_id"], ["challan_lines", "item_id"],
    ["sale_return_lines", "item_id"], ["purchase_return_lines", "item_id"],
    ["purchase_order_lines", "item_id"], ["stock_take_lines", "item_id"],
    ["price_list_items", "item_id"], ["party_item_rates", "item_id"],
    ["item_serials", "item_id"], ["repacks", "item_id"],
  ];
  let n = 0;
  for (const [t, col] of tables) {
    try { n += (await query(`SELECT COUNT(*) c FROM ${t} WHERE ${col} = ?`, [id])).rows[0].c; } catch {}
  }
  // opening stock is ours to remove; anything else means the item traded
  try {
    n += (await query("SELECT COUNT(*) c FROM stock_movements WHERE item_id = ? AND source_module <> 'opening'", [id])).rows[0].c;
  } catch {}
  return n;
}

async function partyUsage(id) {
  const tables = [
    ["sale_invoices", "party_id"], ["purchase_invoices", "party_id"],
    ["payments", "party_id"], ["estimates", "party_id"], ["challans", "party_id"],
    ["sale_returns", "party_id"], ["purchase_returns", "party_id"],
    ["purchase_orders", "party_id"], ["expenses", "party_id"],
  ];
  let n = 0;
  for (const [t, col] of tables) {
    try { n += (await query(`SELECT COUNT(*) c FROM ${t} WHERE ${col} = ?`, [id])).rows[0].c; } catch {}
  }
  return n;
}

async function del(sql, params) { if (APPLY) await query(sql, params); }

(async () => {
  await init();

  if (!fs.existsSync(DB_PATH)) {
    console.log(`No database at ${DB_PATH} — nothing to clean.`);
    return;
  }

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(path.dirname(DB_PATH), `genius.before-clean-${stamp}.db`);
    fs.copyFileSync(DB_PATH, backup);
    console.log(`Backup written: ${backup}\n`);
  }

  const firms = (await query("SELECT id, name FROM firms")).rows;

  for (const firm of firms) {
    /* ── items ── */
    for (const name of DEMO_ITEMS) {
      const it = (await query("SELECT id, name FROM items WHERE firm_id = ? AND name = ?", [firm.id, name])).rows[0];
      if (!it) continue;
      const used = await itemUsage(it.id);
      if (used > 0) { kept.push(`item "${it.name}" — used in ${used} transaction line(s)`); continue; }
      await del("DELETE FROM item_stock WHERE item_id = ?", [it.id]);
      await del("DELETE FROM stock_movements WHERE item_id = ?", [it.id]);
      await del("DELETE FROM item_barcodes WHERE item_id = ?", [it.id]);
      await del("DELETE FROM items WHERE id = ?", [it.id]);
      removed.push(`item "${it.name}"`);
    }

    /* ── parties (the built-in "Cash Sale" walk-in is never demo data) ── */
    for (const name of DEMO_PARTIES) {
      const p = (await query("SELECT id, name FROM parties WHERE firm_id = ? AND name = ?", [firm.id, name])).rows[0];
      if (!p) continue;
      const used = await partyUsage(p.id);
      if (used > 0) { kept.push(`party "${p.name}" — has ${used} transaction(s)`); continue; }
      await del("DELETE FROM party_item_rates WHERE party_id = ?", [p.id]);
      await del("DELETE FROM parties WHERE id = ?", [p.id]);
      removed.push(`party "${p.name}"`);
    }

    /* ── the opening-stock journal the demo seed posted ──
       Only safe to reverse once every demo item it valued has gone; otherwise
       the Inventory balance would no longer match the stock on hand. */
    const je = (await query("SELECT id FROM journal_entries WHERE firm_id = ? AND entry_no = 'JE-OPENING'", [firm.id])).rows[0];
    if (je) {
      const stockLeft = (await query("SELECT COALESCE(SUM(quantity * avg_cost),0) v FROM item_stock WHERE firm_id = ?", [firm.id])).rows[0].v;
      if (stockLeft > 0) {
        kept.push(`opening-stock journal — Sh ${stockLeft} of stock still on hand, so the entry still belongs`);
      } else {
        await del("DELETE FROM journal_entry_lines WHERE entry_id = ?", [je.id]);
        await del("DELETE FROM journal_entries WHERE id = ?", [je.id]);
        await del("DELETE FROM account_balances WHERE firm_id = ? AND account_code IN ('1020','3001')", [firm.id]);
        removed.push("opening-stock journal entry and its balances");
      }
    }

    /* ── masters that only existed to make the demo look furnished ── */
    for (const c of DEMO_CATEGORIES) {
      const row = (await query("SELECT id FROM item_categories WHERE firm_id = ? AND name = ?", [firm.id, c])).rows[0];
      if (!row) continue;
      const inUse = (await query("SELECT COUNT(*) c FROM items WHERE category_id = ?", [row.id])).rows[0].c;
      if (inUse > 0) { kept.push(`category "${c}" — ${inUse} item(s) use it`); continue; }
      await del("DELETE FROM item_categories WHERE id = ?", [row.id]);
      removed.push(`category "${c}"`);
    }
    for (const g of DEMO_PARTY_GROUPS) {
      const row = (await query("SELECT id FROM party_groups WHERE firm_id = ? AND name = ?", [firm.id, g])).rows[0];
      if (!row) continue;
      const inUse = (await query("SELECT COUNT(*) c FROM parties WHERE group_id = ?", [row.id])).rows[0].c;
      if (inUse > 0) { kept.push(`party group "${g}" — ${inUse} party(ies) use it`); continue; }
      await del("DELETE FROM party_groups WHERE id = ?", [row.id]);
      removed.push(`party group "${g}"`);
    }
  }

  /* ── the sample cashier login, only when explicitly asked for ── */
  if (DROP_DEMO_USER) {
    const u = (await query("SELECT id, username FROM users WHERE username = 'sales'")).rows[0];
    if (u) {
      const sold = (await query("SELECT COUNT(*) c FROM sale_invoices WHERE created_by = ?", [u.id])).rows[0].c;
      if (sold > 0) kept.push(`login "sales" — raised ${sold} invoice(s), keep it for the audit trail`);
      else { await del("DELETE FROM users WHERE id = ?", [u.id]); removed.push(`login "sales"`); }
    }
  } else {
    const u = (await query("SELECT 1 FROM users WHERE username = 'sales'")).rows[0];
    if (u) kept.push(`login "sales" — pass --demo-user to remove it too`);
  }

  if (APPLY) persist();

  /* ── report ── */
  const head = APPLY ? "REMOVED" : "WOULD REMOVE (dry run)";
  console.log(`${head}: ${removed.length} item(s)`);
  for (const r of removed) console.log(`  - ${r}`);
  if (kept.length) {
    console.log(`\nKEPT: ${kept.length} — these are referenced by real data`);
    for (const k of kept) console.log(`  · ${k}`);
  }
  console.log(APPLY
    ? "\nDone. Restart the app to see the change."
    : "\nNothing was changed. Re-run with --apply to remove the above.");
})();
