/* Till administrator — the endpoints behind the drawer on the POS bar.
 *
 * Attached by pos.routes.js.
 */
const { query } = require("../../database/db");
const { durable } = require("../../shared/durable");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Reasons the till offers. Keeping the list here rather than in the browser
   means a movement cannot be filed under something the books do not know
   about, and the day book can group them later. */
const CASH_REASONS = {
  in: ["Opening float", "Owner top-up", "Change fund", "Correction"],
  out: ["Bank deposit", "Casual labour", "Delivery fuel", "Airtime & data", "Owner drawing", "Correction"],
};

function attach(router, requirePermission) {
  router.get("/cash-reasons", (req, res) => res.success(CASH_REASONS));

  /* Money into or out of the drawer that is not a sale and not a supplier
     payment. Every one needs a reason — an unexplained drawer is the thing
     this screen exists to prevent. */
  /* Drawer money. The X report counts it, so it has to be on disk before the
     cashier is told it was recorded. */
  router.post("/cash-movement", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
    const b = req.body || {};
    const direction = b.direction === "out" ? "out" : "in";
    const amount = r2(b.amount);
    const reason = String(b.reason || "").trim();

    if (!(amount > 0)) return res.fail("Enter an amount");
    if (!reason) return res.fail("Choose a reason — the day book needs one");
    if (!CASH_REASONS[direction].includes(reason)) return res.fail("That is not a reason this till offers");

    const r = await conn.query(
      `INSERT INTO cash_movements (firm_id, user_id, direction, amount, reason, note)
       VALUES (?,?,?,?,?,?)`,
      [req.user.firm_id, req.user.id, direction, amount, reason, b.note || null]);

    return () => res.success({ id: r.insertId, direction, amount, reason },
      `${direction === "in" ? "Cash in" : "Cash out"} recorded`);
  }));

  /* Today's drawer movements, for the X report and the day book. */
  router.get("/cash-movements", requirePermission("sales", "view"), async (req, res) => {
    const rows = (await query(
      `SELECT cm.*, COALESCE(u.full_name, u.username) AS by_user
         FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id
        WHERE cm.firm_id = ? AND date(cm.created_at) = date(?)
        ORDER BY cm.id DESC`,
      [req.user.firm_id, req.query.date || new Date().toISOString().slice(0, 10)]
    )).rows;
    res.success(rows);
  });

  /* Customers carrying a balance, oldest debt first — the queue the till works
     through when someone comes in to pay off an account. */
  router.get("/credit-customers", requirePermission("sales", "view"), async (req, res) => {
    const firm = req.user.firm_id;
    const rows = (await query(
      `SELECT p.id, p.name, p.phone, p.balance, p.credit_limit
         FROM parties p
        WHERE p.firm_id = ? AND p.balance > 0.005 AND COALESCE(p.status,'active') = 'active'
        ORDER BY p.balance DESC`,
      [firm]
    )).rows;

    /* The oldest bill still owing tells you how overdue they are, which the
       balance alone does not. */
    const oldest = (await query(
      `SELECT party_id, invoice_no, invoice_date,
              CAST(julianday('now') - julianday(COALESCE(due_date, invoice_date)) AS INTEGER) AS days
         FROM sale_invoices s
        WHERE firm_id = ? AND COALESCE(status,'') <> 'voided' AND balance_due > 0.005
          AND NOT EXISTS (
            SELECT 1 FROM sale_invoices o
             WHERE o.firm_id = s.firm_id AND o.party_id = s.party_id
               AND COALESCE(o.status,'') <> 'voided' AND o.balance_due > 0.005
               AND (o.invoice_date < s.invoice_date
                    OR (o.invoice_date = s.invoice_date AND o.id < s.id)))`,
      [firm]
    )).rows;
    const byParty = {};
    for (const o of oldest) byParty[o.party_id] = o;

    res.success(rows.map((p) => {
      const o = byParty[p.id];
      return {
        id: p.id, name: p.name, phone: p.phone,
        owes: r2(p.balance), credit_limit: p.credit_limit,
        oldest_ref: o ? o.invoice_no : null,
        oldest_days: o ? Math.max(0, +o.days || 0) : null,
      };
    }));
  });

  /* Everything rung through today, newest first — what "Previous sales" shows. */
  router.get("/today-sales", requirePermission("sales", "view"), async (req, res) => {
    const day = req.query.date || new Date().toISOString().slice(0, 10);
    const rows = (await query(
      `SELECT s.id, s.invoice_no, s.invoice_date, s.created_at, s.grand_total,
              s.paid_amount, s.balance_due, s.payment_type, s.status,
              COALESCE(p.name, 'Cash Sale') AS party_name
         FROM sale_invoices s LEFT JOIN parties p ON p.id = s.party_id
        WHERE s.firm_id = ? AND s.invoice_date = ?
        ORDER BY s.id DESC LIMIT 200`,
      [req.user.firm_id, day]
    )).rows;

    const totals = rows.reduce((a, r) => {
      if (r.status === "voided") return a;
      a.bills += 1;
      a.taken += (+r.paid_amount || 0);
      return a;
    }, { bills: 0, taken: 0 });

    res.success({ rows, totals: { bills: totals.bills, taken: r2(totals.taken) } });
  });
}

module.exports = { attach, CASH_REASONS };
