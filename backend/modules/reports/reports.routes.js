/**
 * reports.routes.js — the report catalog. Each report is a query over data
 * the transactional modules already capture; ?from=YYYY-MM-DD&to=... filters.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { CODES } = require("../../shared/account.codes");

router.use(verifyToken, requirePermission("reports", "view"));

/* ── bounded report bodies ───────────────────────────────────────────────────
 *
 * Every report below asks for its whole result set and sends it. On the shop
 * this app was verified against — six invoices — that is obviously right. On a
 * two-year shop the sale summary is 20,300 rows; on a ten-year one it is
 * 64 MB of JSON that a browser has to parse and lay out in a table. Nobody
 * reads row 90,000, but everybody waits for it.
 *
 * So the body is bounded and the bound announces itself, using the same
 * convention the list endpoints already use (shared/paginate.js):
 *
 *   X-Result-Limit      the cap applied
 *   X-Result-Truncated  "true" when rows were left out
 *
 * Two things this deliberately does NOT do:
 *
 *   1. It does not change any number. Each report still runs its query over
 *      the whole period and still computes its totals from the whole result;
 *      only the row listing is cut. A truncated sale summary shows the first
 *      5,000 bills and the correct grand total of all 304,500. A wrong number
 *      arriving quickly would not be an improvement.
 *   2. It does not make the full set unreachable. `?limit=` raises the cap, up
 *      to a hard ceiling, so an export or an audit can still pull everything —
 *      it just has to ask.
 *
 * The body shape is untouched (still `{ rows, totals }`, still a bare array
 * where it was one), so a caller that ignores the headers sees exactly what it
 * saw before, minus the tail.
 */
const REPORT_ROW_CAP = 5000;
const REPORT_ROW_MAX = 100000;

function boundReportRows(req, res, next) {
  const asked = parseInt(req.query.limit, 10);
  const cap = Math.min(Math.max(asked > 0 ? asked : REPORT_ROW_CAP, 1), REPORT_ROW_MAX);
  const success = res.success.bind(res);
  res.success = (data, ...rest) => {
    let truncated = false;
    const cut = (arr) => {
      if (!Array.isArray(arr) || arr.length <= cap) return arr;
      truncated = true;
      return arr.slice(0, cap);
    };
    let out = data;
    if (Array.isArray(data)) out = cut(data);
    else if (data && Array.isArray(data.rows)) out = { ...data, rows: cut(data.rows) };
    res.set("X-Result-Limit", String(cap));
    if (truncated) res.set("X-Result-Truncated", "true");
    return success(out, ...rest);
  };
  next();
}
router.use(boundReportRows);

const range = (req, col) => {
  const from = req.query.from || "0000-01-01";
  const to = req.query.to || "9999-12-31";
  return { clause: `AND ${col} BETWEEN ? AND ?`, params: [from, to] };
};

/* 1 ── Sale summary */
router.get("/sale-summary", async (req, res) => {
  const { clause, params } = range(req, "s.invoice_date");
  const rows = (await query(
    `SELECT s.invoice_no, s.invoice_date, p.name AS party_name, s.payment_type,
            s.sub_total, s.tax_total AS tax,
            s.grand_total, s.paid_amount, s.balance_due, s.status
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? ${clause} ORDER BY s.invoice_date, s.id`,
    [req.user.firm_id, ...params]
  )).rows;
  const totals = { grand: sum(rows, "grand_total"), tax: sum(rows, "tax"), due: sum(rows, "balance_due") };
  res.success({ rows, totals });
});

/* 2 ── Purchase summary */
router.get("/purchase-summary", async (req, res) => {
  const { clause, params } = range(req, "b.bill_date");
  const rows = (await query(
    `SELECT b.bill_no, b.bill_date, p.name AS party_name,
            b.sub_total, b.tax_total AS tax,
            b.grand_total, b.paid_amount, b.balance_due, b.status
       FROM purchase_invoices b JOIN parties p ON p.id = b.party_id
      WHERE b.firm_id = ? ${clause} ORDER BY b.bill_date, b.id`,
    [req.user.firm_id, ...params]
  )).rows;
  res.success({ rows, totals: { grand: sum(rows, "grand_total"), tax: sum(rows, "tax"), due: sum(rows, "balance_due") } });
});

/* 5 ── Stock summary: on-hand + value at cost */
router.get("/stock-summary", async (req, res) => {
  const rows = (await query(
    `SELECT i.name, i.item_code, i.hsn_sac, i.unit, i.reorder_level, i.purchase_price,
            COALESCE((SELECT SUM(quantity) FROM item_stock st WHERE st.item_id = i.id),0) AS on_hand
       FROM items i WHERE i.firm_id = ? AND i.is_inventory = 1 ORDER BY i.name`,
    [req.user.firm_id]
  )).rows.map((r) => ({ ...r, stock_value: +(r.on_hand * r.purchase_price).toFixed(2) }));
  res.success({ rows, totals: { qty: sum(rows, "on_hand"), value: sum(rows, "stock_value") } });
});

/* 6 ── Low stock */
router.get("/low-stock", async (req, res) => {
  const rows = (await query(
    `SELECT name, unit, reorder_level, on_hand, purchase_price FROM (
        SELECT i.name, i.unit, i.reorder_level, i.purchase_price,
               COALESCE((SELECT SUM(quantity) FROM item_stock st WHERE st.item_id = i.id),0) AS on_hand
          FROM items i WHERE i.firm_id = ? AND i.is_inventory = 1 AND i.reorder_level > 0
     ) WHERE on_hand <= reorder_level ORDER BY on_hand`,
    [req.user.firm_id]
  )).rows;
  res.success({ rows });
});

/* 7 ── Party statement: running ledger of every transaction with one party */
router.get("/party-statement/:partyId", async (req, res) => {
  const f = req.user.firm_id, pid = req.params.partyId;
  const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [pid, f])).rows[0];
  if (!party) return res.notFound("Party not found");
  const txns = [
    // ALL sales debit the ledger; the matching payment (cash or part-payment)
    // appears as a credit below, so cash sales net to zero — standard ledger form.
    ...(await query(`SELECT invoice_date AS d, CASE payment_type WHEN 'cash' THEN 'Cash sale' ELSE 'Credit sale' END AS type, invoice_no AS ref, grand_total AS debit, 0 AS credit, id FROM sale_invoices WHERE firm_id=? AND party_id=?`, [f, pid])).rows,
    ...(await query(`SELECT bill_date AS d, 'Purchase' AS type, bill_no AS ref, 0 AS debit, grand_total AS credit, id FROM purchase_invoices WHERE firm_id=? AND party_id=? `, [f, pid])).rows,
    ...(await query(`SELECT return_date AS d, 'Credit note' AS type, note_no AS ref, 0 AS debit, grand_total AS credit, id FROM sale_returns WHERE firm_id=? AND party_id=? AND refund_mode='adjust' AND COALESCE(status,'posted') <> 'voided'`, [f, pid])).rows,
    ...(await query(`SELECT return_date AS d, 'Debit note' AS type, note_no AS ref, grand_total AS debit, 0 AS credit, id FROM purchase_returns WHERE firm_id=? AND party_id=? AND COALESCE(status,'posted') <> 'voided'`, [f, pid])).rows,
    ...(await query(`SELECT payment_date AS d, CASE direction WHEN 'in' THEN 'Payment received' ELSE 'Payment made' END AS type, payment_no AS ref,
                     CASE direction WHEN 'out' THEN amount ELSE 0 END AS debit,
                     CASE direction WHEN 'in' THEN amount ELSE 0 END AS credit, id
                FROM payments WHERE firm_id=? AND party_id=? AND COALESCE(status,'paid') NOT IN ('voided','draft')`, [f, pid])).rows,
  ].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id));
  let bal = Number(party.opening_balance) || 0;
  const rows = [
    { d: "", type: "Opening balance", ref: "", debit: 0, credit: 0, balance: bal },
    ...txns.map((t) => { bal = +(bal + t.debit - t.credit).toFixed(2); return { ...t, balance: bal }; }),
  ];
  res.success({ party: { id: party.id, name: party.name, balance: party.balance }, rows, closing: bal });
});

