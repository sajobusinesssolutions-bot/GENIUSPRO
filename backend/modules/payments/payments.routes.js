const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { listQuery, sendList } = require("../../shared/paginate");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { nextSeq, pad } = require("../../shared/sequences");
const { postJournal, templates } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");
const { docSpec, openDocs, planAllocation, applyAllocation } = require("./allocate");
const { blockedReason, voidLedger, logAudit, unwindAllocations, today } = require("../../shared/voucher");
const { clientRef, findByRef, isDuplicateRef, ensureKeys } = require("../../shared/idempotency");
const { blockClosed } = require("../../shared/periodlock");

/* An allocation refused because the balances moved under the operator is a
   400 with the reason in it, not an anonymised 500 — see allocate.js. */
const allocFail = (res, err, next) => (err && err.allocation ? res.fail(err.message, 409) : next(err));

router.use(verifyToken);

router.get("/", requirePermission("payments", "view"), async (req, res) => {
  sendList(res, await listQuery({
    req,
    select: "SELECT y.*, p.name AS party_name FROM payments y JOIN parties p ON p.id = y.party_id",
    countFrom: "FROM payments y JOIN parties p ON p.id = y.party_id",
    where: ["y.firm_id = ?"], args: [req.user.firm_id],
    orderBy: "y.id DESC",
    searchCols: ["y.payment_no", "p.name", "y.reference"],
    dateCol: "y.payment_date",
    /* Drafts were already excluded from the books; voided payments have to be
       excluded from this figure for the same reason. Both stay in the list. */
    sumCols: { amount: "CASE WHEN COALESCE(y.status,'paid') IN ('voided','draft') THEN 0 ELSE y.amount END" },
  }));
});

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* The documents a payment for this party would be applied to, in the order it
 * would apply them.
 *
 * The form used to say, in prose, "money is applied to the oldest open
 * invoices first" and then show nothing at all — so somebody paying 400,000
 * against four bills had no way to see which ones it cleared until after they
 * had saved it and gone looking. Getting that wrong is not a display bug: a
 * customer who thinks their March invoice is settled and a shop whose books
 * say it is April's is an argument nobody can win from memory.
 *
 * The list, the order and the arithmetic all come from `./allocate`, which is
 * the same module the save and the confirm run. They used to be three separate
 * copies of the rule with a comment asking whoever changed one to remember the
 * other two; a preview that can drift from the save is a promise the save then
 * breaks.
 */
router.get("/open", requirePermission("payments", "view"), (req, res) => {
  const firmId = req.user.firm_id;
  const partyId = Number(req.query.party_id) || 0;
  if (!partyId) return res.fail("Choose a customer or supplier first", 400);
  const direction = req.query.direction === "out" ? "out" : "in";
  const t = docSpec(direction);
  const today = new Date().toISOString().slice(0, 10);

  const rows = openDocs(query, firmId, partyId, direction).map((r) => ({
    ...r,
    grand_total: r2(r.grand_total), paid_amount: r2(r.paid_amount), balance_due: r2(r.balance_due),
    /* Whether it is late is the cue for which one to chase, and the server
       already knows today's date — deriving it in the browser means a till
       whose clock has drifted disagrees with the books. */
    overdue: !!(r.due_date && String(r.due_date) < today),
  }));

  res.success({
    direction, doc_table: t.table, rows,
    totalDue: r2(rows.reduce((a, r) => a + r.balance_due, 0)),
  });
});

/**
 * Record a standalone payment. direction: 'in' (from customer) | 'out' (to supplier).
 *
 * Allocation is oldest-first (by document date) unless the body carries an
 * explicit `allocations: [{ doc_id, amount }]` — the operator having said, on
 * the payment form or from an invoice's own row menu, exactly which documents
 * this money settles. "Oldest first" is right most of the time and wrong
 * whenever a customer hands over money for one particular invoice; before this
 * there was no way to say so, and the shop had to unpick it afterwards.
 */
/* What a replayed POST /payments answers with — the same shape the first
   attempt returned, so a caller cannot tell a retry from the original and
   nobody has to write special code for the case. */
