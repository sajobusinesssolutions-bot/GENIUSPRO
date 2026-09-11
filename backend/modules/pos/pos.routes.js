/** pos.routes.js — held/parked bills (resume, lock) + void audit log. */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");

router.use(verifyToken);

/**
 * durable(fn) — run a write and have it on disk before we answer.
 *
 * Plain `query()` schedules the save for the end of the event-loop turn, which
 * is after the reply has gone out. That is fine for a preference; it is not
 * fine for the two things in this file, both of which are money the shop is
 * counting: a held bill is an order a customer is standing over, and the void
 * log is what the Z-report subtracts from the day's takings. Measured before
 * this: a held bill acknowledged and then SIGKILLed lost 10 of 10.
 *
 * commit() saves synchronously, so wrapping the write in a transaction is the
 * whole fix — and it takes the storage layer's write lock, so the read and the
 * write inside it cannot be split by another till.
 *
 * It now lives in shared/durable.js: the same problem turned out to apply to
 * every ordinary write in the tree, and one idiom is better than twenty copies.
 */
const { durable, refuse } = require("../../shared/durable");

/* How long one till's claim on a held bill keeps the others off it. A resume is
   a GET followed straight away by a DELETE, so a live claim normally lasts
   milliseconds; this only matters when the second half never arrives — a till
   that crashed or lost the network between the two. Long enough that the same
   cashier is never fought by their own retry, short enough that a bill is not
   stranded for the rest of the shift. */
const CLAIM_TTL_SECONDS = 90;

/* held_sales predates the claim, so the columns are added on first use — the
   same approach, and for the same reason, as ensureIdempotencyKeys() in
   modules/sales/idempotency.js: setup.js is owned elsewhere and does not know
   about them yet. Moving this into setup() is the tidier home and changes
   nothing else. */
let claimColumnsReady = false;
async function ensureClaimColumns() {
  if (claimColumnsReady) return;
  const cols = (await query("PRAGMA table_info(held_sales)")).rows.map((c) => c.name);
  if (!cols.includes("claimed_by")) await query("ALTER TABLE held_sales ADD COLUMN claimed_by INTEGER");
  if (!cols.includes("claimed_at")) await query("ALTER TABLE held_sales ADD COLUMN claimed_at TEXT");
  if (!cols.includes("claimed_client")) await query("ALTER TABLE held_sales ADD COLUMN claimed_client TEXT");
  claimColumnsReady = true;
}

/* ── which till, not which login ─────────────────────────────────────────────
 *
 * The claim below lets the same user re-claim a bill they already hold, so a
 * till retrying its own resume does not fight itself. A shop that signs both
 * counters in as one account therefore had no guard at all: two browsers, one
 * user id, both claims succeed, and table 4 is rung up twice.
 *
 * A user id does not identify a till. A per-browser identifier does, and the
 * browser is the only thing that can mint one. So the claim is keyed on the
 * pair (user, client): a retry from the same browser still wins, a second
 * browser on the same login now loses with the ordinary 409.
 *
 * Absent header = an old client that has not been taught to send one. It keeps
 * the previous behaviour (same user may re-claim) rather than being locked out
 * of its own bills — a till that cannot resume is worse than a till that can
 * double-resume, and the shop can only have the second problem if it was
 * already sharing a login. Once every client sends the header the pair is
 * always complete and the hole is shut.
 */
function clientId(req) {
  const raw = req.headers["x-client-id"];
  const v = String(Array.isArray(raw) ? raw[0] : raw || "").trim();
  /* Bounded and stored as-is; it is an opaque token, never interpolated into
     SQL and never shown to anyone. */
  return v ? v.slice(0, 64) : null;
}

/* The administrator drawer on the till bar: drawer movements, the credit
   queue, and today's sales. */
require("./admin.routes").attach(router, requirePermission);

router.get("/held", requirePermission("sales", "view"), async (req, res) => {
  await ensureClaimColumns();
  res.success((await query(
    `SELECT h.id, h.label, h.total_hint, h.locked, h.created_at, h.claimed_by, h.claimed_at,
            u.full_name AS held_by, c.full_name AS claimed_by_name
       FROM held_sales h
       LEFT JOIN users u ON u.id = h.created_by
       LEFT JOIN users c ON c.id = h.claimed_by
      WHERE h.firm_id = ? ORDER BY h.id DESC`, [req.user.firm_id])).rows);
});