/* 8 ── Trial balance */
router.get("/trial-balance", async (req, res) => {
  const rows = (await query(
    `SELECT a.code, a.name, a.type, COALESCE(b.balance,0) AS bal
       FROM chart_of_accounts a
       LEFT JOIN account_balances b ON b.firm_id = a.firm_id AND b.account_code = a.code
      WHERE a.firm_id = ? ORDER BY a.code`,
    [req.user.firm_id]
  )).rows.map((r) => ({ code: r.code, name: r.name, type: r.type, debit: r.bal > 0 ? r.bal : 0, credit: r.bal < 0 ? -r.bal : 0 }));
  res.success({ rows, totals: { debit: sum(rows, "debit"), credit: sum(rows, "credit") } });
});

/* 9 ── Cash flow: movements on cash/bank accounts */
router.get("/cash-flow", async (req, res) => {
  const { clause, params } = range(req, "j.entry_date");
  const rows = (await query(
    `SELECT j.entry_date AS d, j.entry_no, j.description, l.account_code, a.name AS account_name,
            l.debit AS cash_in, l.credit AS cash_out
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id
       JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
      WHERE l.firm_id = ? AND a.is_cash_bank = 1 ${clause}
      ORDER BY j.entry_date, j.id`,
    [req.user.firm_id, ...params]
  )).rows;
  let bal = 0;
  const out = rows.map((r) => { bal = +(bal + r.cash_in - r.cash_out).toFixed(2); return { ...r, running: bal }; });
  res.success({ rows: out, totals: { cash_in: sum(rows, "cash_in"), cash_out: sum(rows, "cash_out"), net: bal } });
});

/* 10 ── Bill-wise profit: sale value vs cost of items sold */
router.get("/bill-profit", async (req, res) => {
  const { clause, params } = range(req, "s.invoice_date");
  const rows = (await query(
    `SELECT s.invoice_no, s.invoice_date, p.name AS party_name, s.sub_total AS sale_value,
            COALESCE(SUM(COALESCE(l.base_quantity, l.quantity) * i.purchase_price), 0) AS cost
       FROM sale_invoices s
       JOIN parties p ON p.id = s.party_id
       LEFT JOIN sale_invoice_lines l ON l.invoice_id = s.id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE s.firm_id = ? ${clause}
      GROUP BY s.id ORDER BY s.invoice_date, s.id`,
    [req.user.firm_id, ...params]
  )).rows.map((r) => ({ ...r, profit: +(r.sale_value - r.cost).toFixed(2) }));
  res.success({ rows, totals: { sale: sum(rows, "sale_value"), cost: sum(rows, "cost"), profit: sum(rows, "profit") } });
});

/* ═══ Aronium report catalog ═══ */
const rrange = (req) => [req.query.from || "0000-01-01", req.query.to || "9999-12-31"];

/* Daily sales */
router.get("/daily-sales", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT invoice_date AS d, COUNT(*) AS bills, SUM(grand_total) AS total,
            SUM(paid_amount) AS received, SUM(balance_due) AS unpaid
       FROM sale_invoices WHERE firm_id = ? AND invoice_date BETWEEN ? AND ?
      GROUP BY invoice_date ORDER BY invoice_date DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { total: +rows.reduce((a, r) => a + r.total, 0).toFixed(2) } });
});

/* Hourly sales (from created_at) */
router.get("/hourly-sales", async (req, res) => {
  const [f1, f2] = rrange(req);
  const f = req.user.firm_id;
  // per-hour: bills, qty, gross, tax, net, cost, profit
  const rows = (await query(
    `SELECT substr(s.created_at, 12, 2) || ':00' AS hour, COUNT(DISTINCT s.id) AS bills,
            COALESCE(SUM(l.quantity),0) AS qty,
            COALESCE(SUM(s.grand_total),0)/NULLIF(COUNT(DISTINCT l.invoice_id),0)*COUNT(DISTINCT s.id) AS gross_est,
            COALESCE(SUM(l.line_total),0) AS gross,
            COALESCE(SUM(l.line_total - COALESCE(l.base_quantity, l.quantity)*COALESCE(i.purchase_price,0)),0) AS profit
       FROM sale_invoices s
       LEFT JOIN sale_invoice_lines l ON l.invoice_id = s.id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY hour ORDER BY hour`, [f, f1, f2])).rows
    .map((r) => ({ hour: r.hour, bills: r.bills, qty: +Number(r.qty).toFixed(2),
      gross: +Number(r.gross).toFixed(2), profit: +Number(r.profit).toFixed(2),
      margin_pct: r.gross > 0 ? +((r.profit / r.gross) * 100).toFixed(1) : 0 }));

  // weekday breakdown
  const weekdays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const wdRaw = (await query(
    `SELECT CAST(strftime('%w', s.invoice_date) AS INTEGER) AS wd, COUNT(*) AS bills,
            COALESCE(SUM(s.grand_total),0) AS sales
       FROM sale_invoices s WHERE s.firm_id=? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY wd`, [f, f1, f2])).rows;
  const weekday = weekdays.map((name, i) => {
    const r = wdRaw.find((x) => x.wd === i);
    return { day: name, bills: r ? r.bills : 0, sales: r ? +r.sales.toFixed(2) : 0 };
  });

  const busiest = rows.slice().sort((a, b) => b.gross - a.gross)[0];
  const quietest = rows.slice().filter((r) => r.bills > 0).sort((a, b) => a.gross - b.gross)[0];
  const topProfit = rows.slice().sort((a, b) => b.profit - a.profit)[0];
  const topTxn = rows.slice().sort((a, b) => b.bills - a.bills)[0];
  const bestDay = weekday.slice().sort((a, b) => b.sales - a.sales)[0];
  const worstDay = weekday.slice().filter((d) => d.bills > 0).sort((a, b) => a.sales - b.sales)[0];
  const totalBills = rows.reduce((a, r) => a + r.bills, 0);
  const totalGross = rows.reduce((a, r) => a + r.gross, 0);
  const activeHours = rows.filter((r) => r.bills > 0).length || 1;

  res.success({
    rows, weekday,
    cards: {
      best_hour: busiest ? busiest.hour : "—", best_hour_sales: busiest ? busiest.gross : 0,
      profit_hour: topProfit ? topProfit.hour : "—", profit_hour_val: topProfit ? topProfit.profit : 0,
      top_txn_hour: topTxn ? topTxn.hour : "—", top_txn_count: topTxn ? topTxn.bills : 0,
      lowest_hour: quietest ? quietest.hour : "—",
      best_day: bestDay ? bestDay.day : "—", best_day_sales: bestDay ? bestDay.sales : 0,
      worst_day: worstDay ? worstDay.day : "—",
      revenue_per_hour: +(totalGross / activeHours).toFixed(2),
      avg_txn_per_hour: +(totalBills / activeHours).toFixed(2),
    },
    totals: { bills: totalBills, gross: +totalGross.toFixed(2) },
  });
});

/* Payment types (tender totals from the payments ledger) */
router.get("/payment-types", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT mode, direction, COUNT(*) AS entries, SUM(amount) AS total
       FROM payments WHERE firm_id = ? AND payment_date BETWEEN ? AND ?
        AND COALESCE(status,'paid') NOT IN ('voided','draft')
      GROUP BY mode, direction ORDER BY total DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { in_total: +rows.filter(r => r.direction === 'in').reduce((a, r) => a + r.total, 0).toFixed(2) } });
});

