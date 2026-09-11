/**
 * units.js — the one place that answers "how many BASE units is this line?"
 *
 * An item may be sold in a base unit or a secondary one (1 BAG = 50 KG). The
 * line stores the quantity in the unit it was SOLD in, but stock, cost and
 * profit all live in base units. Every consumer that converted this for itself
 * got it subtly different, and two of them didn't convert at all:
 *
 *   - the profit reports costed 10 KG as 10 BAGS  → a 340,000 "loss"
 *   - sale returns put 10 BAGS back on the shelf for a 10 KG refund
 *
 * One helper, used everywhere, so those can't drift apart again.
 */

const sameUnit = (a, b) =>
  String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();

/**
 * @param {function} query  the db query function
 * @param {object}   line   { item_id, quantity, unit?, use_secondary? }
 * @returns {number} quantity expressed in the item's base unit
 *
 * `use_secondary` is authoritative when the caller sends it (the POS does).
 * Otherwise the stored unit name is matched against the item's secondary unit,
 * which is how older documents and refunds are read.
 */
async function baseQuantity(query, line) {
  const qty = Number(line.quantity) || 0;
  if (!line.item_id) return qty;                       // free-text line
  const it = (await query(
    "SELECT unit, secondary_unit, conversion_rate FROM items WHERE id = ?",
    [line.item_id]
  )).rows[0];
  if (!it || !it.secondary_unit || !(Number(it.conversion_rate) > 0)) return qty;

  const inSecondary = line.use_secondary != null
    ? !!line.use_secondary
    : sameUnit(line.unit, it.secondary_unit);

  return inSecondary ? +(qty / Number(it.conversion_rate)).toFixed(4) : qty;
}

/** Same conversion applied across a document's lines, for the stock poster. */
async function toBaseUnits(query, lines) {
  /* A loop, not .map(): the conversion reads the item, so the callback would
     be async and .map() would return an array of promises — the stock poster
     would then subtract `[object Promise]` from the shelf. */
  const out = [];
  for (const ln of (lines || [])) out.push({ ...ln, quantity: await baseQuantity(query, ln) });
  return out;
}

module.exports = { baseQuantity, toBaseUnits, sameUnit };
