/**
 * installments.routes.js — payment plans on credit invoices.
 *
 * A plan is a timetable, not a second set of books. It records what the
 * customer agreed to pay and when; whether each instalment is settled is
 * *derived* from the invoice's own paid_amount at read time. That means an
 * ordinary payment recorded anywhere in the system moves the plan forward
 * automatically, and a plan can never disagree with the ledger.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");
const { advance, dayOf } = require("../recurring/recurring.routes");

router.use(verifyToken);

const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n) => +Number(n || 0).toFixed(2);
const moduleOn = async (firmId) => await getSetting(firmId, "mod_installments", "0") === "1";

/**
 * Walk the timetable spending the invoice's paid_amount in order. Earlier
 * instalments are settled first, which is how a customer and a shopkeeper both
 * read a payment plan.
 */
function applyPayments(lines, paidAmount) {
  let left = r2(paidAmount);
  const t = today();
  return lines.map((l) => {
    const covered = Math.min(left, l.amount);
    left = r2(left - covered);
    const outstanding = r2(l.amount - covered);
    const settled = outstanding <= 0.005;
    return {
      ...l,
      paid: r2(covered),
      outstanding,
      overdue: !settled && l.due_date <= t,
      days_late: !settled && l.due_date < t
        ? Math.floor((Date.parse(t) - Date.parse(l.due_date)) / 86400000) : 0,
      status: settled ? "paid" : covered > 0 ? "partial" : l.due_date <= t ? "overdue" : "pending",
    };
  });
}

/** Everything a caller needs to show a plan, computed fresh from the ledger. */
async function hydrate(plan) {
  const inv = (await query("SELECT * FROM sale_invoices WHERE id = ?", [plan.invoice_id])).rows[0];
  const raw = (await query("SELECT seq, due_date, amount, label FROM installment_lines WHERE plan_id = ? ORDER BY seq", [plan.id])).rows;
  const lines = applyPayments(raw, inv ? inv.paid_amount : 0);
  const arrears = r2(lines.filter((l) => l.due_date <= today()).reduce((a, l) => a + l.outstanding, 0));
  const nextDue = lines.find((l) => l.status !== "paid");
  const remaining = r2(lines.reduce((a, l) => a + l.outstanding, 0));
  return {
    ...plan,
    invoice_no: inv ? inv.invoice_no : null,
    invoice_total: inv ? inv.grand_total : 0,
    invoice_paid: inv ? inv.paid_amount : 0,
    invoice_balance: inv ? inv.balance_due : 0,
    lines,
    paid_count: lines.filter((l) => l.status === "paid").length,
    overdue_count: lines.filter((l) => l.overdue).length,
    arrears,
    remaining,
    next_due: nextDue ? { seq: nextDue.seq, due_date: nextDue.due_date, amount: nextDue.outstanding } : null,
    /* A plan is finished when the invoice is, not when its dates run out. */
    completed: remaining <= 0.005,
  };
}

/* Sequential, not `rows.map(hydrate)`. Hydrating a plan reads its lines, so
   the callback is async and .map() would hand back an array of promises —
   every screen below would then show a plan with no schedule and no balance. */
async function hydrateAll(rows) {
  const out = [];
  for (const r of rows) out.push(await hydrate(r));
  return out;
}

/* ── Routes ───────────────────────────────────────────────────────────── */

/** Credit invoices that still owe money and have no live plan. */
router.get("/eligible", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.grand_total, s.paid_amount, s.balance_due, p.name AS party_name
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.balance_due > 0
        AND COALESCE(s.doc_type,'invoice') = 'invoice'
        AND NOT EXISTS (SELECT 1 FROM installment_plans ip
                         WHERE ip.invoice_id = s.id AND ip.status = 'active')
      ORDER BY s.invoice_date DESC, s.id DESC`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const plans = await hydrateAll((await query(
    `SELECT ip.*, p.name AS party_name, p.phone
       FROM installment_plans ip JOIN parties p ON p.id = ip.party_id
      WHERE ip.firm_id = ? ORDER BY ip.status, ip.id DESC`,
    [req.user.firm_id]
  )).rows);
  const active = plans.filter((p) => p.status === "active" && !p.completed);
  res.success({
    rows: plans,
    totals: {
      active: active.length,
      arrears: r2(active.reduce((a, p) => a + p.arrears, 0)),
      remaining: r2(active.reduce((a, p) => a + p.remaining, 0)),
      in_arrears: active.filter((p) => p.arrears > 0).length,
    },
  });
});

/* Money actually taken against plans, newest first — the third tab.
 *
 * Instalments are not paid as their own documents: a payment lands on the
 * invoice, and the schedule is worked out from the invoice's paid total. So
 * the history is the payments allocated to invoices that carry a plan. */
router.get("/history", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT pay.id, pay.payment_no, pay.payment_date, pay.amount, pay.mode, pay.reference,
            ip.id AS plan_id, si.invoice_no, p.name AS party_name
       FROM payment_allocations pa
       JOIN payments pay ON pay.id = pa.payment_id
       JOIN sale_invoices si ON si.id = pa.doc_id AND pa.doc_table = 'sale_invoices'
       JOIN installment_plans ip ON ip.invoice_id = si.id
       JOIN parties p ON p.id = ip.party_id
      WHERE pa.firm_id = ?
      ORDER BY pay.payment_date DESC, pay.id DESC
      LIMIT 200`, [req.user.firm_id])).rows;
  res.success({
    rows,
    totals: { taken: r2(rows.reduce((a, r) => a + (+r.amount || 0), 0)), count: rows.length },
  });
});

