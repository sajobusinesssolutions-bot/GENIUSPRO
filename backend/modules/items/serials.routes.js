/**
 * serials.routes.js — serial / IMEI tracking.
 *
 * For items where each unit is individually identifiable (phones, TVs, generators).
 * A serial is received against a purchase, sits in stock, then leaves against a
 * sale — so "when did we sell this IMEI, and to whom?" has an answer when someone
 * walks in with a warranty claim.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");

router.use(verifyToken);

/* Serials available to sell for one item */
router.get("/available/:itemId", requirePermission("items", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT id, serial, received_at FROM item_serials
      WHERE firm_id = ? AND item_id = ? AND status = 'in_stock' ORDER BY id`,
    [req.user.firm_id, req.params.itemId]
  )).rows;
  res.success(rows);
});

/* Everything recorded for one item */
router.get("/item/:itemId", requirePermission("items", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const rows = (await query(
    `SELECT s.*, p.name AS party_name,
            (SELECT invoice_no FROM sale_invoices v WHERE v.id = s.sale_id) AS invoice_no,
            (SELECT bill_no FROM purchase_invoices b WHERE b.id = s.purchase_id) AS bill_no
       FROM item_serials s LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.item_id = ? ORDER BY s.status, s.id DESC LIMIT 500`,
    [f, req.params.itemId]
  )).rows;
  const counts = (await query(
    `SELECT status, COUNT(*) n FROM item_serials WHERE firm_id=? AND item_id=? GROUP BY status`,
    [f, req.params.itemId]
  )).rows.reduce((m, r) => ({ ...m, [r.status]: r.n }), {});
  res.success({ rows, counts });
});

/* Warranty lookup — find one unit's whole history */
router.get("/lookup", requirePermission("items", "view"), async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 3) return res.fail("Enter at least 3 characters of the serial");
  const rows = (await query(
    `SELECT s.*, i.name AS item_name, i.unit, p.name AS party_name, p.phone AS party_phone,
            (SELECT invoice_no FROM sale_invoices v WHERE v.id = s.sale_id) AS invoice_no,
            (SELECT invoice_date FROM sale_invoices v WHERE v.id = s.sale_id) AS sold_date,
            (SELECT bill_no FROM purchase_invoices b WHERE b.id = s.purchase_id) AS bill_no
       FROM item_serials s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.serial LIKE ? ORDER BY s.id DESC LIMIT 25`,
    [req.user.firm_id, `%${q}%`]
  )).rows;
  res.success(rows);
});

/* Record serials that arrived (called after a purchase is saved) */
router.post("/receive", requirePermission("purchases", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const b = req.body || {};
  const itemId = b.item_id;
  const list = [...new Set((b.serials || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!itemId || !list.length) return res.fail("Nothing to record");

  const clashes = [];
  let saved = 0;
  for (const serial of list) {
    const dup = (await conn.query("SELECT id, status FROM item_serials WHERE firm_id=? AND serial=?", [f, serial])).rows[0];
    if (dup) { clashes.push(serial); continue; }
    await conn.query(`INSERT INTO item_serials (firm_id, item_id, serial, status, purchase_id, note)
           VALUES (?,?,?,?,?,?)`,
      [f, itemId, serial, "in_stock", b.purchase_id || null, b.note || null]);
    saved++;
  }
  return () => res.success({ saved, duplicates: clashes },
    clashes.length ? `${saved} recorded — ${clashes.length} already on file` : `${saved} serial(s) recorded`);
}));

/* Mark serials sold (called after a sale is saved) */
router.post("/issue", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const b = req.body || {};
  const list = (b.serials || []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return res.fail("No serials given");
  const missing = [];
  let issued = 0;
  for (const serial of list) {
    const row = (await conn.query("SELECT id, status FROM item_serials WHERE firm_id=? AND serial=?", [f, serial])).rows[0];
    if (!row || row.status !== "in_stock") { missing.push(serial); continue; }
    await conn.query("UPDATE item_serials SET status='sold', sale_id=?, party_id=?, sold_at=? WHERE id=?",
      [b.sale_id || null, b.party_id || null, new Date().toISOString(), row.id]);
    issued++;
  }
  return () => res.success({ issued, unavailable: missing },
    missing.length ? `${issued} issued — ${missing.length} not available` : `${issued} serial(s) issued`);
}));

/* Put one back (sale voided or returned) */
router.post("/return", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const serial = String((req.body || {}).serial || "").trim();
  const row = (await conn.query("SELECT id FROM item_serials WHERE firm_id=? AND serial=?", [f, serial])).rows[0];
  if (!row) return res.fail("Serial not found", 404);
  await conn.query("UPDATE item_serials SET status='in_stock', sale_id=NULL, party_id=NULL, sold_at=NULL WHERE id=?", [row.id]);
  return () => res.success({ serial }, "Back in stock");
}));

module.exports = router;
