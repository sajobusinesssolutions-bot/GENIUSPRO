/* Parties overview — the three figures above the list.
 *
 * Sign convention, set by the posters elsewhere in the app: a sale ADDS to
 * parties.balance and a purchase SUBTRACTS from it. So a positive balance is
 * money owed to you and a negative one is money you owe. Everything below
 * follows from that, and nothing here re-derives it from the documents —
 * the balance column is the maintained figure and this must agree with it.
 *
 * Attached by parties.routes.js above its "/:id" route.
 */
const { query } = require("../../database/db");

function attach(router, requirePermission) {
  router.get("/overview", requirePermission("parties", "view"), async (req, res) => {
    const firm = req.user.firm_id;
    const one = async (sql, args = [firm]) => (await query(sql, args)).rows[0] || {};

    const pos = await one(
      `SELECT COALESCE(SUM(balance), 0) AS net,
              COALESCE(SUM(CASE WHEN balance > 0.005 THEN balance ELSE 0 END), 0) AS owed_to_you,
              COALESCE(SUM(CASE WHEN balance < -0.005 THEN -balance ELSE 0 END), 0) AS you_owe,
              COALESCE(SUM(CASE WHEN balance >  0.005 THEN 1 ELSE 0 END), 0) AS n_owing,
              COALESCE(SUM(CASE WHEN balance < -0.005 THEN 1 ELSE 0 END), 0) AS n_owed,
              COUNT(*) AS n
         FROM parties
        WHERE firm_id = ? AND COALESCE(status, 'active') = 'active'`
    );

    /* Bills due this week, not overdue ones — this panel is a heads-up about
       what is about to fall due, which is a different question from what is
       already late. */
    const due = await one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(balance_due), 0) AS amount
         FROM purchase_invoices
        WHERE firm_id = ? AND balance_due > 0.005
          AND due_date IS NOT NULL
          AND due_date >= date('now') AND due_date <= date('now', '+7 day')`
    );

    const types = await one(
      `SELECT COALESCE(SUM(CASE WHEN party_type IN ('customer','both') THEN 1 ELSE 0 END), 0) AS customers,
              COALESCE(SUM(CASE WHEN party_type IN ('supplier','both') THEN 1 ELSE 0 END), 0) AS suppliers
         FROM parties
        WHERE firm_id = ? AND COALESCE(status, 'active') = 'active'`
    );

    res.success({
      net: +pos.net || 0,
      owedToYou: +pos.owed_to_you || 0,
      youOwe: +pos.you_owe || 0,
      owingCount: +pos.n_owing || 0,
      owedCount: +pos.n_owed || 0,
      total: +pos.n || 0,
      customers: +types.customers || 0,
      suppliers: +types.suppliers || 0,
      dueThisWeek: { count: +due.n || 0, amount: +due.amount || 0 },
    });
  });
}

module.exports = { attach };
