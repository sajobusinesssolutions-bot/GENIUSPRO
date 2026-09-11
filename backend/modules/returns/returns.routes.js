/**
 * returns.routes.js — credit notes (sale returns), debit notes (purchase returns),
 * and delivery challans.
 *
 * Credit note reverses a sale: stock IN, GL = Sales Dr + Output GST Dr,
 * Debtors Cr (adjust) or Cash Cr (refund). Party owes less.
 * Debit note reverses a purchase: stock OUT, GL = Creditors Dr,
 * Purchases Cr + Input GST Cr. We owe less.
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { baseQuantity, toBaseUnits } = require("../../shared/units");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { nextSeq, pad } = require("../../shared/sequences");
const { computeInvoice } = require("../../shared/tax.engine");
const { postDocument } = require("../../shared/stock.poster");
const { postJournal, templates } = require("../../shared/accounting.poster");
const { blockedReason, voidLedger, unwindStock, logAudit, today } = require("../../shared/voucher");
const { CODES } = require("../../shared/account.codes");
const { getSetting } = require("../settings/settings.service");
const { ensureKeys, clientRef, findByRef, isDuplicateRef } = require("../sales/idempotency");
const { blockClosed } = require("../../shared/periodlock");

/**
 * A refund posted twice hands the customer their money back twice and puts the
 * goods on the shelf twice. It is exactly as expensive as a duplicated sale,
 * so it gets exactly the same treatment: one client_ref per attempt, a unique
 * index behind it, and the existing note returned with 200 on a repeat.
 * See modules/sales/idempotency.js for why this shape.
 */
function existingCreditNoteReply(row) {
  let taxes = [];
  try { taxes = JSON.parse(row.tax_breakdown || "[]") || []; } catch { taxes = []; }
  return {
    id: row.id,
    note_no: row.note_no,
    totals: { sub_total: row.sub_total, taxes, tax_total: row.tax_total, grand_total: row.grand_total },
    duplicate: true,
  };
}

async function loadTaxRules(firmId) {
  return (await query("SELECT * FROM tax_rules WHERE firm_id = ? AND is_active = 1 ORDER BY apply_order", [firmId])).rows;
}

router.use(verifyToken);

const r2 = (n) => +Number(n || 0).toFixed(2);