/**
 * Resume a held bill — a claim, not a read.
 *
 * The till resumes in two steps: GET the payload, then DELETE the row. Two
 * tills that pressed the same bill at the same moment both got the payload and
 * both got "Held bill removed" back, so table 4's order was rung up twice and
 * neither cashier was told. The delete is not the guard: by the time it runs
 * both tills already have the lines on screen.
 *
 * So the claim happens here, in the one statement that reads it. The UPDATE is
 * the test — it matches only a bill nobody currently holds (or one this same
 * user already holds, so a retry is not a fight with itself, or one whose claim
 * has gone stale), and `changes` says whether we won. A GET that changes
 * something is not usually right, but this GET *is* the resume: making it
 * honest about that is better than a guard that cannot work.
 */
router.get("/held/:id", requirePermission("sales", "view"), async (req, res, next) => {
  await ensureClaimColumns();
  return await durable(next, async (conn) => {
    const h = (await conn.query("SELECT * FROM held_sales WHERE id = ? AND firm_id = ?",
      [req.params.id, req.user.firm_id])).rows[0];
    if (!h) throw refuse(() => res.notFound("Held bill not found"));
    if (h.locked) throw refuse(() => res.fail("This bill is locked — unlock it first", 403));

    const cid = clientId(req);
    const claimed = await conn.query(
      `UPDATE held_sales SET claimed_by = ?, claimed_at = datetime('now'), claimed_client = ?
        WHERE id = ? AND firm_id = ?
          AND (claimed_by IS NULL
               OR claimed_at IS NULL
               OR claimed_at < datetime('now', ?)
               OR (claimed_by = ?
                   AND (? IS NULL OR claimed_client IS NULL OR claimed_client = ?)))`,
      [req.user.id, cid, h.id, req.user.firm_id,
       `-${CLAIM_TTL_SECONDS} seconds`, req.user.id, cid, cid]);
    if (!claimed.changes) {
      const who = (await conn.query("SELECT COALESCE(u.full_name, u.username) AS n, h.claimed_by AS uid FROM held_sales h LEFT JOIN users u ON u.id = h.claimed_by WHERE h.id = ?", [h.id])).rows[0];
      /* Same login on another counter: naming the user would read as "you are
         already resuming this", which is exactly the confusion that let the
         bill be rung up twice. Say it is another till. */
      const sameUser = who && Number(who.uid) === Number(req.user.id);
      throw refuse(() => res.fail(
        sameUser
          ? "Another till signed in as this user is already resuming this bill"
          : `${who && who.n ? who.n : "Another till"} is already resuming this bill`, 409));
    }
    h.payload = JSON.parse(h.payload);
    h.claimed_by = req.user.id;
    h.claimed_client = cid;
    return () => res.success(h);
  });
});

router.post("/held", requirePermission("sales", "create"), async (req, res, next) => {
  const b = req.body || {};
  if (!b.payload) return res.fail("Nothing to hold");
  return await durable(next, async (conn) => {
    await conn.query("INSERT INTO held_sales (firm_id, label, payload, total_hint, created_by) VALUES (?,?,?,?,?)",
      [req.user.firm_id, b.label || null, JSON.stringify(b.payload), Number(b.total_hint) || 0, req.user.id]);
    return () => res.success({ ok: true }, "Bill held");
  });
});

router.put("/held/:id/lock", requirePermission("sales", "edit"), async (req, res, next) => {
  const want = (req.body || {}).locked ? 1 : 0;
  return await durable(next, async (conn) => {
    await conn.query("UPDATE held_sales SET locked = ? WHERE id = ? AND firm_id = ?",
      [want, req.params.id, req.user.firm_id]);
    return () => res.success({ ok: true }, want ? "Bill locked" : "Bill unlocked");
  });
});

