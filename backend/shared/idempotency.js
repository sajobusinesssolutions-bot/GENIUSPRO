/**
 * idempotency.js — "I already did that", for every document a lost reply
 * could post twice.
 *
 * The problem is not a bug in any handler; it is the network. When a till
 * posts a payment and the answer never comes back, the browser cannot tell
 * "the server never got it" from "the server posted it and the reply died on
 * the way home". Both look like silence. Retrying is a coin toss between
 * losing the document and posting it twice, and doing nothing leaves the
 * cashier staring at a spinner with a customer waiting.
 *
 * The fix is to make a retry *identifiable*. The browser mints one reference
 * per ATTEMPT — not per retry — sends it with every try, and keeps it until
 * the attempt is settled, so it survives a reload. The server stores it under
 * UNIQUE(firm_id, client_ref); on a repeat it hands back the document it
 * already has, with 200. The caller cannot tell the first try from the fifth,
 * which is the entire point: it never has to know whether its request landed.
 *
 * Two layers, because the lookup alone is not a guarantee:
 *   1. `findByRef` before any work — the ordinary case, a retry seconds later;
 *   2. the UNIQUE index, caught by `isDuplicateRef` — two copies of the same
 *      request in flight at once, both past the lookup. Only the index can
 *      settle that one, so it is the index that makes this a promise.
 *
 * This file was `modules/sales/idempotency.js`, covering sales, refunds and
 * voids. It moved here when payments, expenses, purchase bills, debit notes,
 * journals and quotations were brought under the same protection: the module
 * it lived in was not the reason it worked, and six modules importing from a
 * seventh's folder reads as an accident.
 */
const { query } = require("../database/db");
const { ensureIdempotencyKeys } = require("../database/setup.billing");

/** Install the column + unique index if this database has not got them yet. */
async function ensureKeys() {
  await ensureIdempotencyKeys(query);
}

/* A key is opaque to us — we only ever compare it — so the only thing worth
   checking is that it is a sane, bounded string. `crypto.randomUUID()` is what
   the browser sends; the shape below also accepts the other reference formats
   an integrator is likely to reach for rather than forcing them onto UUIDs. */
const REF_SHAPE = /^[A-Za-z0-9._:-]{8,120}$/;

/**
 * The idempotency key on this request, or null if there isn't a usable one.
 * A malformed key is treated as absent rather than rejected: refusing a sale
 * over the shape of a header the cashier cannot see would turn a protection
 * into an outage.
 */
function clientRef(req) {
  const raw = (req.body || {}).client_ref;
  if (raw == null) return null;
  const s = String(raw).trim();
  return REF_SHAPE.test(s) ? s : null;
}

/** The document already posted under this key, or null. */
async function findByRef(table, firmId, ref) {
  if (!ref) return null;
  await ensureKeys();
  return (await query(`SELECT * FROM ${table} WHERE firm_id = ? AND client_ref = ?`, [firmId, ref])).rows[0] || null;
}

/** Did this error come from the idempotency index, rather than a real fault? */
function isDuplicateRef(err) {
  const m = String((err && err.message) || "");
  return /UNIQUE constraint failed/i.test(m) && /client_ref/i.test(m);
}

/**
 * The whole pattern, for a handler that has nothing special to say about a
 * replay beyond "here is the document you already have".
 *
 * Wraps the two checks around a handler so a route reads as the work it does
 * rather than as the retry logic around it:
 *
 *     return replayable(req, res, next, {
 *       table: "payments",
 *       reply: (row) => ({ id: row.id, payment_no: row.payment_no, replayed: true }),
 *       message: "Payment recorded",
 *     }, async (ref) => { ...post it, storing `ref` in client_ref... });
 *
 * `reply` maps a stored row back to the shape the first attempt answered with.
 * It matters that it is the same shape: a retry that comes back looking
 * different is a retry the caller has to have special code for, and then the
 * protection only works for callers that remembered to write it.
 */
async function replayable(req, res, next, { table, reply, message }, work) {
  const firmId = req.user.firm_id;
  await ensureKeys();
  const ref = clientRef(req);
  if (ref) {
    const prior = await findByRef(table, firmId, ref);
    if (prior) return res.success({ ...reply(prior), replayed: true }, message);
  }
  return Promise.resolve()
    .then(() => work(ref))
    .catch(async (err) => {
      /* Two copies in flight at once: the index stopped the second. Answer
         with the document the first one wrote. */
      if (ref && isDuplicateRef(err)) {
        const prior = await findByRef(table, firmId, ref);
        if (prior) return res.success({ ...reply(prior), replayed: true }, message);
      }
      return next(err);
    });
}

module.exports = { ensureKeys, clientRef, findByRef, isDuplicateRef, replayable };
