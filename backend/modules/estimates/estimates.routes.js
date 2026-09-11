/**
 * estimates.routes.js — Estimates/Quotations & Sale Orders.
 * No stock movement, no GL — pure paper until converted to a real invoice.
 * Convert marks the estimate and hands its lines to the client, which posts
 * a normal /sales invoice and confirms with the invoice id (atomic enough:
 * status only flips after the invoice exists).
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { nextSeq, pad } = require("../../shared/sequences");
const { computeInvoice } = require("../../shared/tax.engine");
const { getSetting } = require("../settings/settings.service");
const { logAudit } = require("../../shared/voucher");
const { clientRef, findByRef, isDuplicateRef, ensureKeys } = require("../../shared/idempotency");

router.use(verifyToken);

router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT e.*, p.name AS party_name FROM estimates e
       JOIN parties p ON p.id = e.party_id
      WHERE e.firm_id = ? ORDER BY e.id DESC LIMIT 500`,
    [req.user.firm_id])).rows;
  res.success(rows);
});

router.get("/:id", requirePermission("sales", "view"), async (req, res) => {
  const est = (await query("SELECT * FROM estimates WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!est) return res.notFound("Not found");
  est.lines = (await query("SELECT * FROM estimate_lines WHERE firm_id = ? AND estimate_id = ?", [req.user.firm_id, est.id])).rows;
  est.taxes = est.tax_breakdown ? JSON.parse(est.tax_breakdown) : [];
  /* Aliases and the party's name, so this document can go through the shared
     print template — the same addition made to purchases and returns. Without
     them a printed quotation had a blank document number and a blank date,
     which is precisely the field a customer quotes back at you. */
  const party = (await query("SELECT name, billing_address, phone FROM parties WHERE id = ? AND firm_id = ?",
    [est.party_id, req.user.firm_id])).rows[0];
  est.party_name = party ? party.name : null;
  est.party_address = party ? party.billing_address : null;
  est.party_phone = party ? party.phone : null;
  est.invoice_no = est.doc_no;
  est.invoice_date = est.doc_date;
  /* A quotation is an offer, not a debt. Nothing has been received and nothing
     is due, so both figures are stated rather than left to render as blank. */
  est.paid_amount = 0;
  est.balance_due = 0;
  res.success(est);
});

const estimateReply = (e) => ({ id: e.id, doc_no: e.doc_no, replayed: true,
  totals: { sub_total: e.sub_total, tax_total: e.tax_total, grand_total: e.grand_total } });

