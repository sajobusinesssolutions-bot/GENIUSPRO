/* allocate.js — the one place that decides which documents a payment settles.
 *
 * Why this is a module and not three copies
 * -----------------------------------------
 * The same allocation was written out three times: the preview the form draws
 * (GET /payments/open), the save (POST /payments) and the confirm of a parked
 * draft (POST /payments/:id/confirm). Three copies of a rule about money is
 * three chances for the screen to promise one thing and the books to record
 * another, and a customer who was told their March invoice was cleared while
 * the ledger says April's is an argument nobody can win from memory. The
 * previous round documented "if the allocation order is ever changed it must
 * change in three places" — this file is that comment turned into code, so it
 * cannot be half-changed.
 *
 * Ordering: document date, then id
 * --------------------------------
 * It used to be `ORDER BY id` alone, while every screen said "oldest first".
 * Those are the same thing only when documents are keyed in the order they
 * were written. They are not: a shop that finds last month's delivery note in
 * a drawer and enters it today gets the highest id on the oldest invoice, so
 * a payment "applied oldest first" skipped straight past the one that was
 * actually oldest and, worse, the one most likely to be overdue. Sorting by
 * the date on the paper is what the words on the screen mean. `id` stays as
 * the tiebreak so two documents dated the same day still have one settled
 * order rather than whatever SQLite happens to return.
 */

/* Which table and which columns each direction settles.
   'in'  = money from a customer  → their sale invoices
   'out' = money to a supplier    → our purchase bills */
function docSpec(direction) {
  return direction === "out"
    ? { table: "purchase_invoices", no: "bill_no", date: "bill_date" }
    : { table: "sale_invoices", no: "invoice_no", date: "invoice_date" };
}

/* The open documents, in the order the money is applied to them. Both the
   preview and the save call this, on the same connection semantics, so the
   list the shopkeeper is looking at is the list the allocator walks. */
function openDocs(run, firmId, partyId, direction) {
  const t = docSpec(direction);
  return run(
    `SELECT id, ${t.no} AS doc_no, ${t.date} AS doc_date, due_date, grand_total,
            paid_amount, balance_due, COALESCE(status, '') AS status
       FROM ${t.table}
      WHERE firm_id = ? AND party_id = ? AND balance_due > 0
      ORDER BY ${t.date} ASC, id ASC`,
    [firmId, partyId]
  ).rows;
}

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Half a cent. Money is stored to two places, so a balance that is 0.004 off
   is arithmetic noise, not an amount anybody can pay. */
const EPS = 0.005;

/* Automatic plan: take from each open document in turn until the money runs
   out. Whatever is left is an advance on the party's account. */
function autoPlan(docs, settles) {
  let left = r2(settles);
  const allocations = [];
  for (const d of docs) {
    if (left <= EPS) break;
    const amount = r2(Math.min(left, d.balance_due));
    if (amount <= 0) continue;
    left = r2(left - amount);
    allocations.push({ doc_id: d.id, amount });
  }
  return { allocations, advance: r2(left) };
}

/* Explicit plan: the operator has named the documents and the amounts.
 *
 * Everything below is a refusal rather than a correction. Silently trimming an
 * over-application, or quietly merging a doubled line, would post a payment
 * that does not match the one on the screen the operator was looking at when
 * they pressed Save — and they would have no reason to check. Money is the one
 * place where "close enough" is worse than an error message.
 *
 * Returns { error } or { allocations, advance }.
 */