/* Payment types by user */
router.get("/payment-types-by-user", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(u.full_name,'Unknown') AS user, p.mode, COUNT(*) AS entries, SUM(p.amount) AS total
       FROM payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.firm_id = ? AND p.direction = 'in' AND p.payment_date BETWEEN ? AND ?
        AND COALESCE(p.status,'paid') NOT IN ('voided','draft')
      GROUP BY p.created_by, p.mode ORDER BY user, total DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: {} });
});

/* Refunds (credit notes) */
router.get("/refunds", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT r.return_date AS d, r.note_no, p.name AS party, r.grand_total AS total, r.reason
       FROM sale_returns r JOIN parties p ON p.id = r.party_id
      WHERE r.firm_id = ? AND r.return_date BETWEEN ? AND ? AND COALESCE(r.status,'posted') <> 'voided'
      ORDER BY r.id DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { count: rows.length, total: +rows.reduce((a, r) => a + r.total, 0).toFixed(2) } });
});

/* Unpaid sales / purchases */
router.get("/unpaid-sales", async (req, res) => {
  const rows = (await query(
    `SELECT s.invoice_no, p.name AS party, s.invoice_date, s.grand_total, s.balance_due,
            CAST(julianday('now') - julianday(s.invoice_date) AS INTEGER) AS age_days
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.balance_due > 0 ORDER BY s.invoice_date`, [req.user.firm_id])).rows;
  res.success({ rows, totals: { total: +rows.reduce((a, r) => a + r.balance_due, 0).toFixed(2) } });
});
router.get("/unpaid-purchases", async (req, res) => {
  const rows = (await query(
    `SELECT b.bill_no, p.name AS party, b.bill_date, b.grand_total, b.balance_due,
            CAST(julianday('now') - julianday(b.bill_date) AS INTEGER) AS age_days
       FROM purchase_invoices b JOIN parties p ON p.id = b.party_id
      WHERE b.firm_id = ? AND b.balance_due > 0 ORDER BY b.bill_date`, [req.user.firm_id])).rows;
  res.success({ rows, totals: { total: +rows.reduce((a, r) => a + r.balance_due, 0).toFixed(2) } });
});

/* Discounts granted (line-level) */
router.get("/discounts-granted", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT s.invoice_date AS d, s.invoice_no, p.name AS party, l.description AS item,
            l.quantity, l.discount_pct, l.discount_amt
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       JOIN parties p ON p.id = s.party_id
      WHERE l.firm_id = ? AND l.discount_amt > 0 AND s.invoice_date BETWEEN ? AND ?
      ORDER BY s.id DESC LIMIT 500`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { total: +rows.reduce((a, r) => a + r.discount_amt, 0).toFixed(2) } });
});

/* Stock movement ledger */
router.get("/stock-movement", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT m.move_date AS d, i.name AS item, m.direction, m.quantity, m.unit_cost, m.source_module,
            CASE m.source_module
              WHEN 'sales' THEN (SELECT invoice_no FROM sale_invoices WHERE id = m.source_id)
              WHEN 'purchases' THEN (SELECT bill_no FROM purchase_invoices WHERE id = m.source_id)
              WHEN 'sale_returns' THEN (SELECT note_no FROM sale_returns WHERE id = m.source_id)
              WHEN 'purchase_returns' THEN (SELECT note_no FROM purchase_returns WHERE id = m.source_id)
              ELSE m.source_module END AS ref
       FROM stock_movements m JOIN items i ON i.id = m.item_id
      WHERE m.firm_id = ? AND date(m.move_date) BETWEEN ? AND ?
      ORDER BY m.id DESC LIMIT 500`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { entries: rows.length } });
});

/* Profit & margin per item (cost = current purchase price) */
router.get("/profit-margin", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT i.name AS item, SUM(l.quantity) AS qty, SUM(l.line_total) AS revenue,
            SUM(COALESCE(l.base_quantity, l.quantity) * i.purchase_price) AS cost
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       JOIN items i ON i.id = l.item_id
      WHERE l.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY l.item_id ORDER BY revenue DESC`, [req.user.firm_id, f1, f2])).rows
    .map((r) => ({ ...r, revenue: +r.revenue.toFixed(2), cost: +r.cost.toFixed(2),
      profit: +(r.revenue - r.cost).toFixed(2),
      margin_pct: r.revenue > 0 ? +(((r.revenue - r.cost) / r.revenue) * 100).toFixed(1) : 0 }));
  res.success({ rows, totals: { profit: +rows.reduce((a, r) => a + r.profit, 0).toFixed(2) } });
});

/* Item list: units sold + revenue */
router.get("/item-sales", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(i.name, l.description) AS item, SUM(l.quantity) AS qty, COUNT(DISTINCT l.invoice_id) AS bills,
            SUM(l.line_total) AS revenue
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE l.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY COALESCE(i.name, l.description) ORDER BY revenue DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { revenue: +rows.reduce((a, r) => a + r.revenue, 0).toFixed(2) } });
});

/* Sales by customer / by cashier */
router.get("/sales-by-customer", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT p.name AS customer, COUNT(*) AS bills, SUM(s.grand_total) AS total, SUM(s.balance_due) AS unpaid
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.party_id ORDER BY total DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { total: +rows.reduce((a, r) => a + r.total, 0).toFixed(2) } });
});
router.get("/sales-by-user", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(u.full_name,'Unknown') AS cashier, COUNT(*) AS bills, SUM(s.grand_total) AS total
       FROM sale_invoices s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.created_by ORDER BY total DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: {} });
});

/* Reorder product list */
router.get("/reorder-list", async (req, res) => {
  const rows = (await query(
    `SELECT name, unit, reorder_level, on_hand, MAX(reorder_level * 2 - on_hand, 0) AS suggested_qty FROM (
        SELECT i.name, i.unit, i.reorder_level,
               COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS on_hand
          FROM items i WHERE i.firm_id = ? AND i.is_inventory = 1 AND i.is_active != 0 AND i.reorder_level > 0
     ) WHERE on_hand <= reorder_level ORDER BY name`, [req.user.firm_id])).rows;
  res.success({ rows, totals: { items: rows.length } });
});

/* Sales by category (Aronium: product groups) */
router.get("/sales-by-category", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE((SELECT name FROM item_categories c WHERE c.id = i.category_id), 'Uncategorised') AS category,
            SUM(l.quantity) AS qty, SUM(l.line_total) AS revenue
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE l.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY category ORDER BY revenue DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { revenue: +rows.reduce((a, r) => a + r.revenue, 0).toFixed(2) } });
});

/* Payment types by customer */
router.get("/payment-types-by-customer", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT pa.name AS customer, p.mode, COUNT(*) AS entries, SUM(p.amount) AS total
       FROM payments p JOIN parties pa ON pa.id = p.party_id
      WHERE p.firm_id = ? AND p.direction = 'in' AND p.payment_date BETWEEN ? AND ?
        AND COALESCE(p.status,'paid') NOT IN ('voided','draft')
      GROUP BY p.party_id, p.mode ORDER BY pa.name, total DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: {} });
});

/* Invoice list / purchase bill list */
router.get("/invoice-list", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT s.invoice_no, s.invoice_date, p.name AS party, s.payment_type,
            s.grand_total, s.paid_amount, s.balance_due,
            COALESCE(u.full_name, '') AS cashier
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      ORDER BY s.id DESC LIMIT 500`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { count: rows.length, total: +rows.reduce((a, r) => a + r.grand_total, 0).toFixed(2) } });
});
router.get("/bill-list", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT b.bill_no, b.bill_date, p.name AS party, b.grand_total, b.paid_amount, b.balance_due
       FROM purchase_invoices b JOIN parties p ON p.id = b.party_id
      WHERE b.firm_id = ? AND b.bill_date BETWEEN ? AND ?
      ORDER BY b.id DESC LIMIT 500`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { count: rows.length, total: +rows.reduce((a, r) => a + r.grand_total, 0).toFixed(2) } });
});

/* Purchases by product / by supplier */
router.get("/purchase-by-item", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(i.name, l.description) AS item, SUM(l.quantity) AS qty, SUM(l.line_total) AS spend
       FROM purchase_invoice_lines l
       JOIN purchase_invoices b ON b.id = l.bill_id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE l.firm_id = ? AND b.bill_date BETWEEN ? AND ?
      GROUP BY COALESCE(i.name, l.description) ORDER BY spend DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { spend: +rows.reduce((a, r) => a + r.spend, 0).toFixed(2) } });
});
router.get("/purchase-by-supplier", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT p.name AS supplier, COUNT(*) AS bills, SUM(b.grand_total) AS total, SUM(b.balance_due) AS unpaid
       FROM purchase_invoices b JOIN parties p ON p.id = b.party_id
      WHERE b.firm_id = ? AND b.bill_date BETWEEN ? AND ?
      GROUP BY b.party_id ORDER BY total DESC`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { total: +rows.reduce((a, r) => a + r.total, 0).toFixed(2) } });
});

