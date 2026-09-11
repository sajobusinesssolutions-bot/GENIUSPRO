/**
 * offers.routes.js — offers & promotions.
 *
 * An offer is a rule for giving money off. Evaluating one produces an ordinary
 * per-line discount percentage — the same field a cashier could have typed —
 * so promotions flow through the existing tax, posting and margin logic
 * untouched. There is deliberately no second discount system to keep in step.
 *
 * Offers are advisory at the till: the evaluator says what applies and why,
 * and the cashier can still override. Everything is recomputed server-side, so
 * the numbers a customer is shown are the numbers the books use.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n) => +Number(n || 0).toFixed(2);
const moduleOn = async (firmId) => await getSetting(firmId, "mod_offers", "0") === "1";

/** Offers live today, best (lowest) priority first. */
async function liveOffers(firmId, on = today()) {
  return (await query(
    `SELECT * FROM offers
      WHERE firm_id = ? AND is_active = 1
        AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
        AND (ends_on   IS NULL OR ends_on   = '' OR ends_on   >= ?)
      ORDER BY priority, id`,
    [firmId, on, on]
  )).rows;
}

function describe(o) {
  if (o.offer_type === "bxgy") return `Buy ${o.buy_qty} get ${o.get_qty} free`;
  if (o.offer_type === "amount") return `Sh ${r2(o.value)} off`;
  return `${r2(o.value)}% off`;
}

/**
 * Work out what an offer is worth on one line.
 *
 * "Buy 3 get 1 free" is expressed as a discount percentage rather than an extra
 * free row, because a percentage is what the rest of the system already knows
 * how to tax, post and report on. Six items on a 3+1 deal means one free, which
 * is the same money as 16.67% off the six.
 */
function lineDiscountPct(o, line, item) {
  const qty = Number(line.quantity) || 0;
  const rate = Number(line.rate) || 0;
  const gross = qty * rate;
  if (qty <= 0 || gross <= 0) return 0;
  if (o.min_qty && qty < o.min_qty) return 0;
  if (o.min_amount && gross < o.min_amount) return 0;

  if (o.offer_type === "percent") return Math.min(100, Math.max(0, Number(o.value) || 0));
  if (o.offer_type === "amount") {
    /* A flat amount is per unit, so ten items get ten lots off. */
    const off = Math.min(gross, (Number(o.value) || 0) * qty);
    return +((off / gross) * 100).toFixed(4);
  }
  if (o.offer_type === "bxgy") {
    const buy = Number(o.buy_qty) || 0;
    const get = Number(o.get_qty) || 0;
    if (buy <= 0 || get <= 0) return 0;
    const groups = Math.floor(qty / (buy + get));
    const free = groups * get;
    if (free <= 0) return 0;
    return +((free / qty) * 100).toFixed(4);
  }
  return 0;
}

/** Does this offer point at this line's item? */
function matchesItem(o, item) {
  if (o.scope !== "item") return false;
  if (o.item_id) return item && Number(item.id) === Number(o.item_id);
  if (o.category) return item && String(item.category || "").toLowerCase() === String(o.category).toLowerCase();
  return true; // any item
}

/**
 * Evaluate every live offer against a basket.
 *
 * Item offers become per-line discounts; only the best one applies to a line,
 * so two promotions never silently stack into a loss. A bill offer then applies
 * to what is left after those.
 */
async function evaluate(firmId, lines, { on = today() } = {}) {
  const offers = await liveOffers(firmId, on);
  const itemOffers = offers.filter((o) => o.scope === "item");
  const billOffers = offers.filter((o) => o.scope === "bill");

  /* A loop, not .map(): each line looks its item up in the database, so the
     callback would be async and .map() would return promises. */
  const outLines = [];
  for (const [idx, l] of (lines || []).entries()) {
    const item = l.item_id ? (await query("SELECT * FROM items WHERE id = ? AND firm_id = ?", [l.item_id, firmId])).rows[0] : null;
    const gross = r2((Number(l.quantity) || 0) * (Number(l.rate) || 0));
    let best = null;
    for (const o of itemOffers) {
      if (!matchesItem(o, item)) continue;
      const pct = lineDiscountPct(o, l, item);
      if (pct <= 0) continue;
      if (!best || pct > best.discount_pct) best = { offer_id: o.id, offer_name: o.name, label: describe(o), discount_pct: pct };
    }
    outLines.push({
      index: idx, item_id: l.item_id || null, gross,
      discount_pct: best ? best.discount_pct : 0,
      discount_amount: best ? r2(gross * best.discount_pct / 100) : 0,
      applied: best || null,
    });
  }

  const afterItem = r2(outLines.reduce((a, l) => a + l.gross - l.discount_amount, 0));

  let bill = null;
  for (const o of billOffers) {
    if (o.min_amount && afterItem < o.min_amount) continue;
    const amount = o.offer_type === "amount"
      ? Math.min(afterItem, Number(o.value) || 0)
      : r2(afterItem * (Number(o.value) || 0) / 100);
    if (amount <= 0) continue;
    if (!bill || amount > bill.amount) bill = { offer_id: o.id, offer_name: o.name, label: describe(o), amount: r2(amount) };
  }

  return {
    lines: outLines,
    item_discount: r2(outLines.reduce((a, l) => a + l.discount_amount, 0)),
    bill_discount: bill ? bill.amount : 0,
    bill_offer: bill,
    total_discount: r2(outLines.reduce((a, l) => a + l.discount_amount, 0) + (bill ? bill.amount : 0)),
    applied: [
      ...outLines.filter((l) => l.applied).map((l) => l.applied.offer_name),
      ...(bill ? [bill.offer_name] : []),
    ].filter((v, i, a) => a.indexOf(v) === i),
  };
}

