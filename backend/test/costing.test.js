/**
 * Tests for the costing and accounting maths.
 *
 * postMovement and postJournal both take a live db connection, so rather than
 * fake the whole SQL layer (brittle, and it would test the fake as much as the
 * code) these lock down the two FORMULAS inside them that actually carry risk:
 * weighted-average cost on a receipt, and the debit=credit invariant on a
 * journal. Those are the lines where a mistake silently corrupts the books.
 *
 * The formulas are transcribed from the source with a comment pointing back, so
 * if someone changes the real code without changing it here, the intent is
 * still visible. When you adopt a real test db (see the engineering review),
 * these graduate to calling the functions directly.
 */
const { describe, it, expect } = require("./tiny-test");

/* ── weighted-average, exactly as stock.poster.js computes it on a receipt ── */
function newAvg(oldQty, oldAvg, inQty, inCost) {
  oldQty = Math.max(oldQty, 0);
  const denom = oldQty + inQty;
  return denom > 0 ? +(((oldQty * oldAvg) + (inQty * inCost)) / denom).toFixed(4) : inCost;
}

describe("weighted-average cost", () => {
  it("first receipt sets the cost", () => {
    expect(newAvg(0, 0, 100, 35000)).toBe(35000);
  });
  it("blends two receipts by quantity", () => {
    // 100 @ 35,000 then 100 @ 40,000 → 37,500
    expect(newAvg(100, 35000, 100, 40000)).toBe(37500);
  });
  it("weights by how much of each you hold", () => {
    // 300 @ 1000 then 100 @ 2000 → (300000 + 200000)/400 = 1250
    expect(newAvg(300, 1000, 100, 2000)).toBe(1250);
  });
  it("a receipt into negative stock doesn't distort the average", () => {
    // oversold to −10 then 20 in @ 500: negative clamped, so cost is the new lot
    expect(newAvg(-10, 500, 20, 500)).toBe(500);
  });
  it("keeps four decimals for fractional costs", () => {
    expect(newAvg(3, 100, 1, 100.005)).toBeCloseTo(100.0013, 3);
  });
});

/* ── journal balancing, as accounting.poster.js guards it ── */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function isBalanced(lines) {
  const dr = round2(lines.reduce((a, l) => a + (Number(l.debit) || 0), 0));
  const cr = round2(lines.reduce((a, l) => a + (Number(l.credit) || 0), 0));
  return dr === cr;
}

describe("journal entries balance", () => {
  it("a simple cash sale balances", () => {
    // customer pays 1180 cash; 1000 revenue + 180 VAT payable
    expect(isBalanced([
      { account_code: "1000", debit: 1180 },
      { account_code: "4000", credit: 1000 },
      { account_code: "2200", credit: 180 },
    ])).toBe(true);
  });
  it("an unbalanced entry is caught", () => {
    expect(isBalanced([
      { account_code: "1000", debit: 1180 },
      { account_code: "4000", credit: 1000 },
    ])).toBe(false);
  });
  it("rounding to 2dp keeps a real split balanced", () => {
    // 46,586.40 base: WHT 6% then VAT 18%, all rounded — must still tie out
    const sub = 46586.4;
    const wht = round2(sub * 0.06);
    const net = round2(sub - wht);
    const vat = round2(net * 0.18);
    const grand = round2(net + vat);
    expect(isBalanced([
      { account_code: "1000", debit: grand },
      { account_code: "4000", credit: net },
      { account_code: "2200", credit: vat },
    ])).toBe(true);
  });
});