/* Loss & damage: manual stock write-offs */
router.get("/loss-damage", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT m.move_date AS d, i.name AS item, m.quantity, m.unit_cost,
            ROUND(m.quantity * COALESCE(NULLIF(m.unit_cost,0), i.purchase_price), 2) AS value
       FROM stock_movements m JOIN items i ON i.id = m.item_id
      WHERE m.firm_id = ? AND m.source_module = 'adjustment' AND m.direction = 'out'
        AND date(m.move_date) BETWEEN ? AND ?
      ORDER BY m.id DESC LIMIT 500`, [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { qty: rows.reduce((a, r) => a + r.quantity, 0), value: +rows.reduce((a, r) => a + r.value, 0).toFixed(2) } });
});

/* Drawer entries: POS cash in / out
 *
 * The till writes every drawer movement to `cash_movements` (pos/admin.routes.js
 * "cash-movement") — that is the table the Cash in / Cash out buttons fill, and
 * the only place the operator's chosen reason is kept. This report read only
 * `expenses` and `other_income` journals, so a shop that takes its float top-ups
 * and bank deposits at the till — which is the case this report is named for —
 * opened "POS cash in / out with reasons" and got a page with nothing on it.
 * The three sources are unioned so the drawer is reported whole. */
router.get("/drawer-entries", async (req, res) => {
  const [f1, f2] = rrange(req);
  const drawer = (await query(
    `SELECT date(created_at) AS d, direction, amount,
            TRIM(COALESCE(reason, '') || CASE WHEN COALESCE(note,'') <> '' THEN ' — ' || note ELSE '' END) AS note
       FROM cash_movements
      WHERE firm_id = ? AND date(created_at) BETWEEN ? AND ?`,
    [req.user.firm_id, f1, f2])).rows;
  const outs = (await query(
    `SELECT expense_date AS d, 'out' AS direction, amount, COALESCE(notes, category) AS note
       FROM expenses WHERE firm_id = ? AND category LIKE 'Cash out%' AND expense_date BETWEEN ? AND ?
         AND COALESCE(status,'posted') <> 'voided'`,
    [req.user.firm_id, f1, f2])).rows;
  const ins = (await query(
    `SELECT entry_date AS d, 'in' AS direction,
            (SELECT SUM(debit) FROM journal_entry_lines jl WHERE jl.entry_id = je.id AND jl.debit > 0) AS amount,
            description AS note
       FROM journal_entries je
      WHERE firm_id = ? AND source_module = 'other_income' AND entry_date BETWEEN ? AND ?`,
    [req.user.firm_id, f1, f2])).rows;
  const rows = [...ins, ...outs, ...drawer].sort((a, b) => (a.d < b.d ? 1 : -1));
  const tot = (dir) => +rows.filter((r) => r.direction === dir)
    .reduce((a, r) => a + (Number(r.amount) || 0), 0).toFixed(2);
  res.success({ rows, totals: { in_total: tot("in"), out_total: tot("out") } });
});

/* Fast-moving products (most units sold in range, with current stock & price band) */
router.get("/fast-moving", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT i.name AS item, i.barcode, i.purchase_price AS bp, i.sale_price AS sp,
            COALESCE(SUM(l.quantity),0) AS sales_qty, COALESCE(SUM(l.line_total),0) AS sales_total,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) AS current_qty
       FROM items i
       LEFT JOIN sale_invoice_lines l ON l.item_id = i.id
       LEFT JOIN sale_invoices s ON s.id = l.invoice_id AND s.invoice_date BETWEEN ? AND ?
      WHERE i.firm_id = ? AND i.is_inventory = 1
      GROUP BY i.id HAVING sales_qty > 0
      ORDER BY sales_qty DESC LIMIT 100`, [f1, f2, req.user.firm_id])).rows;
  res.success({ rows, totals: { sales_qty: rows.reduce((a,r)=>a+r.sales_qty,0), sales_total: +rows.reduce((a,r)=>a+r.sales_total,0).toFixed(2) } });
});

/* Slow-moving products (no or few sales, still holding stock) */
router.get("/slow-moving", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT i.name AS item, i.barcode, i.purchase_price AS bp, i.sale_price AS sp,
            COALESCE((SELECT SUM(l.quantity) FROM sale_invoice_lines l JOIN sale_invoices s ON s.id=l.invoice_id
                       WHERE l.item_id=i.id AND s.invoice_date BETWEEN ? AND ?),0) AS sales_qty,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) AS current_qty,
            (SELECT MAX(s.invoice_date) FROM sale_invoice_lines l JOIN sale_invoices s ON s.id=l.invoice_id WHERE l.item_id=i.id) AS last_sold
       FROM items i
      WHERE i.firm_id = ? AND i.is_inventory = 1
      GROUP BY i.id HAVING sales_qty = 0 AND current_qty > 0
      ORDER BY current_qty DESC LIMIT 200`, [f1, f2, req.user.firm_id])).rows;
  res.success({ rows, totals: { current_qty: +rows.reduce((a,r)=>a+r.current_qty,0).toFixed(2) } });
});

/* Stock adjustment by item — grouped by adjustment reference */
router.get("/stock-adjustment", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT m.id AS ref, i.name AS product, i.barcode, m.direction, m.quantity, m.unit_cost,
            date(m.move_date) AS d,
            ROUND(m.quantity * COALESCE(NULLIF(m.unit_cost,0), i.purchase_price), 2) AS value
       FROM stock_movements m JOIN items i ON i.id = m.item_id
      WHERE m.firm_id = ? AND m.source_module = 'adjustment' AND date(m.move_date) BETWEEN ? AND ?
      ORDER BY m.id DESC LIMIT 500`, [req.user.firm_id, f1, f2])).rows
    .map((r) => ({ ...r, value_up: r.direction === "in" ? r.value : 0, value_down: r.direction === "out" ? r.value : 0 }));
  res.success({ rows, totals: {
    value_up: +rows.reduce((a,r)=>a+r.value_up,0).toFixed(2),
    value_down: +rows.reduce((a,r)=>a+r.value_down,0).toFixed(2) } });
});

