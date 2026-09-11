// tax.js — client mirror of the Uganda tax chain, for LIVE totals as you type.
// The server recomputes authoritatively on save; this is UX only.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function computeInvoice({ lines, rules = [], roundOff = true, roundTo = 1, pricesIncludeTax = false }) {
  const out0 = lines.map((ln) => {
    const qty = Number(ln.quantity) || 0, rate = Number(ln.rate) || 0;
    let gross = qty * rate;
    const disc = ln.discount_pct ? gross * (Number(ln.discount_pct) / 100) : Number(ln.discount_amt) || 0;
    const taxable = r2(Math.max(gross - disc, 0));
    return { ...ln, gross: r2(gross), discount: r2(disc), taxable, line_total: taxable };
  });
  const gross_total = r2(out0.reduce((a, l) => a + l.gross, 0));
  const discount_total = r2(out0.reduce((a, l) => a + l.discount, 0));
  const active = [...rules].filter((x) => Number(x.is_active ?? 1) !== 0)
    .sort((a, b) => (a.apply_order || 0) - (b.apply_order || 0));

  /* Prices that already include the add-on taxes: take them back out first, so
     the total on screen is the total on the shelf. The reasoning — and why it
     touches add-mode rules only — is written once, on the server, in
     shared/tax.engine.js. This is the mirror that keeps the figure from
     jumping when the sale is saved. */
  const addFactor = active.filter((x) => x.mode === "add")
    .reduce((f, x) => f * (1 + (Number(x.rate) || 0) / 100), 1);
  const inclusive = pricesIncludeTax && addFactor > 1;
  const out = inclusive
    ? out0.map((l) => { const t = r2(l.taxable / addFactor); return { ...l, taxable: t, line_total: t }; })
    : out0;

  const sub_total = r2(out.reduce((a, l) => a + l.taxable, 0));
  let running = sub_total;
  const taxes = [];
  for (const rule of active) {
    const amount = r2(running * (Number(rule.rate) || 0) / 100);
    running = r2(rule.mode === "add" ? running + amount : running - amount);
    taxes.push({ name: rule.name, rate: rule.rate, mode: rule.mode === "add" ? "add" : "deduct", amount, running_after: running });
  }
  const before = running;
  const step = Number(roundTo) > 1 ? Number(roundTo) : 1;
  const grand = roundOff ? Math.round(before / step) * step : before;
  const tax_total = r2(taxes.reduce((a, t) => a + (t.mode === "add" ? t.amount : -t.amount), 0));
  return { lines: out, gross_total, discount_total, sub_total, taxes, tax_total,
           prices_include_tax: inclusive, round_off: r2(grand - before), grand_total: r2(grand) };
}

// UGX display: thousands-grouped, decimals only when needed.
/* Named inr() for historical reasons — this build is Ugandan and the grouping
   below is en-UG. Kept as-is because ~200 call sites import it; it formats a
   number and never carries a symbol, so the name is only cosmetic. */
export const inr = (n) => {
  const v = Number(n || 0);
  const dp = decimals();
  // With decimal places pinned in Settings, honour that exactly. Otherwise fall
  // back to the old behaviour: show cents only when there are any.
  const hasCents = Math.abs(v % 1) > 0.004;
  const min = dp === null ? (hasCents ? 2 : 0) : dp;
  const max = dp === null ? 2 : dp;
  const abs = Math.abs(v).toLocaleString("en-UG", { minimumFractionDigits: min, maximumFractionDigits: max });
  // proper minus sign in front of the number, not buried in the digits
  return v < 0 ? `\u2212${abs}` : abs;
};

/* One place that decides how money looks: "Sh 12,500" / "−Sh 12,500".
   The symbol comes from the currency_symbol setting via cur(), so switching
   the firm to UGX changes every label. Declared below but hoisted, so cur()
   is available here at call time. */
export const money = (n, { sign = false } = {}) => {
  const v = Number(n || 0);
  const body = `${cur()} ${inr(Math.abs(v))}`;
  if (v < 0) return `\u2212${body}`;
  return sign && v > 0 ? `+${body}` : body;
};

/* "4 BOX + 10 BTL" display for dual-unit items: base qty -> whole base + loose remainder.
 *
 * Worked out in loose units and split back, rather than splitting the base
 * figure directly. The old version floored the base quantity and multiplied
 * the leftover fraction, so a value a hair under a whole pack came back as
 * "119 BAG - 49 KG": a remainder that reads as subtracted, and on a negative
 * on-hand a whole part and a remainder pulling opposite ways. Everything below
 * runs on the magnitude, with the sign put back once at the end, so the two
 * parts always add up to the quantity they came from.
 *
 * The separator is a plus, because they add. It was a minus sign, which read
 * as loose stock owed rather than loose stock held.  */
