/* Items overview — the figures the redesigned Items screen puts above the list.
 *
 * The design shows three summary panels, a category table with a stock value
 * and margin per row, and a units table with a usage count. Every one of those
 * is an aggregate across the whole catalogue, so working them out in the
 * browser would mean shipping every item to compute three numbers. They are
 * done here instead, in one round trip each.
 *
 * Mounted by items.routes.js before its own `/:id` route, so that "overview"
 * is never mistaken for an item id.
 */
const { query } = require("../../database/db");
const { getSetting } = require("../settings/settings.service");

/* On-hand per item, as a joinable subquery. item_stock holds one row per
   batch, so a plain join would multiply the item across its batches. */
const ON_HAND = `(SELECT item_id, SUM(quantity) AS q FROM item_stock GROUP BY item_id)`;

const PRODUCT = `COALESCE(i.item_type, 'product') = 'product'`;
const SERVICE = `COALESCE(i.item_type, 'product') = 'service'`;
const LIVE = `COALESCE(i.status, 'active') = 'active'`;

function attach(router, requirePermission) {
  /* ── The three panels above the product list ── */
  router.get("/overview", requirePermission("items", "view"), async (req, res) => {
    const firm = req.user.firm_id;

    const prod = (await query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(COALESCE(oh.q, 0) * i.purchase_price), 0) AS val,
              COALESCE(SUM(CASE WHEN i.secondary_unit IS NOT NULL
                             AND TRIM(i.secondary_unit) <> ''
                             AND COALESCE(i.conversion_rate, 0) > 0
                        THEN 1 ELSE 0 END), 0) AS dual
         FROM items i LEFT JOIN ${ON_HAND} oh ON oh.item_id = i.id
        WHERE i.firm_id = ? AND ${PRODUCT} AND ${LIVE}`,
      [firm]
    )).rows[0] || {};

    const cats = (await query(
      `SELECT COUNT(*) AS n FROM item_categories WHERE firm_id = ?`, [firm]
    )).rows[0] || {};

    /* Running out: at or under the reorder level. Items with no reorder level
       set are not "running out" — they simply have no opinion about it.
       *
       * Settings → Items → "Low stock alerts" silences it. A shop that
       * restocks by looking at the shelf does not want a red figure telling it
       * about a threshold nobody set deliberately. */
    const low = await getSetting(firm, "low_stock_alert", "1") === "0" ? [] : (await query(
      `SELECT i.name
         FROM items i LEFT JOIN ${ON_HAND} oh ON oh.item_id = i.id
        WHERE i.firm_id = ? AND ${PRODUCT} AND ${LIVE}
          AND COALESCE(i.reorder_level, 0) > 0
          AND COALESCE(oh.q, 0) <= i.reorder_level
        ORDER BY (COALESCE(oh.q, 0) * 1.0) / i.reorder_level, i.name`,
      [firm]
    )).rows;

    /* Dead stock: still on the shelf, nothing sold off it in 60 days. Money
       sitting still is the point, so it is valued at cost.

       An item has to have been on the shelf for the whole window before
       "nothing sold in 60 days" says anything about it — one created this
       morning has not had the chance, and was being counted as dead the
       moment it was saved. Items with no created_at (pre-dating the column)
       are treated as old enough. */
    const dead = (await query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(oh.q, 0) * i.purchase_price), 0) AS val
         FROM items i LEFT JOIN ${ON_HAND} oh ON oh.item_id = i.id
        WHERE i.firm_id = ? AND ${PRODUCT} AND ${LIVE}
          AND COALESCE(oh.q, 0) > 0
          AND date(COALESCE(i.created_at, '0000-01-01')) <= date('now', '-60 day')
          AND NOT EXISTS (
                SELECT 1 FROM stock_movements m
                 WHERE m.firm_id = i.firm_id AND m.item_id = i.id
                   AND m.direction = 'out'
                   AND m.move_date >= date('now', '-60 day'))`,
      [firm]
    )).rows[0] || {};

    /* Services, this calendar month. A service holds no stock, so its margin
       is rate less the cost recorded against it. */
    const svc = (await query(
      `SELECT COUNT(DISTINCT i.id) AS n,
              COALESCE(SUM(l.taxable_value), 0) AS revenue,
              COALESCE(SUM(l.quantity), 0) AS bookings,
              COALESCE(SUM(l.quantity * i.purchase_price), 0) AS cost
         FROM items i
         LEFT JOIN sale_invoice_lines l ON l.item_id = i.id AND l.firm_id = i.firm_id
         LEFT JOIN sale_invoices s ON s.id = l.invoice_id
          AND strftime('%Y-%m', s.invoice_date) = strftime('%Y-%m', 'now')
        WHERE i.firm_id = ? AND ${SERVICE} AND ${LIVE} AND s.id IS NOT NULL`,
      [firm]
    )).rows[0] || {};

    const svcCount = (await query(
      `SELECT COUNT(*) AS n FROM items i WHERE i.firm_id = ? AND ${SERVICE} AND ${LIVE}`,
      [firm]
    )).rows[0] || {};

    const monthSales = (await query(
      `SELECT COALESCE(SUM(sub_total), 0) AS v FROM sale_invoices
        WHERE firm_id = ? AND strftime('%Y-%m', invoice_date) = strftime('%Y-%m', 'now')`,
      [firm]
    )).rows[0] || {};

    const svcRevenue = +svc.revenue || 0;
    const svcCost = +svc.cost || 0;
    const allSales = +monthSales.v || 0;

    res.success({
      products: {
        count: +prod.n || 0,
        stockValue: +prod.val || 0,
        dual: +prod.dual || 0,
        categories: +cats.n || 0,
      },
      lowStock: { count: low.length, names: low.slice(0, 3).map((r) => r.name) },
      deadStock: { count: +dead.n || 0, value: +dead.val || 0 },
      services: {
        count: +svcCount.n || 0,
        revenue: svcRevenue,
        bookings: Math.round(+svc.bookings || 0),
        marginPct: svcRevenue > 0 ? Math.round(((svcRevenue - svcCost) / svcRevenue) * 100) : 0,
        salesSharePct: allSales > 0 ? Math.round((svcRevenue / allSales) * 100) : 0,
      },
    });
  });

  /* ── Category table: one row per category, with what is in it ── */
  router.get("/categories-summary", requirePermission("items", "view"), async (req, res) => {
    const firm = req.user.firm_id;
    const rows = (await query(
      `SELECT c.id, c.name, c.color,
              COUNT(i.id) AS items,
              COALESCE(SUM(COALESCE(oh.q, 0) * i.purchase_price), 0) AS stock_value
         FROM item_categories c
         LEFT JOIN items i ON i.category_id = c.id AND i.firm_id = c.firm_id AND ${LIVE}
         LEFT JOIN ${ON_HAND} oh ON oh.item_id = i.id
        WHERE c.firm_id = ?
        GROUP BY c.id, c.name, c.color
        ORDER BY c.name`,
      [firm]
    )).rows;

    /* Sold and margin come from sale lines, so they are gathered separately
       rather than joined in above — joining both would cross-multiply the
       stock rows against the sale rows and inflate the value. */
    const sold = (await query(
      `SELECT i.category_id AS cid,
              COALESCE(SUM(l.quantity), 0) AS qty,
              COALESCE(SUM(l.taxable_value), 0) AS revenue,
              COALESCE(SUM(COALESCE(l.base_quantity, l.quantity) * i.purchase_price), 0) AS cost
         FROM sale_invoice_lines l
         JOIN items i ON i.id = l.item_id AND i.firm_id = l.firm_id
        WHERE l.firm_id = ? AND i.category_id IS NOT NULL
        GROUP BY i.category_id`,
      [firm]
    )).rows;
    const byCat = {};
    for (const r of sold) byCat[r.cid] = r;

    res.success(rows.map((r) => {
      const s = byCat[r.id] || { qty: 0, revenue: 0, cost: 0 };
      const rev = +s.revenue || 0;
      return {
        id: r.id,
        name: r.name,
        color: r.color || null,
        items: +r.items || 0,
        stockValue: +r.stock_value || 0,
        sold: Math.round(+s.qty || 0),
        marginPct: rev > 0 ? +(((rev - (+s.cost || 0)) / rev) * 100).toFixed(1) : null,
      };
    }));
  });

  /* ── Units table: how many items use each, and any conversion it is part of ──
     A unit is not itself a conversion pair — an item is what links two units.
     So the "converts to" column reports the pairing an item has actually set
     up, which is what the design's note under the form says. */
  router.get("/units-summary", requirePermission("items", "view"), async (req, res) => {
    const firm = req.user.firm_id;
    const units = (await query(
      `SELECT id, name, short FROM item_units WHERE firm_id = ? ORDER BY name`, [firm]
    )).rows;

    const usage = (await query(
      `SELECT UPPER(TRIM(COALESCE(i.unit, ''))) AS base,
              UPPER(TRIM(COALESCE(i.secondary_unit, ''))) AS sec,
              COALESCE(i.conversion_rate, 0) AS rate,
              COUNT(*) AS n
         FROM items i WHERE i.firm_id = ? AND ${LIVE}
        GROUP BY base, sec, rate`,
      [firm]
    )).rows;

    res.success(units.map((u) => {
      const short = String(u.short || "").trim().toUpperCase();
      let items = 0;
      let conv = "";
      for (const r of usage) {
        if (r.base === short) {
          items += r.n;
          if (!conv && r.sec && r.rate > 0) conv = `1 ${short} = ${r.rate} ${r.sec}`;
        } else if (r.sec === short && r.rate > 0) {
          items += r.n;
          if (!conv) conv = `loose from ${r.base}`;
        }
      }
      return { id: u.id, name: u.name, short: u.short, items, conv };
    }));
  });
}

module.exports = { attach };
