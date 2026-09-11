/**
 * utilities.routes.js — Utilities: Excel/CSV import & export,
 * and "Verify My Data" integrity checks.
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { nextSeq, pad } = require("../../shared/sequences");

router.use(verifyToken);

const csvEscape = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function sendCsv(res, name, header, rows) {
  const body = [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send("\uFEFF" + body); // BOM for Excel
}

/* Export items */
router.get("/export-items", requirePermission("settings", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT i.name, i.item_type, i.unit, i.secondary_unit, i.conversion_rate,
            i.sale_price, i.purchase_price, i.reorder_level,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) on_hand
       FROM items i WHERE i.firm_id=? ORDER BY i.name`, [req.user.firm_id])).rows;
  sendCsv(res, "items.csv",
    ["Name","Type","Unit","SecondaryUnit","ConversionRate","SalePrice","PurchasePrice","ReorderLevel","InStock"],
    rows.map((r) => [r.name, r.item_type, r.unit, r.secondary_unit || "", r.conversion_rate || "", r.sale_price, r.purchase_price, r.reorder_level, r.on_hand]));
});

/* Export parties */
router.get("/export-parties", requirePermission("settings", "view"), async (req, res) => {
  const rows = (await query("SELECT name, party_type, phone, email, credit_limit, balance FROM parties WHERE firm_id=? ORDER BY name", [req.user.firm_id])).rows;
  sendCsv(res, "parties.csv", ["Name","Type","Phone","Email","CreditLimit","Balance"],
    rows.map((r) => [r.name, r.party_type, r.phone || "", r.email || "", r.credit_limit, r.balance]));
});

/* Import items — array of {name, unit?, sale_price?, purchase_price?, opening_stock?, reorder_level?} */
router.post("/import-items", requirePermission("settings", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.fail("No rows to import");
    /* Duplicate handling mirrors the import wizard: "skip" keeps what is already
       on file, "overwrite" updates the existing item from the file instead. */
    const onDuplicate = req.body.on_duplicate === "overwrite" ? "overwrite" : "skip";
    let created = 0, skipped = 0, updated = 0;
    const problems = [];
    await conn.beginTransaction();
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const name = (r.name || "").trim();
      if (!name) { skipped++; problems.push({ row: idx + 1, reason: "No item name" }); continue; }
      /* Match on item code when the file carries one — it is the stabler key,
         and it is the only way to tell duplicates apart once duplicate names
         are allowed in Items → Preferences. */
      const code = (r.item_code || "").trim();
      const existing = code
        ? (await conn.query("SELECT id FROM items WHERE firm_id=? AND item_code=?", [req.user.firm_id, code])).rows[0]
        : (await conn.query("SELECT id FROM items WHERE firm_id=? AND lower(name)=lower(?)", [req.user.firm_id, name])).rows[0];
      if (existing) {
        if (onDuplicate === "skip") { skipped++; continue; }
        await conn.query(
          `UPDATE items SET name=?, unit=COALESCE(?,unit), sale_price=COALESCE(?,sale_price),
                            purchase_price=COALESCE(?,purchase_price), reorder_level=COALESCE(?,reorder_level)
            WHERE id=?`,
          [name, r.unit || null,
           r.sale_price != null && r.sale_price !== "" ? Number(r.sale_price) || 0 : null,
           r.purchase_price != null && r.purchase_price !== "" ? Number(r.purchase_price) || 0 : null,
           r.reorder_level != null && r.reorder_level !== "" ? Number(r.reorder_level) || 0 : null,
           existing.id]);
        updated++;
        continue;
      }
      const ir = await conn.query(
        `INSERT INTO items (firm_id, item_code, name, item_type, is_inventory, unit, sale_price, purchase_price, reorder_level)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [req.user.firm_id, code || null, name, "product", 1, r.unit || "PCS",
         Number(r.sale_price) || 0, Number(r.purchase_price) || 0, Number(r.reorder_level) || 0]);
      const opening = Number(r.opening_stock) || 0;
      if (opening > 0) {
        await conn.query("INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module, created_by) VALUES (?,?,?,?,?,?,?)",
          [req.user.firm_id, ir.insertId, "in", opening, Number(r.purchase_price) || 0, "opening", req.user.id]);
        await conn.query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)",
          [req.user.firm_id, ir.insertId, "", opening, Number(r.purchase_price) || 0]);
      }
      created++;
    }
    await conn.commit();
    const bits = [`${created} added`];
    if (updated) bits.push(`${updated} updated`);
    if (skipped) bits.push(`${skipped} skipped`);
    res.success({ created, updated, skipped, problems: problems.slice(0, 20) }, `Import finished — ${bits.join(", ")}`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* Sample import file — the exact shape the wizard expects, with two example rows. */
router.get("/sample-items-csv", (req, res) => {
  sendCsv(res, "sample-items.csv",
    ["ItemCode", "Name", "Unit", "SalePrice", "PurchasePrice", "OpeningStock", "ReorderLevel"],
    [["SKU-001", "Blue Ballpoint Pen", "PCS", 500, 300, 120, 20],
     ["SKU-002", "A4 Ream 80gsm", "PKT", 18000, 14500, 25, 5]]);
});

/* Verify My Data — integrity checks a business owner can run any time */
router.get("/verify", requirePermission("settings", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // 1) GL must balance
  const glSum = +(await query("SELECT COALESCE(SUM(balance),0) v FROM account_balances WHERE firm_id=?", [f])).rows[0].v.toFixed(2);
  add("Books balance (Σ ledger = 0)", glSum === 0, `Σ = ${glSum}`);

  // 2) journal entries individually balanced
  const badJe = (await query(
    `SELECT COUNT(*) v FROM (
       SELECT entry_id, ROUND(SUM(debit)-SUM(credit),2) diff FROM journal_entry_lines
        WHERE firm_id=? GROUP BY entry_id) WHERE diff != 0`, [f])).rows[0].v;
  add("Every journal entry balanced", badJe === 0, badJe ? `${badJe} unbalanced` : "all balanced");

  // 3) cached stock matches movement ledger
  const stockDrift = (await query(
    `SELECT COUNT(*) v FROM (
       SELECT i.id, COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) cached,
              COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN quantity ELSE -quantity END) FROM stock_movements m WHERE m.item_id=i.id),0) ledger
         FROM items i WHERE i.firm_id=? AND i.is_inventory=1
     ) WHERE ROUND(cached - ledger, 3) != 0`, [f])).rows[0].v;
  add("Stock cache matches movement ledger", stockDrift === 0, stockDrift ? `${stockDrift} items drifted` : "all consistent");

  // 4) invoice paid + due = grand
  const badInv = (await query(
    "SELECT COUNT(*) v FROM sale_invoices WHERE firm_id=? AND ROUND(paid_amount + balance_due - grand_total, 2) != 0", [f])).rows[0].v;
  add("Invoices: paid + due = total", badInv === 0, badInv ? `${badInv} inconsistent` : "all consistent");

  // 5) trial balance Dr = Cr
  const tb = (await query(
    `SELECT ROUND(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END),2) dr,
            ROUND(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),2) cr
       FROM account_balances WHERE firm_id=?`, [f])).rows[0];
  add("Trial balance Dr = Cr", tb.dr === tb.cr, `${tb.dr} vs ${tb.cr}`);

  res.success({ checks, healthy: checks.every((c) => c.ok) });
});

/* ── Exports, all of them ──────────────────────────────────────────────────
 *
 * There were two: items and parties. A shop being asked by its accountant for
 * "last year's sales as a spreadsheet" had no way to produce one from this
 * screen, and was reduced to printing a report and typing it back in.
 *
 * One route, a table of datasets. Each names its own SQL and its own header,
 * so adding the next one is four lines and cannot accidentally leak another
 * firm's rows — the firm filter is in every query below, not bolted on.
 */
const EXPORTS = {
  items: {
    name: "items.csv",
    label: "Items, with stock and prices",
    header: ["Name", "Code", "Barcode", "Type", "Unit", "SalePrice", "PurchasePrice", "ReorderLevel", "InStock"],
    sql: `SELECT i.name, i.item_code, i.barcode, i.item_type, i.unit,
                 i.sale_price, i.purchase_price, i.reorder_level,
                 COALESCE((SELECT SUM(quantity) FROM item_stock s
                            WHERE s.item_id=i.id AND s.firm_id=i.firm_id),0) on_hand
            FROM items i WHERE i.firm_id=? ORDER BY i.id`,
  },
  parties: {
    name: "parties.csv",
    label: "Customers and suppliers, with balances",
    header: ["Name", "Type", "Phone", "Email", "CreditLimit", "Balance"],
    sql: `SELECT name, party_type, phone, email, credit_limit, balance
            FROM parties WHERE firm_id=? ORDER BY name`,
  },
  sales: {
    name: "sales.csv",
    label: "Every sale invoice",
    header: ["InvoiceNo", "Date", "Customer", "SubTotal", "Discount", "Tax", "Total", "Paid", "Owing", "Status"],
    sql: `SELECT si.invoice_no, si.invoice_date, COALESCE(p.name,'Cash Sale'),
                 si.sub_total, si.discount_total,
                 (si.cgst_total + si.sgst_total + si.igst_total + si.cess_total),
                 si.grand_total, si.paid_amount, si.balance_due, COALESCE(si.status,'')
            FROM sale_invoices si LEFT JOIN parties p ON p.id = si.party_id
           WHERE si.firm_id=? AND COALESCE(si.doc_type,'invoice')='invoice'
           ORDER BY si.invoice_date, si.id`,
  },
  purchases: {
    name: "purchases.csv",
    label: "Every supplier bill",
    header: ["BillNo", "Date", "Supplier", "SubTotal", "Discount", "Total", "Paid", "Owing", "Status"],
    sql: `SELECT pi.bill_no, pi.bill_date, COALESCE(p.name,''),
                 pi.sub_total, pi.discount_total, pi.grand_total,
                 pi.paid_amount, pi.balance_due, COALESCE(pi.status,'')
            FROM purchase_invoices pi LEFT JOIN parties p ON p.id = pi.party_id
           WHERE pi.firm_id=? ORDER BY pi.bill_date, pi.id`,
  },
  payments: {
    name: "payments.csv",
    label: "Money in and out",
    header: ["PaymentNo", "Date", "Direction", "Party", "Mode", "Amount", "Reference", "Notes"],
    sql: `SELECT pm.payment_no, pm.payment_date, pm.direction, COALESCE(p.name,''),
                 pm.mode, pm.amount, COALESCE(pm.reference,''), COALESCE(pm.notes,'')
            FROM payments pm LEFT JOIN parties p ON p.id = pm.party_id
           WHERE pm.firm_id=? ORDER BY pm.payment_date, pm.id`,
  },
  expenses: {
    name: "expenses.csv",
    label: "Every expense",
    header: ["ExpenseNo", "Date", "Category", "PaidTo", "Mode", "Amount", "Tax", "Notes"],
    sql: `SELECT e.expense_no, e.expense_date, COALESCE(e.category,''), COALESCE(p.name,''),
                 e.mode, e.amount, e.tax_amount, COALESCE(e.notes,'')
            FROM expenses e LEFT JOIN parties p ON p.id = e.party_id
           WHERE e.firm_id=? ORDER BY e.expense_date, e.id`,
  },
  stock: {
    name: "stock-movements.csv",
    label: "Every stock movement",
    header: ["Date", "Item", "Direction", "Quantity", "UnitCost", "Source"],
    sql: `SELECT m.move_date, COALESCE(i.name,''), m.direction, m.quantity,
                 COALESCE(m.unit_cost,0), COALESCE(m.source_module,'')
            FROM stock_movements m LEFT JOIN items i ON i.id = m.item_id
           WHERE m.firm_id=? ORDER BY m.move_date, m.id`,
  },
};

/* What can be exported, so the screen does not keep its own copy of this list
   and drift from it. */
router.get("/exports", requirePermission("settings", "view"), (req, res) => {
  res.success(Object.entries(EXPORTS).map(([id, e]) => ({ id, label: e.label, name: e.name })));
});

router.get("/export/:what", requirePermission("settings", "view"), async (req, res) => {
  const e = EXPORTS[req.params.what];
  if (!e) return res.fail("There is nothing by that name to export", 404);
  const rows = (await query(e.sql, [req.user.firm_id])).rows;
  sendCsv(res, e.name, e.header, rows.map((r) => Object.values(r)));
});

/* ── Duplicates ────────────────────────────────────────────────────────────
 *
 * The single most common mess in a shop's data, and nothing in the app looked
 * for it. Two items called the same thing means stock split across both and a
 * reorder figure that is wrong for each; two parties on one phone number means
 * a debt that shows as settled on one card and outstanding on the other.
 *
 * Reports only. Merging is a decision with consequences, so this finds them
 * and leaves the choice with a person.
 */
router.get("/duplicates", requirePermission("settings", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const groups = async (sql, args) => (await query(sql, args)).rows;

  res.success({
    item_names: await groups(
      `SELECT LOWER(TRIM(name)) k, COUNT(*) n, GROUP_CONCAT(name, ' | ') names,
              GROUP_CONCAT(id) ids
         FROM items WHERE firm_id=? AND COALESCE(status,'active')='active'
        GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 200`, [f]),
    item_barcodes: await groups(
      `SELECT barcode k, COUNT(*) n, GROUP_CONCAT(name, ' | ') names, GROUP_CONCAT(id) ids
         FROM items WHERE firm_id=? AND COALESCE(barcode,'') <> ''
        GROUP BY barcode HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 200`, [f]),
    party_names: await groups(
      `SELECT LOWER(TRIM(name)) k, COUNT(*) n, GROUP_CONCAT(name, ' | ') names, GROUP_CONCAT(id) ids
         FROM parties WHERE firm_id=?
        GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 200`, [f]),
    party_phones: await groups(
      `SELECT phone k, COUNT(*) n, GROUP_CONCAT(name, ' | ') names, GROUP_CONCAT(id) ids
         FROM parties WHERE firm_id=? AND COALESCE(phone,'') <> ''
        GROUP BY phone HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 200`, [f]),
  });
});

/* ── What is actually in this database ─────────────────────────────────────
 * A shop asking "is it safe to keep using this, or is it getting big?" had
 * nowhere to look. Row counts and the date of the oldest record, which between
 * them answer it.
 */
const COUNTED = [
  ["items", "Items"], ["parties", "Customers & suppliers"],
  ["sale_invoices", "Sale documents"], ["purchase_invoices", "Supplier bills"],
  ["payments", "Payments"], ["expenses", "Expenses"],
  ["stock_movements", "Stock movements"], ["journal_entry_lines", "Ledger lines"],
  ["audit_logs", "Audit entries"], ["shifts", "Shifts"],
];
router.get("/storage", requirePermission("settings", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const tables = [];
  for (const [t, label] of COUNTED) {
    try {
      const n = (await query(`SELECT COUNT(*) n FROM ${t} WHERE firm_id=?`, [f])).rows[0].n;
      tables.push({ table: t, label, rows: Number(n) || 0 });
    } catch {
      /* A table this installation does not have yet is not an error worth
         failing the whole screen for — it is a row that is simply absent. */
    }
  }
  let oldest = null;
  try {
    oldest = (await query(
      "SELECT MIN(invoice_date) d FROM sale_invoices WHERE firm_id=?", [f])).rows[0].d || null;
  } catch { oldest = null; }
  res.success({ tables, oldest, total: tables.reduce((a, t) => a + t.rows, 0) });
});

/* ── Rebuild the stock cache ───────────────────────────────────────────────
 *
 * "Verify my data" has always been able to say the cached stock figure has
 * drifted from the movement ledger, and then offer nothing but "contact
 * support". The ledger is the record and the cache is derived from it, so the
 * repair is arithmetic, not a judgement — recompute the cache from the
 * movements and say how many items changed.
 *
 * Only ever writes `item_stock`. It cannot invent or destroy history: every
 * figure it writes is the sum of movements that were already there.
 */
router.post("/repair-stock", requirePermission("settings", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = req.user.firm_id;
    /* Batched items are excluded on purpose. Their cache is one row per batch,
       each carrying an expiry date that the movement ledger does not record —
       collapsing them to a single total would balance the figure and destroy
       the expiry tracking that made batches worth keeping. Those are reported
       and left alone. */
    const all = (await conn.query(
      `SELECT i.id, i.name,
              COALESCE((SELECT SUM(quantity) FROM item_stock s
                         WHERE s.item_id=i.id AND s.firm_id=i.firm_id),0) cached,
              COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN quantity ELSE -quantity END)
                          FROM stock_movements m WHERE m.item_id=i.id AND m.firm_id=i.firm_id),0) ledger,
              COALESCE((SELECT COUNT(*) FROM item_stock s2
                         WHERE s2.item_id=i.id AND s2.firm_id=i.firm_id
                           AND COALESCE(s2.batch_no,'') <> ''),0) batched
         FROM items i WHERE i.firm_id=? AND i.is_inventory=1`, [f])).rows
      .filter((r) => Math.round((r.cached - r.ledger) * 1000) !== 0);

    const drift = all.filter((r) => !r.batched);
    const skipped = all.filter((r) => r.batched);

    if (!drift.length) {
      return res.success(
        { fixed: 0, skipped: skipped.length, skipped_names: skipped.map((r) => r.name).slice(0, 20) },
        skipped.length
          ? `Nothing repaired. ${skipped.length} batched item${skipped.length === 1 ? " was" : "s were"} left alone — their batches carry expiry dates the ledger does not record`
          : "Nothing to repair — the stock figures already match the ledger");
    }

    await conn.beginTransaction();
    for (const r of drift) {
      await conn.query("DELETE FROM item_stock WHERE firm_id=? AND item_id=?", [f, r.id]);
      await conn.query("INSERT INTO item_stock (firm_id, item_id, quantity) VALUES (?,?,?)", [f, r.id, r.ledger]);
    }
    await conn.commit();
    res.success({ fixed: drift.length, skipped: skipped.length,
                  skipped_names: skipped.map((r) => r.name).slice(0, 20) },
      `${drift.length} item${drift.length === 1 ? "'s" : "s'"} stock recomputed from the movement ledger`
      + (skipped.length ? `. ${skipped.length} batched item${skipped.length === 1 ? "" : "s"} left alone` : ""));
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
