/**
 * durable.js — "saved" must mean "on disk".
 *
 * A bare `query()` write schedules the save for the end of the event-loop turn
 * (database/db.js:scheduleSave), which is *after* the reply has gone out to the
 * socket. A power cut in that window loses a write the till was told had
 * succeeded. `commit()` persists synchronously, so the fix for every ordinary
 * mutating handler is the same shape the money-moving ones already use:
 * acquire, begin, work, commit, rollback on throw, release in a `finally`.
 *
 * This is that shape, written once. It is lifted verbatim from the helper the
 * concurrency pass wrote in modules/pos/pos.routes.js — pos now requires it
 * from here rather than keeping a private copy, so there is one idiom in the
 * tree and not two.
 *
 * Usage:
 *
 *   router.put("/:id", perm, async (req, res, next) => durable(next, (conn) => {
 *     const row = conn.query("SELECT ...").rows[0];
 *     if (!row) return res.notFound("Not found");     // nothing written; rolls back
 *     conn.query("UPDATE ...");
 *     return () => res.success({ ok: true }, "Saved");  // sent AFTER the commit
 *   }));
 *
 * Three rules make it safe:
 *
 *  - `fn` returns a *function*. That function is called after commit(), so the
 *    client is never told "saved" before the bytes are on the platter. Returning
 *    anything else (the value of `res.fail(...)`, say) is read as "this handler
 *    refused and has already answered": the transaction is rolled back, so a
 *    refusal can never leave half a write behind.
 *  - `fn` may be async, and is awaited. It became async the day a query became
 *    a round-trip rather than a call into memory (see database/db.js), so the
 *    old rule — "fn is synchronous, awaiting real I/O in there would hold
 *    every other till up" — could no longer be kept. What holds instead is the
 *    write lock: `pool.getConnection()` queues, so however long a block takes,
 *    the transactions it guards still run one at a time and in order. Do not
 *    await anything *other* than the database in here; a block that waits on a
 *    web request is a block that holds the till up for as long as that takes.
 *  - a throw rolls back and goes to `next(err)` with the error untouched, so the
 *    caller still sees the message it saw before. `refuse()` is the escape hatch
 *    for a deliberate refusal raised from deep inside the block.
 *
 * Do not use it on a GET. A transaction around a read buys nothing and takes
 * the write mutex off the tills that need it.
 *
 * Nesting: acquireWriteLock() is not re-entrant, so a handler that calls a
 * service which opens its own transaction (recurring's generate, the restore
 * routes) must NOT be wrapped — it would deadlock against itself. Those are
 * left alone deliberately; they already commit through the transaction they
 * open further down.
 */
const { pool } = require("../database/db");

async function durable(next, fn, opts = {}) {
  /* `opts.central` opens the transaction on the central database rather than
     on the company's — for the handful of routes whose writes are about a
     company but live in the central file (firms, memberships, invitations).
     With one file it makes no difference at all. */
  const conn = await pool.getConnection(opts);
  try {
    await conn.beginTransaction();
    const reply = await fn(conn);    // returns a function that sends the response
    /* Not a function: the handler refused and answered for itself. Nothing it
       may have written is kept — a refusal is not a partial save. */
    if (typeof reply !== "function") { await conn.rollback(); return reply; }
    await conn.commit();
    return reply();
  } catch (err) {
    await conn.rollback();
    if (err && err.reply) return err.reply();   // a refusal, not a fault
    return next(err);
  } finally { conn.release(); }
}

/** Refuse from inside a `durable` block: rolls the transaction back, then answers. */
function refuse(send) { const e = new Error("refused"); e.reply = send; return e; }

module.exports = { durable, refuse };