router.delete("/held/:id", requirePermission("sales", "create"), async (req, res, next) => {
  return await durable(next, async (conn) => {
    const h = (await conn.query("SELECT locked FROM held_sales WHERE id = ? AND firm_id = ?",
      [req.params.id, req.user.firm_id])).rows[0];
    if (h && h.locked) throw refuse(() => res.fail("Locked bill — unlock before removing", 403));
    const r = await conn.query("DELETE FROM held_sales WHERE id = ? AND firm_id = ?",
      [req.params.id, req.user.firm_id]);
    /* Nothing removed means somebody else got there first. Saying "removed"
       either way is how a bill could be resumed twice and read as normal. */
    if (!r.changes) throw refuse(() => res.fail("That bill has already been resumed or removed", 404));
    return () => res.success({ ok: true }, "Held bill removed");
  });
});

/* Void audit trail.
   Idempotent on client_ref, the same as sales and refunds. The X/Z report
   subtracts voids from the day's takings, so a retry that logged the same void
   twice would understate the cash the till should be holding by the value of
   the bill — and an audit trail that records an event that happened once as
   having happened twice is worse than no audit trail. A repeat of a reference
   already recorded gets the original row back with 200 and writes nothing.
   See modules/sales/idempotency.js for the contract. */
const { ensureKeys, clientRef, findByRef, isDuplicateRef } = require("../sales/idempotency");

router.post("/void", requirePermission("sales", "create"), async (req, res, next) => {
  const b = req.body || {};
  const { getSetting } = require("../settings/settings.service");
  await ensureKeys();
  const ref = clientRef(req);
  if (ref) {
    const prior = await findByRef("void_log", req.user.firm_id, ref);
    if (prior) return res.success({ ok: true, id: prior.id, duplicate: true }, "Void recorded");
  }
  if (await getSetting(req.user.firm_id, "require_void_reason", "1") === "1" && !b.reason) {
    return res.fail("A void reason is required by Settings", 400);
  }
  /* Committed rather than left to the end-of-turn save: this row is what the
     Z-report subtracts from the takings, so losing it to a power cut hands the
     cashier a till that is short by the value of the void with nothing on
     paper to explain it. */
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await conn.query(
      "INSERT INTO void_log (firm_id, user_id, scope, item_name, quantity, amount, reason, client_ref) VALUES (?,?,?,?,?,?,?,?)",
      [req.user.firm_id, req.user.id, b.scope === "bill" ? "bill" : "item",
       b.item_name || null, Number(b.quantity) || 0, Number(b.amount) || 0, b.reason || null, ref]);
    await conn.commit();
    return res.success({ ok: true, id: r.insertId }, "Void recorded");
  } catch (err) {
    await conn.rollback();
    if (!(ref && isDuplicateRef(err))) return next(err);
    const prior = await findByRef("void_log", req.user.firm_id, ref);
    return res.success({ ok: true, id: prior && prior.id, duplicate: true }, "Void recorded");
  } finally { conn.release(); }
});

