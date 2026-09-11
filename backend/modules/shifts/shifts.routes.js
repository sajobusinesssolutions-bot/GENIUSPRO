/**
 * shifts.routes.js — cashier till sessions.
 *
 * A shift is opened with a starting float and closed with the cash physically
 * counted. On close the app computes what SHOULD be in the drawer for that
 * window — float + cash actually collected − cash paid out — and records the
 * variance. Sales are never blocked by this module directly; the optional
 * block_sales_without_shift setting (checked in sales.routes) does that.
 *
 * "Expected cash" reuses the exact formula the Z report uses, so the two always
 * agree: paid_amount on sales − supplier payments out − expenses, restricted to
 * this shift's open→close window by created_at timestamp.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");

router.use(verifyToken);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** The caller's currently open shift, if any. */
async function openShiftFor(firmId, userId) {
  return (await query(
    "SELECT * FROM shifts WHERE firm_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    [firmId, userId])).rows[0] || null;
}

/**
 * Cash that should have passed through the drawer between two timestamps.
 * Mirrors zreport-summary's expectedCash so a shift close and a Z report over
 * the same window never disagree.
 */
async function cashForWindow(firmId, userId, fromTs, toTs) {
  const one = async (sql, p) => (await query(sql, p)).rows[0] || {};
  /* Cash that actually reached the drawer, read from the payments ledger
     rather than from the invoice's payment_type.

     Every sale that takes money writes a payments row carrying the tender it
     was taken in, so this counts a credit bill part-paid in cash, and a debt
     collected at the till, both of which the old query — which only looked at
     invoices marked payment_type='cash' — missed entirely. It cannot
     double-count a cash sale, because that sale's money exists here once. */
  const collected = (await one(
    `SELECT COALESCE(SUM(amount),0) t FROM payments
      WHERE firm_id=? AND created_by=? AND direction='in' AND mode='cash'
        AND created_at BETWEEN ? AND ?
        AND COALESCE(status,'paid') NOT IN ('voided','draft')`, [firmId, userId, fromTs, toTs])).t;
  // cash paid out (supplier payments + expenses) recorded by this user in the window
  const paysOut = (await one(
    `SELECT COALESCE(SUM(amount),0) t FROM payments
      WHERE firm_id=? AND direction='out' AND created_by=? AND created_at BETWEEN ? AND ?
        AND COALESCE(status,'paid') NOT IN ('voided','draft')`,
    [firmId, userId, fromTs, toTs])).t;
  const expenses = (await one(
    `SELECT COALESCE(SUM(amount),0) t FROM expenses
      WHERE firm_id=? AND created_by=? AND created_at BETWEEN ? AND ?
        AND COALESCE(status,'posted') <> 'voided'`,
    [firmId, userId, fromTs, toTs])).t;
  /* Money put into or taken out of the drawer by hand: the opening float,
     an owner top-up, a run to the bank. Without these an owner adding cash
     mid-shift made the till read as over at every close. */
  const moved = await one(
    `SELECT COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0) AS cin,
            COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS cout
       FROM cash_movements
      WHERE firm_id=? AND user_id=? AND created_at BETWEEN ? AND ?`,
    [firmId, userId, fromTs, toTs]);
  return {
    collected: r2(collected + (+moved.cin || 0)),
    paidOut: r2(paysOut + expenses + (+moved.cout || 0)),
  };
}

/* GET /current — the caller's open shift (null if none) */
router.get("/current", async (req, res) => {
  res.success(await openShiftFor(req.user.firm_id, req.user.id));
});

/* POST /open — start a shift */
router.post("/open", async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (await openShiftFor(firmId, req.user.id)) {
    return res.fail("You already have an open shift — close it before starting another", 409);
  }
  const b = req.body || {};
  const float = Math.max(0, Number(b.opening_float) || 0);
  await conn.query(
    `INSERT INTO shifts (firm_id, user_id, opened_by, opening_float, open_note, status)
     VALUES (?,?,?,?,?, 'open')`,
    [firmId, req.user.id, req.user.id, float, b.open_note || null]);
  const shift = await openShiftFor(firmId, req.user.id);
  return () => res.success(shift, "Shift started");
}));

