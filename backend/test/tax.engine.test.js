/**
 * Tests for shared/tax.engine.js — the invoice/receipt maths.
 *
 * These lock down the behaviour two of this month's bugs violated: a disabled
 * rule must not apply, and the order of add/deduct rules must be respected.
 */
const { describe, it, expect } = require("./tiny-test");
const { computeInvoice, computeLine } = require("../shared/tax.engine");

const T = (out) => out.totals;   // backend nests totals

describe("computeLine", () => {
  it("multiplies quantity by rate", () => {
    expect(computeLine({ quantity: 2, rate: 42000 }).taxable_value).toBe(84000);
  });
  it("applies a percentage discount", () => {
    expect(computeLine({ quantity: 10, rate: 1000, discount_pct: 5 }).taxable_value).toBe(9500);
  });
  it("applies a flat discount", () => {
    expect(computeLine({ quantity: 10, rate: 1000, discount_amt: 500 }).taxable_value).toBe(9500);
  });
  it("never lets a discount push the line negative", () => {
    expect(computeLine({ quantity: 1, rate: 100, discount_amt: 999 }).taxable_value).toBe(0);
  });
  it("handles a fractional quantity (dual-unit sale)", () => {
    expect(computeLine({ quantity: 0.2, rate: 1000 }).taxable_value).toBe(200);
  });
});

describe("computeInvoice — no tax", () => {
  it("sums the lines", () => {
    const o = computeInvoice({ lines: [{ quantity: 2, rate: 42000 }, { quantity: 3, rate: 4500 }], rules: [] });
    expect(T(o).sub_total).toBe(97500);
    expect(T(o).grand_total).toBe(97500);
  });
  it("reports zero tax when there are no rules", () => {
    expect(T(computeInvoice({ lines: [{ quantity: 1, rate: 1000 }], rules: [] })).tax_total).toBe(0);
  });
});

describe("computeInvoice — tax rules", () => {
  const VAT = { name: "VAT", rate: 18, mode: "add", apply_order: 1 };
  const WHT = { name: "WHT", rate: 6, mode: "deduct", apply_order: 1 };

  it("adds VAT on top", () => {
    const o = computeInvoice({ lines: [{ quantity: 1, rate: 1000 }], rules: [VAT], roundOff: false });
    expect(T(o).added_total).toBe(180);
    expect(T(o).grand_total).toBe(1180);
  });

  it("deducts withholding tax", () => {
    const o = computeInvoice({ lines: [{ quantity: 1, rate: 1000 }], rules: [WHT], roundOff: false });
    expect(T(o).deducted_total).toBe(60);
    expect(T(o).grand_total).toBe(940);
  });

  it("applies rules in apply_order — WHT on the base, then VAT on the remainder", () => {
    const o = computeInvoice({
      lines: [{ quantity: 1, rate: 1000 }],
      rules: [{ ...WHT, apply_order: 1 }, { name: "VAT", rate: 18, mode: "add", apply_order: 2 }],
      roundOff: false,
    });
    // 1000 − 60 (WHT) = 940, then +18% of 940 = 169.20 → 1109.20
    expect(T(o).grand_total).toBeCloseTo(1109.2, 2);
  });

  // THE REGRESSION TEST for this month's tax bug:
  it("IGNORES a rule whose is_active is 0", () => {
    const o = computeInvoice({
      lines: [{ quantity: 1, rate: 1000 }],
      rules: [{ ...VAT, is_active: 0 }],
      roundOff: false,
    });
    expect(T(o).tax_total).toBe(0);
    expect(T(o).grand_total).toBe(1000);
  });

  it("treats a missing is_active as active (older rows)", () => {
    const rule = { name: "VAT", rate: 18, mode: "add", apply_order: 1 };  // no is_active field
    expect(T(computeInvoice({ lines: [{ quantity: 1, rate: 1000 }], rules: [rule], roundOff: false })).grand_total).toBe(1180);
  });
});

describe("computeInvoice — cash rounding", () => {
  it("rounds the grand total to the nearest whole unit by default", () => {
    const o = computeInvoice({ lines: [{ quantity: 1, rate: 999.6 }], rules: [] });
    expect(T(o).grand_total).toBe(1000);
    expect(T(o).round_off).toBeCloseTo(0.4, 2);
  });
  it("rounds to the nearest 100 when asked", () => {
    const o = computeInvoice({ lines: [{ quantity: 1, rate: 1240 }], rules: [], roundTo: 100 });
    expect(T(o).grand_total).toBe(1200);
  });
  it("leaves the total exact when rounding is off", () => {
    const o = computeInvoice({ lines: [{ quantity: 1, rate: 999.6 }], rules: [], roundOff: false });
    expect(T(o).grand_total).toBe(999.6);
  });
});