/* General ledger — every account with opening, debit, credit, closing */
router.get("/general-ledger", async (req, res) => {
  const [f1, f2] = rrange(req);
  const accts = (await query("SELECT code, name, opening_balance, type FROM chart_of_accounts WHERE firm_id = ? AND status != 'inactive' ORDER BY code", [req.user.firm_id])).rows;
  /* One query for every account's movement, not one query per account.
     This used to run a SELECT per row of the chart — a hundred accounts meant
     a hundred statements, which was merely wasteful against a file on this
     disk and is a hundred network round-trips against a hosted database. The
     grouping SQL already knew how to do this in one pass. */
  const moved = new Map();
  for (const m of (await query(
    `SELECT jl.account_code AS code, COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_entry_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.firm_id = ? AND je.entry_date BETWEEN ? AND ?
      GROUP BY jl.account_code`, [req.user.firm_id, f1, f2])).rows) moved.set(m.code, m);
  const rows = accts.map((a) => {
    const mv = moved.get(a.code) || { dr: 0, cr: 0 };
    const opening = a.opening_balance || 0;
    const closing = opening + mv.dr - mv.cr;
    return { code: a.code, account: a.name, type: a.type, opening: +opening.toFixed(2), debit: +mv.dr.toFixed(2), credit: +mv.cr.toFixed(2), closing: +closing.toFixed(2) };
  }).filter((r) => r.opening || r.debit || r.credit || r.closing);
  const order = ["asset", "liability", "equity", "income", "expense"];
  const labels = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };
  const groups = order.map((t) => {
    const gr = rows.filter((r) => r.type === t);
    return { type: t, label: labels[t], rows: gr,
      subtotal: { debit: +gr.reduce((a,r)=>a+r.debit,0).toFixed(2), credit: +gr.reduce((a,r)=>a+r.credit,0).toFixed(2),
                  closing: +gr.reduce((a,r)=>a+r.closing,0).toFixed(2) } };
  }).filter((g) => g.rows.length > 0);
  res.success({ rows, groups, totals: { debit: +rows.reduce((a,r)=>a+r.debit,0).toFixed(2), credit: +rows.reduce((a,r)=>a+r.credit,0).toFixed(2) } });
});

