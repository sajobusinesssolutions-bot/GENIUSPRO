/**
 * sequences.js — gapless human-readable document numbers (blueprint §5.6).
 * nextSeq runs inside the caller's transaction so numbers never collide.
 * Sequences are namespaced per firm: e.g. "INV:firm3".
 */
function pad(n, width = 6) {
  return String(n).padStart(width, "0");
}

async function nextSeq(conn, name) {
  await conn.query(
    "INSERT INTO sequences (name, value) VALUES (?, 1) " +
    "ON CONFLICT(name) DO UPDATE SET value = value + 1",
    [name]
  );
  const { rows } = await conn.query("SELECT value FROM sequences WHERE name = ?", [name]);
  return rows[0].value;
}

/**
 * ensureUniqueDocNumbers — belt to nextSeq's braces.
 *
 * nextSeq is correct: the counter is bumped and read inside the caller's
 * transaction, so two tills cannot draw the same number, and firing 30
 * simultaneous sales does produce 30 distinct invoice numbers. But "correct"
 * here rests on every future caller staying inside a transaction and on nobody
 * reintroducing a MAX(invoice_no)+1 shortcut. A duplicate document number is
 * not something a shop discovers quickly — the second INV-000412 reads as a
 * reprint of the first — so it is worth having the database refuse it outright
 * rather than trusting the code above it.
 *
 * Installed on first use, like ensureIdempotencyKeys, because setup.js is
 * owned elsewhere. If an existing shop database already holds a duplicate the
 * index cannot be created; that is reported once and left alone rather than
 * stopping a till at opening time — those numbers are already on paper, and
 * only a human can decide which document keeps which.
 */
const DOC_NUMBER_INDEXES = [
  ["ux_sale_invoices_no", "sale_invoices", "firm_id, invoice_no"],
  ["ux_payments_no", "payments", "firm_id, payment_no"],
];

let docNumbersReady = false;
async function ensureUniqueDocNumbers(query) {
  if (docNumbersReady) return;
  docNumbersReady = true;
  for (const [name, table, cols] of DOC_NUMBER_INDEXES) {
    try {
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
    } catch (e) {
      console.error(
        `Could not make ${table}(${cols}) unique — this database already holds a duplicate. ` +
        `Documents keep working; the duplicate needs sorting out by hand. (${e.message})`
      );
    }
  }
}

module.exports = { nextSeq, pad, ensureUniqueDocNumbers };
