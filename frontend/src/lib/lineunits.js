/**
 * lineunits.js — switching a document line between its base and secondary unit.
 *
 * Same rules as the POS `flip`, extracted so invoices and purchases behave
 * identically and can't drift from the till. A line carries:
 *   base_unit, secondary_unit, conversion_rate  (1 base = rate secondary)
 *   unit           — the unit currently shown/edited
 *   use_secondary  — whether `unit` is the secondary one
 *   rate           — price per the CURRENT unit
 *   base_rate      — remembered base price while flipped (so flipping back is exact)
 *
 * qty × rate (the money) is preserved across a flip: switch to a unit that's
 * 50× smaller and the price per unit drops 50×, the quantity rises 50×.
 */
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/** Fields to copy onto a line when an item is picked, enabling the unit switch. */
export function unitFieldsFromItem(it) {
  return {
    unit: it.unit || "",
    base_unit: it.unit || "",
    secondary_unit: it.secondary_unit || null,
    conversion_rate: Number(it.conversion_rate) || 0,
    secondary_price: Number(it.secondary_price) || 0,
    use_secondary: false,
    base_rate: null,
  };
}

/** True when a line actually has a second unit to switch to. */
export function canFlip(l) {
  return !!(l && l.secondary_unit && Number(l.conversion_rate) > 0);
}

/** Return the patch that flips a line to its other unit (or {} if it can't). */
export function flipLine(l) {
  const cr = Number(l.conversion_rate) || 0;
  if (!canFlip(l)) return {};
  if (!l.use_secondary) {
    const secRate = Number(l.secondary_price) > 0 ? Number(l.secondary_price) : Number(l.rate) / cr;
    return {
      use_secondary: true, unit: l.secondary_unit, base_rate: Number(l.rate) || 0,
      rate: r2(secRate), quantity: r3((Number(l.quantity) || 0) * cr),
    };
  }
  const baseRate = l.base_rate != null ? Number(l.base_rate) : Number(l.rate) * cr;
  return {
    use_secondary: false, unit: l.base_unit, base_rate: null,
    rate: r2(baseRate), quantity: Math.max(0.001, r3((Number(l.quantity) || 0) / cr)),
  };
}