describe("computeInvoice — prices that already include tax", () => {
  const VAT_ADD = { name: "VAT", rate: 18, mode: "add", apply_order: 1 };
  const VAT_DEDUCT = { name: "VAT", rate: 18, mode: "deduct", apply_order: 1 };
  const inc = (opts) => T(computeInvoice({ roundOff: false, pricesIncludeTax: true, ...opts }));
  const exc = (opts) => T(computeInvoice({ roundOff: false, ...opts }));

  it("**the customer pays what the shelf said**", () => {
    /* The whole point of the setting: a shop that prices in round numbers gets
       a round number at the till. Exclusive, the same 11,800 becomes 13,924. */
    expect(inc({ lines: [{ quantity: 1, rate: 11800 }], rules: [VAT_ADD] }).grand_total).toBe(11800);
    expect(exc({ lines: [{ quantity: 1, rate: 11800 }], rules: [VAT_ADD] }).grand_total).toBe(13924);
  });

  it("…and the tax line says how much of it was tax", () => {
    const o = inc({ lines: [{ quantity: 1, rate: 11800 }], rules: [VAT_ADD] });
    expect(o.sub_total).toBe(10000);
    expect(o.taxes[0].amount).toBe(1800);
  });

  it("marks the invoice, so an inclusive one can be told from an exclusive one", () => {
    expect(inc({ lines: [{ quantity: 1, rate: 11800 }], rules: [VAT_ADD] }).prices_include_tax).toBe(true);
    expect(exc({ lines: [{ quantity: 1, rate: 11800 }], rules: [VAT_ADD] }).prices_include_tax).toBe(false);
  });

  it("**does nothing to a deduct chain**", () => {
    /* A withholding tax is taken OUT of the price the customer pays, so an
       entered price already is the gross and there is nothing to include.
       Silently rescaling one would change every shop's takings on upgrade. */
    const lines = [{ quantity: 1, rate: 11800 }];
    expect(inc({ lines, rules: [VAT_DEDUCT] }).grand_total)
      .toBe(exc({ lines, rules: [VAT_DEDUCT] }).grand_total);
  });

  it("does nothing when the shop has no tax rules at all", () => {
    const lines = [{ quantity: 2, rate: 500 }];
    expect(inc({ lines, rules: [] }).grand_total).toBe(exc({ lines, rules: [] }).grand_total);
  });

  it("leaves the deduct part of a mixed chain alone", () => {
    /* 11,800 inclusive of the 18% added → 10,000 base; then 6% withheld. */
    const rules = [VAT_ADD, { name: "WHT", rate: 6, mode: "deduct", apply_order: 2 }];
    const o = inc({ lines: [{ quantity: 1, rate: 11800 }], rules });
    expect(o.sub_total).toBe(10000);
    expect(o.taxes[0].amount).toBe(1800);
    expect(o.taxes[1].amount).toBe(708);          // 6% of 11,800
    expect(o.grand_total).toBe(11092);
  });

  it("**the lines still add up to the sub-total**", () => {
    /* Scaling the total but not its lines would make every line-level report
       disagree with the invoice it came from — and nothing would say so. */
    /* `inc` hands back only the totals, and this check is about the lines —
       so it uses the whole result. */
    const o = computeInvoice({ lines: [{ quantity: 3, rate: 1180 }, { quantity: 1, rate: 590 }],
      rules: [VAT_ADD], roundOff: false, pricesIncludeTax: true });
    const summed = Math.round(o.lines.reduce((a, l) => a + l.taxable_value, 0) * 100) / 100;
    expect(summed).toBe(o.totals.sub_total);
  });

  it("handles two add rules by taking both back out", () => {
    const rules = [VAT_ADD, { name: "Levy", rate: 10, mode: "add", apply_order: 2 }];
    const o = inc({ lines: [{ quantity: 1, rate: 12980 }], rules });   // 10,000 × 1.18 × 1.10
    expect(o.sub_total).toBe(10000);
    expect(o.grand_total).toBe(12980);
  });
});