/* The two figures above the list. Collected is what has actually been paid
   against planned invoices; expected-this-month is every instalment falling
   due before month end that is not yet settled. */
router.get("/summary", requirePermission("sales", "view"), async (req, res) => {
  const plans = await hydrateAll((await query(
    `SELECT ip.*, p.name AS party_name FROM installment_plans ip
       JOIN parties p ON p.id = ip.party_id WHERE ip.firm_id = ?`,
    [req.user.firm_id])).rows);

  const live = plans.filter((p) => p.status === "active" && !p.completed);
  const monthEnd = new Date();
  monthEnd.setMonth(monthEnd.getMonth() + 1); monthEnd.setDate(0);
  const monthEndStr = monthEnd.toISOString().slice(0, 10);

  let expected = 0, arrears = 0, remaining = 0, collected = 0, dueSoon = 0;
  for (const p of live) {
    remaining = r2(remaining + p.remaining);
    arrears = r2(arrears + p.arrears);
    if (p.arrears > 0.005) dueSoon++;
    for (const l of p.lines) {
      if (l.status === "paid") continue;
      if (l.due_date <= monthEndStr) expected = r2(expected + l.outstanding);
    }
    collected = r2(collected + r2(p.plan_total - p.remaining));
  }

  res.success({
    plans: plans.length,
    active: live.length,
    completed: plans.filter((p) => p.completed).length,
    expectedThisMonth: expected,
    arrears, remaining, collected, dueSoon,
  });
});