/* ── Routes ───────────────────────────────────────────────────────────── */

router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT o.*, i.name AS item_name FROM offers o LEFT JOIN items i ON i.id = o.item_id
      WHERE o.firm_id = ? ORDER BY o.is_active DESC, o.priority, o.id DESC`,
    [req.user.firm_id]
  )).rows.map((o) => {
    const t = today();
    const started = !o.starts_on || o.starts_on <= t;
    const ended = o.ends_on && o.ends_on < t;
    return { ...o, summary: describe(o), live: !!o.is_active && started && !ended, expired: !!ended, pending: !started };
  });
  res.success(rows);
});

router.post("/", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Offers & promotions" in Settings → Modules first', 400);
  const b = req.body || {};
  if (!b.name) return res.fail("Give this offer a name", 400);
  const type = ["percent", "amount", "bxgy"].includes(b.offer_type) ? b.offer_type : "percent";
  const scope = b.scope === "bill" ? "bill" : "item";
  if (scope === "bill" && type === "bxgy") return res.fail("Buy-x-get-y applies to an item, not a whole bill", 400);
  if (type === "percent" && !(Number(b.value) > 0 && Number(b.value) <= 100)) return res.fail("A percentage must be between 0 and 100", 400);
  if (type === "amount" && !(Number(b.value) > 0)) return res.fail("Enter how much to take off", 400);
  if (type === "bxgy" && !(Number(b.buy_qty) > 0 && Number(b.get_qty) > 0)) return res.fail("Enter both the buy and the free quantity", 400);
  if (b.starts_on && b.ends_on && b.ends_on < b.starts_on) return res.fail("The offer ends before it starts", 400);

  const r = await conn.query(
    `INSERT INTO offers (firm_id, name, scope, offer_type, value, item_id, category,
       min_qty, min_amount, buy_qty, get_qty, starts_on, ends_on, priority, is_active, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [firmId, b.name, scope, type, Number(b.value) || 0, b.item_id || null, b.category || null,
     Number(b.min_qty) || 0, Number(b.min_amount) || 0, b.buy_qty || null, b.get_qty || null,
     b.starts_on || null, b.ends_on || null, Number(b.priority) || 0,
     b.is_active === false ? 0 : 1, b.notes || null, req.user.id]
  );
  return () => res.success({ id: r.insertId }, `"${b.name}" saved`);
}));

router.put("/:id", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const o = (await query("SELECT * FROM offers WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!o) return res.notFound("Offer not found");
  const b = req.body || {};
  await conn.query(
    `UPDATE offers SET name = COALESCE(?, name), value = COALESCE(?, value),
       item_id = ?, category = ?, min_qty = COALESCE(?, min_qty), min_amount = COALESCE(?, min_amount),
       buy_qty = ?, get_qty = ?, starts_on = ?, ends_on = ?, priority = COALESCE(?, priority),
       is_active = COALESCE(?, is_active), notes = ? WHERE id = ?`,
    [b.name || null, b.value ?? null, b.item_id ?? o.item_id, b.category ?? o.category,
     b.min_qty ?? null, b.min_amount ?? null, b.buy_qty ?? o.buy_qty, b.get_qty ?? o.get_qty,
     b.starts_on ?? o.starts_on, b.ends_on ?? o.ends_on, b.priority ?? null,
     b.is_active == null ? null : (b.is_active ? 1 : 0), b.notes ?? o.notes, o.id]
  );
  return () => res.success({ id: o.id }, "Offer updated");
}));

router.delete("/:id", requirePermission("sales", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const o = (await conn.query("SELECT * FROM offers WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!o) return res.notFound("Offer not found");
  await conn.query("DELETE FROM offers WHERE id = ?", [o.id]);
  return () => res.success({ id: o.id }, `"${o.name}" deleted — bills already raised keep the discount they were given`);
}));

/** What applies to this basket, and what it is worth. */
router.post("/evaluate", requirePermission("sales", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.success({ lines: [], item_discount: 0, bill_discount: 0, total_discount: 0, applied: [] });
  res.success(await evaluate(firmId, req.body?.lines || [], { on: req.body?.on }));
});

module.exports = router;
module.exports.evaluate = evaluate;
module.exports.lineDiscountPct = lineDiscountPct;