/* Z-report summary — sales, journals, payments breakdown, expected cash */
router.get("/zreport-summary", async (req, res) => {
  const [f1, f2] = rrange(req);
  const f = req.user.firm_id;
  const one = async (sql, p) => (await query(sql, p)).rows[0] || {};
  const sales = await one(`SELECT COALESCE(SUM(grand_total),0) t, COUNT(*) n, COALESCE(SUM(CASE WHEN balance_due>0 THEN balance_due ELSE 0 END),0) unpaid, COALESCE(SUM(paid_amount),0) paid, COALESCE(SUM(tax_total),0) tax FROM sale_invoices WHERE firm_id=? AND invoice_date BETWEEN ? AND ?`, [f, f1, f2]);
  const disc = await one(`SELECT COALESCE(SUM(l.discount_amt),0) t FROM sale_invoice_lines l JOIN sale_invoices s ON s.id=l.invoice_id WHERE l.firm_id=? AND s.invoice_date BETWEEN ? AND ?`, [f, f1, f2]);
  const paysOut = await one(`SELECT COALESCE(SUM(amount),0) t FROM payments WHERE firm_id=? AND direction='out' AND payment_date BETWEEN ? AND ? AND COALESCE(status,'paid') NOT IN ('voided','draft')`, [f, f1, f2]);
  const expenses = await one(`SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE firm_id=? AND expense_date BETWEEN ? AND ? AND COALESCE(status,'posted') <> 'voided'`, [f, f1, f2]);
  const rows = [
    { section: "TOTAL SALES", amount: +sales.t.toFixed(2), head: 1 },
    { section: "> Invoices", amount: sales.n },
    { section: "> Cash sales (unpaid/running)", amount: +sales.unpaid.toFixed(2) },
    { section: "> Cash sales (paid/settled)", amount: +sales.paid.toFixed(2) },
    { section: "TOTAL SALES JOURNALS (others)", amount: +(sales.tax + disc.t).toFixed(2), head: 1 },
    { section: "> Taxes", amount: +sales.tax.toFixed(2) },
    { section: "> Discounts", amount: +disc.t.toFixed(2) },
    { section: "TOTAL PAYMENTS (paid out cash)", amount: +(paysOut.t + expenses.t).toFixed(2), head: 1 },
    { section: "> To suppliers/vendors", amount: +paysOut.t.toFixed(2) },
    { section: "> To ledger accounts (expenses)", amount: +expenses.t.toFixed(2) },
  ];
  const voids = await one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM void_log WHERE firm_id=? AND date(created_at) BETWEEN ? AND ?`, [f, f1, f2]);
  rows.push({ section: "VOIDED TRANSACTIONS", amount: +voids.t.toFixed(2), head: 1 });
  rows.push({ section: "> Voided count", amount: voids.n });
  const byUser = (await query(
    `SELECT COALESCE(u.full_name,'Unknown') AS cashier, COUNT(*) AS bills,
            COALESCE(SUM(s.grand_total),0) AS total, COALESCE(SUM(s.paid_amount),0) AS collected
       FROM sale_invoices s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.firm_id=? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.created_by ORDER BY total DESC`, [f, f1, f2])).rows
    .map((u) => ({ ...u, total: +u.total.toFixed(2), collected: +u.collected.toFixed(2) }));
  /* Cash moved into or out of the drawer by hand — the opening float, an
     owner top-up, a run to the bank. Without these the Z report and the shift
     close disagree about what should be in the till. */
  const moved = await one(
    `SELECT COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0) AS cin,
            COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS cout
       FROM cash_movements WHERE firm_id=? AND date(created_at) BETWEEN ? AND ?`, [f, f1, f2]);
  const expectedCash = +(sales.paid + (+moved.cin || 0) - paysOut.t - expenses.t - (+moved.cout || 0)).toFixed(2);
  res.success({ rows, by_user: byUser, totals: { expected_cash: expectedCash, voids: voids.n, void_total: +voids.t.toFixed(2) } });
});

/* Sales by items — grouped by each sale (bill), with profit */
router.get("/sales-by-items", async (req, res) => {
  const [f1, f2] = rrange(req);
  const sales = (await query(
    `SELECT s.id, s.invoice_no, s.created_at, COALESCE(u.full_name,'Unknown') AS seller
       FROM sale_invoices s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      ORDER BY s.id DESC LIMIT 100`, [req.user.firm_id, f1, f2])).rows;
  /* Every line for every sale in one statement, then grouped here — this ran a
     SELECT per sale, so a hundred-sale day was a hundred statements. Against a
     hosted database that is a hundred round-trips for one report.
     The id list is built from numbers this route selected itself, so there is
     nothing user-supplied being pasted into the SQL. */
  const ids = sales.map((s) => Number(s.id)).filter(Number.isFinite);
  const linesBySale = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    for (const l of (await query(
      `SELECT l.invoice_id, COALESCE(i.name,l.description) AS item, i.barcode, l.rate, l.quantity AS qty, l.line_total AS total,
              ROUND(l.line_total - COALESCE(l.base_quantity, l.quantity) * COALESCE(i.purchase_price,0), 2) AS profit
         FROM sale_invoice_lines l LEFT JOIN items i ON i.id = l.item_id AND i.firm_id = l.firm_id
        WHERE l.firm_id = ? AND l.invoice_id IN (${ids.map(() => "?").join(",")})`,
      [req.user.firm_id, ...ids])).rows) {
      const bucket = linesBySale.get(l.invoice_id);
      if (bucket) bucket.push(l);
    }
  }
  const groups = sales.map((s) => {
    const lines = linesBySale.get(Number(s.id)) || [];
    return { sale: s.invoice_no, seller: s.seller, at: s.created_at, lines,
      qty: lines.reduce((a,l)=>a+l.qty,0), total: +lines.reduce((a,l)=>a+l.total,0).toFixed(2), profit: +lines.reduce((a,l)=>a+l.profit,0).toFixed(2) };
  });
  res.success({ groups, totals: {
    qty: groups.reduce((a,g)=>a+g.qty,0),
    total: +groups.reduce((a,g)=>a+g.total,0).toFixed(2),
    profit: +groups.reduce((a,g)=>a+g.profit,0).toFixed(2) } });
});

/* Day close (Z report): takings by payment mode and by user.
   Scoped to one day when ?date= is given, otherwise to the ?from..?to range the
   report screen is showing. It used to read ?to only and compare it for
   equality, so a range of 2026-08-01..2026-08-06 asked for "sales dated exactly
   2026-08-06" and reported nothing while six bills sat inside the range. */
router.get("/day-close", async (req, res) => {
  const f = req.user.firm_id;
  const today = new Date().toISOString().slice(0, 10);
  const single = req.query.date || null;
  const from = single || req.query.from || req.query.to || today;
  const to = single || req.query.to || req.query.from || today;
  const oneDay = from === to;
  // Tenders actually received in the window (every paid shilling writes a payments row with its mode)
  const byMode = (await query(
    `SELECT mode, COUNT(*) AS bills, SUM(amount) AS total, SUM(amount) AS received
       FROM payments WHERE firm_id = ? AND direction = 'in' AND payment_date BETWEEN ? AND ?
        AND COALESCE(status,'paid') NOT IN ('voided','draft')
      GROUP BY mode ORDER BY total DESC`, [f, from, to])).rows;
  const creditOut = (await query(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(balance_due),0) AS total
       FROM sale_invoices WHERE firm_id = ? AND invoice_date BETWEEN ? AND ? AND balance_due > 0`, [f, from, to])).rows[0];
  if (creditOut.total > 0) byMode.push({ mode: "credit (unpaid)", bills: creditOut.bills, total: creditOut.total, received: 0 });
  const byUser = (await query(
    `SELECT COALESCE(u.full_name, 'Unknown') AS user, COUNT(*) AS bills, SUM(s.grand_total) AS total
       FROM sale_invoices s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.created_by ORDER BY total DESC`, [f, from, to])).rows;
  const refunds = (await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS total
       FROM sale_returns WHERE firm_id = ? AND return_date BETWEEN ? AND ?
         AND COALESCE(status,'posted') <> 'voided'`, [f, from, to])).rows[0];
  const voids = (await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM void_log WHERE firm_id = ? AND date(created_at) BETWEEN ? AND ?`, [f, from, to])).rows[0];
  const sales = (await query(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total),0) AS total, COALESCE(SUM(balance_due),0) AS unpaid
       FROM sale_invoices WHERE firm_id = ? AND invoice_date BETWEEN ? AND ?`, [f, from, to])).rows[0];
  res.success({
    date: to, from, to, one_day: oneDay,
    rows: byMode.map((m) => ({ ...m, total: +m.total.toFixed(2), received: +m.received.toFixed(2) })),
    by_user: byUser.map((u) => ({ ...u, total: +u.total.toFixed(2) })),
    totals: {
      bills: sales.bills, gross: +sales.total.toFixed(2), unpaid: +sales.unpaid.toFixed(2),
      refunds: refunds.n, refund_total: +refunds.total.toFixed(2),
      voids: voids.n, void_total: +voids.total.toFixed(2),
      net: +(sales.total - refunds.total).toFixed(2),
    },
  });
});

/* Voided items: the audit trail behind the POS void button */
router.get("/voided-items", async (req, res) => {
  const from = req.query.from || "0000-01-01", to = req.query.to || "9999-12-31";
  const rows = (await query(
    `SELECT v.created_at, v.scope, v.item_name, v.quantity, v.amount, v.reason, u.full_name AS voided_by
       FROM void_log v LEFT JOIN users u ON u.id = v.user_id
      WHERE v.firm_id = ? AND date(v.created_at) BETWEEN ? AND ?
      ORDER BY v.id DESC`, [req.user.firm_id, from, to])).rows;
  res.success({ rows, totals: { count: rows.length, amount: +rows.reduce((a, r) => a + r.amount, 0).toFixed(2) } });
});

/* Batch / expiry report: every tracked batch with days to expiry */
router.get("/expiry", async (req, res) => {
  const rows = (await query(
    `SELECT i.name AS item_name, s.batch_no, s.quantity, s.expiry_date,
            CAST(julianday(s.expiry_date) - julianday('now') AS INTEGER) AS days_left
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE s.firm_id = ? AND s.quantity > 0 AND s.expiry_date IS NOT NULL
      ORDER BY s.expiry_date`, [req.user.firm_id])).rows;
  res.success({ rows, totals: { batches: rows.length, expired: rows.filter((r) => r.days_left < 0).length } });
});

/* Uganda tax summary: per-rule totals levied on sales & purchases in range.
 * Parses the persisted tax_breakdown JSON so it reflects the rules as they
 * were at transaction time, even if the configuration changed since. */
router.get("/tax-summary", async (req, res) => {
  const f = req.user.firm_id;
  const from = req.query.from || "0000-01-01";
  const to = req.query.to || "9999-12-31";
  const agg = new Map();
  const fold = (rows, key) => {
    for (const r of rows) {
      let taxes = [];
      try { taxes = JSON.parse(r.tax_breakdown || "[]"); } catch {}
      for (const t of taxes) {
        const k = `${t.name}|${t.rate}|${t.mode}`;
        const row = agg.get(k) || { name: t.name, rate: t.rate, mode: t.mode, sales: 0, sale_returns: 0, purchases: 0, purchase_returns: 0 };
        row[key] = +(row[key] + (Number(t.amount) || 0)).toFixed(2);
        agg.set(k, row);
      }
    }
  };
  fold((await query("SELECT tax_breakdown FROM sale_invoices WHERE firm_id=? AND invoice_date BETWEEN ? AND ?", [f, from, to])).rows, "sales");
  fold((await query("SELECT tax_breakdown FROM sale_returns WHERE firm_id=? AND return_date BETWEEN ? AND ? AND COALESCE(status,'posted') <> 'voided'", [f, from, to])).rows, "sale_returns");
  fold((await query("SELECT tax_breakdown FROM purchase_invoices WHERE firm_id=? AND bill_date BETWEEN ? AND ?", [f, from, to])).rows, "purchases");
  fold((await query("SELECT tax_breakdown FROM purchase_returns WHERE firm_id=? AND return_date BETWEEN ? AND ? AND COALESCE(status,'posted') <> 'voided'", [f, from, to])).rows, "purchase_returns");
  const rows = [...agg.values()].map((r) => ({ ...r, net_sales: +(r.sales - r.sale_returns).toFixed(2), net_purchases: +(r.purchases - r.purchase_returns).toFixed(2) }));
  const totals = {
    sales: +rows.reduce((a, r) => a + r.net_sales, 0).toFixed(2),
    purchases: +rows.reduce((a, r) => a + r.net_purchases, 0).toFixed(2),
  };
  res.success({ rows, totals });
});

const sum = (rows, k) => +rows.reduce((a, r) => a + (Number(r[k]) || 0), 0).toFixed(2);

/* ─────────────────────────────────────────────────────────────────────────
   Sale summary grouped by USER (the rep the sale is credited to).
   Matches the columns in the reference layout: items sold, total sales, tax,
   running (unpaid) balance, invoice count, discounts, commission, levy.
   Cost uses base_quantity × purchase_price, so dual-unit sales are costed
   correctly — this is the fix from v1.3.1 flowing through to a per-rep view.
   ───────────────────────────────────────────────────────────────────────── */
router.get("/sale-summary-by-user", async (req, res) => {
  const [f1, f2] = rrange(req);
  const firmId = req.user.firm_id;
  const commissionPct = Number(req.query.commission_pct) || 0;   // optional, applied to net sales

  const rows = (await query(
    `SELECT COALESCE(u.full_name, u.username, 'Unattributed') AS rep,
            s.sales_rep_id AS rep_id,
            COUNT(DISTINCT s.id)                              AS invoices,
            COALESCE(SUM(li.items_sold), 0)                   AS items_sold,
            COALESCE(SUM(s.sub_total), 0)                     AS total_sales,
            COALESCE(SUM(s.tax_total), 0)                     AS total_tax,
            COALESCE(SUM(s.discount_total), 0)                AS discounts,
            COALESCE(SUM(s.balance_due), 0)                   AS running,
            COALESCE(SUM(s.grand_total), 0)                   AS grand_total
       FROM sale_invoices s
       LEFT JOIN users u ON u.id = s.sales_rep_id
       LEFT JOIN (
            SELECT invoice_id, SUM(quantity) AS items_sold
              FROM sale_invoice_lines GROUP BY invoice_id
       ) li ON li.invoice_id = s.id
      WHERE s.firm_id = ? AND s.status != 'cancelled'
        AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.sales_rep_id
      ORDER BY total_sales DESC`,
    [firmId, f1, f2])).rows;

  for (const r of rows) {
    r.commission = +(r.total_sales * commissionPct / 100).toFixed(2);
    r.levy = 0;   // reserved for a shop-configurable levy; shown for layout parity
    r.status = r.running > 0 ? "Owing" : "Clear";
  }
  res.success({
    rows,
    totals: {
      invoices: rows.reduce((a, r) => a + r.invoices, 0),
      items_sold: sum(rows, "items_sold"),
      total_sales: sum(rows, "total_sales"),
      total_tax: sum(rows, "total_tax"),
      discounts: sum(rows, "discounts"),
      running: sum(rows, "running"),
      commission: sum(rows, "commission"),
    },
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Sale summary grouped by CATEGORY then ITEM — the second reference layout.
   Each row is an item under its category, with qty, revenue, tax share and the
   running (unpaid-portion) contribution.
   ───────────────────────────────────────────────────────────────────────── */
router.get("/sale-summary-by-category-item", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(c.name, 'Uncategorised')          AS category,
            COALESCE(i.name, l.description, 'Item')     AS item_name,
            COALESCE(i.barcode, '')                     AS barcode,
            SUM(l.quantity)                             AS qty,
            SUM(l.line_total)                           AS total,
            -- tax apportioned to the line by its share of the invoice sub-total
            SUM(l.line_total * (CASE WHEN s.sub_total > 0 THEN s.tax_total / s.sub_total ELSE 0 END)) AS tax,
            SUM(l.line_total * (CASE WHEN s.grand_total > 0 THEN s.balance_due / s.grand_total ELSE 0 END)) AS running,
            COUNT(DISTINCT s.id)                        AS invoices
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       LEFT JOIN items i ON i.id = l.item_id
       LEFT JOIN item_categories c ON c.id = i.category_id
      WHERE l.firm_id = ? AND s.status != 'cancelled'
        AND s.invoice_date BETWEEN ? AND ?
      GROUP BY category, item_name, barcode
      ORDER BY category, total DESC`,
    [req.user.firm_id, f1, f2])).rows;

  for (const r of rows) { r.tax = +Number(r.tax).toFixed(2); r.running = +Number(r.running).toFixed(2); }
  res.success({
    rows,
    totals: {
      total: sum(rows, "total"), tax: sum(rows, "tax"),
      running: sum(rows, "running"), qty: sum(rows, "qty"),
    },
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Sales & profit by user over a date range.
   Profit = revenue − cost, cost valued on base units (dual-unit correct).
   Also returns margin % and average bill, which a manager actually acts on.
   ───────────────────────────────────────────────────────────────────────── */
router.get("/user-profit", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(u.full_name, u.username, 'Unattributed') AS rep,
            COUNT(DISTINCT s.id)                        AS invoices,
            COALESCE(SUM(s.sub_total), 0)               AS revenue,
            COALESCE(SUM(li.cost), 0)                   AS cost
       FROM sale_invoices s
       LEFT JOIN users u ON u.id = s.sales_rep_id
       LEFT JOIN (
            SELECT l.invoice_id,
                   SUM(COALESCE(l.base_quantity, l.quantity) * COALESCE(i.purchase_price, 0)) AS cost
              FROM sale_invoice_lines l LEFT JOIN items i ON i.id = l.item_id
             GROUP BY l.invoice_id
       ) li ON li.invoice_id = s.id
      WHERE s.firm_id = ? AND s.status != 'cancelled'
        AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.sales_rep_id
      ORDER BY revenue DESC`,
    [req.user.firm_id, f1, f2])).rows;

  for (const r of rows) {
    r.profit = +(r.revenue - r.cost).toFixed(2);
    r.margin_pct = r.revenue > 0 ? +(r.profit / r.revenue * 100).toFixed(1) : 0;
    r.avg_bill = r.invoices > 0 ? +(r.revenue / r.invoices).toFixed(2) : 0;
  }
  res.success({
    rows,
    totals: {
      invoices: rows.reduce((a, r) => a + r.invoices, 0),
      revenue: sum(rows, "revenue"), cost: sum(rows, "cost"), profit: sum(rows, "profit"),
    },
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Hourly sales by user — when each rep actually sells. Feeds staffing and,
   read alongside shifts, shows idle vs busy hours per person.
   ───────────────────────────────────────────────────────────────────────── */
router.get("/user-hourly", async (req, res) => {
  const [f1, f2] = rrange(req);
  const rows = (await query(
    `SELECT COALESCE(u.full_name, u.username, 'Unattributed') AS rep,
            CAST(strftime('%H', s.created_at) AS INTEGER)     AS hour,
            COUNT(*)                                          AS bills,
            COALESCE(SUM(s.grand_total), 0)                   AS total
       FROM sale_invoices s
       LEFT JOIN users u ON u.id = s.sales_rep_id
      WHERE s.firm_id = ? AND s.status != 'cancelled'
        AND s.invoice_date BETWEEN ? AND ?
      GROUP BY s.sales_rep_id, hour
      ORDER BY rep, hour`,
    [req.user.firm_id, f1, f2])).rows;
  res.success({ rows, totals: { total: sum(rows, "total") } });
});

/* ─────────────────────────────────────────────────────────────────────────
   Time on shift per user, from closed shifts in the range. "Time spent by a
   user" as requested — total hours, shift count, and average shift length.
   ───────────────────────────────────────────────────────────────────────── */
router.get("/user-time", async (req, res) => {
  const [f1, f2] = rrange(req);
  let rows = [];
  try {
    rows = (await query(
      `SELECT COALESCE(u.full_name, u.username, 'Unknown') AS rep,
              COUNT(*) AS shifts,
              SUM((julianday(s.closed_at) - julianday(s.opened_at)) * 24 * 60) AS total_minutes,
              COALESCE(SUM(s.variance), 0) AS total_variance
         FROM shifts s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.firm_id = ? AND s.status = 'closed'
          AND date(s.opened_at) BETWEEN ? AND ?
        GROUP BY s.user_id ORDER BY total_minutes DESC`,
      [req.user.firm_id, f1, f2])).rows;
  } catch { rows = []; }   // shifts table not present yet
  for (const r of rows) {
    const m = Math.round(r.total_minutes || 0);
    r.hours = +(m / 60).toFixed(1);
    r.avg_minutes = r.shifts ? Math.round(m / r.shifts) : 0;
    r.total_variance = +Number(r.total_variance).toFixed(2);
    delete r.total_minutes;
  }
  res.success({ rows, totals: { hours: +rows.reduce((a, r) => a + r.hours, 0).toFixed(1) } });
});

/* ═══ Receivables & Payables (Zoho Books report set) ═══ */

/* Bucket an open document by how long it has been overdue. Documents without a
   due date age from their own date, which is what a shop owner expects. */
const AGE_BUCKETS = ["Current", "1-15 days", "16-30 days", "31-60 days", "61-90 days", "Over 90 days"];
const bucketOf = (dueDate, asOf) => {
  const days = Math.floor((Date.parse(asOf) - Date.parse(dueDate)) / 86400000);
  if (!(days > 0)) return "Current";
  if (days <= 15) return "1-15 days";
  if (days <= 30) return "16-30 days";
  if (days <= 60) return "31-60 days";
  if (days <= 90) return "61-90 days";
  return "Over 90 days";
};
const asOfDate = (req) => req.query.to || new Date().toISOString().slice(0, 10);

/* Open documents on one side of the ledger, newest last. */
async function openDocs(firmId, side, asOf) {
  const t = side === "payable" ? "purchase_invoices" : "sale_invoices";
  const noCol = side === "payable" ? "bill_no" : "invoice_no";
  const dtCol = side === "payable" ? "bill_date" : "invoice_date";
  return (await query(
    `SELECT d.id, d.${noCol} AS doc_no, d.${dtCol} AS doc_date,
            COALESCE(d.due_date, d.${dtCol}) AS due_date,
            p.id AS party_id, p.name AS party_name, p.phone,
            d.grand_total, d.paid_amount, d.balance_due, d.status
       FROM ${t} d JOIN parties p ON p.id = d.party_id
      WHERE d.firm_id = ? AND d.balance_due > 0 AND COALESCE(d.doc_type,'') NOT IN ('estimate','sale_order','purchase_order')
        AND d.${dtCol} <= ?
      ORDER BY p.name, d.${dtCol}, d.id`,
    [firmId, asOf]
  )).rows.map((r) => ({ ...r, bucket: bucketOf(r.due_date, asOf),
                       days_overdue: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(r.due_date)) / 86400000)) }));
}

/* Aging summary — one row per party, a column per bucket. */
async function agingSummary(req, res, side) {
  const asOf = asOfDate(req);
  const docs = await openDocs(req.user.firm_id, side, asOf);
  const byParty = new Map();
  for (const d of docs) {
    if (!byParty.has(d.party_id)) {
      byParty.set(d.party_id, { party_name: d.party_name, phone: d.phone, total: 0,
        ...Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) });
    }
    const row = byParty.get(d.party_id);
    row[d.bucket] = +(row[d.bucket] + d.balance_due).toFixed(2);
    row.total = +(row.total + d.balance_due).toFixed(2);
  }
  const rows = [...byParty.values()].sort((a, b) => b.total - a.total);
  const totals = { total: +rows.reduce((a, r) => a + r.total, 0).toFixed(2) };
  for (const b of AGE_BUCKETS) totals[b] = +rows.reduce((a, r) => a + r[b], 0).toFixed(2);
  res.success({ rows, totals, as_of: asOf, buckets: AGE_BUCKETS });
}

/* Aging details — every open document with its bucket. */
async function agingDetails(req, res, side) {
  const asOf = asOfDate(req);
  const rows = (await openDocs(req.user.firm_id, side, asOf))
    .sort((a, b) => b.days_overdue - a.days_overdue || a.party_name.localeCompare(b.party_name));
  res.success({ rows, totals: { balance_due: +rows.reduce((a, r) => a + r.balance_due, 0).toFixed(2) }, as_of: asOf });
}

router.get("/ar-aging-summary", async (req, res) => await agingSummary(req, res, "receivable"));
router.get("/ar-aging-details", async (req, res) => await agingDetails(req, res, "receivable"));
router.get("/ap-aging-summary", async (req, res) => await agingSummary(req, res, "payable"));
router.get("/ap-aging-details", async (req, res) => await agingDetails(req, res, "payable"));

/* Invoice details — every sale invoice in the range with its settlement state. */
router.get("/invoice-details", async (req, res) => {
  const { clause, params } = range(req, "s.invoice_date");
  const rows = (await query(
    `SELECT s.invoice_no, s.invoice_date, s.due_date, p.name AS party_name,
            s.grand_total, s.paid_amount, s.balance_due, s.status
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND COALESCE(s.doc_type,'invoice') = 'invoice' ${clause}
      ORDER BY s.invoice_date, s.id`,
    [req.user.firm_id, ...params]
  )).rows;
  res.success({ rows, totals: {
    grand_total: +rows.reduce((a, r) => a + r.grand_total, 0).toFixed(2),
    paid_amount: +rows.reduce((a, r) => a + r.paid_amount, 0).toFixed(2),
    balance_due: +rows.reduce((a, r) => a + r.balance_due, 0).toFixed(2),
  } });
});

/* Quote details — estimates and their conversion state. */
/* Estimates and sale orders live in their own `estimates` table — the sales
 * module has never written an invoice row with doc_type 'estimate' or
 * 'sale_order' (sales.routes.js hardcodes 'invoice'). Reading sale_invoices
 * therefore matched nothing, ever: a shop that quotes every job opened Quote
 * Details and printed "No quotes or orders in this range" over a full order
 * book. `order` is this table's word for a sale order, and `valid_until` is
 * its due date. */
router.get("/quote-details", async (req, res) => {
  const { clause, params } = range(req, "s.doc_date");
  const rows = (await query(
    `SELECT s.doc_no AS quote_no, s.doc_date AS quote_date, s.valid_until AS valid_till,
            p.name AS party_name, s.grand_total,
            CASE WHEN s.doc_type = 'order' THEN 'Sale order · ' ELSE 'Estimate · ' END || s.status AS status
       FROM estimates s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? ${clause}
      ORDER BY s.doc_date, s.id`,
    [req.user.firm_id, ...params]
  )).rows;
  res.success({ rows, totals: { grand_total: +rows.reduce((a, r) => a + r.grand_total, 0).toFixed(2) } });
});

/* Customer / supplier balance summary — what each party owes right now. */
async function balanceSummary(req, res, side) {
  const asOf = asOfDate(req);
  const docs = await openDocs(req.user.firm_id, side, asOf);
  const byParty = new Map();
  for (const d of docs) {
    if (!byParty.has(d.party_id)) byParty.set(d.party_id, { party_name: d.party_name, phone: d.phone, invoices: 0, invoiced: 0, paid: 0, balance_due: 0 });
    const r = byParty.get(d.party_id);
    r.invoices += 1;
    r.invoiced = +(r.invoiced + d.grand_total).toFixed(2);
    r.paid = +(r.paid + d.paid_amount).toFixed(2);
    r.balance_due = +(r.balance_due + d.balance_due).toFixed(2);
  }
  const rows = [...byParty.values()].sort((a, b) => b.balance_due - a.balance_due);
  res.success({ rows, totals: { balance_due: +rows.reduce((a, r) => a + r.balance_due, 0).toFixed(2) }, as_of: asOf });
}
router.get("/customer-balance-summary", async (req, res) => await balanceSummary(req, res, "receivable"));
router.get("/supplier-balance-summary", async (req, res) => await balanceSummary(req, res, "payable"));

/* Receivable / payable summary — the whole book condensed into buckets. */
async function bucketSummary(req, res, side) {
  const asOf = asOfDate(req);
  const docs = await openDocs(req.user.firm_id, side, asOf);
  const rows = AGE_BUCKETS.map((b) => {
    const inB = docs.filter((d) => d.bucket === b);
    return { bucket: b, documents: inB.length, amount: +inB.reduce((a, d) => a + d.balance_due, 0).toFixed(2) };
  });
  const total = +rows.reduce((a, r) => a + r.amount, 0).toFixed(2);
  res.success({ rows: rows.map((r) => ({ ...r, share: total ? +(r.amount / total * 100).toFixed(1) : 0 })),
                totals: { amount: total, documents: docs.length }, as_of: asOf });
}
router.get("/receivable-summary", async (req, res) => await bucketSummary(req, res, "receivable"));
router.get("/payable-summary", async (req, res) => await bucketSummary(req, res, "payable"));

/* Receivable / payable details — the flat list, oldest first. */
async function bucketDetails(req, res, side) {
  const asOf = asOfDate(req);
  const rows = (await openDocs(req.user.firm_id, side, asOf)).sort((a, b) => a.doc_date.localeCompare(b.doc_date));
  res.success({ rows, totals: { balance_due: +rows.reduce((a, r) => a + r.balance_due, 0).toFixed(2) }, as_of: asOf });
}
router.get("/receivable-details", async (req, res) => await bucketDetails(req, res, "receivable"));
router.get("/payable-details", async (req, res) => await bucketDetails(req, res, "payable"));

module.exports = router;