router.get("/:id", requirePermission("sales", "view"), async (req, res) => {
  const plan = (await query(
    `SELECT ip.*, p.name AS party_name, p.phone FROM installment_plans ip
       JOIN parties p ON p.id = ip.party_id WHERE ip.id = ? AND ip.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!plan) return res.notFound("Plan not found");
  res.success(await hydrate(plan));
});

/**
 * Preview a timetable without saving. Lets the UI show the customer exactly
 * what they are agreeing to before anything is committed.
 */
function buildSchedule({ total, down, count, frequency, interval, start }) {
  const lines = [];
  let seq = 0;
  if (down > 0) lines.push({ seq: seq++, due_date: start, amount: r2(down), label: "Down payment" });
  const rest = r2(total - down);
  const per = Math.floor((rest / count) * 100) / 100;
  let running = 0;
  /* Every due date is stepped from the agreed day of the month, so one short
     February doesn't shift the rest of the plan. */
  const anchor = dayOf(start);
  let due = down > 0 ? advance(start, frequency, interval, anchor) : start;
  for (let i = 0; i < count; i++) {
    /* The last instalment carries the rounding remainder so the timetable adds
       up to the invoice exactly, to the shilling. */
    const amount = i === count - 1 ? r2(rest - running) : per;
    running = r2(running + amount);
    lines.push({ seq: seq++, due_date: due, amount, label: `Instalment ${i + 1} of ${count}` });
    due = advance(due, frequency, interval, anchor);
  }
  return lines;
}

router.post("/preview", requirePermission("sales", "view"), (req, res) => {
  const b = req.body || {};
  const total = r2(b.plan_total);
  const down = r2(b.down_payment);
  const count = Number(b.count_n) || 0;
  if (!(total > 0)) return res.fail("Nothing to spread — this invoice has no balance", 400);
  if (!(count > 0)) return res.fail("Choose how many instalments", 400);
  if (down >= total) return res.fail("The down payment covers the whole invoice — no plan needed", 400);
  res.success(buildSchedule({ total, down, count, frequency: b.frequency || "monthly",
    interval: Number(b.interval_n) || 1, start: b.start_date || today() }));
});

/* The plan and its timetable are one document. Written loose, an insert that
   failed part-way through the lines left a plan whose schedule did not add up
   to the invoice — and nothing said so. */
router.post("/", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Installments management" in Settings → Modules first', 400);
  const b = req.body || {};
  const inv = (await query("SELECT * FROM sale_invoices WHERE id = ? AND firm_id = ?", [b.invoice_id, firmId])).rows[0];
  if (!inv) return res.fail("Choose an invoice", 400);
  if (inv.balance_due <= 0) return res.fail(`${inv.invoice_no} is already settled`, 400);
  const live = (await query("SELECT id FROM installment_plans WHERE invoice_id = ? AND status = 'active'", [inv.id])).rows[0];
  if (live) return res.fail(`${inv.invoice_no} already has a payment plan`, 400);

  /* The plan covers the whole invoice so the timetable and the ledger speak
     about the same number; anything already paid simply settles early rows. */
  const total = r2(inv.grand_total);
  const down = r2(b.down_payment);
  const count = Number(b.count_n) || 0;
  if (!(count > 0)) return res.fail("Choose how many instalments", 400);
  if (count > 120) return res.fail("That is more instalments than this is designed for (max 120)", 400);
  if (down < 0) return res.fail("The down payment cannot be negative", 400);
  if (down >= total) return res.fail("The down payment covers the whole invoice — no plan needed", 400);
  const start = b.start_date || today();

  const lines = buildSchedule({ total, down, count, frequency: b.frequency || "monthly",
    interval: Number(b.interval_n) || 1, start });

  const r = await conn.query(
    `INSERT INTO installment_plans (firm_id, invoice_id, party_id, plan_total, down_payment,
       count_n, frequency, interval_n, start_date, status, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [firmId, inv.id, inv.party_id, total, down, count, b.frequency || "monthly",
     Number(b.interval_n) || 1, start, "active", b.notes || null, req.user.id]
  );
  const id = r.insertId;
  for (const l of lines) {
    await conn.query("INSERT INTO installment_lines (plan_id, seq, due_date, amount, label) VALUES (?,?,?,?,?)",
      [id, l.seq, l.due_date, l.amount, l.label]);
  }
  return () => res.success({ id }, `Payment plan set on ${inv.invoice_no} — ${count} instalment${count === 1 ? "" : "s"}`);
}));

/** Cancel the timetable. The invoice and everything paid against it stay put. */
router.post("/:id/cancel", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const plan = (await conn.query("SELECT * FROM installment_plans WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!plan) return res.notFound("Plan not found");
  await conn.query("UPDATE installment_plans SET status = 'cancelled' WHERE id = ?", [plan.id]);
  return () => res.success({ id: plan.id }, "Plan cancelled — the invoice and its payments are unchanged");
}));

router.delete("/:id", requirePermission("sales", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const plan = (await conn.query("SELECT * FROM installment_plans WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!plan) return res.notFound("Plan not found");
  await conn.query("DELETE FROM installment_lines WHERE plan_id = ?", [plan.id]);
  await conn.query("DELETE FROM installment_plans WHERE id = ?", [plan.id]);
  return () => res.success({ id: plan.id }, "Plan deleted — the invoice and its payments are unchanged");
}));

/** Everything due or overdue, for chasing payments. */
router.get("/due/list", requirePermission("sales", "view"), async (req, res) => {
  const horizon = req.query.upto || today();
  const plans = (await hydrateAll((await query(
    `SELECT ip.*, p.name AS party_name, p.phone FROM installment_plans ip
       JOIN parties p ON p.id = ip.party_id
      WHERE ip.firm_id = ? AND ip.status = 'active'`,
    [req.user.firm_id]
  )).rows)).filter((p) => !p.completed);

  const rows = [];
  for (const p of plans) {
    for (const l of p.lines) {
      if (l.status === "paid" || l.due_date > horizon) continue;
      rows.push({
        plan_id: p.id, invoice_no: p.invoice_no, party_name: p.party_name, phone: p.phone,
        seq: l.seq, label: l.label, due_date: l.due_date, amount: l.amount,
        paid: l.paid, outstanding: l.outstanding, days_late: l.days_late, status: l.status,
      });
    }
  }
  rows.sort((a, b) => a.due_date.localeCompare(b.due_date));
  res.success({ rows, totals: { outstanding: r2(rows.reduce((a, x) => a + x.outstanding, 0)), count: rows.length } });
});

module.exports = router;
module.exports.buildSchedule = buildSchedule;
module.exports.applyPayments = applyPayments;
