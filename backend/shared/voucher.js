/**
 * voucher.js — cancelling and correcting a posted document.
 *
 * Every voucher in this app posts to the ledger the moment it is saved. Until
 * now most of them could only be posted: an expense typed as 450,000 instead
 * of 45,000 could not be fixed, and the advice was to enter a second, opposite
 * expense. That leaves two wrong documents where there was one, and no way for
 * anybody reading the P&L later to tell a correction from a real payment.
 *
 * The rule this file implements
 * -----------------------------
 * A posted voucher is never deleted. It is VOIDED — the journal it wrote is
 * reversed with an opposing entry, its side effects are unwound, and the
 * document stays in the book marked as voided. The audit trail is the point:
 * a shop that is asked by URA to explain a figure has to be able to show what
 * was there before as well as what is there now, and a DELETE cannot do that.
 *
 * An EDIT is that same void followed by a re-post under the SAME document
 * number. The number matters: it is written on the paper receipt in somebody's
 * file, and issuing EXP-000042 as a fresh EXP-000043 means the shop's copy and
 * the customer's copy no longer agree. `edit_count` rises with each amendment
 * so a corrected document can never be read as an original.
 *
 * The manual journal is the one exception, and it was here before this file:
 * `DELETE /accounting/journal/:id` unwinds the balances and removes the entry
 * outright. It has no document behind it and no number anybody has written
 * down, so there is nothing for a reversal to preserve.
 */
const { reverseJournal } = require("./accounting.poster");

/** Half a cent — money is stored to two places. */
const EPS = 0.005;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Refuse, in words, when a voucher cannot be touched.
 *
 * Returns a message or null. Kept in one place because every one of these
 * refusals was going to be written slightly differently on six routes, and
 * "Not allowed" is not a reason anybody can act on.
 */
function blockedReason(row, { label, statusCol = "status" }) {
  if (!row) return `${label} not found`;
  const st = String(row[statusCol] || "").toLowerCase();
  if (st === "voided") return `${label} is already voided — nothing more to undo`;
  return null;
}

/**
 * Void a voucher: reverse its ledger entries and mark it.
 *
 * `sources` is every source_module the document posted under. Most post once,
 * but a credit note refunded in cash writes under one module while the stock
 * it returned writes under another, and a reversal that misses one leaves the
 * books out by exactly that leg.
 *
 * Side effects that are not the ledger — a party balance, an allocation, stock
 * on a shelf — are the caller's, because only the caller knows what its own
 * document did. This does the part that is identical everywhere.
 */
async function voidLedger(conn, { firmId, sources, sourceId, docNo, userId, date }) {
  let reversed = 0;
  for (const sourceModule of sources) {
    reversed += await reverseJournal(conn, {
      firmId, sourceModule, sourceId, date: date || today(),
      description: `Void ${docNo}`, userId,
    });
  }
  return reversed;
}

/** One line in audit_logs, in the shape the rest of the app writes them. */
async function logAudit(conn, { userId, module, action, entityId, detail }) {
  await conn.query(
    "INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
    [userId || null, module, action, entityId, detail || null]
  );
}

/**
 * Give back money a payment took off invoices.
 *
 * A payment that settled three bills wrote three `payment_allocations` rows
 * and moved three `balance_due` figures. Voiding it has to put all three back,
 * or the shop has invoices that read as paid with no payment behind them —
 * which is the one error that never shows up until a customer disputes it.
 *
 * Deliberately re-reads each document rather than trusting the stored amount:
 * a bill that has since been voided itself is skipped instead of having its
 * balance pushed back above zero.
 */
async function unwindAllocations(conn, { firmId, paymentId }) {
  const rows = (await conn.query(
    "SELECT doc_table, doc_id, amount FROM payment_allocations WHERE firm_id = ? AND payment_id = ?",
    [firmId, paymentId])).rows;
  let given = 0;
  for (const a of rows) {
    /* The table name comes from our own INSERT, never from a request body,
       but it is still checked before it reaches a query — an allow-list is
       cheap and the alternative is a table name interpolated into SQL. */
    if (!["sale_invoices", "purchase_invoices"].includes(a.doc_table)) continue;
    const doc = (await conn.query(
      `SELECT paid_amount, balance_due, grand_total, COALESCE(status,'') AS status
         FROM ${a.doc_table} WHERE id = ? AND firm_id = ?`, [a.doc_id, firmId])).rows[0];
    if (!doc || doc.status === "voided") continue;
    const paid = r2(Math.max(0, Number(doc.paid_amount) - Number(a.amount)));
    const due = r2(Number(doc.grand_total) - paid);
    await conn.query(
      `UPDATE ${a.doc_table} SET paid_amount = ?, balance_due = ?, status = ? WHERE id = ?`,
      [paid, due, paid <= EPS ? "unpaid" : "partial", a.doc_id]);
    given = r2(given + Number(a.amount));
  }
  await conn.query("DELETE FROM payment_allocations WHERE firm_id = ? AND payment_id = ?", [firmId, paymentId]);
  return { rows: rows.length, amount: given };
}

/**
 * Put back the stock a document moved.
 *
 * Reads the movements the document actually posted and writes the opposite of
 * each one, batch for batch. That last part matters: a credit note that took
 * 5 units out of LOT-A and 3 out of LOT-B has to return 5 to LOT-A and 3 to
 * LOT-B, and the older void code in `sales` updates `item_stock` by item id
 * alone — which, on an item held in three batches, adds the returned quantity
 * to all three. Reversing from the movement ledger cannot make that mistake,
 * because the ledger already says which batch each unit came from.
 *
 * The reversal is written as movements too, not as a silent correction, so the
 * stock ledger for the item explains its own balance.
 */
async function unwindStock(conn, { firmId, sourceModule, sourceId, userId, date }) {
  const moves = (await conn.query(
    `SELECT item_id, batch_no, direction, quantity, unit_cost
       FROM stock_movements WHERE firm_id = ? AND source_module = ? AND source_id = ?`,
    [firmId, sourceModule, sourceId])).rows;
  const when = date || today();
  let n = 0;
  for (const m of moves) {
    const back = m.direction === "out" ? "in" : "out";
    const qty = Number(m.quantity) || 0;
    if (!qty) continue;
    const batch = m.batch_no || "";
    await conn.query(
      `INSERT INTO stock_movements (firm_id, item_id, batch_no, direction, quantity, unit_cost,
                                    source_module, source_id, move_date, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [firmId, m.item_id, batch, back, qty, m.unit_cost || 0, sourceModule + "_void", sourceId, when, userId || null]);
    const delta = back === "in" ? qty : -qty;
    const row = (await conn.query("SELECT id FROM item_stock WHERE firm_id=? AND item_id=? AND batch_no=?",
      [firmId, m.item_id, batch])).rows[0];
    if (row) await conn.query("UPDATE item_stock SET quantity = ROUND(quantity + ?, 4) WHERE id = ?", [delta, row.id]);
    else await conn.query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)",
      [firmId, m.item_id, batch, delta, m.unit_cost || 0]);
    n++;
  }
  return n;
}

module.exports = { blockedReason, voidLedger, unwindStock, logAudit, unwindAllocations, r2, EPS, today };
