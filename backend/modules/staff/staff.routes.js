/* Staff — who is on, what they sold, and what they are owed.
 *
 * Deliberately built only from things the app already records: shifts opened
 * and closed, and documents carrying a sales rep. Nothing here is invented.
 *
 * What is NOT here, and why:
 *   • Clock-in from a phone. There is no phone app. A shift opened at the till
 *     is the only arrival this app can honestly witness, so that is what
 *     attendance is measured from.
 *   • Payroll, PAYE and NSSF. Those need statutory rates and bands that change
 *     by law and by year; guessing at them would produce numbers a shop might
 *     actually file. Commission is computed and shown as owed, and stops there.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/* First and last day of a month, defaulting to this one. */
function monthRange(ym) {
  const base = /^\d{4}-\d{2}$/.test(String(ym || "")) ? `${ym}-01` : `${today().slice(0, 7)}-01`;
  const d = new Date(base);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const p = (n) => String(n).padStart(2, "0");
  return {
    from: `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`,
    to: `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}`,
    label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  };
}

const staffRows = async (firmId) => (await query(
  `SELECT u.id, u.username, u.full_name, u.status, u.commission_pct, u.roster_start, u.roster_end,
          r.name AS role_name
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.active_firm_id = ? ORDER BY u.id`, [firmId])).rows;

/* ── Who is on right now ──────────────────────────────────────────────────
   Hours are counted from the shift itself. An open shift counts up to now,
   which is what "hours today" has to mean while the day is still running. */
router.get("/today", requirePermission("users", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const day = req.query.date || today();
  const grace = Number(await getSetting(firmId, "roster_grace_mins", "10")) || 0;

  const shifts = (await query(
    `SELECT s.*, COALESCE(u.full_name, u.username) AS name, u.roster_start, u.roster_end,
            r.name AS role_name
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE s.firm_id = ? AND date(s.opened_at) = ?
      ORDER BY s.opened_at`, [firmId, day])).rows;

  const now = new Date();
  /* A loop, not .map(): each shift's takings is its own query, so the
     callback would be async and .map() would hand back promises. */
  const rows = [];
  for (const s of shifts) {
    const opened = new Date(String(s.opened_at).replace(" ", "T"));
    const closed = s.closed_at ? new Date(String(s.closed_at).replace(" ", "T")) : null;
    const hours = r2(((closed || now) - opened) / 3600000);

    /* Late only means something against a rostered start. Without one there is
       nothing to be late for, and saying "on time" would be a guess. */
    let lateMins = null;
    if (s.roster_start && /^\d{2}:\d{2}/.test(s.roster_start)) {
      const due = new Date(`${day}T${s.roster_start.slice(0, 5)}:00`);
      const diff = Math.round((opened - due) / 60000);
      lateMins = diff > grace ? diff : 0;
    }

    /* What this person rang up during this shift. */
    const sales = (await query(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total), 0) AS total
         FROM sale_invoices
        WHERE firm_id = ? AND COALESCE(status,'') <> 'voided'
          AND sales_rep_id = ? AND created_at >= ? AND created_at <= ?`,
      [firmId, s.user_id, s.opened_at, s.closed_at || "9999-12-31"])).rows[0] || {};

    rows.push({
      shift_id: s.id, user_id: s.user_id, name: s.name, role_name: s.role_name,
      opened_at: s.opened_at, closed_at: s.closed_at, status: s.status,
      hours, late_mins: lateMins,
      roster: s.roster_start ? `${String(s.roster_start).slice(0, 5)}–${String(s.roster_end || "").slice(0, 5)}` : null,
      bills: +sales.bills || 0, sales: r2(sales.total),
    });
  }

  const open = rows.filter((r) => r.status === "open");
  const hours = r2(rows.reduce((a, r) => a + r.hours, 0));
  const sales = r2(rows.reduce((a, r) => a + r.sales, 0));

  const staff = (await staffRows(firmId)).filter((u) => (u.status || "active") === "active");
  const onIds = new Set(rows.map((r) => r.user_id));

  res.success({
    date: day,
    rows,
    /* Rostered today but no shift opened. Only people with a roster can be
       counted absent — the rest simply have no expectation set. */
    absent: staff.filter((u) => u.roster_start && !onIds.has(u.id))
      .map((u) => ({ id: u.id, name: u.full_name || u.username, roster: String(u.roster_start).slice(0, 5) })),
    totals: {
      on_now: open.length,
      shifts: rows.length,
      hours,
      sales,
      /* The figure the deck puts at the top: what an hour of staff time
         actually brought in. Meaningless with no hours logged, so null. */
      per_hour: hours > 0 ? r2(sales / hours) : null,
      late: rows.filter((r) => r.late_mins > 0).length,
      staff: staff.length,
    },
  });
});

/* ── What each person sold ─────────────────────────────────────────────── */
router.get("/performance", requirePermission("users", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const { from, to, label } = monthRange(req.query.month);

  /* A loop, not .map(): each person's figures are their own queries. */
  const rows = [];
  for (const u of await staffRows(firmId)) {
    const s = (await query(
      `SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total), 0) AS total,
              COALESCE(SUM(discount_total), 0) AS discount
         FROM sale_invoices
        WHERE firm_id = ? AND sales_rep_id = ? AND COALESCE(status,'') <> 'voided'
          AND invoice_date BETWEEN ? AND ?`, [firmId, u.id, from, to])).rows[0] || {};

    /* Returns are attributed to whoever made the original sale, which is the
       only attribution that means anything — the person who handled the
       return did not cause it. */
    const ret = (await query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(sr.grand_total), 0) AS total
         FROM sale_returns sr
         JOIN sale_invoices si ON si.id = sr.invoice_id
        WHERE sr.firm_id = ? AND si.sales_rep_id = ? AND sr.return_date BETWEEN ? AND ?`,
      [firmId, u.id, from, to])).rows[0] || {};

    const hrs = (await query(
      `SELECT COALESCE(SUM((julianday(COALESCE(closed_at, datetime('now'))) - julianday(opened_at)) * 24), 0) AS h
         FROM shifts WHERE firm_id = ? AND user_id = ? AND date(opened_at) BETWEEN ? AND ?`,
      [firmId, u.id, from, to])).rows[0] || {};

    const bills = +s.bills || 0;
    const total = r2(s.total);
    const returned = r2(ret.total);
    const hours = r2(hrs.h);
    rows.push({
      id: u.id, name: u.full_name || u.username, role_name: u.role_name,
      status: u.status || "active",
      bills, sales: total,
      avg_bill: bills > 0 ? r2(total / bills) : 0,
      discount: r2(s.discount),
      returns: +ret.n || 0, returned,
      net: r2(total - returned),
      hours,
      per_hour: hours > 0 ? r2(total / hours) : null,
    });
  }
  rows.sort((a, b) => b.net - a.net);

  const sold = r2(rows.reduce((a, r) => a + r.sales, 0));
  res.success({
    from, to, label, rows,
    totals: {
      sold, returned: r2(rows.reduce((a, r) => a + r.returned, 0)),
      bills: rows.reduce((a, r) => a + r.bills, 0),
      hours: r2(rows.reduce((a, r) => a + r.hours, 0)),
      selling: rows.filter((r) => r.bills > 0).length,
    },
  });
});