function explicitPlan(docs, settles, requested) {
  const byId = new Map(docs.map((d) => [Number(d.id), d]));
  const seen = new Set();
  const allocations = [];
  let total = 0;

  for (const raw of requested) {
    const id = Number(raw && (raw.doc_id ?? raw.id));
    const amount = r2(Number(raw && raw.amount) || 0);
    if (!id) return { error: "An allocation line has no document on it" };
    /* The same invoice twice would apply the money twice: two rows in
       payment_allocations, two subtractions from balance_due, and an invoice
       that reads as overpaid with no single line explaining it. */
    if (seen.has(id)) return { error: "The same invoice is listed twice — each one can only be paid once on a payment" };
    seen.add(id);
    const doc = byId.get(id);
    if (!doc) return { error: "One of the chosen invoices is not open for this party — it may have been settled or voided since this form was opened" };
    if (amount <= 0) continue;                     /* a row set to zero is simply not paid */
    if (amount > r2(doc.balance_due) + EPS) {
      return { error: `${doc.doc_no} only has ${r2(doc.balance_due).toFixed(2)} outstanding — you cannot apply ${amount.toFixed(2)} to it` };
    }
    total = r2(total + amount);
    allocations.push({ doc_id: id, amount });
  }

  if (!allocations.length) return { error: "Choose at least one invoice to settle, or switch back to automatic" };
  if (total > r2(settles) + EPS) {
    return { error: `The chosen invoices come to ${total.toFixed(2)}, which is more than the ${r2(settles).toFixed(2)} this payment settles` };
  }
  /* Under-allocating is allowed and deliberate: a customer may hand over money
     meant for one invoice and leave the rest on account. It is named as an
     advance rather than being spilled onto invoices they did not choose. */
  return { allocations, advance: r2(settles - total) };
}

/* Build the plan for a payment. `requested` is the operator's explicit choice
   or null/undefined for the automatic oldest-first plan. */
function planAllocation(docs, settles, requested) {
  if (Array.isArray(requested) && requested.length) return explicitPlan(docs, settles, requested);
  return autoPlan(docs, settles);
}

/* A race lost to another till is not a server fault and must not come back to
   the operator as "Something went wrong. Reference: k3f9a2" — they need to be
   told the balance moved so they can re-read it and decide again. Tagged so
   the routes can turn it into a plain 400 instead of an anonymised 500. */
function allocError(message) {
  const e = new Error(message);
  e.allocation = true;
  return e;
}

/* Apply a plan inside an open transaction: move each document's balance and
   file the allocation row that says why it moved. */
/**
 * Apply a plan inside an open transaction.
 *
 * Returns the total applied **and** what it was applied to: the document
 * number, how much went to it, and what is left on it afterwards. That detail
 * exists here and nowhere else — the caller has ids and amounts, not numbers
 * and closing balances — and it is what a receipt has to say. A slip reading
 * "Allocated 200,000" against a customer with four open bills tells them
 * nothing they can check; "INV-000212  120,000  (0 left) · INV-000213  80,000
 * (45,000 left)" is a receipt somebody can file.
 */
async function applyAllocation(conn, { firmId, paymentId, direction, allocations }) {
  const t = docSpec(direction);
  const applied = [];
  for (const a of allocations) {
    /* Re-read inside the transaction. The plan may have been built from a
       preview taken minutes ago, and another till may have taken money from
       the same customer since. */
    const doc = (await conn.query(
      `SELECT balance_due, ${t.no} AS doc_no FROM ${t.table} WHERE id = ? AND firm_id = ?`,
      [a.doc_id, firmId])).rows[0];
    if (!doc) throw allocError("One of the chosen invoices no longer exists");
    if (a.amount > r2(doc.balance_due) + EPS) {
      throw allocError(`Another payment has been taken against this invoice since this form was opened — only ${r2(doc.balance_due).toFixed(2)} is still outstanding`);
    }
    const newDue = r2(doc.balance_due - a.amount);
    await conn.query(`UPDATE ${t.table} SET paid_amount = paid_amount + ?, balance_due = ?, status = ? WHERE id = ?`,
      [a.amount, newDue, newDue <= EPS ? "paid" : "partial", a.doc_id]);
    await conn.query("INSERT INTO payment_allocations (firm_id, payment_id, doc_table, doc_id, amount) VALUES (?,?,?,?,?)",
      [firmId, paymentId, t.table, a.doc_id, a.amount]);
    applied.push({ doc_id: a.doc_id, doc_no: doc.doc_no, amount: r2(a.amount), balance_after: newDue });
  }
  /* `{total, applied}`, not a boxed Number with properties hung off it: a
     boxed Number is an object, so `=== 0` is false and `typeof` says the wrong
     thing, and the next person to compare it would be right to expect a
     number. Neither caller uses the scalar, so there is nothing to preserve. */
  return { total: r2(allocations.reduce((s, a) => s + a.amount, 0)), applied };
}

module.exports = { docSpec, openDocs, planAllocation, applyAllocation, allocError, r2, EPS };