async function existingPaymentReply(y, firmId) {
  const t = docSpec(y.direction);
  const applied = (await query(
    `SELECT a.doc_id, a.amount, d.${t.no} AS doc_no, d.balance_due AS balance_after
       FROM payment_allocations a JOIN ${t.table} d ON d.id = a.doc_id
      WHERE a.firm_id = ? AND a.payment_id = ?`, [firmId, y.id])).rows;
  const settles = r2(Number(y.amount) + Number(y.tax_deducted || 0));
  return {
    id: y.id, payment_no: y.payment_no, status: y.status || "paid",
    allocated: r2(settles - (Number(y.unallocated) || 0)),
    unallocated: r2(y.unallocated || 0), applied, replayed: true,
  };
}

router.post("/", requirePermission("payments", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  /* Declared out here so the catch can tell a duplicate key from a real
     fault after the transaction has already been rolled back. */
  let ref = null;
  try {
    const b = req.body || {};
    const firmId = req.user.firm_id;

    /* Before any work: a payment retried after a lost reply must settle the
       same invoices once, not twice. Taking 200,000 off a customer and having
       the answer die on the way back used to leave the cashier with two bad
       choices and no way to tell which was right. */
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("payments", firmId, ref);
      if (prior) return res.success(await existingPaymentReply(prior, firmId), "Payment recorded");
    }

    const amount = +Number(b.amount || 0).toFixed(2);
    if (!(amount > 0)) return res.fail("Enter an amount", 400);
    const direction = b.direction === "out" ? "out" : "in";
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
    if (!party) return res.fail("Choose a party", 400);
    const dt = b.payment_date || new Date().toISOString().slice(0, 10);
    if (await blockClosed(req, res, dt, "payment")) return;
    /* "Deposit To" — the cash/bank account the money lands in (or leaves from). */
    const cashCode = b.deposit_code || b.cash_account_code || CODES.CASH;
    const charges = +Number(b.bank_charges || 0).toFixed(2);
    const deducted = +Number(b.tax_deducted || 0).toFixed(2);
    if (charges < 0 || deducted < 0) return res.fail("Bank charges and deducted tax cannot be negative", 400);
    if (charges > amount) return res.fail("Bank charges cannot exceed the amount received", 400);
    const isDraft = b.status === "draft";
    /* A draft is parked, not posted: nothing is allocated, no GL entry, no
       balance moved. Confirm it later from the payments list. */
    const settles = +(amount + deducted).toFixed(2);

    await conn.beginTransaction();
    const no = `PAY-${pad(await nextSeq(conn, `PAY:firm${firmId}`))}`;
    const pr = await conn.query(
      `INSERT INTO payments (firm_id, payment_no, direction, party_id, payment_date, amount, mode, reference, notes, created_by,
                             bank_charges, tax_deducted, deposit_code, received_on, status, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firmId, no, direction, party.id, dt, amount, b.mode || "cash", b.reference || null, b.notes || null, req.user.id,
       charges, deducted, cashCode, b.received_on || null, isDraft ? "draft" : "paid", ref]
    );
    const paymentId = pr.insertId;

    if (isDraft) {
      await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
        [req.user.id, "payments", "draft", paymentId, `${no} ${direction} draft ${amount}`]);
      await conn.commit();
      return res.success({ id: paymentId, payment_no: no, status: "draft", allocated: 0, unallocated: 0 },
        `${no} saved as a draft — nothing has been allocated or posted yet`);
    }

    /* Allocate: either the documents the operator named, or oldest-first.
       Both plans, and every guard on the explicit one, live in ./allocate. */
    const open = openDocs(conn.query.bind(conn), firmId, party.id, direction);
    const plan = planAllocation(open, settles, b.allocations);
    if (plan.error) { await conn.rollback(); return res.fail(plan.error, 400); }
    const done = await applyAllocation(conn, { firmId, paymentId, direction, allocations: plan.allocations });
    const remaining = plan.advance;
    if (remaining > 0) await conn.query("UPDATE payments SET unallocated = ? WHERE id = ?", [remaining, paymentId]);

    // GL + party balance.
    if (direction === "in") {
      await postJournal(conn, {
        firmId, date: dt, description: `Payment in ${no} — ${party.name}`, reference: no,
        sourceModule: "payments", sourceId: paymentId, userId: req.user.id,
        lines: templates.paymentIn({ amount, cashCode, deducted, charges }),
      });
      await conn.query("UPDATE parties SET balance = ROUND(balance - ?, 2) WHERE id = ?", [settles, party.id]);
    } else {
      await postJournal(conn, {
        firmId, date: dt, description: `Payment out ${no} — ${party.name}`, reference: no,
        sourceModule: "payments", sourceId: paymentId, userId: req.user.id,
        lines: templates.paymentOut({ amount, cashCode, deducted, charges }),
      });
      await conn.query("UPDATE parties SET balance = ROUND(balance + ?, 2) WHERE id = ?", [settles, party.id]);
    }

    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "payments", "create", paymentId, `${no} ${direction} ${amount}`]);

    await conn.commit();
    /* `applied` is what the receipt prints: which bills this money settled,
       how much went to each, and what is still on them. A slip that says only
       "Allocated 200,000" against a customer with four open invoices is not
       something they can check against their own file. */
    res.success({ id: paymentId, payment_no: no, status: "paid",
      allocated: +(settles - remaining).toFixed(2), unallocated: remaining,
      applied: done.applied }, "Payment recorded");
  } catch (err) {
    await conn.rollback();
    /* Two copies of the same attempt in flight at once — the unique index
       stopped the second. Answer with the payment the first one wrote. */
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("payments", req.user.firm_id, ref);
      if (prior) return res.success(await existingPaymentReply(prior, req.user.firm_id), "Payment recorded");
    }
    allocFail(res, err, next);
  }
  finally { conn.release(); }
});

/** Post a parked draft: allocate it against open documents and write the GL entry. */
router.post("/:id/confirm", requirePermission("payments", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const y = (await query("SELECT * FROM payments WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    if (!y) return res.fail("Payment not found", 404);
    if (y.status !== "draft") return res.fail("Only draft payments can be confirmed", 400);
    const party = (await query("SELECT * FROM parties WHERE id = ?", [y.party_id])).rows[0];
    const amount = +Number(y.amount).toFixed(2);
    const charges = +Number(y.bank_charges || 0).toFixed(2);
    const deducted = +Number(y.tax_deducted || 0).toFixed(2);
    const settles = +(amount + deducted).toFixed(2);
    const cashCode = y.deposit_code || CODES.CASH;

    await conn.beginTransaction();
    /* A draft's allocation is worked out when it is confirmed, not when it was
       parked: the party's open documents will have moved on in between. */
    const open = openDocs(conn.query.bind(conn), firmId, y.party_id, y.direction);
    const plan = planAllocation(open, settles, null);
    const done = await applyAllocation(conn, { firmId, paymentId: y.id, direction: y.direction, allocations: plan.allocations });
    const remaining = plan.advance;
    await conn.query("UPDATE payments SET status = 'paid', unallocated = ? WHERE id = ?", [remaining, y.id]);

    const args = { amount, cashCode, deducted, charges };
    await postJournal(conn, {
      firmId, date: y.payment_date, description: `Payment ${y.direction} ${y.payment_no} — ${party ? party.name : ""}`,
      reference: y.payment_no, sourceModule: "payments", sourceId: y.id, userId: req.user.id,
      lines: y.direction === "in" ? templates.paymentIn(args) : templates.paymentOut(args),
    });
    await conn.query(`UPDATE parties SET balance = ROUND(balance ${y.direction === "in" ? "-" : "+"} ?, 2) WHERE id = ?`, [settles, y.party_id]);
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "payments", "confirm", y.id, `${y.payment_no} confirmed ${settles}`]);

    await conn.commit();
    res.success({ id: y.id, payment_no: y.payment_no, status: "paid",
      allocated: +(settles - remaining).toFixed(2), unallocated: remaining,
      applied: done.applied },
      `${y.payment_no} confirmed`);
  } catch (err) { await conn.rollback(); allocFail(res, err, next); }
  finally { conn.release(); }
});

/* One payment with what it settled, for the edit form and the row menu. */
router.get("/:id", requirePermission("payments", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const y = (await query(
    `SELECT y.*, p.name AS party_name FROM payments y
       JOIN parties p ON p.id = y.party_id
      WHERE y.id = ? AND y.firm_id = ?`, [req.params.id, firmId])).rows[0];
  if (!y) return res.fail("Payment not found", 404);
  const t = docSpec(y.direction);
  y.allocations = (await query(
    `SELECT a.doc_id, a.amount, d.${t.no} AS doc_no, d.balance_due
       FROM payment_allocations a JOIN ${t.table} d ON d.id = a.doc_id
      WHERE a.firm_id = ? AND a.payment_id = ?`, [firmId, y.id])).rows;
  res.success(y);
});

/**
 * Cancel a payment.
 *
 * Three things have to come back, and missing any one of them leaves the books
 * telling a story nobody can reconcile:
 *
 *   1. the ledger entry — reversed, not deleted;
 *   2. the invoices it settled — a bill that reads "paid" with no payment
 *      behind it is the error that surfaces months later, in an argument with
 *      a customer;
 *   3. the party's running balance — otherwise the statement and the invoice
 *      list disagree about the same money.
 *
 * A draft never posted any of the three, so cancelling one is just a status
 * change; it is handled on the way through rather than as a special case.
 */
router.delete("/:id", requirePermission("payments", "delete"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const y = (await query("SELECT * FROM payments WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    const stop = blockedReason(y, { label: "Payment" });
    if (stop) return res.fail(stop, y ? 400 : 404);

    const wasPosted = String(y.status || "paid") !== "draft";
    const settles = r2(Number(y.amount) + Number(y.tax_deducted || 0));
    const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : null;

    await conn.beginTransaction();
    if (wasPosted) {
      await voidLedger(conn, { firmId, sources: ["payments"], sourceId: y.id, docNo: y.payment_no, userId: req.user.id, date: today() });
      await unwindAllocations(conn, { firmId, paymentId: y.id });
      await conn.query(`UPDATE parties SET balance = ROUND(balance ${y.direction === "in" ? "+" : "-"} ?, 2) WHERE id = ?`,
        [settles, y.party_id]);
    }
    await conn.query("UPDATE payments SET status='voided', unallocated=0, void_reason=?, voided_at=datetime('now') WHERE id=? AND firm_id=?",
      [reason, y.id, firmId]);
    await logAudit(conn, { userId: req.user.id, module: "payments", action: "void", entityId: y.id,
      detail: `${y.payment_no} ${y.direction} ${y.amount}` });
    await conn.commit();
    res.success({ id: y.id, voided: true }, `${y.payment_no} voided`);
  } catch (err) { await conn.rollback(); allocFail(res, err, next); }
  finally { conn.release(); }
});

/**
 * Correct a payment: void it and post it again under the same number.
 *
 * The allocation is worked out fresh rather than being nudged. A payment that
 * was 200,000 across two invoices and is corrected to 150,000 has no sensible
 * "adjusted" version of its old split — one of those invoices has to give
 * money back, and which one is a decision, not arithmetic. So the old
 * allocation is unwound completely and the new amount is applied from scratch,
 * either oldest-first or against the invoices the operator names.
 *
 * The party cannot be changed. Money that moved from one customer's account to
 * another's is two documents, not an edit, and quietly re-pointing a receipt
 * would leave both statements wrong with one voucher to explain it.
 */
router.put("/:id", requirePermission("payments", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const y = (await query("SELECT * FROM payments WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    const stop = blockedReason(y, { label: "Payment" });
    if (stop) return res.fail(stop, y ? 400 : 404);
    if (String(y.status) === "draft") return res.fail("This payment is still a draft — confirm it first, or delete it and start again", 400);

    const b = req.body || {};
    if (b.party_id != null && Number(b.party_id) !== Number(y.party_id)) {
      return res.fail("A payment cannot be moved to another party — void this one and record it against the right account", 400);
    }
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [y.party_id, firmId])).rows[0];
    if (!party) return res.fail("The party on this payment no longer exists", 400);

    const amount = +Number(b.amount != null ? b.amount : y.amount).toFixed(2);
    if (!(amount > 0)) return res.fail("Enter an amount", 400);
    const charges = +Number(b.bank_charges != null ? b.bank_charges : y.bank_charges || 0).toFixed(2);
    const deducted = +Number(b.tax_deducted != null ? b.tax_deducted : y.tax_deducted || 0).toFixed(2);
    if (charges < 0 || deducted < 0) return res.fail("Bank charges and deducted tax cannot be negative", 400);
    if (charges > amount) return res.fail("Bank charges cannot exceed the amount received", 400);
    const dt = b.payment_date || y.payment_date;
    const cashCode = b.deposit_code || b.cash_account_code || y.deposit_code || CODES.CASH;
    const oldSettles = r2(Number(y.amount) + Number(y.tax_deducted || 0));
    const settles = r2(amount + deducted);

    await conn.beginTransaction();

    /* Undo the old posting completely first — ledger, invoices, party balance
       — so the new one is applied to a book that looks as it did before this
       payment was ever taken. Adjusting the difference instead would be
       arithmetic on top of arithmetic, and every rounding step would stay. */
    await voidLedger(conn, { firmId, sources: ["payments"], sourceId: y.id, docNo: y.payment_no, userId: req.user.id, date: today() });
    await unwindAllocations(conn, { firmId, paymentId: y.id });
    await conn.query(`UPDATE parties SET balance = ROUND(balance ${y.direction === "in" ? "+" : "-"} ?, 2) WHERE id = ?`,
      [oldSettles, y.party_id]);

    await conn.query(
      `UPDATE payments SET payment_date=?, amount=?, mode=?, reference=?, notes=?, bank_charges=?, tax_deducted=?,
              deposit_code=?, received_on=?, edited_at=datetime('now'), edit_count=COALESCE(edit_count,0)+1
        WHERE id=? AND firm_id=?`,
      [dt, amount, b.mode || y.mode || "cash",
       b.reference !== undefined ? (b.reference || null) : y.reference,
       b.notes !== undefined ? (b.notes || null) : y.notes,
       charges, deducted, cashCode,
       b.received_on !== undefined ? (b.received_on || null) : y.received_on,
       y.id, firmId]);

    const open = openDocs(conn.query.bind(conn), firmId, y.party_id, y.direction);
    const plan = planAllocation(open, settles, b.allocations);
    if (plan.error) { await conn.rollback(); return res.fail(plan.error, 400); }
    const done = await applyAllocation(conn, { firmId, paymentId: y.id, direction: y.direction, allocations: plan.allocations });
    await conn.query("UPDATE payments SET unallocated = ? WHERE id = ?", [plan.advance, y.id]);

    const args = { amount, cashCode, deducted, charges };
    await postJournal(conn, {
      firmId, date: dt, description: `Payment ${y.direction} ${y.payment_no} — ${party.name} (amended)`,
      reference: y.payment_no, sourceModule: "payments", sourceId: y.id, userId: req.user.id,
      lines: y.direction === "in" ? templates.paymentIn(args) : templates.paymentOut(args),
    });
    await conn.query(`UPDATE parties SET balance = ROUND(balance ${y.direction === "in" ? "-" : "+"} ?, 2) WHERE id = ?`,
      [settles, y.party_id]);
    await logAudit(conn, { userId: req.user.id, module: "payments", action: "edit", entityId: y.id,
      detail: `${y.payment_no} ${y.amount} → ${amount}` });

    await conn.commit();
    res.success({ id: y.id, payment_no: y.payment_no, status: "paid",
      allocated: r2(settles - plan.advance), unallocated: plan.advance, applied: done.applied },
      `${y.payment_no} updated`);
  } catch (err) { await conn.rollback(); allocFail(res, err, next); }
  finally { conn.release(); }
});

module.exports = router;