/* POST /close — close the caller's open shift (or, with permission, another's) */
router.post("/close", async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const b = req.body || {};
  // a manager with users.edit may close a specific shift for someone else
  // a manager whose role includes users.edit may close a specific open shift
  // for someone else (e.g. a cashier who left without closing)
  let shift;
  if (b.shift_id) {
    const canManage = (await query(
      `SELECT 1 FROM role_permissions rp JOIN users u ON u.role_id = rp.role_id
        WHERE u.id = ? AND rp.module = 'users' AND rp.action = 'edit'`, [req.user.id])).rows.length > 0;
    if (!canManage) return res.fail("You can only close your own shift", 403);
    shift = (await query("SELECT * FROM shifts WHERE id=? AND firm_id=? AND status='open'", [b.shift_id, firmId])).rows[0];
  } else {
    shift = await openShiftFor(firmId, req.user.id);
  }
  if (!shift) return res.fail("No open shift to close", 404);

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const { collected, paidOut } = await cashForWindow(firmId, shift.user_id, shift.opened_at, now);
  const expected = r2(Number(shift.opening_float) + collected - paidOut);
  const counted = b.counted_cash != null ? r2(b.counted_cash) : null;
  const variance = counted != null ? r2(counted - expected) : null;

  await conn.query(
    `UPDATE shifts SET status='closed', closed_at=?, closed_by=?, counted_cash=?,
        expected_cash=?, variance=?, close_note=? WHERE id=?`,
    [now, req.user.id, counted, expected, variance, b.close_note || null, shift.id]);

  const closed = (await conn.query("SELECT * FROM shifts WHERE id=?", [shift.id])).rows[0];
  return () => res.success(closed, "Shift closed");
}));

/* Everything about a shift that is NOT cash.
 *
 * The screen was answering exactly one question — what should be in the drawer
 * — and a shift is not only a drawer. A cashier who took nine bills, four of
 * them on mobile money, closes a drawer that balances perfectly while having
 * no idea whether the shift went well; and a manager reading a variance has no
 * way to see that two sales were voided in the window it covers.
 *
 * All of it comes from rows the app already writes. Nothing is estimated.
 */
