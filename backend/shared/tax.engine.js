/**
 * tax.engine.js — Uganda-style configurable tax chain.
 *
 * Instead of per-line GST slabs, taxes are firm-level RULES applied in order
 * to the invoice running total. Each rule: { name, rate, mode, apply_order }.
 *   mode 'deduct'  → amount = running * rate/100; running -= amount
 *                    (e.g. URA 6% withholding tax deducted from invoice value)
 *   mode 'add'     → amount = running * rate/100; running += amount
 *                    (classic add-on tax)
 *
 * Default Uganda chain (seeded, editable in Settings → Taxes):
 *   1. Income Tax (WHT) 6% deduct   → total − 6%
 *   2. VAT 18% deduct               → result − 18%  = grand total
 * Example: 1,000 → WHT 60 → 940 → VAT 169.20 → grand 770.80
 *
 * PURE: no DB, no I/O. Deterministic 2dp rounding per step; optional
 * invoice-level round-off to the nearest shilling at the end.
 */
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function computeLine(line) {
  const qty = Number(line.quantity) || 0;
  const rate = Number(line.rate) || 0;
  let gross = qty * rate;
  let discount = 0;
  if (line.discount_pct) discount = gross * (Number(line.discount_pct) / 100);
  else if (line.discount_amt) discount = Number(line.discount_amt) || 0;
  const taxable = r2(Math.max(gross - discount, 0));
  return { taxable_value: taxable, discount_amt: r2(discount), line_total: taxable };
}

/**
 * @param {boolean} pricesIncludeTax  the prices typed on the lines already
 *   contain the ADD-mode taxes (Settings → Transactions → "Prices include
 *   tax"). See the note below; it does nothing to deduct-mode rules, and it
 *   does nothing at all when the shop has no add-mode rules.
 */
function computeInvoice({ lines, rules = [], roundOff = true, roundTo = 1, pricesIncludeTax = false }) {
  let computed = lines.map((ln) => ({ ...ln, ...computeLine(ln) }));
  let sub_total = r2(computed.reduce((a, l) => a + l.taxable_value, 0));
  const discount_total = r2(computed.reduce((a, l) => a + l.discount_amt, 0));

  const active = [...rules]
    .filter((x) => x && Number(x.is_active ?? 1) !== 0)
    .sort((a, b) => (a.apply_order || 0) - (b.apply_order || 0));

  /* ── prices that already include tax ──────────────────────────────────────
   *
   * This only means anything for ADD-mode rules, and that is not a
   * simplification — it is what the words mean. A deduct rule (Uganda's
   * withholding tax, and VAT as this app's default chain applies it) is taken
   * *out* of the price the customer pays, so the entered price already is the
   * gross: there is nothing to include. An add rule is put *on top*, so a shop
   * that prices its shelf at 11,800 including 18% VAT is stating a total, not
   * a base.
   *
   * So the add-mode taxes are taken back out of the entered total first, and
   * the ordinary chain then runs on what is left. The customer pays what the
   * shelf said, and the tax lines say how much of it was tax — which is the
   * whole point of the setting, and the reason a shop turns it on: they price
   * in round numbers.
   *
   * Every line is scaled, not just the total, so `sub_total` stays the sum of
   * its lines. A shop reading a line's taxable value on a report and adding
   * them up must get the figure on the invoice.
   */
  const addFactor = active
    .filter((x) => x.mode === "add")
    .reduce((f, x) => f * (1 + (Number(x.rate) || 0) / 100), 1);
  if (pricesIncludeTax && addFactor > 1) {
    computed = computed.map((l) => {
      const taxable = r2(l.taxable_value / addFactor);
      return { ...l, taxable_value: taxable, line_total: taxable, tax_inclusive_entered: r2(l.taxable_value) };
    });
    sub_total = r2(computed.reduce((a, l) => a + l.taxable_value, 0));
  }

  let running = sub_total;
  const taxes = [];
  for (const rule of active) {
    const amount = r2(running * (Number(rule.rate) || 0) / 100);
    running = r2(rule.mode === "add" ? running + amount : running - amount);
    taxes.push({ name: rule.name, rate: Number(rule.rate) || 0, mode: rule.mode === "add" ? "add" : "deduct", amount, running_after: running });
  }
  const deducted_total = r2(taxes.filter((t) => t.mode === "deduct").reduce((a, t) => a + t.amount, 0));
  const added_total = r2(taxes.filter((t) => t.mode === "add").reduce((a, t) => a + t.amount, 0));

  const before = running;
  // roundTo lets a shop round cash totals to the nearest 50 or 100 shillings,
  // because coins below that aren't really in circulation.
  const step = Number(roundTo) > 1 ? Number(roundTo) : 1;
  const grand = roundOff ? Math.round(before / step) * step : before;
  const round_off = r2(grand - before);

  return {
    lines: computed,
    totals: {
      sub_total, discount_total, taxes,
      /* Recorded so a reader can tell a 10,000 invoice priced inclusively from
         one priced exclusively, which otherwise look identical on the page. */
      prices_include_tax: !!(pricesIncludeTax && addFactor > 1),
      deducted_total, added_total,
      tax_total: r2(deducted_total + added_total),  // total tax levied (abs)
      round_off, grand_total: r2(grand),
    },
  };
}

module.exports = { computeInvoice, computeLine, r2 };
