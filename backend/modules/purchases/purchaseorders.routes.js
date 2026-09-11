/**
 * purchaseorders.routes.js — what to buy, and from whom.
 *
 * Two halves:
 *  1. Suggestions — how fast each item actually sells, how many days of cover is
 *     left, and how much to order. Grouped by the supplier you last bought from.
 *  2. Purchase orders — a record of what was ordered, so a delivery can be
 *     checked against it and partial deliveries are obvious.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

/**
 * Reorder suggestions.
 *  ?days=  how far back to measure sales (default 30)
 *  ?cover= how many days of stock to hold (default 30)
 */
router.get("/suggestions", requirePermission("purchases", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const days = Math.max(Number(req.query.days) || Number(await getSetting(f, "reorder_lookback_days", "30")) || 30, 1);
  const cover = Math.max(Number(req.query.cover) || Number(await getSetting(f, "reorder_cover_days", "30")) || 30, 1);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = (await query(
    `SELECT i.id, i.name, i.item_code, i.unit, i.reorder_level, i.purchase_price,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS on_hand,
            COALESCE((SELECT SUM(l.quantity) FROM sale_invoice_lines l
                        JOIN sale_invoices v ON v.id = l.invoice_id
                       WHERE l.item_id = i.id AND v.firm_id = i.firm_id
                         AND v.invoice_date >= ? AND v.status != 'voided'), 0) AS sold,
            (SELECT p.party_id FROM purchase_invoice_lines pl
                JOIN purchase_invoices p ON p.id = pl.bill_id
               WHERE pl.item_id = i.id ORDER BY p.id DESC LIMIT 1) AS supplier_id,
            (SELECT pl.rate FROM purchase_invoice_lines pl
                JOIN purchase_invoices p ON p.id = pl.bill_id
               WHERE pl.item_id = i.id ORDER BY p.id DESC LIMIT 1) AS last_rate
       FROM items i
      WHERE i.firm_id = ? AND i.is_inventory = 1 AND i.is_active = 1`,
    [since, f]
  )).rows;

  const out = [];
  for (const r of rows) {
    const perDay = +(Number(r.sold) / days).toFixed(4);
    const onHand = Number(r.on_hand) || 0;
    // days of cover left; no sales at all means we can't judge by velocity
    const daysLeft = perDay > 0 ? Math.floor(onHand / perDay) : null;
    const belowReorder = Number(r.reorder_level) > 0 && onHand <= Number(r.reorder_level);
    const runningOut = daysLeft !== null && daysLeft < cover;
    if (!belowReorder && !runningOut) continue;

    // order enough to cover the target window, topping up to the reorder level at least
    const target = perDay > 0 ? Math.ceil(perDay * cover) : Number(r.reorder_level) || 0;
    const suggested = Math.max(Math.ceil(target - onHand), 0);
    if (suggested <= 0) continue;

    out.push({
      item_id: r.id, name: r.name, item_code: r.item_code, unit: r.unit,
      on_hand: onHand, reorder_level: Number(r.reorder_level) || 0,
      sold_in_period: Number(r.sold), per_day: perDay, days_left: daysLeft,
      suggested_qty: suggested,
      rate: Number(r.last_rate) || Number(r.purchase_price) || 0,
      supplier_id: r.supplier_id || null,
      reason: belowReorder && runningOut ? "below reorder level and running out"
            : belowReorder ? "at or below reorder level"
            : `about ${daysLeft} day(s) of stock left`,
    });
  }

  // group by supplier so each order can go to one person
  const suppliers = {};
  for (const s of out) {
    const key = s.supplier_id || "none";
    if (!suppliers[key]) {
      const p = s.supplier_id ? (await query("SELECT name FROM parties WHERE id=?", [s.supplier_id])).rows[0] : null;
      suppliers[key] = { supplier_id: s.supplier_id, supplier_name: p ? p.name : "No usual supplier", items: [], value: 0 };
    }
    suppliers[key].items.push(s);
    suppliers[key].value = +(suppliers[key].value + s.suggested_qty * s.rate).toFixed(2);
  }
  res.success({ days, cover, groups: Object.values(suppliers), count: out.length });
});