/* ── Credit notes (sale returns) ── */
router.get("/credit-notes", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT r.*, p.name AS party_name, s.invoice_no
       FROM sale_returns r JOIN parties p ON p.id = r.party_id
       LEFT JOIN sale_invoices s ON s.id = r.invoice_id
      WHERE r.firm_id = ? ORDER BY r.id DESC LIMIT 500`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

router.post("/credit-notes", requirePermission("sales", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  let ref = null;
  try {
    const b = req.body || {};
    const firmId = req.user.firm_id;
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("sale_returns", firmId, ref);
      if (prior) return res.success(existingCreditNoteReply(prior), "Credit note issued");
    }
    const firm = (await query("SELECT * FROM firms WHERE id = ?", [firmId])).rows[0];
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
    if (!party) return res.fail("Choose a customer", 400);
    if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);

    // Same tax chain as the original sale.
    const taxesOn = await getSetting(firmId, "taxes_enabled", "1") === "1";
    const { lines, totals } = computeInvoice({
      lines: b.lines, rules: taxesOn ? await loadTaxRules(firmId) : [], roundOff: false,
    });

    await conn.beginTransaction();
    const no = `CN-${pad(await nextSeq(conn, `CN:firm${firmId}`))}`;
    const dt = b.return_date || new Date().toISOString().slice(0, 10);
    if (await blockClosed(req, res, dt, "note")) { await conn.rollback(); return; }
    const refundMode = b.refund_mode === "cash" ? "cash" : "adjust";

    const r = await conn.query(
      `INSERT INTO sale_returns (firm_id, note_no, invoice_id, party_id, return_date, refund_mode,
        sub_total, tax_breakdown, tax_total, grand_total, reason, created_by, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firmId, no, b.invoice_id || null, party.id, dt, refundMode,
       totals.sub_total, JSON.stringify(totals.taxes), totals.tax_total,
       totals.grand_total, b.reason || null, req.user.id, ref]
    );
    const retId = r.insertId;

    for (const ln of lines) {
      await conn.query(
        `INSERT INTO sale_return_lines (firm_id, return_id, item_id, description,
          quantity, base_quantity, rate, taxable_value, line_total)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [firmId, retId, ln.item_id || null, ln.description || null,
         ln.quantity, await baseQuantity(query, ln), ln.rate, ln.taxable_value, ln.line_total]
      );
    }

    /* Goods come back into stock — in BASE units.
       This used to post the raw line quantity, so refunding 10 KG of a 50 KG
       bag put 10 whole BAGS back on the shelf: a 50x inventory inflation on
       every dual-unit refund, which then fed the stock valuation and reorder
       reports. */
    if (await getSetting(firmId, "stock_maintenance", "1") === "1") {
      await postDocument(conn, { firmId, lines: await toBaseUnits(query, lines), direction: "in", sourceModule: "sale_returns", sourceId: retId, userId: req.user.id });
    }

    // Reverse the sale in the GL.
    const creditAcct = refundMode === "cash" ? (b.cash_account_code || CODES.CASH) : CODES.DEBTORS;
    await postJournal(conn, {
      firmId, date: dt, description: `Credit note ${no} — ${party.name}`, reference: no,
      sourceModule: "sale_returns", sourceId: retId, userId: req.user.id,
      lines: templates.creditNote({ subTotal: totals.sub_total, deducted: totals.deducted_total, added: totals.added_total, creditCode: creditAcct }),
    });

    // Customer owes less (only when adjusting against their balance).
    if (refundMode === "adjust") {
      await conn.query("UPDATE parties SET balance = ROUND(balance - ?, 2) WHERE id = ?", [totals.grand_total, party.id]);
    }

    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "sales", "credit_note", retId, no]);
    await conn.commit();
    res.success({ id: retId, note_no: no, totals }, "Credit note issued");
  } catch (err) {
    await conn.rollback();
    /* Two copies of the refund in flight at once — the index stopped the
       second. Answer with the note the first one wrote. */
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("sale_returns", req.user.firm_id, ref);
      if (prior) return res.success(existingCreditNoteReply(prior), "Credit note issued");
    }
    next(err);
  }
  finally { conn.release(); }
});


/* ── One document, for printing ───────────────────────────────────────────
 *
 * Credit notes, debit notes and challans could be created and listed but never
 * fetched on their own, so there was nothing to print — the only "Print" these
 * screens offered was `window.print()` on the whole page, which round four
 * proved renders the navigation rail instead of the document.
 *
 * Each returns the header with its lines, mapped into the field names the
 * print templates already use (`invoice_no`, `invoice_date`, `lines`). Mapping
 * here rather than in the browser means one shape reaches `printInvoice`, and a
 * template that changes cannot silently stop matching one of four callers.
 *
 * `firm_id` is in every WHERE clause, including the child fetch. Round nine's
 * audit found child rows fetched by parent id alone, and an unscoped child read
 * is how one shop's lines end up on another shop's paper.
 */
async function docLines(table, fkColumn, id, firmId) {
  return (await query(
    `SELECT * FROM ${table} WHERE ${fkColumn} = ? AND firm_id = ? ORDER BY id`,
    [id, firmId]
  )).rows;
}

router.get("/credit-notes/:id", requirePermission("sales", "view"), async (req, res) => {
  const r = (await query(
    `SELECT r.*, p.name AS party_name, p.billing_address AS party_address, p.phone AS party_phone,
            s.invoice_no AS against_invoice_no
       FROM sale_returns r JOIN parties p ON p.id = r.party_id
       LEFT JOIN sale_invoices s ON s.id = r.invoice_id
      WHERE r.id = ? AND r.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!r) return res.fail("Credit note not found", 404);
  res.success({
    ...r,
    invoice_no: r.note_no,
    invoice_date: r.return_date,
    /* A credit note is settled the moment it is issued — it either reduces what
       the customer owes or hands cash back. Saying "Balance due 0" is true, and
       leaving the field absent would print an empty row. */
    paid_amount: r.grand_total,
    balance_due: 0,
    payment_type: r.refund_mode === "cash" ? "cash" : "credit",
    lines: await docLines("sale_return_lines", "return_id", r.id, req.user.firm_id),
  });
});