router.post("/", requirePermission("sales", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  let ref = null;
  try {
    const b = req.body || {};
    const firmId = req.user.firm_id;
    /* A quotation posts nothing, so a duplicate costs no money — but it does
       put two live quotes for the same job in front of one customer, and the
       shop has no way to know which one they are holding. */
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("estimates", firmId, ref);
      if (prior) return res.success(estimateReply(prior), "Estimate created");
    }
    const docType = b.doc_type === "order" ? "order" : "estimate";
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
    if (!party) return res.fail("Choose a party", 400);
    if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);

    const taxesOn = await getSetting(firmId, "taxes_enabled", "1") === "1";
    const rules = taxesOn ? (await query("SELECT * FROM tax_rules WHERE firm_id = ? AND is_active = 1 ORDER BY apply_order", [firmId])).rows : [];
    const { lines, totals } = computeInvoice({ lines: b.lines, rules, roundOff: await getSetting(firmId, "round_off", "1") === "1" });

    await conn.beginTransaction();
    const prefix = docType === "order" ? "SO" : "EST";
    const no = `${prefix}-${pad(await nextSeq(conn, `${prefix}:firm${firmId}`))}`;
    const r = await conn.query(
      `INSERT INTO estimates (firm_id, doc_no, doc_type, party_id, doc_date, valid_until,
        sub_total, tax_breakdown, tax_total, grand_total, notes, created_by, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firmId, no, docType, party.id, b.doc_date || new Date().toISOString().slice(0, 10),
       b.valid_until || null, totals.sub_total, JSON.stringify(totals.taxes),
       totals.tax_total, totals.grand_total, b.notes || null, req.user.id, ref]);
    for (const ln of lines) {
      await conn.query(
        `INSERT INTO estimate_lines (firm_id, estimate_id, item_id, description, quantity, rate, taxable_value, line_total)
         VALUES (?,?,?,?,?,?,?,?)`,
        [firmId, r.insertId, ln.item_id || null, ln.description || null,
         ln.quantity, ln.rate, ln.taxable_value, ln.line_total]);
    }
    await conn.commit();
    res.success({ id: r.insertId, doc_no: no, totals }, `${docType === "order" ? "Sale order" : "Estimate"} created`);
  } catch (err) {
    await conn.rollback();
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("estimates", req.user.firm_id, ref);
      if (prior) return res.success(estimateReply(prior), "Estimate created");
    }
    next(err);
  }
  finally { conn.release(); }
});

/* Flip status; converting requires the created invoice's id. */
router.put("/:id/status", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const est = (await query("SELECT * FROM estimates WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!est) return res.notFound("Not found");
  if (est.status === "converted") return res.fail("Already converted");
  if (b.status === "converted") {
    if (!b.invoice_id) return res.fail("invoice_id required to mark converted");
    await conn.query("UPDATE estimates SET status='converted', converted_invoice_id=? WHERE id=?", [b.invoice_id, est.id]);
  } else if (b.status === "cancelled" || b.status === "open") {
    await conn.query("UPDATE estimates SET status=? WHERE id=?", [b.status, est.id]);
  } else return res.fail("Bad status");
  return () => res.success({ ok: true }, "Updated");
}));

/**
 * Change a quotation.
 *
 * The one document in this app where an edit is genuinely just an edit: a
 * quotation posts nothing, holds no stock and settles no debt, so there is no
 * ledger to reverse and nothing to preserve except the number the customer has
 * on their copy. Until now a price change on a quote meant issuing a second
 * one and telling the customer to ignore the first — which is how two live
 * quotes for the same job end up in circulation at different prices.
 *
 * A converted quote is refused: its lines are the invoice's history, and
 * rewriting them would leave the invoice quoting a document that no longer
 * says what it said.
 */
router.put("/:id", requirePermission("sales", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const b = req.body || {};
    const est = (await query("SELECT * FROM estimates WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    if (!est) return res.fail("Not found", 404);
    if (est.status === "converted") {
      return res.fail(`${est.doc_no} has already been turned into an invoice — change the invoice instead`);
    }
    if (b.lines !== undefined && (!Array.isArray(b.lines) || !b.lines.length)) return res.fail("Add at least one item", 400);

    let totals = null, lines = null;
    if (Array.isArray(b.lines)) {
      const taxesOn = await getSetting(firmId, "taxes_enabled", "1") === "1";
      const rules = taxesOn ? (await query("SELECT * FROM tax_rules WHERE firm_id = ? AND is_active = 1 ORDER BY apply_order", [firmId])).rows : [];
      ({ lines, totals } = computeInvoice({ lines: b.lines, rules, roundOff: await getSetting(firmId, "round_off", "1") === "1" }));
    }

    await conn.beginTransaction();
    if (totals) {
      await conn.query("DELETE FROM estimate_lines WHERE firm_id = ? AND estimate_id = ?", [firmId, est.id]);
      for (const ln of lines) {
        await conn.query(
          `INSERT INTO estimate_lines (firm_id, estimate_id, item_id, description, quantity, rate, taxable_value, line_total)
           VALUES (?,?,?,?,?,?,?,?)`,
          [firmId, est.id, ln.item_id || null, ln.description || null,
           ln.quantity, ln.rate, ln.taxable_value, ln.line_total]);
      }
      await conn.query(
        `UPDATE estimates SET sub_total=?, tax_breakdown=?, tax_total=?, grand_total=? WHERE id=? AND firm_id=?`,
        [totals.sub_total, JSON.stringify(totals.taxes), totals.tax_total, totals.grand_total, est.id, firmId]);
    }
    await conn.query(
      `UPDATE estimates SET doc_date=?, valid_until=?, notes=?, party_id=? WHERE id=? AND firm_id=?`,
      [b.doc_date || est.doc_date,
       b.valid_until !== undefined ? (b.valid_until || null) : est.valid_until,
       b.notes !== undefined ? (b.notes || null) : est.notes,
       b.party_id || est.party_id, est.id, firmId]);
    await logAudit(conn, { userId: req.user.id, module: "sales", action: "edit_estimate", entityId: est.id, detail: est.doc_no });
    await conn.commit();
    res.success({ id: est.id, doc_no: est.doc_no, totals: totals || undefined }, `${est.doc_no} updated`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* Remove a quotation outright. Nothing was posted, so there is nothing to
   reverse and nothing an auditor needs to see — except on one that became an
   invoice, which stays as that invoice's paper trail. */
router.delete("/:id", requirePermission("sales", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const est = (await query("SELECT * FROM estimates WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
  if (!est) return res.fail("Not found", 404);
  if (est.status === "converted") {
    return res.fail(`${est.doc_no} became an invoice — it is that invoice's paper trail and has to stay`);
  }
  await conn.query("DELETE FROM estimate_lines WHERE firm_id = ? AND estimate_id = ?", [firmId, est.id]);
  await conn.query("DELETE FROM estimates WHERE id = ? AND firm_id = ?", [est.id, firmId]);
  await logAudit(conn, { userId: req.user.id, module: "sales", action: "delete_estimate", entityId: est.id, detail: est.doc_no });
  return () => res.success({ id: est.id }, `${est.doc_no} deleted`);
}));

module.exports = router;