/* Open orders — for the picker on the purchase form */
router.get("/open", requirePermission("purchases", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT o.id, o.po_no, o.party_id, o.order_date, p.name AS party_name
       FROM purchase_orders o LEFT JOIN parties p ON p.id = o.party_id
      WHERE o.firm_id = ? AND o.status IN ('draft','sent','partial')
      ORDER BY o.id DESC LIMIT 50`, [req.user.firm_id])).rows;
  for (const o of rows) {
    o.lines = (await query(
      `SELECT l.item_id, l.quantity, l.rate, COALESCE(l.received_qty,0) AS received_qty, i.name, i.unit
         FROM purchase_order_lines l JOIN items i ON i.id = l.item_id
        WHERE l.po_id = ? AND COALESCE(l.received_qty,0) < l.quantity`, [o.id])).rows;
  }
  res.success(rows.filter((o) => o.lines.length));
});

/* List orders */
router.get("/", requirePermission("purchases", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT o.*, p.name AS party_name,
            (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = o.id) AS line_count,
            (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = o.id AND l.received_qty >= l.quantity) AS done_count
       FROM purchase_orders o LEFT JOIN parties p ON p.id = o.party_id
      WHERE o.firm_id = ? ORDER BY o.id DESC LIMIT 100`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

/* One order with its lines */
router.get("/:id", requirePermission("purchases", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const o = (await query(
    `SELECT o.*, p.name AS party_name, p.phone AS party_phone
       FROM purchase_orders o LEFT JOIN parties p ON p.id = o.party_id
      WHERE o.id = ? AND o.firm_id = ?`, [req.params.id, f])).rows[0];
  if (!o) return res.fail("Order not found", 404);
  o.lines = (await query(
    /* firm_id added to the child fetch. Round nine's audit flagged child rows
       fetched by parent id alone; the parent is scoped above, so this is
       defence in depth rather than a live hole, which is exactly where that
       audit said the predicates belonged. */
    `SELECT l.*, i.name, i.unit, i.item_code FROM purchase_order_lines l
       JOIN items i ON i.id = l.item_id
      WHERE l.po_id = ? AND l.firm_id = ?`, [o.id, f])).rows;
  /* Aliases so this document can be printed by the shared template — see the
     same note in purchases.routes.js. An order line carries the item's `name`
     where a bill line carries a `description`, and has no line total of its
     own, so both are derived rather than left blank on the paper. */
  o.invoice_no = o.po_no;
  o.invoice_date = o.order_date;
  o.lines = o.lines.map((l) => ({
    ...l,
    description: l.description || l.name,
    line_total: l.line_total != null ? l.line_total : (Number(l.quantity) || 0) * (Number(l.rate) || 0),
  }));
  o.sub_total = o.sub_total != null ? o.sub_total : o.lines.reduce((t, l) => t + (Number(l.line_total) || 0), 0);
  o.grand_total = o.total != null ? o.total : o.sub_total;
  /* An order is not money owed yet — nothing has been received and no bill has
     arrived. Printing "Balance due" on it would misstate the position. */
  o.paid_amount = 0;
  o.balance_due = 0;
  o.taxes = [];
  res.success(o);
});

/* Create an order */
/* Header and lines together: an order with no lines cannot be received and
   cannot be explained. */
router.post("/", requirePermission("purchases", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const b = req.body || {};
  const lines = (b.lines || []).filter((l) => l.item_id && Number(l.quantity) > 0);
  if (!lines.length) return res.fail("Add at least one item to order");

  const n = ((await query("SELECT COUNT(*) n FROM purchase_orders WHERE firm_id=?", [f])).rows[0].n || 0) + 1;
  const poNo = "PO-" + String(n).padStart(4, "0");
  const total = +lines.reduce((a, l) => a + Number(l.quantity) * (Number(l.rate) || 0), 0).toFixed(2);

  await conn.query(`INSERT INTO purchase_orders (firm_id, po_no, party_id, order_date, expected_date, status, note, total, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
    [f, poNo, b.party_id || null, b.order_date || new Date().toISOString().slice(0, 10),
     b.expected_date || null, "draft", b.note || null, total, req.user.id]);
  const poId = (await conn.query("SELECT id FROM purchase_orders WHERE firm_id=? AND po_no=?", [f, poNo])).rows[0].id;
  for (const l of lines) {
    await conn.query("INSERT INTO purchase_order_lines (firm_id, po_id, item_id, quantity, rate) VALUES (?,?,?,?,?)",
      [f, poId, l.item_id, Number(l.quantity), Number(l.rate) || 0]);
  }
  return () => res.success({ id: poId, po_no: poNo, total }, `${poNo} created`);
}));

/* Change status: draft → sent → cancelled */
router.put("/:id/status", requirePermission("purchases", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const o = (await conn.query("SELECT * FROM purchase_orders WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!o) return res.fail("Order not found", 404);
  const want = String(req.body.status || "").trim();
  if (!["draft", "sent", "cancelled"].includes(want)) return res.fail("Unknown status");
  if (o.status === "received") return res.fail("This order has already been received in full");
  await conn.query("UPDATE purchase_orders SET status=? WHERE id=?", [want, o.id]);
  return () => res.success({ id: o.id, status: want }, `Marked ${want}`);
}));

/* Record what actually arrived (called after a purchase is saved against this order) */
/* Received quantities and the status they imply move together, or the order
   says "draft" while goods are on the shelf. */
router.post("/:id/receive", requirePermission("purchases", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const o = (await conn.query("SELECT * FROM purchase_orders WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!o) return res.fail("Order not found", 404);
  for (const r of req.body.lines || []) {
    await conn.query("UPDATE purchase_order_lines SET received_qty = ROUND(COALESCE(received_qty,0) + ?, 4) WHERE po_id=? AND item_id=?",
      [Number(r.quantity) || 0, o.id, r.item_id]);
  }
  const open = (await conn.query(
    "SELECT COUNT(*) n FROM purchase_order_lines WHERE po_id=? AND COALESCE(received_qty,0) < quantity", [o.id]
  )).rows[0].n;
  const any = (await conn.query(
    "SELECT COUNT(*) n FROM purchase_order_lines WHERE po_id=? AND COALESCE(received_qty,0) > 0", [o.id]
  )).rows[0].n;
  const status = open === 0 ? "received" : any > 0 ? "partial" : o.status;
  await conn.query("UPDATE purchase_orders SET status=? WHERE id=?", [status, o.id]);
  return () => res.success({ id: o.id, status, outstanding_lines: open },
    status === "received" ? "Order fully received" : `${open} line(s) still outstanding`);
}));

/* Delete a draft */
router.delete("/:id", requirePermission("purchases", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const o = (await conn.query("SELECT * FROM purchase_orders WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!o) return res.fail("Order not found", 404);
  if (["partial", "received"].includes(o.status)) return res.fail("Goods have already been received against this order");
  await conn.query("DELETE FROM purchase_order_lines WHERE po_id=?", [o.id]);
  await conn.query("DELETE FROM purchase_orders WHERE id=?", [o.id]);
  return () => res.success({ id: o.id }, "Order deleted");
}));

module.exports = router;