router.get("/debit-notes/:id", requirePermission("purchases", "view"), async (req, res) => {
  const r = (await query(
    `SELECT r.*, p.name AS party_name, p.billing_address AS party_address, p.phone AS party_phone,
            b.bill_no AS against_bill_no
       FROM purchase_returns r JOIN parties p ON p.id = r.party_id
       LEFT JOIN purchase_invoices b ON b.id = r.bill_id
      WHERE r.id = ? AND r.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!r) return res.fail("Debit note not found", 404);
  res.success({
    ...r,
    invoice_no: r.note_no,
    invoice_date: r.return_date,
    paid_amount: r.grand_total,
    balance_due: 0,
    payment_type: "credit",
    lines: await docLines("purchase_return_lines", "return_id", r.id, req.user.firm_id),
  });
});

router.get("/challans/:id", requirePermission("sales", "view"), async (req, res) => {
  const c = (await query(
    `SELECT c.*, p.name AS party_name, p.billing_address AS party_address, p.phone AS party_phone
       FROM challans c JOIN parties p ON p.id = c.party_id
      WHERE c.id = ? AND c.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!c) return res.fail("Challan not found", 404);
  const lines = await docLines("challan_lines", "challan_id", c.id, req.user.firm_id);
  res.success({
    ...c,
    invoice_no: c.challan_no,
    invoice_date: c.challan_date,
    /* A delivery challan deliberately carries no prices. It is a goods-out
       note, not a demand for money, and printing rates on one is how a
       customer ends up treating it as an invoice and paying twice. The rate
       and total columns render as zero, which the template prints as blank
       money rather than a figure. */
    sub_total: 0, grand_total: 0, paid_amount: 0, balance_due: 0,
    taxes: [],
    lines: lines.map((l) => ({ ...l, rate: 0, line_total: 0 })),
  });
});

/* ── Debit notes (purchase returns) ── */
router.get("/debit-notes", requirePermission("purchases", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT r.*, p.name AS party_name, b.bill_no
       FROM purchase_returns r JOIN parties p ON p.id = r.party_id
       LEFT JOIN purchase_invoices b ON b.id = r.bill_id
      WHERE r.firm_id = ? ORDER BY r.id DESC LIMIT 500`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

const debitNoteReply = (n) => ({ id: n.id, note_no: n.note_no, replayed: true,
  totals: { sub_total: n.sub_total, tax_total: n.tax_total, grand_total: n.grand_total } });

router.post("/debit-notes", requirePermission("purchases", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  let ref = null;
  try {
    const b = req.body || {};
    const firmId = req.user.firm_id;
    /* Credit notes have been protected since they were written; debit notes
       never were, and a duplicate one takes stock off the shelf twice while
       telling the supplier they are owed less than they are. */
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("purchase_returns", firmId, ref);
      if (prior) return res.success(debitNoteReply(prior), "Debit note issued");
    }
    const firm = (await query("SELECT * FROM firms WHERE id = ?", [firmId])).rows[0];
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
    if (!party) return res.fail("Choose a supplier", 400);
    if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);

    const taxesOn = await getSetting(firmId, "taxes_enabled", "1") === "1";
    const { lines, totals } = computeInvoice({
      lines: b.lines, rules: taxesOn ? await loadTaxRules(firmId) : [], roundOff: false,
    });

    await conn.beginTransaction();
    const no = `DN-${pad(await nextSeq(conn, `DN:firm${firmId}`))}`;
    const dt = b.return_date || new Date().toISOString().slice(0, 10);
    if (await blockClosed(req, res, dt, "note")) { await conn.rollback(); return; }

    const r = await conn.query(
      `INSERT INTO purchase_returns (firm_id, note_no, bill_id, party_id, return_date,
        sub_total, tax_breakdown, tax_total, grand_total, reason, created_by, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firmId, no, b.bill_id || null, party.id, dt,
       totals.sub_total, JSON.stringify(totals.taxes), totals.tax_total,
       totals.grand_total, b.reason || null, req.user.id, ref]
    );
    const retId = r.insertId;

    for (const ln of lines) {
      await conn.query(
        `INSERT INTO purchase_return_lines (firm_id, return_id, item_id, description,
          quantity, rate, taxable_value, line_total)
         VALUES (?,?,?,?,?,?,?,?)`,
        [firmId, retId, ln.item_id || null, ln.description || null,
         ln.quantity, ln.rate, ln.taxable_value, ln.line_total]
      );
    }

    // Goods go back out of stock.
    if (await getSetting(firmId, "stock_maintenance", "1") === "1") {
      await postDocument(conn, { firmId, lines, direction: "out", sourceModule: "purchase_returns", sourceId: retId, userId: req.user.id });
    }

    // Reverse the purchase in the GL: we owe the supplier less.
    await postJournal(conn, {
      firmId, date: dt, description: `Debit note ${no} — ${party.name}`, reference: no,
      sourceModule: "purchase_returns", sourceId: retId, userId: req.user.id,
      lines: templates.debitNote({ subTotal: totals.sub_total, deducted: totals.deducted_total, added: totals.added_total }),
    });
    await conn.query("UPDATE parties SET balance = ROUND(balance + ?, 2) WHERE id = ?", [totals.grand_total, party.id]);

    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "purchases", "debit_note", retId, no]);
    await conn.commit();
    res.success({ id: retId, note_no: no, totals }, "Debit note issued");
  } catch (err) {
    await conn.rollback();
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("purchase_returns", req.user.firm_id, ref);
      if (prior) return res.success(debitNoteReply(prior), "Debit note issued");
    }
    next(err);
  }
  finally { conn.release(); }
});

