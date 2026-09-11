/**
 * repacks.routes.js — turning one item into another.
 *
 * The everyday case: buy a 50kg sack, sell it as 1kg bags. One SKU is consumed
 * and a different SKU is produced, and the cost has to travel with the goods —
 * otherwise the bags look free and the margin on them is nonsense.
 *
 * Inventory value is preserved: what leaves the sack arrives in the bags. Any
 * extra cost of doing the work (labour, packaging) can be added and is paid in
 * cash, increasing the value of what's produced.
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { postMovement } = require("../../shared/stock.poster");
const { postJournal, round2 } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");

router.use(verifyToken);

/* History */
router.get("/", requirePermission("items", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT r.*, a.name AS from_name, a.unit AS from_unit, b.name AS to_name, b.unit AS to_unit,
            (SELECT username FROM users WHERE id = r.created_by) AS who
       FROM repacks r
       JOIN items a ON a.id = r.from_item_id
       JOIN items b ON b.id = r.to_item_id
      WHERE r.firm_id = ? ORDER BY r.id DESC LIMIT 100`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

/* What one unit of the source currently costs — so the form can show the maths live */
router.get("/cost/:itemId", requirePermission("items", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const it = (await query("SELECT id, name, unit, purchase_price FROM items WHERE id=? AND firm_id=?", [req.params.itemId, f])).rows[0];
  if (!it) return res.notFound("Item not found");
  const s = (await query(
    `SELECT COALESCE(SUM(quantity),0) qty,
            COALESCE(AVG(NULLIF(avg_cost,0)),0) avg_cost
       FROM item_stock WHERE firm_id=? AND item_id=?`, [f, req.params.itemId])).rows[0];
  res.success({
    item: it,
    on_hand: +Number(s.qty).toFixed(3),
    unit_cost: +(Number(s.avg_cost) || Number(it.purchase_price) || 0).toFixed(4),
  });
});

/* Do the repack */
router.post("/", requirePermission("items", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = req.user.firm_id;
    const b = req.body || {};
    const fromQty = Number(b.from_qty) || 0;
    const toQty = Number(b.to_qty) || 0;
    if (!b.from_item_id || !b.to_item_id) { conn.release(); return res.fail("Choose what you're breaking down and what you're making"); }
    if (String(b.from_item_id) === String(b.to_item_id)) { conn.release(); return res.fail("Those are the same item"); }
    if (fromQty <= 0 || toQty <= 0) { conn.release(); return res.fail("Enter both quantities"); }

    const from = (await conn.query("SELECT * FROM items WHERE id=? AND firm_id=?", [b.from_item_id, f])).rows[0];
    const to = (await conn.query("SELECT * FROM items WHERE id=? AND firm_id=?", [b.to_item_id, f])).rows[0];
    if (!from || !to) { conn.release(); return res.fail("Item not found", 404); }

    const onHand = (await conn.query("SELECT COALESCE(SUM(quantity),0) v FROM item_stock WHERE firm_id=? AND item_id=?", [f, from.id])).rows[0].v;
    if (Number(onHand) < fromQty) {
      conn.release();
      return res.fail(`Only ${onHand} ${from.unit} of "${from.name}" in stock`);
    }

    // cost travels with the goods
    const src = (await conn.query(
      "SELECT COALESCE(AVG(NULLIF(avg_cost,0)),0) c FROM item_stock WHERE firm_id=? AND item_id=?", [f, from.id])).rows[0];
    const unitIn = Number(src.c) || Number(from.purchase_price) || 0;
    const costConsumed = round2(fromQty * unitIn);
    const extra = round2(Number(b.extra_cost) || 0);
    const unitOut = +((costConsumed + extra) / toQty).toFixed(4);

    const ref = "RPK-" + String(((await conn.query("SELECT COUNT(*) n FROM repacks WHERE firm_id=?", [f])).rows[0].n || 0) + 1).padStart(4, "0");

    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO repacks (firm_id, reference, from_item_id, from_qty, to_item_id, to_qty, cost_consumed, extra_cost, unit_cost_out, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [f, ref, from.id, fromQty, to.id, toQty, costConsumed, extra, unitOut, b.note || null, req.user.id]);
    const repackId = (await conn.query("SELECT id FROM repacks WHERE firm_id=? AND reference=?", [f, ref])).rows[0].id;

    await postMovement(conn, { firmId: f, itemId: from.id, direction: "out", quantity: fromQty,
      unitCost: unitIn, sourceModule: "repack", sourceId: repackId, userId: req.user.id });
    await postMovement(conn, { firmId: f, itemId: to.id, direction: "in", quantity: toQty,
      unitCost: unitOut, sourceModule: "repack", sourceId: repackId, userId: req.user.id });

    // Value simply moves within Inventory, so no entry is needed for the swap itself.
    // Extra work costs money, though — that raises the value of what's on the shelf.
    if (extra > 0.004) {
      await postJournal(conn, {
        firmId: f, date: new Date().toISOString().slice(0, 10),
        description: `Repacking cost — ${ref}`, reference: ref,
        sourceModule: "repack", sourceId: repackId, userId: req.user.id,
        lines: [
          { account_code: CODES.STOCK, debit: extra, narration: `${to.name} packing` },
          { account_code: b.cash_account_code || CODES.CASH, credit: extra },
        ],
      });
    }
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", "repack", repackId, `${fromQty} ${from.unit} ${from.name} → ${toQty} ${to.unit} ${to.name}`]);

    await conn.commit();
    res.success({ id: repackId, reference: ref, cost_consumed: costConsumed, extra_cost: extra, unit_cost_out: unitOut },
      `${ref}: ${fromQty} ${from.unit} → ${toQty} ${to.unit} at Sh ${unitOut.toFixed(2)} each`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