async function shiftFigures(firmId, userId, fromTs, toTs) {
  const rows = async (sql, args) => (await query(sql, args)).rows;
  const one = async (sql, args) => (await rows(sql, args))[0] || {};

  /* Money in, split by how it was taken. Cash is only one column of this, and
     it is the only one the drawer ever sees. */
  const tenders = await rows(
    `SELECT COALESCE(mode,'cash') AS mode, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n
       FROM payments
      WHERE firm_id=? AND created_by=? AND direction='in'
        AND created_at BETWEEN ? AND ?
        AND COALESCE(status,'paid') NOT IN ('voided','draft')
      GROUP BY COALESCE(mode,'cash')
      ORDER BY amount DESC`, [firmId, userId, fromTs, toTs]);

  /* What was sold in the window, whether or not it was paid for. A shift that
     put four bills on account took no cash for them and should still be able
     to say it sold something. */
  const sold = await one(
    `SELECT COUNT(*) AS bills,
            COALESCE(SUM(grand_total),0)    AS total,
            COALESCE(SUM(discount_total),0) AS discounts,
            COALESCE(SUM(balance_due),0)    AS on_account
       FROM sale_invoices
      WHERE firm_id=? AND created_by=? AND COALESCE(doc_type,'invoice')='invoice'
        AND COALESCE(status,'') <> 'voided'
        AND created_at BETWEEN ? AND ?`, [firmId, userId, fromTs, toTs]);

  const voided = await one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(grand_total),0) AS total
       FROM sale_invoices
      WHERE firm_id=? AND created_by=? AND status='voided'
        AND created_at BETWEEN ? AND ?`, [firmId, userId, fromTs, toTs]);

  const bills = Number(sold.bills) || 0;
  return {
    tenders: tenders.map((t) => ({ mode: t.mode, amount: r2(t.amount), n: Number(t.n) || 0 })),
    bills,
    sales_total: r2(sold.total),
    discounts: r2(sold.discounts),
    on_account: r2(sold.on_account),
    /* Written out rather than left to the screen: an average of nothing is
       not zero, it is nothing, and a tile reading "Sh 0.00 average bill" on a
       quiet shift is a figure that looks like a fault. */
    average_bill: bills ? r2(Number(sold.total) / bills) : null,
    voided_n: Number(voided.n) || 0,
    voided_total: r2(voided.total),
  };
}

/* GET /preview — what expected cash is right now, without closing, and the
   rest of what this shift has done. Lets the till show the number before the
   cashier counts. */
router.get("/preview", async (req, res) => {
  const shift = await openShiftFor(req.user.firm_id, req.user.id);
  if (!shift) return res.fail("No open shift", 404);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const { collected, paidOut } = await cashForWindow(req.user.firm_id, shift.user_id, shift.opened_at, now);
  res.success({
    opening_float: shift.opening_float,
    cash_collected: collected,
    cash_paid_out: paidOut,
    expected_cash: r2(Number(shift.opening_float) + collected - paidOut),
    opened_at: shift.opened_at,
    ...await shiftFigures(req.user.firm_id, shift.user_id, shift.opened_at, now),
  });
});

/**
 * GET /open — every shift open right now, whoever it belongs to.
 *
 * A manager could close somebody else's shift but had no way to find out
 * there was one: `/current` answers about the caller and nothing else. So a
 * cashier who went home without closing left a shift that stayed open until
 * somebody guessed it existed, and the next day's expected cash was computed
 * from a window that had never been shut.
 *
 * Needs the reports permission, like the history — this is management data:
 * it says what every till in the shop is holding.
 */
router.get("/open", requirePermission("reports", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const rows = (await query(
    `SELECT s.*, COALESCE(u.full_name, u.username) AS user_name
       FROM shifts s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.firm_id = ? AND s.status = 'open' ORDER BY s.opened_at`, [firmId])).rows;
  /* The expected figure is worked out by the same function the close uses, so
     a manager looking at this list and the cashier closing the shift cannot be
     shown two different numbers for the same drawer. */
  for (const sh of rows) {
    const { collected, paidOut } = await cashForWindow(firmId, sh.user_id, sh.opened_at, now);
    sh.cash_collected = collected;
    sh.cash_paid_out = paidOut;
    sh.expected_cash = r2(Number(sh.opening_float) + collected - paidOut);
    sh.minutes = Math.max(0, Math.round((new Date(now) - new Date(sh.opened_at)) / 60000));
  }
  res.success({ rows });
});

/**
 * GET /:id/movements — what went in and out of this drawer, and why.
 *
 * The close screen shows a variance. A variance with no way to see the
 * movements behind it is a number somebody has to accept on faith, and the
 * first question anybody asks about a short drawer is "what came out of it".
 */
router.get("/:id/movements", async (req, res) => {
  const firmId = req.user.firm_id;
  const shift = (await query("SELECT * FROM shifts WHERE id = ? AND firm_id = ?",
    [req.params.id, firmId])).rows[0];
  if (!shift) return res.fail("No such shift", 404);
  /* Your own shift, or anybody's if you may read the reports. */
  const mine = shift.user_id === req.user.id;
  if (!mine) {
    const may = (await query(
      `SELECT 1 FROM role_permissions WHERE role_id = ? AND module = 'reports' AND action = 'view'`,
      [req.user.role_id])).rows.length > 0 || req.user.is_owner;
    if (!may) return res.fail("That is not your shift", 403);
  }
  const to = shift.closed_at || new Date().toISOString().replace("T", " ").slice(0, 19);
  const rows = (await query(
    `SELECT id, direction, amount, reason, note, created_at
       FROM cash_movements
      WHERE firm_id = ? AND user_id = ? AND created_at BETWEEN ? AND ?
      ORDER BY id`, [firmId, shift.user_id, shift.opened_at, to])).rows;
  res.success({ shift, rows });
});

/* GET / — shift history (needs reports permission; it's management data).
   ?from&to filter by open date; ?user_id filters one person. */
router.get("/", requirePermission("reports", "view"), async (req, res) => {
  const from = req.query.from || "0000-01-01";
  const to = req.query.to || "9999-12-31";
  const params = [req.user.firm_id, from, to];
  let userClause = "";
  if (req.query.user_id) { userClause = "AND s.user_id = ?"; params.push(req.query.user_id); }
  const rows = (await query(
    `SELECT s.*, COALESCE(u.full_name, u.username) AS user_name,
            COALESCE(cu.full_name, cu.username) AS closed_by_name,
            CASE WHEN s.closed_at IS NOT NULL
                 THEN CAST((julianday(s.closed_at) - julianday(s.opened_at)) * 24 * 60 AS INTEGER)
                 ELSE NULL END AS minutes
       FROM shifts s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN users cu ON cu.id = s.closed_by
      WHERE s.firm_id = ? AND date(s.opened_at) BETWEEN ? AND ? ${userClause}
      ORDER BY s.id DESC`, params)).rows;
  res.success({ rows });
});

module.exports = router;