/* ── Delivery challans ── */
router.get("/challans", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT c.*, p.name AS party_name,
            (SELECT COUNT(*) FROM challan_lines l WHERE l.challan_id = c.id) AS line_count
       FROM challans c JOIN parties p ON p.id = c.party_id
      WHERE c.firm_id = ? ORDER BY c.id DESC LIMIT 500`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

router.post("/challans", requirePermission("sales", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.party_id) return res.fail("Choose a party", 400);
    if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);
    await conn.beginTransaction();
    const no = `DC-${pad(await nextSeq(conn, `DC:firm${req.user.firm_id}`))}`;
    const r = await conn.query(
      `INSERT INTO challans (firm_id, challan_no, party_id, challan_date, vehicle_no, notes, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.firm_id, no, b.party_id, b.challan_date || new Date().toISOString().slice(0, 10),
       b.vehicle_no || null, b.notes || null, req.user.id]
    );
    for (const ln of b.lines) {
      await conn.query("INSERT INTO challan_lines (firm_id, challan_id, item_id, description, quantity, unit) VALUES (?,?,?,?,?,?)",
        [req.user.firm_id, r.insertId, ln.item_id || null, ln.description || null, Number(ln.quantity) || 1, ln.unit || null]);
    }
    await conn.commit();
    res.success({ id: r.insertId, challan_no: no }, "Challan created");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

router.put("/challans/:id/status", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const status = (req.body || {}).status;
  if (!["open", "delivered", "invoiced"].includes(status)) return res.fail("Bad status");
  await conn.query("UPDATE challans SET status = ? WHERE id = ? AND firm_id = ?", [status, req.params.id, req.user.firm_id]);
  return () => res.success({ ok: true }, "Challan updated");
}));

/* ── Cancelling a note ────────────────────────────────────────────────────
 *
 * A credit note is itself a correction, which is exactly why it has to be
 * cancellable: a refund raised against the wrong invoice, or for the wrong
 * quantity, used to be permanent, and the only remedy on offer was to raise a
 * fresh invoice for the goods — putting a sale in the books that never
 * happened, on a date it did not happen.
 *
 * The note is voided rather than deleted, and everything it did is undone in
 * the order it was done: the ledger entry reversed, the goods it moved put
 * back on (or taken off) the shelf, and the party balance returned.
 */