export function dualQty(q, unit, secUnit, conv) {
  q = Number(q) || 0;
  const c = Number(conv) || 0;
  if (!secUnit || c <= 1) return `${+q.toFixed(2)} ${unit}`;
  const neg = q < 0;
  // normalise to loose units first, then re-split — the remainder cannot go negative
  const loose = Math.round(Math.abs(q) * c * 100) / 100;
  const whole = Math.floor(r2(loose / c));
  /* conversion_rate is a free REAL column — 2.5 BTL per BOX is legal — so the
     remainder is not necessarily whole and picks up float residue. Round it the
     way the rest of this file rounds. */
  const rem = r2(loose - whole * c);
  let body;
  if (rem === 0) body = `${whole} ${unit}`;
  else if (whole === 0) body = `${rem} ${secUnit}`;
  else body = `${whole} ${unit} + ${rem} ${secUnit}`;
  /* The sign belongs to the whole expression, not just its first term: prefixed
     to the whole part alone, "−1 BAG + 25 KG" reads as −0.5 BAG when the value
     is −1.5 BAG. Negative on-hand is real — it shows in the search palette — so
     bracket the two-part form. */
  if (!neg) return body;
  return whole === 0 || rem === 0 ? `−${body}` : `−(${body})`;
}

/* ── Currency symbol ───────────────────────────────────────────────────────
 * Settings exposes a `currency_symbol` key (default "Sh"), but every screen
 * printed the literal "Sh" instead, so changing it to UGX in Settings did
 * nothing anywhere — the same class of dead setting the tax-rule gating had.
 * One store, set once at boot, read by every money label.
 *
 * Seeded from localStorage so the first paint after a reload is already
 * correct rather than flashing the default and then correcting itself.
 */
let CURRENCY = "Sh";
try { CURRENCY = localStorage.getItem("vy_currency") || "Sh"; } catch { /* private mode */ }

export const cur = () => CURRENCY;

export function setCurrency(symbol) {
  CURRENCY = (symbol || "Sh").trim() || "Sh";
  try { localStorage.setItem("vy_currency", CURRENCY); } catch { /* ignore */ }
}

/* ── Decimal places ────────────────────────────────────────────────────────
 * Settings → General exposes `amount_decimals`, but only the Z report ever read
 * it — everywhere else guessed from the value, so the same figure appeared as
 * "Sh 42,000" on one screen and "Sh 3969300.00" on another. Stored the same way
 * as the currency symbol so first paint is already right.
 * null means "not configured — decide per value", preserving the old behaviour.
 */
let DECIMALS = null;
try {
  const saved = localStorage.getItem("vy_decimals");
  DECIMALS = saved === null || saved === "" ? null : Number(saved);
} catch { /* private mode */ }

export const decimals = () => (DECIMALS === null || Number.isNaN(DECIMALS) ? null : DECIMALS);

export function setDecimals(dp) {
  const n = dp === null || dp === undefined || dp === "" ? null : Number(dp);
  DECIMALS = n === null || Number.isNaN(n) ? null : Math.max(0, Math.min(4, n));
  try {
    if (DECIMALS === null) localStorage.removeItem("vy_decimals");
    else localStorage.setItem("vy_decimals", String(DECIMALS));
  } catch { /* ignore */ }
}

/* ── Date format ───────────────────────────────────────────────────────────
 * Settings → General exposes `date_format` (YYYY-MM-DD / DD/MM/YYYY /
 * MM/DD/YYYY). Nothing read it, so the app showed ISO in tables, US M/D/Y in
 * Cash & bank, "Aug 4, 2026" in Accounting and "8/4/2026, 3:15:35 AM" in
 * Shifts — four renderings of one date. fmtDate() is the single place now.
 */
let DATEFMT = "YYYY-MM-DD";
try { DATEFMT = localStorage.getItem("vy_datefmt") || "YYYY-MM-DD"; } catch { /* private mode */ }

export const dateFormat = () => DATEFMT;

export function setDateFormat(f) {
  const allowed = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"];
  DATEFMT = allowed.includes(f) ? f : "YYYY-MM-DD";
  try { localStorage.setItem("vy_datefmt", DATEFMT); } catch { /* ignore */ }
}

/** Format a date per the configured pattern. Falsy or unparseable → "—". */
export function fmtDate(value) {
  if (!value) return "—";
  let yyyy, mm, dd;
  /* A bare "YYYY-MM-DD" is parsed by Date as UTC midnight and then read back in
     local time, so anywhere west of UTC every invoice date, instalment due date
     and tax-period date rendered a day early. Take the parts straight off the
     string instead; only genuine datetimes go through Date. */
  const s = typeof value === "string" ? value.trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    [, yyyy, mm, dd] = m;
  } else {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    yyyy = d.getFullYear();
    mm = String(d.getMonth() + 1).padStart(2, "0");
    dd = String(d.getDate()).padStart(2, "0");
  }
  if (DATEFMT === "DD/MM/YYYY") return `${dd}/${mm}/${yyyy}`;
  if (DATEFMT === "MM/DD/YYYY") return `${mm}/${dd}/${yyyy}`;
  return `${yyyy}-${mm}-${dd}`;
}

/** Same, with a short time appended — for shift logs and audit rows. */
export function fmtDateTime(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${fmtDate(d)} ${t}`;
}
