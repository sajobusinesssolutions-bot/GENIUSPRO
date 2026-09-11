const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken } = require("../../shared/middleware/auth");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

router.get("/", async (req, res) => {
  const f = req.user.firm_id;
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  // optional reporting window — defaults to the current month
  const from = req.query.from || `${month}-01`;
  const to = req.query.to || today;
  const inRange = "invoice_date >= ? AND invoice_date <= ?";

  const salesToday = (await query("SELECT COALESCE(SUM(grand_total),0) v FROM sale_invoices WHERE firm_id=? AND invoice_date=?", [f, today])).rows[0].v;
  const salesMonth = (await query("SELECT COALESCE(SUM(grand_total),0) v FROM sale_invoices WHERE firm_id=? AND substr(invoice_date,1,7)=?", [f, month])).rows[0].v;
  const receivable = (await query("SELECT COALESCE(SUM(balance),0) v FROM parties WHERE firm_id=? AND balance > 0", [f])).rows[0].v;
  const payable = -(await query("SELECT COALESCE(SUM(balance),0) v FROM parties WHERE firm_id=? AND balance < 0", [f])).rows[0].v;
  const invoiceCount = (await query("SELECT COUNT(*) v FROM sale_invoices WHERE firm_id=?", [f])).rows[0].v;
  const stockValue = (await query(
    `SELECT COALESCE(SUM(q.on_hand * q.purchase_price),0) v FROM (
       SELECT i.purchase_price, COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) on_hand
         FROM items i WHERE i.firm_id=? AND i.is_inventory=1) q`, [f])).rows[0].v;
  const cashInHand = (await query(
    `SELECT COALESCE(SUM(b.balance),0) v FROM account_balances b
       JOIN chart_of_accounts a ON a.firm_id=b.firm_id AND a.code=b.account_code
      WHERE b.firm_id=? AND a.is_cash_bank=1`, [f])).rows[0].v;
  /* Settings → Items → "Low stock alerts".
   *
   * Honoured where the figure is produced rather than on each screen that
   * shows it: the dashboard tile, the alert list and the rail badge all read
   * this one array, so a shop that has turned the alerts off goes quiet
   * everywhere at once rather than in three places out of four. */
  const lowStockOn = await getSetting(f, "low_stock_alert", "1") !== "0";
  const lowStock = !lowStockOn ? [] : (await query(
    `SELECT name, reorder_level, on_hand FROM (
        SELECT i.name, i.reorder_level,
               COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) on_hand
          FROM items i WHERE i.firm_id=? AND i.is_inventory=1 AND i.reorder_level>0
     ) WHERE on_hand <= reorder_level LIMIT 10`, [f])).rows;
  // Stock with an expiry date is money with a deadline — surface it before it rots.
  const alertDays = Number(await getSetting(f, "expiry_alert_days", "30")) || 30;
  const today2 = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + alertDays * 86400000).toISOString().slice(0, 10);
  const expiring = (await query(
    `SELECT i.name, s.batch_no, s.quantity, s.expiry_date, i.unit,
            ROUND(s.quantity * COALESCE(NULLIF(s.avg_cost,0), i.purchase_price, 0), 2) AS value,
            CAST(julianday(s.expiry_date) - julianday(?) AS INTEGER) AS days_left
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE s.firm_id = ? AND s.quantity > 0 AND s.expiry_date IS NOT NULL AND s.expiry_date <= ?
      ORDER BY s.expiry_date LIMIT 25`, [today2, f, horizon])).rows;
  const expiringTotal = (await query(
    `SELECT COALESCE(SUM(s.quantity * COALESCE(NULLIF(s.avg_cost,0), i.purchase_price, 0)),0) v,
            COUNT(*) n
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE s.firm_id = ? AND s.quantity > 0 AND s.expiry_date IS NOT NULL AND s.expiry_date <= ?`,
    [f, horizon])).rows[0];

  const periodSales = (await query(
    `SELECT COALESCE(SUM(grand_total),0) v FROM sale_invoices WHERE firm_id=? AND ${inRange} AND status != 'voided'`,
    [f, from, to])).rows[0].v;
  const periodCount = (await query(
    `SELECT COUNT(*) v FROM sale_invoices WHERE firm_id=? AND ${inRange} AND status != 'voided'`,
    [f, from, to])).rows[0].v;
  const trend = (await query(
    `SELECT invoice_date d, SUM(grand_total) v FROM sale_invoices
      WHERE firm_id=? AND ${inRange} GROUP BY invoice_date ORDER BY invoice_date`, [f, from, to])).rows;

  const topSellers = (await query(
    /* Quantity in base units (base_quantity), the same measure the item screen
       reports "sold this month" in. Summing l.quantity instead mixed packs and
       loose units in one figure, so a best-seller read 1273 against the item's
       own 47. */
    `SELECT COALESCE(i.name, l.description) AS name, SUM(COALESCE(l.base_quantity, l.quantity)) AS qty, SUM(l.line_total) AS revenue,
            MAX(COALESCE(oh.q, 0)) AS on_hand,
            MAX(COALESCE(i.unit, '')) AS unit
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       LEFT JOIN items i ON i.id = l.item_id
       LEFT JOIN (SELECT item_id, SUM(quantity) AS q FROM item_stock GROUP BY item_id) oh ON oh.item_id = i.id
      WHERE l.firm_id = ? AND s.invoice_date >= ? AND s.invoice_date <= ?
      GROUP BY name ORDER BY revenue DESC LIMIT 5`, [f, from, to])).rows
    .map((r) => ({ name: r.name, qty: +r.qty, revenue: +r.revenue.toFixed(2),
                   on_hand: +(r.on_hand || 0), unit: r.unit || "" }));
  const salesYesterday = (await query(
    `SELECT COALESCE(SUM(grand_total),0) v FROM sale_invoices WHERE firm_id=? AND invoice_date=date('now','-1 day')`, [f])).rows[0].v;

  /* ── Collection rate ─────────────────────────────────────────────────────
     Invoiced against actually settled for the period. Turnover on paper is
     not turnover in the drawer, and the gap is the number a small business
     needs to see soonest. */
  const collected = (await query(
    `SELECT COALESCE(SUM(paid_amount),0) v FROM sale_invoices
      WHERE firm_id=? AND ${inRange} AND status != 'voided'`, [f, from, to])).rows[0].v;

  /* ── Receivables ageing ──────────────────────────────────────────────────
     Bucketed by how long each unsettled invoice has been outstanding. Uses
     the invoice date rather than a due date because credit terms are held per
     party and not every invoice carries one. */
  const ageRows = (await query(
    `SELECT invoice_date, (grand_total - COALESCE(paid_amount,0)) AS due
       FROM sale_invoices
      WHERE firm_id=? AND status != 'voided' AND (grand_total - COALESCE(paid_amount,0)) > 0.005`,
    [f])).rows;
  const ageing = { d30: 0, d60: 0, d90: 0, d90p: 0 };
  const asAt = new Date();
  for (const r of ageRows) {
    const days = Math.floor((asAt - new Date(r.invoice_date)) / 86400000);
    const due = Number(r.due) || 0;
    if (days <= 30) ageing.d30 += due;
    else if (days <= 60) ageing.d60 += due;
    else if (days <= 90) ageing.d90 += due;
    else ageing.d90p += due;
  }
  for (const k of Object.keys(ageing)) ageing[k] = +ageing[k].toFixed(2);

  /* ── Cash against credit ─────────────────────────────────────────────────
     Derived the same way the invoice screen derives it — settled in full is a
     cash sale — so the dashboard and the till cannot disagree. */
  const splitRow = (await query(
    `SELECT
       COALESCE(SUM(CASE WHEN (grand_total - COALESCE(paid_amount,0)) <= 0.005 THEN grand_total ELSE 0 END),0) AS cash,
       COALESCE(SUM(CASE WHEN (grand_total - COALESCE(paid_amount,0))  > 0.005 THEN grand_total ELSE 0 END),0) AS credit
       FROM sale_invoices WHERE firm_id=? AND ${inRange} AND status != 'voided'`,
    [f, from, to])).rows[0];
  const split = { cash: +splitRow.cash.toFixed(2), credit: +splitRow.credit.toFixed(2) };

  /* Today, in the shape the dashboard puts across the top: what was taken,
     over how many bills, and what the average bill came to. Voided sales are
     left out — they were reversed, so counting them would flatter both. */
  const todayRow = (await query(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total), 0) AS total
       FROM sale_invoices WHERE firm_id = ? AND invoice_date = ? AND COALESCE(status,'') <> 'voided'`,
    [f, today])).rows[0];
  const billsToday = +todayRow.bills || 0;
  const todayTotal = +todayRow.total || 0;

  /* Sales by hour of the day, for the curve. The window follows the hours the
     shop actually billed in rather than an assumed 07:00–21:00 — a till that
     rings up at 03:00 was drawing every bill outside the axis, so the chart
     came back as gridlines and nothing else. */
  const hourRows = (await query(
    `SELECT CAST(strftime('%H', COALESCE(created_at, invoice_date)) AS INTEGER) AS h,
            COALESCE(SUM(grand_total), 0) AS v
       FROM sale_invoices
      WHERE firm_id = ? AND invoice_date = ? AND COALESCE(status,'') <> 'voided'
      GROUP BY h ORDER BY h`, [f, today])).rows;
  const byHour = {};
  for (const r of hourRows) byHour[r.h] = +r.v || 0;
  const soldHours = hourRows.map((r) => +r.h).filter((h) => h >= 0 && h <= 23);
  /* Nothing sold yet: keep the old shop-hours window so the empty chart still
     reads as a day rather than a single tick. */
  let firstHour = 7;
  let lastHour = 21;
  if (soldHours.length) {
    firstHour = Math.max(0, Math.min(...soldHours) - 1);
    lastHour = Math.min(23, Math.max(...soldHours) + 1);
    /* A single busy hour would otherwise draw a two-point line; widen to at
       least six hours so the curve has somewhere to sit. */
    while (lastHour - firstHour < 5) {
      if (firstHour > 0) firstHour--;
      else if (lastHour < 23) lastHour++;
      else break;
    }
  }
  const hourly = [];
  for (let h = firstHour; h <= lastHour; h++) hourly.push({ hour: h, value: byHour[h] || 0 });

  /* Bills parked at the till, with enough to recognise them by. */
  const held = (await query(
    `SELECT h.id, h.label, h.total_hint, h.created_at, COALESCE(u.full_name, u.username) AS held_by
       FROM held_sales h LEFT JOIN users u ON u.id = h.created_by
      WHERE h.firm_id = ? ORDER BY h.id DESC LIMIT 5`, [f])).rows;

  const latestBills = (await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.created_at, s.grand_total, s.balance_due,
            s.payment_type, s.status, COALESCE(p.name, 'Cash Sale') AS party_name
       FROM sale_invoices s LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? ORDER BY s.id DESC LIMIT 6`, [f])).rows;

  /* What the drawer should hold, if a shift is open. Null when none is —
     better no figure than a wrong one. */
  let drawer = null;
  const openShift = (await query(
    "SELECT * FROM shifts WHERE firm_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [f, req.user.id])).rows[0];
  if (openShift) {
    const one = async (sql, args) => (await query(sql, args)).rows[0] || {};
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const cashIn = (await one(
      `SELECT COALESCE(SUM(amount),0) t FROM payments
        WHERE firm_id=? AND created_by=? AND direction='in' AND mode='cash' AND created_at BETWEEN ? AND ?
          AND COALESCE(status,'paid') NOT IN ('voided','draft')`,
      [f, openShift.user_id, openShift.opened_at, now])).t;
    const paysOut = (await one(
      `SELECT COALESCE(SUM(amount),0) t FROM payments
        WHERE firm_id=? AND direction='out' AND created_by=? AND created_at BETWEEN ? AND ?
          AND COALESCE(status,'paid') NOT IN ('voided','draft')`,
      [f, openShift.user_id, openShift.opened_at, now])).t;
    const exp = (await one(
      `SELECT COALESCE(SUM(amount),0) t FROM expenses
        WHERE firm_id=? AND created_by=? AND created_at BETWEEN ? AND ?
          AND COALESCE(status,'posted') <> 'voided'`,
      [f, openShift.user_id, openShift.opened_at, now])).t;
    const mv = await one(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS cin,
              COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS cout
         FROM cash_movements WHERE firm_id=? AND user_id=? AND created_at BETWEEN ? AND ?`,
      [f, openShift.user_id, openShift.opened_at, now]);
    drawer = {
      float: +Number(openShift.opening_float).toFixed(2),
      expected: +(Number(openShift.opening_float) + cashIn + (+mv.cin || 0) - paysOut - exp - (+mv.cout || 0)).toFixed(2),
      opened_at: openShift.opened_at,
    };
  }

  /* ── Which widgets are even allowed on the screen ────────────────────────
     A shop that has switched manufacturing or loyalty off must not be shown a
     production or points figure — it would be a permanently empty box the
     owner cannot make go away. The flags travel with the figures so the
     dashboard needs no second request to know what to draw, and so the
     queries behind a switched-off module never run at all. */
  const on = async (k, dflt) => await getSetting(f, k, dflt) !== "0";
  const mods = {
    loyalty: await on("mod_loyalty", "0"),
    manufacturing: await on("mod_manufacturing", "0"),
    purchases: await on("mod_purchases", "1"),
    expenses: await on("mod_expenses", "1"),
    inventory: await on("mod_inventory", "1"),
    shifts: await on("mod_shifts", "1"),
  };

  /* ── The fortnight behind today ──────────────────────────────────────────
     Every trend strip on the dashboard reads from this one array, so the bars
     under "takings", "margin" and "money received" are the same fourteen days
     and can be compared by eye. Built by three grouped queries and filled with
     zeros in JS: a day with no trade must draw an empty slot, not be missing,
     or a closed Sunday silently shortens the week. */
  const DAYS = 14;
  const dayKeys = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    dayKeys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  const win0 = dayKeys[0], win1 = dayKeys[dayKeys.length - 1];
  const dayMap = {};
  for (const d of dayKeys) dayMap[d] = { d, sales: 0, net: 0, credit: 0, cost: 0, margin: 0, received: 0 };

  for (const r of (await query(
    `SELECT invoice_date d, COALESCE(SUM(grand_total),0) v, COALESCE(SUM(sub_total),0) n,
            COALESCE(SUM(CASE WHEN (grand_total - COALESCE(paid_amount,0)) > 0.005
                              THEN grand_total ELSE 0 END),0) c
       FROM sale_invoices
      WHERE firm_id=? AND invoice_date BETWEEN ? AND ? AND COALESCE(status,'') <> 'voided'
      GROUP BY invoice_date`, [f, win0, win1])).rows) {
    if (dayMap[r.d]) {
      dayMap[r.d].sales = +r.v || 0; dayMap[r.d].credit = +r.c || 0;
      /* Margin is measured against the goods value, not the grand total: the
         grand total carries VAT the shop is only holding for URA, and any
         withholding deducted at source. Taking it as revenue would price the
         tax into the shopkeeper's profit — and would put a different margin on
         this screen from the one the profit reports print. */
      dayMap[r.d].net = +r.n || 0;
    }
  }
  /* Cost of what went out of the door, on the same basis the profit reports
     use (base quantity × the item's purchase price). Two screens quoting two
     different margins for the same day is worse than quoting none. */
  for (const r of (await query(
    `SELECT s.invoice_date d,
            COALESCE(SUM(COALESCE(l.base_quantity, l.quantity) * COALESCE(i.purchase_price,0)),0) c
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE l.firm_id=? AND s.invoice_date BETWEEN ? AND ? AND COALESCE(s.status,'') <> 'voided'
      GROUP BY s.invoice_date`, [f, win0, win1])).rows) {
    if (dayMap[r.d]) dayMap[r.d].cost = +r.c || 0;
  }
  for (const r of (await query(
    `SELECT payment_date d, COALESCE(SUM(amount),0) v FROM payments
      WHERE firm_id=? AND direction='in' AND payment_date BETWEEN ? AND ?
        AND COALESCE(status,'paid') NOT IN ('voided','draft')
      GROUP BY payment_date`, [f, win0, win1])).rows) {
    if (dayMap[r.d]) dayMap[r.d].received = +r.v || 0;
  }
  const days = dayKeys.map((d) => {
    const row = dayMap[d];
    row.margin = +(row.net - row.cost).toFixed(2);
    row.sales = +row.sales.toFixed(2); row.net = +row.net.toFixed(2);
    row.credit = +row.credit.toFixed(2);
    row.cost = +row.cost.toFixed(2); row.received = +row.received.toFixed(2);
    return row;
  });
  const todayRowD = days[days.length - 1];
  /* Same weekday a week ago, not merely yesterday: market day against market
     day is the comparison a shopkeeper actually makes, and yesterday alone
     calls every Monday a disaster. */
  const lastWeekSame = days.length >= 8 ? days[days.length - 8].sales : 0;

  /* ── Today's gross margin ───────────────────────────────────────────────
     Turnover flatters; what is left after the goods is what feeds anyone. */
  const marginToday = {
    revenue: todayRowD.net,
    cost: todayRowD.cost,
    margin: todayRowD.margin,
    pct: todayRowD.net > 0 ? +((todayRowD.margin / todayRowD.net) * 100).toFixed(1) : null,
  };

  /* ── Where the money physically is ──────────────────────────────────────
     Cash, bank and mobile money as separate lines. One "cash in hand" total
     hides the shop that has plenty on paper and nothing in the drawer. */
  const cashAccounts = (await query(
    `SELECT a.code, a.name, COALESCE(b.balance,0) AS balance
       FROM chart_of_accounts a
       LEFT JOIN account_balances b ON b.firm_id=a.firm_id AND b.account_code=a.code
      WHERE a.firm_id=? AND a.is_cash_bank=1 AND COALESCE(a.status,'active')='active'
      ORDER BY a.code`, [f])).rows
    .map((r) => ({ code: r.code, name: r.name, balance: +(+r.balance).toFixed(2) }));
  const cashTotal = +cashAccounts.reduce((a, r) => a + r.balance, 0).toFixed(2);

  /* ── Owed to me, overdue portion ────────────────────────────────────────
     Anything past thirty days. This is the figure that closes small shops:
     the books look healthy, the money is in other people's pockets. */
  const receivableOverdue = +(ageing.d60 + ageing.d90 + ageing.d90p).toFixed(2);

  /* ── What I owe, and how much of it is already late ────────────────────── */
  let payables = { total: 0, overdue: 0, bills: 0, nextDue: null };
  if (mods.purchases) {
    const p = (await query(
      `SELECT COALESCE(SUM(balance_due),0) total, COUNT(*) bills,
              COALESCE(SUM(CASE WHEN COALESCE(NULLIF(due_date,''), bill_date) < ?
                                THEN balance_due ELSE 0 END),0) overdue,
              MIN(COALESCE(NULLIF(due_date,''), bill_date)) next_due
         FROM purchase_invoices WHERE firm_id=? AND balance_due > 0.005`, [today, f])).rows[0];
    payables = { total: +(+p.total).toFixed(2), overdue: +(+p.overdue).toFixed(2),
                 bills: +p.bills || 0, nextDue: p.next_due || null };
  }

  /* ── The hours this shop actually sells in ───────────────────────────────
     Over the last thirty days, not today — today may be half over. Tells the
     owner when to be behind the counter and when to be at the wholesaler. */
  const busy = (await query(
    `SELECT CAST(strftime('%H', COALESCE(created_at, invoice_date)) AS INTEGER) h,
            COALESCE(SUM(grand_total),0) v
       FROM sale_invoices
      WHERE firm_id=? AND invoice_date >= date(?, '-29 day') AND COALESCE(status,'') <> 'voided'
      GROUP BY h ORDER BY v DESC`, [f, today])).rows.filter((r) => r.h != null);
  const busyHours = busy.length
    ? { peak: +busy[0].h, open: Math.min(...busy.map((r) => +r.h)), close: Math.max(...busy.map((r) => +r.h)) }
    : null;

  /* ── Stock that is not moving ────────────────────────────────────────────
     Money sitting on a shelf. Sixty days without a sale, still on hand. */
  let deadStock = { count: 0, value: 0 };
  if (mods.inventory) {
    const ds = (await query(
      `SELECT COUNT(*) n, COALESCE(SUM(oh * COALESCE(purchase_price,0)),0) v FROM (
         SELECT i.id, i.purchase_price,
                COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id=i.firm_id),0) oh,
                (SELECT MAX(s2.invoice_date) FROM sale_invoice_lines l2
                   JOIN sale_invoices s2 ON s2.id=l2.invoice_id
                  WHERE l2.item_id=i.id AND l2.firm_id=i.firm_id) last_sold
           FROM items i WHERE i.firm_id=? AND i.is_inventory=1
       ) WHERE oh > 0 AND (last_sold IS NULL OR last_sold < date(?, '-59 day'))`, [f, today])).rows[0];
    deadStock = { count: +ds.n || 0, value: +(+ds.v).toFixed(2) };
  }

  /* Spending today, so the takings figure is not read as profit. */
  const expensesToday = mods.expenses
    ? +(await query("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE firm_id=? AND expense_date=? AND COALESCE(status,'posted') <> 'voided'",
             [f, today])).rows[0].v.toFixed(2)
    : 0;

  /* Module-gated figures. The queries only run when the module is on. */
  let loyalty = null;
  if (mods.loyalty) {
    const l = (await query(
      `SELECT COALESCE(SUM(CASE WHEN direction='earn' THEN points ELSE 0 END),0) earned,
              COALESCE(SUM(CASE WHEN direction='redeem' THEN points ELSE 0 END),0) redeemed,
              COALESCE(SUM(CASE WHEN direction='redeem' THEN value ELSE 0 END),0) redeemed_value
         FROM loyalty_ledger WHERE firm_id=? AND substr(COALESCE(created_at,''),1,10)=?`, [f, today])).rows[0];
    const bal = (await query(
      `SELECT COALESCE(SUM(CASE WHEN direction='earn' THEN points
                                WHEN direction='adjust' THEN points ELSE -points END),0) v
         FROM loyalty_ledger WHERE firm_id=?`, [f])).rows[0].v;
    loyalty = { earnedToday: +(+l.earned).toFixed(2), redeemedToday: +(+l.redeemed).toFixed(2),
                redeemedValue: +(+l.redeemed_value).toFixed(2), outstanding: +(+bal).toFixed(2) };
  }
  let production = null;
  if (mods.manufacturing) {
    const p = (await query(
      `SELECT COUNT(*) runs, COALESCE(SUM(quantity),0) qty,
              COALESCE(SUM(quantity * COALESCE(unit_cost,0)),0) value
         FROM production_runs WHERE firm_id=? AND COALESCE(run_date, substr(created_at,1,10))=?`,
      [f, today])).rows[0];
    production = { runs: +p.runs || 0, qty: +(+p.qty).toFixed(2), value: +(+p.value).toFixed(2) };
  }

  res.success({
    mods, days, trendFrom: win0, lastWeekSame: +lastWeekSame.toFixed(2),
    marginToday, cashAccounts, cashTotal, receivableOverdue, payables,
    busyHours, deadStock, expensesToday, loyalty, production,
    salesToday: +salesToday.toFixed(2), salesMonth: +salesMonth.toFixed(2),
    salesYesterday: +salesYesterday.toFixed(2), topSellers,
    receivable: +receivable.toFixed(2), payable: +payable.toFixed(2),
    invoiceCount, stockValue: +stockValue.toFixed(2), cashInHand: +cashInHand.toFixed(2),
    lowStock, trend,
    expiring, expiringCount: expiringTotal.n, expiringValue: +expiringTotal.v.toFixed(2), expiryAlertDays: alertDays,
    periodSales: +periodSales.toFixed(2), periodCount, from, to,
    collected: +collected.toFixed(2), ageing, split,
    billsToday, todayTotal,
    avgBillToday: billsToday > 0 ? +(todayTotal / billsToday).toFixed(2) : 0,
    hourly, held, latestBills, drawer,
  });
});

/* Sidebar badges — small counts to surface attention items */
router.get("/badges", async (req, res) => {
  const f = req.user.firm_id;
  const one = async (sql, p = [f]) => (await query(sql, p)).rows[0].n || 0;
  res.success({
    pos: await one("SELECT COUNT(*) n FROM held_sales WHERE firm_id=?"),
    invoices: await one("SELECT COUNT(*) n FROM sale_invoices WHERE firm_id=? AND balance_due > 0 AND status != 'voided'"),
    purchases: await one("SELECT COUNT(*) n FROM purchase_invoices WHERE firm_id=? AND balance_due > 0"),
    items: await one(`SELECT COUNT(*) n FROM (
        SELECT i.id, COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) oh
          FROM items i WHERE i.firm_id=? AND i.is_inventory=1
      ) WHERE oh < 0`),
  });
});

/* Global search: Open Anything (Ctrl+F) */
router.get("/search", async (req, res) => {
  const f = req.user.firm_id;
  const q = `%${(req.query.q || "").trim()}%`;
  if (q === "%%") return res.success({ parties: [], items: [], invoices: [] });
  res.success({
    parties: (await query("SELECT id, name, balance FROM parties WHERE firm_id=? AND name LIKE ? LIMIT 5", [f, q])).rows,
    // unit / secondary_unit / conversion_rate come back so the caller can render
    // the quantity with dualQty; without them the palette printed a bare base
    // number and dual-unit items read wrong.
    items: (await query(`SELECT i.id, i.name, i.sale_price, i.unit, i.secondary_unit, i.conversion_rate,
                         COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) on_hand
                    FROM items i WHERE i.firm_id=? AND i.name LIKE ? LIMIT 5`, [f, q])).rows,
    invoices: (await query(`SELECT s.id, s.invoice_no, s.grand_total, p.name party_name
                       FROM sale_invoices s JOIN parties p ON p.id=s.party_id
                      WHERE s.firm_id=? AND (s.invoice_no LIKE ? OR p.name LIKE ?) ORDER BY s.id DESC LIMIT 5`, [f, q, q])).rows,
  });
});

module.exports = router;
