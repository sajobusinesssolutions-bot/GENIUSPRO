/**
 * recurring.routes.js — recurring sales & purchases.
 *
 * A recurring document is a saved set of lines plus a schedule. When it falls
 * due the runner replays it through the *real* sale/purchase handler, so every
 * guard, tax rule, stock movement and GL posting is identical to a document
 * keyed by hand. Nothing here re-implements invoicing.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");
const { createSale } = require("../sales/sales.routes");
const { createPurchase } = require("../purchases/purchases.routes");

router.use(verifyToken);

const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());

/**
 * Step a date forward by one period.
 *
 * `anchorDay` is the day-of-month the schedule was agreed on. Without it, a
 * schedule starting on the 31st clamps to the 28th in February and then stays
 * on the 28th forever, quietly walking away from the agreed date. Passing the
 * anchor makes February an exception rather than a permanent change: 31 → 28
 * → back to 31.
 */
function advance(dateStr, frequency, interval = 1, anchorDay = null) {
  const n = Math.max(1, Number(interval) || 1);
  const d = new Date(dateStr + "T00:00:00Z");
  if (frequency === "daily") d.setUTCDate(d.getUTCDate() + n);
  else if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (frequency === "yearly") {
    const day = anchorDay || d.getUTCDate();
    d.setUTCFullYear(d.getUTCFullYear() + n, d.getUTCMonth(), 1);
    d.setUTCDate(Math.min(day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
  } else {
    const day = anchorDay || d.getUTCDate();
    const m = d.getUTCMonth() + n;
    d.setUTCFullYear(d.getUTCFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12, 1);
    d.setUTCDate(Math.min(day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
  }
  return iso(d);
}
const dayOf = (dateStr) => new Date(dateStr + "T00:00:00Z").getUTCDate();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Has this schedule run its course? */
function isFinished(r, nextDate) {
  if (r.end_type === "count") return (r.generated || 0) >= (r.end_count || 0);
  if (r.end_type === "until") return !nextDate || nextDate > r.end_until;
  return false;
}

const linesOf = async (id) =>
  (await query("SELECT item_id, description, quantity, rate, discount_pct FROM recurring_lines WHERE recurring_id = ? ORDER BY id", [id])).rows;

/**
 * Invoke a real route handler outside Express. The shim captures whatever the
 * handler would have sent so the runner can record success or the exact reason
 * a generation was refused (credit limit, stock, inactive item…).
 */
function callHandler(handler, { body, user }) {
  return new Promise((resolve, reject) => {
    const req = { body, user, params: {}, query: {} };
    const res = {
      success: (data, message) => resolve({ ok: true, data, message }),
      fail: (message) => resolve({ ok: false, message }),
      notFound: (message) => resolve({ ok: false, message: message || "Not found" }),
    };
    Promise.resolve(handler(req, res, (err) => reject(err))).catch(reject);
  });
}

/**
 * Generate one document from a schedule. `asUser` carries the firm and the
 * identity the document is created under.
 */
async function generateOne(r, asUser, forDate) {
  const lines = await linesOf(r.id);
  if (!lines.length) return { ok: false, message: "This recurring document has no items" };
  const dateField = r.doc_type === "purchase" ? "bill_date" : "invoice_date";
  const body = {
    party_id: r.party_id,
    payment_type: r.payment_type || "credit",
    sales_rep_id: r.sales_rep_id || asUser.id,
    [dateField]: forDate,
    notes: r.notes || null,
    lines: lines.map((l) => ({
      item_id: l.item_id, description: l.description,
      quantity: l.quantity, rate: l.rate, discount_pct: l.discount_pct || 0,
    })),
  };
  const handler = r.doc_type === "purchase" ? createPurchase : createSale;
  const out = await callHandler(handler, { body, user: asUser });
  const docTable = r.doc_type === "purchase" ? "purchase_invoices" : "sale_invoices";

  if (!out.ok) {
    await query("INSERT INTO recurring_runs (firm_id, recurring_id, run_date, doc_table, status, message) VALUES (?,?,?,?,?,?)",
      [r.firm_id, r.id, forDate, docTable, "failed", out.message]);
    return { ok: false, message: out.message };
  }
  const id = out.data?.id;
  const row = id ? (await query(`SELECT * FROM ${docTable} WHERE id = ?`, [id])).rows[0] : null;
  const no = row ? (row.invoice_no || row.bill_no) : "";
  await query("INSERT INTO recurring_runs (firm_id, recurring_id, run_date, doc_table, doc_id, doc_no, status) VALUES (?,?,?,?,?,?,?)",
    [r.firm_id, r.id, forDate, docTable, id, no, "created"]);
  return { ok: true, doc_id: id, doc_no: no };
}

/**
 * Roll a schedule forward. A schedule that has been left alone for months
 * catches up one document per missed period rather than collapsing them into
 * one, so the books match what was actually agreed. `limit` stops a runaway
 * catch-up on a very old schedule.
 */
async function runSchedule(r, asUser, { upto = today(), limit = 60 } = {}) {
  const results = [];
  let next = r.next_run || r.start_date;
  let generated = r.generated || 0;
  let guard = 0;

  while (next && next <= upto && guard < limit) {
    if (r.end_type === "count" && generated >= (r.end_count || 0)) break;
    if (r.end_type === "until" && r.end_until && next > r.end_until) break;
    guard++;
    const out = await generateOne({ ...r, generated }, asUser, next);
    results.push({ date: next, ...out });
    if (!out.ok) break;               // stop on the first refusal so it can be fixed
    generated++;
    next = advance(next, r.frequency, r.interval_n, dayOf(r.start_date));
  }

  const finished = isFinished({ ...r, generated }, next);
  await query("UPDATE recurring_docs SET next_run = ?, generated = ?, last_run = ?, status = ? WHERE id = ?",
    [finished ? null : next, generated, results.length ? today() : r.last_run,
     finished ? "ended" : r.status, r.id]);
  return results;
}

/* ── Routes ───────────────────────────────────────────────────────────── */

const moduleOn = async (firmId, docType) =>
  await getSetting(firmId, docType === "purchase" ? "mod_recurring_purchases" : "mod_recurring_sales", "0") === "1";

router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const type = req.query.doc_type;
  const rows = (await query(
    `SELECT r.*, p.name AS party_name,
            (SELECT COUNT(*) FROM recurring_lines l WHERE l.recurring_id = r.id) AS line_count,
            COALESCE((SELECT SUM(l.quantity * l.rate * (1 - COALESCE(l.discount_pct,0)/100.0))
                        FROM recurring_lines l WHERE l.recurring_id = r.id), 0) AS amount
       FROM recurring_docs r JOIN parties p ON p.id = r.party_id
      WHERE r.firm_id = ? ${type ? "AND r.doc_type = ?" : ""}
      ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, r.next_run`,
    type ? [req.user.firm_id, type] : [req.user.firm_id]
  )).rows;
  res.success(rows.map((r) => ({ ...r, due: r.status === "active" && r.next_run && r.next_run <= today() })));
});

/* The two figures above the schedule list, and what each schedule is worth.
 *
 * A schedule's amount is the sum of its lines — the same arithmetic the
 * generated document will do, so the figure on the list and the invoice it
 * eventually raises agree. Tax is deliberately left out of the projection:
 * it varies per party and per item, and a projection that is confidently
 * wrong is worse than one that is plainly a subtotal.
 */
router.get("/summary", requirePermission("sales", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const type = req.query.doc_type === "purchase" ? "purchase" : "sale";

  const rows = (await query(
    `SELECT r.id, r.frequency, r.status, r.next_run,
            COALESCE((SELECT SUM(l.quantity * l.rate * (1 - COALESCE(l.discount_pct,0)/100.0))
                        FROM recurring_lines l WHERE l.recurring_id = r.id), 0) AS amount
       FROM recurring_docs r WHERE r.firm_id = ? AND r.doc_type = ?`, [f, type])).rows;

  /* Everything expressed per month so the schedules can be added together —
     a weekly 10,000 and a yearly 500,000 are not otherwise comparable. */
  const perMonth = { daily: 30, weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };
  let projected = 0, dueSoon = 0;
  const monthEnd = new Date(); monthEnd.setMonth(monthEnd.getMonth() + 1); monthEnd.setDate(0);
  const monthEndStr = monthEnd.toISOString().slice(0, 10);
  const todayStr = today();
  let expected = 0;

  for (const r of rows) {
    if (r.status !== "active") continue;
    projected += (+r.amount || 0) * (perMonth[r.frequency] || 1);
    if (r.next_run && r.next_run <= todayStr) dueSoon++;
    /* What is still to come this month: every run left between now and month
       end, not just the next one — a weekly schedule bills four times. */
    if (r.next_run && r.next_run <= monthEndStr) {
      const step = { daily: 1, weekly: 7, monthly: 31, yearly: 366 }[r.frequency] || 31;
      let d = new Date(r.next_run < todayStr ? todayStr : r.next_run);
      while (d.toISOString().slice(0, 10) <= monthEndStr) {
        expected += (+r.amount || 0);
        d = new Date(d.getTime() + step * 86400000);
        if (step > 31) break;
      }
    }
  }

  const history = (await query(
    `SELECT COUNT(*) AS runs FROM recurring_runs rr
       JOIN recurring_docs r ON r.id = rr.recurring_id
      WHERE rr.firm_id = ? AND r.doc_type = ?`, [f, type])).rows[0] || {};

  res.success({
    projectedMonthly: +projected.toFixed(2),
    expectedThisMonth: +expected.toFixed(2),
    dueSoon,
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    runs: +history.runs || 0,
  });
});

/* Everything these schedules have actually raised. */
router.get("/history", requirePermission("sales", "view"), async (req, res) => {
  const type = req.query.doc_type === "purchase" ? "purchase" : "sale";
  const rows = (await query(
    `SELECT rr.*, r.name AS schedule_name, r.doc_type, p.name AS party_name
       FROM recurring_runs rr
       JOIN recurring_docs r ON r.id = rr.recurring_id
       LEFT JOIN parties p ON p.id = r.party_id
      WHERE rr.firm_id = ? AND r.doc_type = ?
      ORDER BY rr.id DESC LIMIT 200`, [req.user.firm_id, type])).rows;
  res.success(rows);
});

router.get("/:id", requirePermission("sales", "view"), async (req, res) => {
  const r = (await query("SELECT * FROM recurring_docs WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!r) return res.notFound("Recurring document not found");
  const runs = (await query("SELECT * FROM recurring_runs WHERE recurring_id = ? ORDER BY id DESC LIMIT 30", [r.id])).rows;
  res.success({ ...r, lines: await linesOf(r.id), runs });
});

/* Schedule and lines are one saved document — a schedule with no lines would
   fire and produce an empty invoice every period. */
router.post("/", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const firmId = req.user.firm_id;
  const docType = b.doc_type === "purchase" ? "purchase" : "sale";
  if (!await moduleOn(firmId, docType)) {
    return res.fail(`Switch on "${docType === "purchase" ? "Recurring purchases" : "Recurring sales"}" in Settings → Modules first`, 400);
  }
  if (!b.name) return res.fail("Give this schedule a name", 400);
  if (!b.party_id) return res.fail(docType === "purchase" ? "Choose a supplier" : "Choose a customer", 400);
  if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);
  const start = b.start_date || today();
  if (b.end_type === "count" && !(Number(b.end_count) > 0)) return res.fail("Enter how many documents to create", 400);
  if (b.end_type === "until" && !b.end_until) return res.fail("Enter the date to stop on", 400);
  if (b.end_type === "until" && b.end_until < start) return res.fail("The stop date is before the start date", 400);

  const r = await conn.query(
    `INSERT INTO recurring_docs (firm_id, name, doc_type, party_id, payment_type, sales_rep_id,
       frequency, interval_n, start_date, next_run, end_type, end_count, end_until,
       auto_generate, status, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [firmId, b.name, docType, b.party_id, b.payment_type || "credit", b.sales_rep_id || null,
     b.frequency || "monthly", Number(b.interval_n) || 1, start, start,
     b.end_type || "never", b.end_count || null, b.end_until || null,
     b.auto_generate === false ? 0 : 1, b.status === "paused" ? "paused" : "active", b.notes || null, req.user.id]
  );
  const id = r.insertId;
  for (const l of b.lines) {
    await conn.query("INSERT INTO recurring_lines (recurring_id, item_id, description, quantity, rate, discount_pct) VALUES (?,?,?,?,?,?)",
      [id, l.item_id || null, l.description || "", Number(l.quantity) || 1, Number(l.rate) || 0, Number(l.discount_pct) || 0]);
  }
  return () => res.success({ id }, `"${b.name}" saved — first document due ${start}`);
}));

/* Same reason as create: rewriting the lines is a delete plus inserts, and
   half of that is a schedule that bills the wrong thing. */
router.put("/:id", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const r = (await conn.query("SELECT * FROM recurring_docs WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!r) return res.notFound("Recurring document not found");
  const b = req.body || {};
  await conn.query(
    `UPDATE recurring_docs SET name = COALESCE(?, name), party_id = COALESCE(?, party_id),
       payment_type = COALESCE(?, payment_type), sales_rep_id = COALESCE(?, sales_rep_id),
       frequency = COALESCE(?, frequency), interval_n = COALESCE(?, interval_n),
       end_type = COALESCE(?, end_type), end_count = ?, end_until = ?,
       auto_generate = COALESCE(?, auto_generate), notes = ?, next_run = COALESCE(?, next_run)
     WHERE id = ?`,
    [b.name || null, b.party_id || null, b.payment_type || null, b.sales_rep_id || null,
     b.frequency || null, b.interval_n || null, b.end_type || null,
     b.end_count ?? r.end_count, b.end_until ?? r.end_until,
     b.auto_generate == null ? null : (b.auto_generate ? 1 : 0), b.notes ?? r.notes,
     b.next_run || null, r.id]
  );
  if (Array.isArray(b.lines)) {
    await conn.query("DELETE FROM recurring_lines WHERE recurring_id = ?", [r.id]);
    for (const l of b.lines) {
      await conn.query("INSERT INTO recurring_lines (recurring_id, item_id, description, quantity, rate, discount_pct) VALUES (?,?,?,?,?,?)",
        [r.id, l.item_id || null, l.description || "", Number(l.quantity) || 1, Number(l.rate) || 0, Number(l.discount_pct) || 0]);
    }
  }
  return () => res.success({ id: r.id }, "Schedule updated");
}));

/** Pause / resume / end without losing the schedule or its history. */
router.post("/:id/status", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const r = (await conn.query("SELECT * FROM recurring_docs WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!r) return res.notFound("Recurring document not found");
  const want = ["active", "paused", "ended"].includes(req.body?.status) ? req.body.status : null;
  if (!want) return res.fail("Status must be active, paused or ended", 400);
  /* Resuming a schedule whose date has passed picks up from today rather than
     firing every missed period at once. */
  const nextRun = want === "active" && (!r.next_run || r.next_run < today()) ? today() : r.next_run;
  await conn.query("UPDATE recurring_docs SET status = ?, next_run = ? WHERE id = ?", [want, want === "ended" ? null : nextRun, r.id]);
  return () => res.success({ id: r.id, status: want }, `Schedule ${want === "active" ? "resumed" : want}`);
}));

router.delete("/:id", requirePermission("sales", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const r = (await conn.query("SELECT * FROM recurring_docs WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!r) return res.notFound("Recurring document not found");
  await conn.query("DELETE FROM recurring_lines WHERE recurring_id = ?", [r.id]);
  await conn.query("DELETE FROM recurring_docs WHERE id = ?", [r.id]);
  return () => res.success({ id: r.id }, `"${r.name}" deleted — documents it already created are untouched`);
}));

/** Generate this schedule's due documents now. */
router.post("/:id/run", requirePermission("sales", "create"), async (req, res, next) => {
  try {
    const r = (await query("SELECT * FROM recurring_docs WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
    if (!r) return res.notFound("Recurring document not found");
    if (r.status === "ended") return res.fail("This schedule has already finished", 400);
    const results = await runSchedule(r, req.user, { upto: req.body?.upto || today() });
    const made = results.filter((x) => x.ok);
    const failed = results.find((x) => !x.ok);
    if (!results.length) return res.success({ created: [] }, `Nothing due yet — next is ${r.next_run}`);
    res.success({ created: made, failed: failed || null },
      failed
        ? `${made.length} created, then stopped: ${failed.message}`
        : `${made.length} document${made.length === 1 ? "" : "s"} created`);
  } catch (e) { next(e); }
});

/** Run every schedule that is due — used by the "Run all due" button. */
router.post("/run-due", requirePermission("sales", "create"), async (req, res, next) => {
  try {
    const rows = (await query(
      "SELECT * FROM recurring_docs WHERE firm_id = ? AND status = 'active' AND auto_generate = 1 AND next_run IS NOT NULL AND next_run <= ?",
      [req.user.firm_id, today()]
    )).rows;
    let created = 0;
    const problems = [];
    for (const r of rows) {
      const out = await runSchedule(r, req.user);
      created += out.filter((x) => x.ok).length;
      const bad = out.find((x) => !x.ok);
      if (bad) problems.push({ name: r.name, message: bad.message });
    }
    res.success({ schedules: rows.length, created, problems },
      rows.length === 0 ? "Nothing is due today"
        : `${created} document${created === 1 ? "" : "s"} created from ${rows.length} schedule${rows.length === 1 ? "" : "s"}` +
          (problems.length ? ` · ${problems.length} needs attention` : ""));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.advance = advance;
module.exports.dayOf = dayOf;
module.exports.runSchedule = runSchedule;