function voidNote(table, cfg) {
  return async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const firmId = req.user.firm_id;
      const n = (await query(`SELECT * FROM ${table} WHERE id = ? AND firm_id = ?`, [req.params.id, firmId])).rows[0];
      const stop = blockedReason(n, { label: cfg.label });
      if (stop) return res.fail(stop, n ? 400 : 404);

      await conn.beginTransaction();
      await voidLedger(conn, { firmId, sources: [cfg.source], sourceId: n.id, docNo: n.note_no, userId: req.user.id, date: today() });
      await unwindStock(conn, { firmId, sourceModule: cfg.source, sourceId: n.id, userId: req.user.id, date: today() });

      /* A credit note refunded in cash never touched the customer's balance,
         so putting it back would credit them money they were handed over the
         counter. Only the "adjust against their account" kind moved it. */
      const movedBalance = cfg.source === "sale_returns" ? n.refund_mode !== "cash" : true;
      if (movedBalance) {
        await conn.query(`UPDATE parties SET balance = ROUND(balance ${cfg.balanceBack} ?, 2) WHERE id = ?`,
          [Number(n.grand_total) || 0, n.party_id]);
      }
      await conn.query(`UPDATE ${table} SET status='voided', void_reason=?, voided_at=datetime('now') WHERE id=? AND firm_id=?`,
        [(req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : null, n.id, firmId]);
      await logAudit(conn, { userId: req.user.id, module: cfg.module, action: "void_note", entityId: n.id,
        detail: `${n.note_no} ${n.grand_total}` });
      await conn.commit();
      res.success({ id: n.id, voided: true }, `${n.note_no} voided`);
    } catch (err) { await conn.rollback(); next(err); }
    finally { conn.release(); }
  };
}

router.delete("/credit-notes/:id", requirePermission("sales", "delete"),
  voidNote("sale_returns", { label: "Credit note", source: "sale_returns", module: "sales", balanceBack: "+" }));

router.delete("/debit-notes/:id", requirePermission("purchases", "delete"),
  voidNote("purchase_returns", { label: "Debit note", source: "purchase_returns", module: "purchases", balanceBack: "-" }));

/* A challan posts nothing — no ledger entry, no stock, until it is turned into
   an invoice. So it is the one document here that can simply go, and the only
   guard it needs is the one that stops a delivery note being erased after the
   invoice that quotes it has been raised. */
router.delete("/challans/:id", requirePermission("sales", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const c = (await query("SELECT * FROM challans WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
  if (!c) return res.fail("Challan not found", 404);
  if (c.status === "invoiced") return res.fail(`${c.challan_no} has already been invoiced — void the invoice first`);
  await conn.query("DELETE FROM challan_lines WHERE firm_id = ? AND challan_id = ?", [firmId, c.id]);
  await conn.query("DELETE FROM challans WHERE id = ? AND firm_id = ?", [c.id, firmId]);
  await logAudit(conn, { userId: req.user.id, module: "sales", action: "delete_challan", entityId: c.id, detail: c.challan_no });
  return () => res.success({ id: c.id }, `${c.challan_no} deleted`);
}));

/* Head and lines of an open challan, changed together. Editing one line of a
   delivery note by hand was not possible at all, so a wrong quantity meant
   raising a second note and asking the driver to ignore the first. */
router.put("/challans/:id", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const b = req.body || {};
  const c = (await query("SELECT * FROM challans WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
  if (!c) return res.fail("Challan not found", 404);
  if (c.status === "invoiced") return res.fail(`${c.challan_no} has already been invoiced — it cannot be changed now`);
  if (b.lines !== undefined && (!Array.isArray(b.lines) || !b.lines.length)) return res.fail("Add at least one item");

  await conn.query(
    `UPDATE challans SET challan_date=?, vehicle_no=?, notes=?, party_id=? WHERE id=? AND firm_id=?`,
    [b.challan_date || c.challan_date,
     b.vehicle_no !== undefined ? (b.vehicle_no || null) : c.vehicle_no,
     b.notes !== undefined ? (b.notes || null) : c.notes,
     b.party_id || c.party_id, c.id, firmId]);
  if (Array.isArray(b.lines)) {
    await conn.query("DELETE FROM challan_lines WHERE firm_id = ? AND challan_id = ?", [firmId, c.id]);
    for (const ln of b.lines) {
      await conn.query("INSERT INTO challan_lines (firm_id, challan_id, item_id, description, quantity, unit) VALUES (?,?,?,?,?,?)",
        [firmId, c.id, ln.item_id || null, ln.description || null, Number(ln.quantity) || 1, ln.unit || null]);
    }
  }
  await logAudit(conn, { userId: req.user.id, module: "sales", action: "edit_challan", entityId: c.id, detail: c.challan_no });
  return () => res.success({ id: c.id, challan_no: c.challan_no }, `${c.challan_no} updated`);
}));

module.exports = router;