/* ═══ End of day: preview, commit to history, list history ═══ */
async function computeDay(firmId, day, onlyUserId) {
  // Aronium semantics: X/Z cover everything SINCE THE LAST CLOSE (else start of day)
  const last = (await query(
    "SELECT created_at, totals_json FROM day_closes WHERE firm_id = ? ORDER BY id DESC LIMIT 1", [firmId])).rows[0];
  const since = last ? last.created_at : `${day} 00:00:00`;
  let lastDoc = null, lastPay = 0;
  if (last) { try { const t = JSON.parse(last.totals_json);
    if (t.to_doc && t.to_doc !== "—") lastDoc = t.to_doc;
    if (t.last_payment_id) lastPay = Number(t.last_payment_id) || 0;
  } catch {} }
  const docCut = lastDoc ? ` AND s.invoice_no > '${lastDoc.replace(/'/g, "")}'` : "";
  const uf = onlyUserId ? " AND s.created_by = " + Number(onlyUserId) : "";
  const ufp = onlyUserId ? " AND p.created_by = " + Number(onlyUserId) : "";

  const win = `s.firm_id = ${Number(firmId)} AND s.invoice_date = ? AND (datetime(s.created_at) > datetime(?)${docCut ? ` OR 1=1` : ``})${docCut}${uf}`;
  const sales = (await query(`SELECT COUNT(*) AS bills, COALESCE(SUM(grand_total),0) AS total,
      COALESCE(SUM(balance_due),0) AS unpaid, COALESCE(SUM(tax_total),0) AS tax,
      MIN(invoice_no) AS from_doc, MAX(invoice_no) AS to_doc
      FROM sale_invoices s WHERE ${win}`, [day, since])).rows[0];
  const byMode = (await query(
    `SELECT p.mode, COUNT(*) AS bills, SUM(p.amount) AS total
       FROM payments p WHERE p.firm_id = ? AND p.direction = 'in' AND p.payment_date = ?
        AND p.id > ${lastPay} AND datetime(p.created_at) >= datetime(?)${ufp}
      GROUP BY p.mode ORDER BY total DESC`, [firmId, day, since])).rows;
  const creditOut = (await query(`SELECT COUNT(*) AS bills, COALESCE(SUM(balance_due),0) AS total
      FROM sale_invoices s WHERE ${win} AND balance_due > 0`, [day, since])).rows[0];
  if (creditOut.total > 0) byMode.push({ mode: "credit (unpaid)", bills: creditOut.bills, total: creditOut.total });
  const sellers = (await query(
    `SELECT s.created_by AS uid, COALESCE(u.full_name,'Unknown') AS user, COUNT(*) AS bills, SUM(s.grand_total) AS total
       FROM sale_invoices s LEFT JOIN users u ON u.id = s.created_by
      WHERE ${win} GROUP BY s.created_by ORDER BY total DESC`, [day, since])).rows;
  /* A loop, not .map(): the tender breakdown per person is its own query, so
     the callback would be async and .map() would hand back promises. */
  const byUser = [];
  for (const u of sellers) {
    const modes = (await query(
      `SELECT p.mode, SUM(p.amount) AS total FROM payments p
        WHERE p.firm_id = ? AND p.direction = 'in' AND p.payment_date = ?
          AND datetime(p.created_at) > datetime(?) AND p.created_by = ?
        GROUP BY p.mode ORDER BY total DESC`, [firmId, day, since, u.uid])).rows
      .map((m) => ({ mode: m.mode, total: +m.total.toFixed(2) }));
    byUser.push({ ...u, total: +u.total.toFixed(2), modes });
  }
  const discounts = (await query(
    `SELECT COALESCE(SUM(l.discount_amt),0) AS total
       FROM sale_invoice_lines l JOIN sale_invoices s ON s.id = l.invoice_id
      WHERE ${win}`, [day, since])).rows[0];
  const items = (await query(
    `SELECT COALESCE(i.name, l.description) AS name,
            COALESCE((SELECT name FROM item_categories c WHERE c.id = i.category_id), 'Products') AS grp,
            SUM(l.quantity) AS qty
       FROM sale_invoice_lines l
       JOIN sale_invoices s ON s.id = l.invoice_id
       LEFT JOIN items i ON i.id = l.item_id
      WHERE ${win} GROUP BY name ORDER BY qty DESC`, [day, since])).rows;
  const groups = {};
  items.forEach((it) => { groups[it.grp] = (groups[it.grp] || 0) + it.qty; });
  const refunds = (await query(`SELECT COUNT(*) AS n, COALESCE(SUM(grand_total),0) AS total FROM sale_returns WHERE firm_id = ? AND return_date = ? AND datetime(created_at) > datetime(?)`, [firmId, day, since])).rows[0];
  const voids = (await query(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM void_log WHERE firm_id = ? AND date(created_at) = ? AND datetime(created_at) > datetime(?)`, [firmId, day, since])).rows[0];
  const received = byMode.filter((m) => m.mode !== "credit (unpaid)").reduce((a, m) => a + m.total, 0);
  const reportNo = ((await query("SELECT COUNT(*) AS n FROM day_closes WHERE firm_id = ?", [firmId])).rows[0].n || 0) + 1;
  const tax = +sales.tax.toFixed(2);
  const lastPaymentId = (await query(
    `SELECT COALESCE(MAX(id),?) AS m FROM payments WHERE firm_id = ? AND direction='in' AND payment_date = ? AND id > ?`,
    [lastPay, firmId, day, lastPay])).rows[0].m;
  return {
    date: day, since, report_no: reportNo, last_payment_id: lastPaymentId,
    from_doc: sales.from_doc || "—", to_doc: sales.to_doc || "—",
    rows: byMode.map((m) => ({ ...m, total: +m.total.toFixed(2) })),
    by_user: byUser,
    items: items.map((i) => ({ name: i.name, qty: +i.qty })),
    groups: Object.entries(groups).map(([name, qty]) => ({ name, qty: +qty })),
    totals: {
      bills: sales.bills, gross: +sales.total.toFixed(2), unpaid: +sales.unpaid.toFixed(2),
      received: +received.toFixed(2), discounts: +discounts.total.toFixed(2),
      tax, taxable: +(sales.total - tax).toFixed(2),
      refunds: refunds.n, refund_total: +refunds.total.toFixed(2),
      voids: voids.n, void_total: +voids.total.toFixed(2),
      net: +(sales.total - refunds.total).toFixed(2),
    },
  };
}

router.get("/day-close/preview", async (req, res) => {
  const day = req.query.date || new Date().toISOString().slice(0, 10);
  const only = req.query.scope === "cashout" ? req.user.id : null;
  res.success(await computeDay(req.user.firm_id, day, only));
});

/* A close is the line the next X/Z report counts from. Lose it to a power cut
   after the cashier has been shown the totals and banked the cash, and the
   following report re-counts the whole day. */
router.post("/day-close", async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const scope = ["cashout", "cashout_all", "close_register"].includes(b.scope) ? b.scope : "cashout_all";
  const day = b.date || new Date().toISOString().slice(0, 10);
  const data = await computeDay(req.user.firm_id, day, scope === "cashout" ? req.user.id : null);
  const r = await conn.query(
    "INSERT INTO day_closes (firm_id, close_date, scope, user_id, totals_json) VALUES (?,?,?,?,?)",
    [req.user.firm_id, day, scope, req.user.id, JSON.stringify(data)]);
  return () => res.success({ id: r.insertId, ...data, scope }, "Day close saved to history");
}));

/* Every close ever taken, each with its full totals. That is management data,
   not till data — the same shape as GET /api/shifts, which is gated the same
   way. A cashier keeps the X report and can still close the register; what
   they no longer get is the whole book of past takings. */
router.get("/day-close/history", requirePermission("reports", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT dc.id, dc.close_date, dc.scope, dc.created_at, COALESCE(u.full_name, 'Unknown') AS by_user, dc.totals_json
       FROM day_closes dc LEFT JOIN users u ON u.id = dc.user_id
      WHERE dc.firm_id = ? ORDER BY dc.id DESC LIMIT 120`, [req.user.firm_id])).rows
    .map((r) => {
      const t = JSON.parse(r.totals_json);
      return { id: r.id, close_date: r.close_date, scope: r.scope, created_at: r.created_at,
               by_user: r.by_user, net: t.totals.net, gross: t.totals.gross, data: t };
    });
  res.success(rows);
});

/* Live sync for shops running more than one till.
   The server already refuses to oversell, but a second till would show stale
   stock until checkout failed. Polling this keeps every screen honest. */
router.get("/sync", requirePermission("sales", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const stock = (await query(
    `SELECT i.id, COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS on_hand
       FROM items i WHERE i.firm_id = ? AND i.is_inventory = 1 AND i.is_active = 1`,
    [f]
  )).rows;
  const held = (await query("SELECT COUNT(*) n FROM held_sales WHERE firm_id = ?", [f])).rows[0].n;
  const lastSale = (await query(
    "SELECT invoice_no, created_at FROM sale_invoices WHERE firm_id = ? ORDER BY id DESC LIMIT 1", [f]
  )).rows[0] || null;
  res.success({ stock, held, last_sale: lastSale, at: new Date().toISOString() });
});

module.exports = router;