/* ── What they are owed ───────────────────────────────────────────────────
   Commission is earned on net sales — what was sold, less what came back.
   Paying on gross would mean a sale that was returned the next day still
   earned commission, which is how a commission scheme gets gamed. */
router.get("/commission", requirePermission("users", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const { from, to, label } = monthRange(req.query.month);
  const fallback = Number(await getSetting(firmId, "commission_default_pct", "0")) || 0;

  /* Active staff only, as the roster endpoint does: someone switched off in
     Settings → Users has left, and keeping them here parks an ex-employee in
     "what they are owed" at Sh 0 for good. */
  /* A loop, not .map(): each person's figures are their own queries. */
  const rows = [];
  for (const u of (await staffRows(firmId)).filter((u) => (u.status || "active") === "active")) {
    const s = (await query(
      `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS bills
         FROM sale_invoices
        WHERE firm_id = ? AND sales_rep_id = ? AND COALESCE(status,'') <> 'voided'
          AND invoice_date BETWEEN ? AND ?`, [firmId, u.id, from, to])).rows[0] || {};
    const ret = (await query(
      `SELECT COALESCE(SUM(sr.grand_total), 0) AS total
         FROM sale_returns sr JOIN sale_invoices si ON si.id = sr.invoice_id
        WHERE sr.firm_id = ? AND si.sales_rep_id = ? AND sr.return_date BETWEEN ? AND ?`,
      [firmId, u.id, from, to])).rows[0] || {};

    const rate = u.commission_pct == null ? fallback : Number(u.commission_pct);
    const sold = r2(s.total);
    const returned = r2(ret.total);
    const net = r2(sold - returned);
    rows.push({
      id: u.id, name: u.full_name || u.username, role_name: u.role_name,
      status: u.status || "active",
      /* Carried so the terms dialog opens showing what is actually set,
         rather than blank fields that would wipe the roster on save. */
      roster_start: u.roster_start ? String(u.roster_start).slice(0, 5) : "",
      roster_end: u.roster_end ? String(u.roster_end).slice(0, 5) : "",
      rate, own_rate: u.commission_pct != null,
      bills: +s.bills || 0, sold, returned, net,
      earned: r2((net * rate) / 100),
      clawback: r2((returned * rate) / 100),
    });
  }
  /* Everyone still on the payroll is listed, including whoever sold nothing and
     whoever is on no commission rate. Dropping them made the table read as the
     staff list minus anyone having a quiet month — a Sales Rep with no
     commission rows simply vanished, which looks like a missing account rather
     than a zero. Sorted by what is owed, then by name so the tail is stable. */
  rows.sort((a, b) => b.earned - a.earned || String(a.name).localeCompare(String(b.name)));

  res.success({
    from, to, label, rows, default_rate: fallback,
    totals: {
      earned: r2(rows.reduce((a, r) => a + r.earned, 0)),
      clawback: r2(rows.reduce((a, r) => a + r.clawback, 0)),
      net: r2(rows.reduce((a, r) => a + r.net, 0)),
      people: rows.filter((r) => r.earned > 0).length,
    },
  });
});

/* Rate and rostered hours for one person. */
router.put("/:id/terms", requirePermission("users", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const u = (await query("SELECT id FROM users WHERE id = ? AND active_firm_id = ?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!u) return res.fail("Staff member not found", 404);

  const sets = [], args = [];
  if ("commission_pct" in b) {
    const v = b.commission_pct === "" || b.commission_pct === null ? null : Number(b.commission_pct);
    if (v !== null && (isNaN(v) || v < 0 || v > 100)) return res.fail("A commission rate is between 0 and 100");
    sets.push("commission_pct = ?"); args.push(v);
  }
  for (const k of ["roster_start", "roster_end"]) {
    if (!(k in b)) continue;
    const v = String(b[k] || "").trim();
    if (v && !/^\d{2}:\d{2}$/.test(v)) return res.fail("Rostered hours look like 08:00");
    sets.push(`${k} = ?`); args.push(v || null);
  }
  if (!sets.length) return res.fail("Nothing to change");
  args.push(req.params.id);
  await conn.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, args);
  return () => res.success({ id: Number(req.params.id) }, "Saved");
}));

module.exports = router;
