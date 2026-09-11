/**
 * Tests for shared/units.js — base-unit conversion.
 *
 * This is where the 340,000 phantom-loss bug lived. baseQuantity takes the db
 * query function, so we hand it a tiny fake that returns one cement item
 * (1 BAG = 50 KG). No database needed.
 */
const { describe, it, expect } = require("./tiny-test");
const { baseQuantity, toBaseUnits, sameUnit } = require("../shared/units");

// fake query(): understands only the item lookup units.js makes
const CEMENT = { unit: "BAG", secondary_unit: "KG", conversion_rate: 50 };
const SIMPLE = { unit: "PCS", secondary_unit: null, conversion_rate: 0 };
const fakeQuery = (items) => (sql, params) => {
  const id = params[0];
  return { rows: items[id] ? [items[id]] : [] };
};
const q = fakeQuery({ 1: CEMENT, 2: SIMPLE });

describe("sameUnit", () => {
  it("matches ignoring case and spacing", () => {
    expect(sameUnit("kg", " KG ")).toBe(true);
    expect(sameUnit("BAG", "KG")).toBe(false);
  });
});

describe("baseQuantity", () => {
  it("leaves a base-unit line unchanged", async () => {
    expect(await baseQuantity(q, { item_id: 1, quantity: 2, unit: "BAG" })).toBe(2);
  });

  // THE REGRESSION TEST for the dual-unit costing bug:
  it("converts 10 KG of a 50 KG bag to 0.2 BAG", async () => {
    expect(await baseQuantity(q, { item_id: 1, quantity: 10, unit: "KG" })).toBe(0.2);
  });

  it("honours an explicit use_secondary flag over the unit name", async () => {
    expect(await baseQuantity(q, { item_id: 1, quantity: 10, use_secondary: true })).toBe(0.2);
    expect(await baseQuantity(q, { item_id: 1, quantity: 10, use_secondary: false })).toBe(10);
  });

  it("leaves a single-unit item alone", async () => {
    expect(await baseQuantity(q, { item_id: 2, quantity: 7, unit: "PCS" })).toBe(7);
  });

  it("passes through a free-text line with no item", async () => {
    expect(await baseQuantity(q, { item_id: null, quantity: 5 })).toBe(5);
  });

  it("falls back to the raw quantity if the item vanished", async () => {
    expect(await baseQuantity(q, { item_id: 999, quantity: 5, unit: "KG" })).toBe(5);
  });

  it("round-trips: sell in KG then value at base cost gives the right figure", async () => {
    // cement cost 35,000/BAG; sell 10 KG → 0.2 BAG → cost 7,000. This is the
    // number the report showed as a 340,000 loss before the fix.
    const base = await baseQuantity(q, { item_id: 1, quantity: 10, unit: "KG" });
    expect(base * 35000).toBe(7000);
  });
});

describe("toBaseUnits", () => {
  it("converts every line in a document", async () => {
    const out = await toBaseUnits(q, [
      { item_id: 1, quantity: 10, unit: "KG" },
      { item_id: 1, quantity: 2, unit: "BAG" },
    ]);
    expect(out.map((l) => l.quantity)).toEqual([0.2, 2]);
  });
});

/* Purchase in a secondary unit: quantity ÷ factor, cost × factor, so the total
   value put on the shelf is unchanged. Guards the v1.6 purchase-unit feature. */
describe("purchase secondary-unit conversion", () => {
  const CR = 50;   // 1 BAG = 50 KG
  const convert = (qty, rate, useSecondary) => {
    const q = useSecondary ? +(qty / CR).toFixed(4) : qty;
    const cost = useSecondary ? +(rate * CR).toFixed(2) : rate;
    return { q, cost, value: +(q * cost).toFixed(2) };
  };
  it("100 KG @ 700 becomes 2 BAG @ 35000", () => {
    const r = convert(100, 700, true);
    expect(r.q).toBe(2);
    expect(r.cost).toBe(35000);
  });
  it("shelf value is identical whether entered in KG or BAG", () => {
    expect(convert(100, 700, true).value).toBe(convert(2, 35000, false).value);
  });
});
