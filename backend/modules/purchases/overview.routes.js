/* Purchases overview — the three figures above the list, and the count on each
 * of the four document tabs.
 *
 * The mirror of /sales/overview, and deliberately built the same way: whole-book
 * figures counted here rather than summed in the browser, so they describe the
 * book and not whichever page happens to be showing.
 *
 * Attached by purchases.routes.js above its "/:id" route.
 */
const { query } = require("../../database/db");

function attach(router, requirePermission) {
  router.get("/overview", requirePermission("purchases", "view"), async (req, res) => {
    const firm = req.user.firm_id;
    const one = async (sql, args = [firm]) => (await query(sql, args)).rows[0] || {};

    const bills = await one(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(grand_total), 0) AS total,
              COALESCE(SUM(paid_amount), 0) AS paid,
              COALESCE(SUM(balance_due), 0) AS owed,
              COALESCE(SUM(CASE WHEN balance_due <= 0.005 THEN 1 ELSE 0 END), 0) AS settled,
              COALESCE(SUM(CASE WHEN balance_due > 0.005 THEN 1 ELSE 0 END), 0) AS open_n
         FROM purchase_invoices
        WHERE firm_id = ? AND COALESCE(doc_type, 'purchase') = 'purchase'
          AND COALESCE(status, '') <> 'voided'`
    );

    /* Falling due in the next week — a heads-up about what is about to land,
       which is a different question from what is already late. */
    const due = await one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance_due), 0) AS amount
         FROM purchase_invoices
        WHERE firm_id = ? AND balance_due > 0.005
          AND due_date IS NOT NULL
          AND due_date >= date('now') AND due_date <= date('now', '+7 day')`
    );

    const late = await one(
      `SELECT COUNT(*) AS n FROM purchase_invoices
        WHERE firm_id = ? AND balance_due > 0.005
          AND COALESCE(due_date, bill_date) < date('now')`
    );

    /* Orders placed but not yet received: money committed that is not yet a
       bill and not yet stock on the shelf. Orders carry `total`, not
       `grand_total`, and "still awaiting" is draft, sent or partial —
       the same set the open-orders list uses, so the two agree. */
    const orders = await one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total,
              COALESCE(SUM(CASE WHEN status IN ('draft','sent','partial') THEN 1 ELSE 0 END), 0) AS open_n,
              COALESCE(SUM(CASE WHEN status IN ('draft','sent','partial') THEN total ELSE 0 END), 0) AS open_total
         FROM purchase_orders WHERE firm_id = ?`
    );

    const notes = await one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS total
         FROM purchase_returns WHERE firm_id = ? AND COALESCE(status,'posted') <> 'voided'`
    );

    const exp = await one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(CASE WHEN strftime('%Y-%m', expense_date) = strftime('%Y-%m','now')
                           THEN amount ELSE 0 END), 0) AS this_month
         FROM expenses WHERE firm_id = ? AND COALESCE(status,'posted') <> 'voided'`
    );

    const total = +bills.total || 0;
    const paid = +bills.paid || 0;

    res.success({
      counts: {
        bills: +bills.n || 0,
        orders: +orders.n || 0,
        returns: +notes.n || 0,
        expenses: +exp.n || 0,
      },
      bills: {
        total, paid,
        owed: +bills.owed || 0,
        /* A book with nothing bought is not 0% settled — it has nothing to
           settle, and NaN would otherwise reach the screen. */
        settledPct: total > 0 ? Math.round((paid / total) * 100) : 0,
        count: +bills.n || 0,
        settled: +bills.settled || 0,
        open: +bills.open_n || 0,
        overdue: +late.n || 0,
        dueThisWeek: { count: +due.n || 0, amount: +due.amount || 0 },
      },
      orders: {
        count: +orders.n || 0, total: +orders.total || 0,
        open: +orders.open_n || 0, onOrder: +orders.open_total || 0,
      },
      returns: { count: +notes.n || 0, total: +notes.total || 0 },
      expenses: { count: +exp.n || 0, total: +exp.total || 0, thisMonth: +exp.this_month || 0 },
    });
  });
}

module.exports = { attach };
