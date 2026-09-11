const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { listQuery, sendList } = require("../../shared/paginate");
const { postJournal, round2 } = require("../../shared/accounting.poster");
const { voidLedger, logAudit, today: todayStr } = require("../../shared/voucher");
const { CODES } = require("../../shared/account.codes");

/* Typed write-off reasons post to their own accounts, so "stock went missing"
   becomes something you can actually report on. */
const REASON_ACCOUNTS = {
  opening: CODES.CAPITAL,        // opening stock is owner-funded, not an expense
  damaged: CODES.STOCK_ADJ,
  expired: CODES.STOCK_ADJ,
  stolen: CODES.STOCK_ADJ,
  sample: CODES.STOCK_ADJ,
  own_use: CODES.STOCK_ADJ,
  correction: CODES.STOCK_ADJ,
};
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");

router.use(verifyToken);

router.get("/", requirePermission("items", "view"), async (req, res) => {
  const result = await listQuery({
    req,
    select: `SELECT i.*,
            (SELECT name FROM item_categories c WHERE c.id = i.category_id) AS category_name,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS on_hand
       FROM items i`,
    countFrom: "FROM items i",
    where: ["i.firm_id = ?"], args: [req.user.firm_id],
    orderBy: "i.name",
    searchCols: ["i.name", "i.item_code", "i.barcode"],
  });
  const rows = result.rows;
  const bmap = {};
  for (const b of (await query("SELECT item_id, barcode FROM item_barcodes WHERE firm_id = ?", [req.user.firm_id])).rows) {
    (bmap[b.item_id] = bmap[b.item_id] || []).push(b.barcode);
  }
  for (const r of rows) r.barcodes = (r.barcode ? [r.barcode] : []).concat(bmap[r.id] || []);
  sendList(res, result);
});

/* Screen-level aggregates for the Items page. Registered here, above "/:id",
   so Express never reads "overview" or "units-summary" as an item id. */
require("./overview.routes").attach(router, requirePermission);

/* Item detail + its transaction history (per-item drill-down) */
/**
 * The next free item code.
 *
 * Typing one is a small job done a thousand times, and done by hand it
 * produces HW-002, HW-2, hw-002 and HW-02 for four items on the same shelf —
 * after which no search matches and no import lines up. So the server issues
 * one: a prefix by kind, and the first number not already taken.
 *
 * Computed here rather than in the browser because only the server can see
 * every item; two counters entering stock at once would otherwise both be
 * offered the same code, and the second would find out at save time.
 *
 * Registered before `/:id` — Express matches in order, and "next-code" is a
 * perfectly good value for a parameter called id.
 */
router.get("/next-code", requirePermission("items", "view"), async (req, res) => {
  const service = String(req.query.type || "") === "service";
  const prefix = service ? "SV" : "IT";
  const rows = (await query(
    "SELECT item_code FROM items WHERE firm_id = ? AND item_code LIKE ?",
    [req.user.firm_id, `${prefix}-%`])).rows;
  let max = 0;
  for (const r of rows) {
    const m = /^[A-Z]{2}-(\d+)$/.exec(String(r.item_code || "").toUpperCase());
    if (m) max = Math.max(max, Number(m[1]));
  }
  const next = `${prefix}-${String(max + 1).padStart(4, "0")}`;
  res.success({ code: next });
});

/**
 * Which batches of an item are on the shelf, and when each goes off.
 *
 * The books have held stock per batch since batch tracking shipped, and a sale
 * has always issued from the earliest-expiring batch first. What was missing
 * was any way to SEE that: a pharmacist selling a box could not tell which
 * batch was about to go, and could not deliberately sell a different one when
 * a customer wanted a longer date.
 *
 * Ordered the way the issue works, so the list reads top-down as the order the
 * stock will actually leave: dated batches by expiry, then undated ones oldest
 * first, which is FIFO for anything that does not expire.
 *
 * Registered before `/:id`, or "batches" is read as an item id.
 */
router.get("/:id/batches", requirePermission("items", "view"), async (req, res) => {
  const firm = req.user.firm_id;
  const item = (await query("SELECT id, name, unit FROM items WHERE id = ? AND firm_id = ?",
    [req.params.id, firm])).rows[0];
  if (!item) return res.notFound("Item not found");

  const rows = (await query(
    `SELECT batch_no, quantity, avg_cost, expiry_date,
            CASE WHEN expiry_date IS NULL THEN NULL
                 ELSE CAST(julianday(expiry_date) - julianday('now') AS INTEGER) END AS days_left
       FROM item_stock
      WHERE firm_id = ? AND item_id = ? AND quantity > 0
      ORDER BY (expiry_date IS NULL), expiry_date, id`, [firm, item.id])).rows;

  res.success({
    item,
    rows,
    /* Said here rather than worked out in four different screens. */
    expired: rows.filter((r) => r.days_left != null && r.days_left < 0).length,
    tracked: rows.some((r) => r.batch_no || r.expiry_date),
  });
});

router.get("/:id", requirePermission("items", "view"), async (req, res) => {
  const it = (await query(
    `SELECT i.*, COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id),0) AS on_hand
       FROM items i WHERE i.id = ? AND i.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!it) return res.notFound("Item not found");
  it.stock_value = +(it.on_hand * it.purchase_price).toFixed(2);
  it.barcodes = (it.barcode ? [it.barcode] : []).concat(
    (await query("SELECT barcode FROM item_barcodes WHERE firm_id = ? AND item_id = ?", [req.user.firm_id, it.id])).rows.map((r) => r.barcode));
  it.transactions = (await query(
    `SELECT m.move_date AS d, m.direction, m.quantity, m.unit_cost, m.source_module, m.source_id,
            CASE m.source_module
              WHEN 'sales' THEN (SELECT invoice_no FROM sale_invoices WHERE id = m.source_id)
              WHEN 'purchases' THEN (SELECT bill_no FROM purchase_invoices WHERE id = m.source_id)
              WHEN 'sale_returns' THEN (SELECT note_no FROM sale_returns WHERE id = m.source_id)
              WHEN 'purchase_returns' THEN (SELECT note_no FROM purchase_returns WHERE id = m.source_id)
              ELSE m.source_module END AS ref
       FROM stock_movements m WHERE m.firm_id = ? AND m.item_id = ?
      ORDER BY m.id DESC LIMIT 100`,
    [req.user.firm_id, req.params.id]
  )).rows;

  /* How much of this moved this month — the design prints it under the stock
     value, so the figure has to come back with the item rather than being
     counted from the hundred-row transaction window above, which may not
     reach far enough back. */
  it.sold_this_month = Math.round(+((await query(
    `SELECT COALESCE(SUM(COALESCE(l.base_quantity, l.quantity)), 0) AS q
       FROM sale_invoice_lines l JOIN sale_invoices s ON s.id = l.invoice_id
      WHERE l.firm_id = ? AND l.item_id = ?
        AND strftime('%Y-%m', s.invoice_date) = strftime('%Y-%m', 'now')`,
    [req.user.firm_id, req.params.id]
  )).rows[0] || {}).q || 0);

  /* A service holds no stock, so it has no movements — what it has instead is
     bookings. Same panel on screen, different source. */
  if (String(it.item_type || "product") === "service") {
    it.bookings = (await query(
      `SELECT s.invoice_no AS ref, s.invoice_date AS d, l.quantity, l.taxable_value AS amount,
              COALESCE((SELECT name FROM parties p WHERE p.id = s.party_id), 'Cash Sale') AS party,
              COALESCE((SELECT full_name FROM users u WHERE u.id = s.sales_rep_id), '') AS staff
         FROM sale_invoice_lines l JOIN sale_invoices s ON s.id = l.invoice_id
        WHERE l.firm_id = ? AND l.item_id = ?
        ORDER BY s.invoice_date DESC, s.id DESC LIMIT 20`,
      [req.user.firm_id, req.params.id]
    )).rows;
    it.booked_total = it.bookings.reduce((a, b) => a + (+b.amount || 0), 0);
  }

  res.success(it);
});

/* Edit item */
/**
 * Bulk active/inactive.
 *
 * The screen that drives this previously issued one PUT per item, which is
 * tolerable for fifty and slow for a thousand — and each request re-validated
 * and rewrote the whole row to change a single flag. One statement, one
 * transaction, one audit entry.
 */
router.post("/bulk-active", requirePermission("items", "edit"), async (req, res, next) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.fail("No items selected");
  const active = b.is_active ? 1 : 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    /* Scoped to the firm in the statement itself, so an id from another firm
       simply matches nothing rather than being trusted from the request. */
    const marks = ids.map(() => "?").join(",");
    await conn.query(
      `UPDATE items SET is_active = ? WHERE firm_id = ? AND id IN (${marks})`,
      [active, req.user.firm_id, ...ids]);
    const changed = (await conn.query(
      `SELECT COUNT(*) n FROM items WHERE firm_id = ? AND is_active = ? AND id IN (${marks})`,
      [req.user.firm_id, active, ...ids])).rows[0].n;
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", active ? "bulk_activate" : "bulk_deactivate", null,
       `${changed} item(s)`]);
    await conn.commit();
    res.success({ updated: changed, is_active: active },
      `${changed} item${changed === 1 ? "" : "s"} marked ${active ? "active" : "inactive"}`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* ── Bulk update ───────────────────────────────────────────────────────────
 *
 * The one endpoint in this application that can change every price in the shop
 * in a single request. It is written to that standard rather than to the
 * standard of the screen that calls it.
 *
 * Five properties, each of which exists because its absence would be a real
 * failure rather than an inconvenience:
 *
 * 1. **All or nothing.** One transaction. A batch that fails on item 180 of
 *    300 leaves nothing behind. A half-applied price change is worse than a
 *    refused one: the shop does not know which half, and the only way to find
 *    out is to read 300 rows.
 *
 * 2. **Validated before anything is written.** Every id, every price and every
 *    name is checked in a first pass, and the whole request is refused with the
 *    first genuine problem named. Discovering a bad price on row 200 after 199
 *    have been written is what rollback is for, but not needing the rollback is
 *    better — and the message can then say which row.
 *
 * 3. **Only what changed is written.** A field whose new value equals its old
 *    one is dropped, so the audit log records changes rather than submissions,
 *    and a shopkeeper who opened the screen and saved without editing anything
 *    does not generate 300 rows saying nothing happened.
 *
 * 4. **One audit row per changed item, naming the field and both values.**
 *    Round eleven found `PUT /items/:id` could change an item with no audit row
 *    at all. Doing that 300 times at once, on prices, would leave a shop unable
 *    to answer "who put the cement up". Every row records old→new, so the
 *    change is reversible by inspection.
 *
 * 5. **Firm-scoped in the statement.** Ids arrive off the wire. They are
 *    resolved against `items WHERE firm_id = ?` and anything that does not
 *    match is refused by count, never silently skipped — a request that asked
 *    to change 300 items and changed 299 must not report success.
 */

/* A ceiling, not a limit anyone will meet. A shop with 4,000 items can send
   them all; a client looping without a terminating condition cannot. */
const BULK_MAX = 5000;

/* Fields this endpoint is allowed to write, with how to read each one off the
   wire. Anything not named here is ignored rather than trusted — which is what
   stops a crafted body from setting `firm_id` or `id`. */
const BULK_FIELDS = {
  name:           { kind: "text",  required: true },
  description:    { kind: "text" },
  item_code:      { kind: "text" },
  hsn_sac:        { kind: "text" },
  barcode:        { kind: "text" },
  unit:           { kind: "text" },
  secondary_unit: { kind: "text" },
  category_id:    { kind: "id" },
  tax_rate_id:    { kind: "id" },
  sale_price:     { kind: "money" },
  purchase_price: { kind: "money" },
  wholesale_price:{ kind: "money" },
  mrp:            { kind: "money" },
  secondary_price:{ kind: "money" },
  conversion_rate:{ kind: "number" },
  reorder_level:  { kind: "number" },
  default_qty:    { kind: "number" },
  warranty_months:{ kind: "number" },
  is_active:      { kind: "bool" },
  track_serials:  { kind: "bool" },
};

const normalise = (kind, raw) => {
  if (kind === "text") return raw === null || raw === undefined ? null : String(raw).trim();
  if (kind === "id")   return raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (kind === "bool") return raw ? 1 : 0;
  return Number(raw);                                  // money | number
};

/* Same value, allowing for the fact that SQLite hands back 42000 where the
   form sends "42000". Without this every save would rewrite every row it was
   shown and the audit log would be noise. */
const same = (kind, a, b) => {
  if (kind === "text") return (a ?? "") === (b ?? "");
  if (kind === "id")   return (a ?? null) === (b ?? null);
  return Number(a || 0) === Number(b || 0);
};

router.put("/bulk", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const b = req.body || {};
  const rows = Array.isArray(b.items) ? b.items : [];
  const priceList = b.price_list && b.price_list.id ? b.price_list : null;

  if (!rows.length && !(priceList && (priceList.prices || []).length)) {
    return res.fail("Nothing to save", 400);
  }
  if (rows.length > BULK_MAX) {
    return res.fail(`That is ${rows.length} items in one save. The most this will take at once is ${BULK_MAX}.`, 400);
  }

  /* ── pass one: resolve every id, in one query ── */
  const ids = [...new Set(rows.map((r) => Number(r.id)).filter(Boolean))];
  if (ids.length !== rows.length) return res.fail("The same item appears twice in this batch", 400);
  let known = new Map();
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    for (const it of (await query(`SELECT * FROM items WHERE firm_id = ? AND id IN (${marks})`, [firmId, ...ids])).rows) {
      known.set(it.id, it);
    }
    if (known.size !== ids.length) {
      /* Named by count rather than by id: an id that is not ours should not be
         confirmed as existing somewhere else. */
      return res.fail(`${ids.length - known.size} of the ${ids.length} items in this batch could not be found`, 404);
    }
  }

  /* Duplicate names are refused by the same rule the single-item edit uses, so
     bulk is not a way around a setting the shop has deliberately switched on. */
  const { getSetting } = require("../settings/settings.service");
  const allowDupes = await getSetting(firmId, "allow_duplicate_item_names", "0") === "1";

  /* ── pass two: work out what actually changes, and refuse bad input ── */
  const planned = [];
  const nameClaims = new Map();                        // lower(name) -> item id
  for (const r of rows) {
    const it = known.get(Number(r.id));
    const changes = {};
    for (const [field, spec] of Object.entries(BULK_FIELDS)) {
      if (!(field in r)) continue;                     // absent means "leave alone"
      const val = normalise(spec.kind, r[field]);

      if (spec.kind === "money" || spec.kind === "number") {
        if (!Number.isFinite(val)) return res.fail(`${it.name}: "${r[field]}" is not a number`, 400);
        if (val < 0) return res.fail(`${it.name}: ${field.replace(/_/g, " ")} cannot be negative`, 400);
      }
      if (spec.required && spec.kind === "text" && !val) {
        return res.fail(`An item cannot be left without a name (${it.name})`, 400);
      }
      if (same(spec.kind, it[field], val)) continue;   // property 3
      changes[field] = val;
    }

    /* A conversion rate of zero with a secondary unit set means "50 KG to the
       bag, where a bag is nothing" — every dual-unit figure derived from it is
       then a division by zero. The single-item form has no such guard, which is
       worth knowing separately. */
    const secUnit = "secondary_unit" in changes ? changes.secondary_unit : it.secondary_unit;
    const convRate = "conversion_rate" in changes ? changes.conversion_rate : it.conversion_rate;
    if (secUnit && !(Number(convRate) > 0)) {
      return res.fail(`${it.name}: a second unit needs how many of it make one ${changes.unit || it.unit}`, 400);
    }

    if (changes.name && !allowDupes) {
      const key = changes.name.toLowerCase();
      if (nameClaims.has(key)) return res.fail(`Two items in this batch would both be called "${changes.name}"`, 400);
      nameClaims.set(key, it.id);
      const dup = (await query("SELECT id FROM items WHERE firm_id = ? AND lower(name) = lower(?) AND id != ?",
        [firmId, changes.name, it.id])).rows[0];
      /* An item being renamed out of the way in the same batch is not a clash —
         swapping two names, or freeing one up, has to be possible. */
      const renamedAway = dup && rows.some((o) => Number(o.id) === dup.id && o.name &&
        String(o.name).trim().toLowerCase() !== changes.name.toLowerCase());
      if (dup && !renamedAway) {
        return res.fail(`An item named "${changes.name}" already exists`, 400);
      }
    }

    if (Object.keys(changes).length) planned.push({ it, changes });
  }

  /* Price-list rows are validated the same way, against a list that is ours. */
  let listRows = [];
  if (priceList) {
    const list = (await query("SELECT id, name FROM price_lists WHERE id = ? AND firm_id = ?",
      [priceList.id, firmId])).rows[0];
    if (!list) return res.notFound("Price list not found");
    for (const pr of priceList.prices || []) {
      const itemId = Number(pr.item_id);
      const price = Number(pr.price);
      if (!known.has(itemId) && !(await query("SELECT id FROM items WHERE id = ? AND firm_id = ?", [itemId, firmId])).rows[0]) {
        return res.fail("A price was sent for an item that is not on this list", 404);
      }
      if (!Number.isFinite(price) || price < 0) return res.fail("A price list price is not a number", 400);
      listRows.push({ itemId, price, listId: list.id, listName: list.name });
    }
  }

  /* ── pass three: write ── */
  for (const { it, changes } of planned) {
    const fields = Object.keys(changes);
    await conn.query(
      `UPDATE items SET ${fields.map((f) => `${f}=?`).join(", ")} WHERE id = ? AND firm_id = ?`,
      [...fields.map((f) => changes[f]), it.id, firmId]);
    /* old→new on every field, so the log answers "what was it before" without
       needing a backup restored to find out. */
    const detail = fields.map((f) => `${f}: ${it[f] ?? "—"} → ${changes[f] ?? "—"}`).join("; ");
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", "bulk_edit", it.id, `${it.name} — ${detail}`.slice(0, 900)]);
  }

  let priceChanges = 0;
  for (const { itemId, price, listId, listName } of listRows) {
    const ex = (await query("SELECT id, price FROM price_list_items WHERE firm_id=? AND list_id=? AND item_id=?",
      [firmId, listId, itemId])).rows[0];
    if (ex && Number(ex.price) === price) continue;    // property 3, again
    if (ex) await conn.query("UPDATE price_list_items SET price=? WHERE id=? AND firm_id=?", [price, ex.id, firmId]);
    else await conn.query("INSERT INTO price_list_items (firm_id, list_id, item_id, price) VALUES (?,?,?,?)",
      [firmId, listId, itemId, price]);
    const nm = (known.get(itemId) || (await query("SELECT name FROM items WHERE id=? AND firm_id=?", [itemId, firmId])).rows[0] || {}).name;
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", "bulk_price", itemId,
       `${nm} — ${listName}: ${ex ? ex.price : "—"} → ${price}`]);
    priceChanges++;
  }

  /* "Nothing changed" is decided here rather than before the loops, because a
     price-book row is only known to be unchanged once it has been compared
     against what is stored. Deciding earlier let a batch in which every one of
     forty prices matched report "Updated " — the word with nothing after it,
     which reads as a save that happened. Not an error either way: somebody
     opened the screen, thought better of it, and saved. */
  const parts = [];
  if (planned.length) parts.push(`${planned.length} item${planned.length === 1 ? "" : "s"}`);
  if (priceChanges) parts.push(`${priceChanges} price${priceChanges === 1 ? "" : "s"}`);
  return () => res.success({ updated: planned.length, prices: priceChanges },
    parts.length ? `Updated ${parts.join(" and ")}` : "Nothing had changed");
}));

router.put("/:id", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const it = (await query("SELECT * FROM items WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!it) return res.notFound("Item not found");
  const b = req.body || {};
  if (b.name && b.name.toLowerCase() !== (it.name || "").toLowerCase()) {
    const { getSetting } = require("../settings/settings.service");
    if (await getSetting(req.user.firm_id, "allow_duplicate_item_names", "0") !== "1") {
      const dup = (await query("SELECT id FROM items WHERE firm_id = ? AND lower(name) = lower(?) AND id != ?", [req.user.firm_id, b.name, it.id])).rows[0];
      if (dup) return res.fail(`An item named "${b.name}" already exists. Enable "Allow duplicate item names" in Items → Preferences to permit this.`);
    }
  }
  await conn.query(
    `UPDATE items SET name=?, unit=?, secondary_unit=?, conversion_rate=?, secondary_price=?, sales_account_code=?, cogs_account_code=?, track_serials=?, image=?, sale_price=?, purchase_price=?,
       markup_pct=?, price_change_allowed=?, reorder_level=?, warranty_months=?, category_id=?, is_active=?, color=?, default_qty=?
     WHERE id=?`,
    [b.name ?? it.name, b.unit ?? it.unit, b.secondary_unit ?? it.secondary_unit,
     b.conversion_rate != null ? Number(b.conversion_rate) : it.conversion_rate,
     b.secondary_price != null ? Number(b.secondary_price) : it.secondary_price,
     b.sales_account_code !== undefined ? (b.sales_account_code || null) : it.sales_account_code,
     b.cogs_account_code !== undefined ? (b.cogs_account_code || null) : it.cogs_account_code,
     b.track_serials !== undefined ? (b.track_serials ? 1 : 0) : it.track_serials,
     b.image !== undefined ? (b.image || null) : it.image,
     b.sale_price != null ? Number(b.sale_price) : it.sale_price,
     b.purchase_price != null ? Number(b.purchase_price) : it.purchase_price,
     b.markup_pct != null ? Number(b.markup_pct) : it.markup_pct,
     b.price_change_allowed != null ? (b.price_change_allowed ? 1 : 0) : it.price_change_allowed,
     b.reorder_level != null ? Number(b.reorder_level) : it.reorder_level,
     b.warranty_months != null ? Number(b.warranty_months) : it.warranty_months,
     b.category_id !== undefined ? (b.category_id || null) : it.category_id,
     b.is_active != null ? (b.is_active ? 1 : 0) : it.is_active,
     b.color !== undefined ? (b.color || null) : it.color,
     b.default_qty !== undefined ? (Number(b.default_qty) || 1) : (it.default_qty || 1),
     it.id]);
  /* The edit and the line in the audit log are one unit: an item that changed
     with nothing recorded, or a log entry for a change that did not happen,
     are both worse than the edit failing outright. */
  await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
    [req.user.id, "items", "edit", it.id, b.name || it.name]);
  return () => res.success({ ok: true }, "Item updated");
}));

/* Delete item — blocked once used in any document; deactivate instead */
router.delete("/:id", requirePermission("items", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const id = req.params.id, f = req.user.firm_id;
  /* Establish the item is ours before saying anything about it. The statements
     below were all firm-scoped, so nothing was ever written across the line —
     but the reply still came back "deactivated" for an id belonging to another
     business, which confirms that id exists and who it is used by. */
  const own = (await query("SELECT id FROM items WHERE id = ? AND firm_id = ?", [id, f])).rows[0];
  if (!own) return res.notFound("Item not found");
  /* Usage is counted within this firm only. Unscoped, another business's
     invoices could pin one of our items as "has history" and make it
     undeletable for a reason nobody here can see. */
  const used = (await query(
    `SELECT (SELECT COUNT(*) FROM sale_invoice_lines WHERE firm_id=? AND item_id=?) +
            (SELECT COUNT(*) FROM purchase_invoice_lines WHERE firm_id=? AND item_id=?) +
            (SELECT COUNT(*) FROM stock_movements WHERE firm_id=? AND item_id=? AND source_module != 'opening') AS n`,
    [f, id, f, id, f, id])).rows[0].n;
  if (used > 0) {
    await conn.query("UPDATE items SET is_active = 0 WHERE id = ? AND firm_id = ?", [id, f]);
    return () => res.success({ deactivated: true }, "Item has transaction history — deactivated instead of deleted");
  }
  /* Four deletes, one unit. Half of this — barcodes and stock gone, the item
     still on the shelf — is an item nobody can scan and nobody can fix. */
  await conn.query("DELETE FROM item_barcodes WHERE item_id = ? AND firm_id = ?", [id, f]);
  await conn.query("DELETE FROM item_stock WHERE item_id = ? AND firm_id = ?", [id, f]);
  await conn.query("DELETE FROM stock_movements WHERE item_id = ? AND firm_id = ?", [id, f]);
  await conn.query("DELETE FROM items WHERE id = ? AND firm_id = ?", [id, f]);
  return () => res.success({ deleted: true }, "Item deleted");
}));

/* Extra barcodes: group same-priced flavours under one item */
router.post("/:id/barcodes", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const code = String((req.body || {}).barcode || "").trim();
  if (!code) return res.fail("Enter a barcode");
  const clash = (await query(
    `SELECT i.name FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.firm_id=? AND b.barcode=?
     UNION SELECT name FROM items WHERE firm_id=? AND barcode=?`, [req.user.firm_id, code, req.user.firm_id, code])).rows[0];
  if (clash) return res.fail(`That barcode already belongs to "${clash.name}"`);
  await conn.query("INSERT INTO item_barcodes (firm_id, item_id, barcode) VALUES (?,?,?)", [req.user.firm_id, req.params.id, code]);
  return () => res.success({ ok: true }, "Barcode added");
}));
router.delete("/:id/barcodes/:code", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  await conn.query("DELETE FROM item_barcodes WHERE firm_id=? AND item_id=? AND barcode=?",
    [req.user.firm_id, req.params.id, req.params.code]);
  return () => res.success({ ok: true }, "Barcode removed");
}));

/* Manual stock adjustment (ADJUST ITEM) */
/* The hand adjustments made against one item, newest first — the list the
   Adjust dialog shows so one can be taken back. */
router.get("/:id/adjustments", requirePermission("items", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const rows = (await query(
    `SELECT m.id, m.direction, m.quantity, m.unit_cost, m.move_date,
            COALESCE(u.full_name, u.username) AS by_name,
            EXISTS (SELECT 1 FROM stock_movements r
                     WHERE r.firm_id = m.firm_id AND r.source_module = 'adjustment_void'
                       AND r.source_id = m.id) AS reversed
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.created_by
      WHERE m.firm_id = ? AND m.item_id = ? AND m.source_module = 'adjustment'
      ORDER BY m.id DESC LIMIT 50`, [firmId, req.params.id])).rows;
  res.success(rows);
});

/**
 * Take back a stock adjustment.
 *
 * The advice until now was to make an opposite adjustment. That leaves two
 * wrong entries in the item's ledger where there was one, and no way for
 * anybody reading it later to tell a correction from a second real count — so
 * "wrote off 40 units, wrote on 40 units" and "genuinely lost 40 and found 40"
 * look identical. This marks the reversal as a reversal.
 */
router.post("/adjustments/:moveId/reverse", requirePermission("items", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const m = (await query(
      "SELECT * FROM stock_movements WHERE id = ? AND firm_id = ? AND source_module = 'adjustment'",
      [req.params.moveId, firmId])).rows[0];
    if (!m) return res.fail("Adjustment not found", 404);
    const already = (await query(
      "SELECT 1 FROM stock_movements WHERE firm_id = ? AND source_module = 'adjustment_void' AND source_id = ?",
      [firmId, m.id])).rows[0];
    if (already) return res.fail("That adjustment has already been taken back", 400);

    const it = (await query("SELECT name, unit FROM items WHERE id = ? AND firm_id = ?", [m.item_id, firmId])).rows[0] || {};
    const qty = Number(m.quantity) || 0;
    const back = m.direction === "in" ? "out" : "in";

    /* Taking back a stock-IN removes units. If they have since been sold the
       shelf would go negative, so it is refused rather than quietly allowed —
       the same rule the purchase-bill void follows, for the same reason. */
    if (back === "out") {
      const st = (await query("SELECT COALESCE(SUM(quantity),0) q FROM item_stock WHERE firm_id=? AND item_id=?",
        [firmId, m.item_id])).rows[0];
      if (Number(st.q) + 0.0001 < qty) {
        return res.fail(
          `That adjustment put ${qty} ${it.unit || ""} on the shelf and only ${Number(st.q)} ${it.unit || ""} ${Number(st.q) === 1 ? "is" : "are"} left — taking it back now would leave "${it.name}" below zero.`,
          409);
      }
    }

    await conn.beginTransaction();
    await voidLedger(conn, { firmId, sources: ["adjustment"], sourceId: m.id,
      docNo: `adjustment #${m.id}`, userId: req.user.id, date: todayStr() });
    await conn.query(
      `INSERT INTO stock_movements (firm_id, item_id, batch_no, direction, quantity, unit_cost,
                                    source_module, source_id, move_date, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [firmId, m.item_id, m.batch_no || "", back, qty, m.unit_cost || 0,
       "adjustment_void", m.id, todayStr(), req.user.id]);
    const delta = back === "in" ? qty : -qty;
    const ex = (await conn.query("SELECT id FROM item_stock WHERE firm_id=? AND item_id=? AND batch_no=?",
      [firmId, m.item_id, m.batch_no || ""])).rows[0];
    if (ex) await conn.query("UPDATE item_stock SET quantity = ROUND(quantity + ?, 4) WHERE id = ?", [delta, ex.id]);
    else await conn.query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)",
      [firmId, m.item_id, m.batch_no || "", delta, m.unit_cost || 0]);
    await logAudit(conn, { userId: req.user.id, module: "items", action: "reverse_adjust", entityId: m.item_id,
      detail: `adjustment #${m.id} (${m.direction} ${qty}) taken back` });
    await conn.commit();
    res.success({ id: m.id, reversed: true }, `Adjustment taken back — ${qty} ${it.unit || ""} ${back === "in" ? "back on" : "off"} the shelf`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

router.post("/:id/adjust", requirePermission("items", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const qty = Number(b.quantity) || 0;
    if (qty <= 0) return res.fail("Enter a quantity", 400);
    const dir = b.direction === "out" ? "out" : "in";
    const it = (await query("SELECT * FROM items WHERE id = ? AND firm_id = ? AND is_inventory = 1", [req.params.id, req.user.firm_id])).rows[0];
    if (!it) return res.notFound("Item not found");
    await conn.beginTransaction();
    /* The movement's own id becomes the source of its ledger entry.
     *
     * It used to post with `sourceId: it.id` — the ITEM's id — so every
     * adjustment ever made to one item shared a single source. Nothing broke
     * while adjustments could only be made, but it meant an adjustment could
     * never be individually undone: reversing "the adjustment" would have
     * reversed all of them at once, because the ledger had no way to tell them
     * apart. One row, one identity, and each can now be taken back on its own.
     */
    const mv = await conn.query(
      `INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module, source_id, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.firm_id, it.id, dir, qty, it.purchase_price, "adjustment", null, req.user.id]
    );
    const moveId = mv.insertId;
    await conn.query("UPDATE stock_movements SET source_id = ? WHERE id = ?", [moveId, moveId]);
    const delta = dir === "in" ? qty : -qty;
    const ex = (await conn.query("SELECT id FROM item_stock WHERE firm_id = ? AND item_id = ? AND batch_no = ''", [req.user.firm_id, it.id])).rows[0];
    if (ex) await conn.query("UPDATE item_stock SET quantity = quantity + ? WHERE id = ?", [delta, ex.id]);
    else await conn.query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)", [req.user.firm_id, it.id, "", delta, it.purchase_price]);
    // Adjustments move value as well as quantity, so they must hit the ledger too —
    // otherwise Inventory on the balance sheet drifts away from what's on the shelf.
    const unitCost = Number(it.purchase_price) || 0;
    const value = round2(qty * unitCost);
    if (value > 0.004) {
      const reasonCode = REASON_ACCOUNTS[b.reason] || CODES.STOCK_ADJ;
      await postJournal(conn, {
        firmId: req.user.firm_id, date: new Date().toISOString().slice(0, 10),
        description: `Stock ${dir === "in" ? "in" : "out"} — ${it.name}${b.reason ? ` (${b.reason})` : ""}`,
        reference: b.note || null, sourceModule: "adjustment", sourceId: moveId, userId: req.user.id,
        lines: dir === "in"
          ? [{ account_code: CODES.STOCK, debit: value }, { account_code: reasonCode, credit: value }]
          : [{ account_code: reasonCode, debit: value }, { account_code: CODES.STOCK, credit: value }],
      });
    }
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", "adjust", it.id, `${dir} ${qty} — ${b.reason || ""} ${b.note || ""}`]);
    await conn.commit();
    res.success({ ok: true, id: moveId }, "Stock adjusted");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

router.post("/", requirePermission("items", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const b = req.body || {};
    /* Zoho-style item preferences (Items → ⋯ → Preferences) */
    const { getSetting } = require("../settings/settings.service");
    if (await getSetting(req.user.firm_id, "allow_duplicate_item_names", "0") !== "1") {
      const dup = (await query("SELECT id, is_active FROM items WHERE firm_id = ? AND lower(name) = lower(?)",
        [req.user.firm_id, b.name || ""])).rows[0];
      if (dup) {
        await conn.rollback(); conn.release();
        /* A deactivated item is still an item, and its history still points at
           that name. Saying only "already exists" about something the list
           does not show is how somebody concludes the app is wrong: the reply
           says where it is instead. */
        return res.fail(dup.is_active === 0
          ? `There is already a deactivated item called "${b.name}". Turn on "Show deactivated" in Items and reactivate it, or give this one a different name.`
          : `An item named "${b.name}" already exists. Enable "Allow duplicate item names" in Items → Preferences to permit this.`);
      }
    }
    const trackDefault = await getSetting(req.user.firm_id, "inventory_tracking_default", "1") === "1";
    const isInventory = b.item_type === "service" ? 0 : (b.is_inventory != null ? (b.is_inventory ? 1 : 0) : (trackDefault ? 1 : 0));
    const r = await conn.query(
      `INSERT INTO items (firm_id, item_code, name, item_type, is_inventory, hsn_sac, unit, barcode, sale_price, purchase_price, price_inclusive, tax_rate_id, reorder_level, category_id, wholesale_price, mrp, description, secondary_unit, conversion_rate, secondary_price, sales_account_code, cogs_account_code, track_serials, image)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.firm_id, b.item_code || null, b.name, b.item_type || "product",
       isInventory, b.hsn_sac || null, b.unit || "PCS", b.barcode || null,
       Number(b.sale_price) || 0, Number(b.purchase_price) || 0, b.price_inclusive ? 1 : 0,
       b.tax_rate_id || null, Number(b.reorder_level) || 0, b.category_id || null,
       Number(b.wholesale_price) || 0, Number(b.mrp) || 0, b.description || null,
       b.secondary_unit || null, Number(b.conversion_rate) || 0, Number(b.secondary_price) || 0, b.sales_account_code || null, b.cogs_account_code || null, b.track_serials ? 1 : 0, b.image || null]
    );
    const newId = r.insertId || (await query("SELECT id FROM items WHERE firm_id=? AND name=? ORDER BY id DESC", [req.user.firm_id, b.name])).rows[0].id;
    if (b.markup_pct != null || b.price_change_allowed != null) {
      await query("UPDATE items SET markup_pct=?, price_change_allowed=?, color=? WHERE id=?",
        [Number(b.markup_pct) || 0, b.price_change_allowed === 0 || b.price_change_allowed === false ? 0 : 1, b.color || null, newId]);
      await query("UPDATE items SET default_qty=? WHERE id=?", [Number(b.default_qty) || 1, newId]);
    }
    if (Array.isArray(b.barcodes)) {
      for (const code of b.barcodes.map((x) => String(x).trim()).filter(Boolean)) {
        try { await query("INSERT INTO item_barcodes (firm_id, item_id, barcode) VALUES (?,?,?)", [req.user.firm_id, newId, code]); } catch {}
      }
    }
    const itemId = r.insertId;
    // Opening stock as an inventory movement, if provided
    const opening = Number(b.opening_stock) || 0;
    if (opening > 0 && b.item_type !== "service") {
      /* Opening stock is real stock, and in a pharmacy or a grocery it already
         has a batch and a date printed on it. Dropping them here meant the
         first sale of a newly-added item could never issue earliest-expiry
         first: the only batch on the shelf had no expiry to compare. */
      const openBatch = String(b.opening_batch_no || "").trim();
      const openExpiry = b.opening_expiry_date || null;
      await conn.query(
        `INSERT INTO stock_movements (firm_id, item_id, batch_no, direction, quantity, unit_cost, source_module, created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [req.user.firm_id, itemId, openBatch, "in", opening, Number(b.purchase_price) || 0, "opening", req.user.id]
      );
      await conn.query(
        "INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost, expiry_date) VALUES (?,?,?,?,?,?)",
        [req.user.firm_id, itemId, openBatch, opening, Number(b.purchase_price) || 0, openExpiry]
      );
    }
    await conn.commit();
    res.success({ id: itemId }, "Item saved");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* Stock ledger — every in and out for one item, with the running balance.
   This is what you open when a quantity looks wrong, and what an auditor asks for. */
router.get("/:id/ledger", requirePermission("items", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const it = (await query("SELECT id, name, unit, purchase_price FROM items WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!it) return res.notFound("Item not found");
  const conds = ["m.firm_id = ?", "m.item_id = ?"]; const args = [f, req.params.id];
  if (req.query.from) { conds.push("date(m.move_date) >= ?"); args.push(req.query.from); }
  if (req.query.to) { conds.push("date(m.move_date) <= ?"); args.push(req.query.to); }
  const rows = (await query(
    `SELECT m.id, m.move_date, m.direction, m.quantity, m.unit_cost, m.batch_no,
            m.source_module, m.source_id, u.username AS who
       FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by
      WHERE ${conds.join(" AND ")} ORDER BY m.id`, args)).rows;

  // opening balance = everything before the window
  let opening = 0;
  if (req.query.from) {
    const o = (await query(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN quantity ELSE -quantity END),0) v
         FROM stock_movements WHERE firm_id=? AND item_id=? AND date(move_date) < ?`,
      [f, req.params.id, req.query.from])).rows[0];
    opening = +Number(o.v).toFixed(3);
  }
  let bal = opening;
  const ledger = rows.map((r) => {
    const q = Number(r.quantity) || 0;
    bal = +(bal + (r.direction === "in" ? q : -q)).toFixed(3);
    return { ...r, in_qty: r.direction === "in" ? q : 0, out_qty: r.direction === "out" ? q : 0, balance: bal };
  });
  res.success({ item: it, opening, closing: bal, rows: ledger });
});

/* Stock ageing — where capital is sitting still.
   Buckets stock by how long since it last moved, and flags items that haven't
   sold at all in the window: that's money on a shelf rather than in the till. */
router.get("/reports/ageing", requirePermission("items", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await query(
    `SELECT i.id, i.name, i.item_code, i.unit, i.created_at,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id),0) AS on_hand,
            COALESCE((SELECT AVG(NULLIF(avg_cost,0)) FROM item_stock s WHERE s.item_id=i.id AND s.firm_id = i.firm_id), i.purchase_price, 0) AS unit_cost,
            (SELECT MAX(date(m.move_date)) FROM stock_movements m WHERE m.item_id=i.id AND m.direction='in') AS last_in,
            (SELECT MAX(date(m.move_date)) FROM stock_movements m WHERE m.item_id=i.id AND m.direction='out') AS last_out
       FROM items i
      WHERE i.firm_id=? AND i.is_inventory=1 AND i.is_active=1`, [f])).rows;

  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const out = [];
  for (const r of rows) {
    const qty = Number(r.on_hand) || 0;
    if (qty <= 0) continue;
    const value = +(qty * (Number(r.unit_cost) || 0)).toFixed(2);
    const ageFrom = r.last_in || r.last_out;
    const ageDays = ageFrom ? Math.floor((Date.parse(today) - Date.parse(ageFrom)) / 86400000) : null;
    const idleDays = r.last_out ? Math.floor((Date.parse(today) - Date.parse(r.last_out)) / 86400000) : null;
    const key = ageDays == null || ageDays > 90 ? "90+" : ageDays > 60 ? "61-90" : ageDays > 30 ? "31-60" : "0-30";
    buckets[key] = +(buckets[key] + value).toFixed(2);
    /* How long the item has existed at all. An item cannot be "not selling"
       for longer than it has been on the books. */
    const onBooks = r.created_at
      ? Math.floor((Date.parse(today) - Date.parse(String(r.created_at).slice(0, 10))) / 86400000)
      : null;
    out.push({ item_id: r.id, name: r.name, item_code: r.item_code, unit: r.unit,
               on_hand: qty, unit_cost: +Number(r.unit_cost).toFixed(2), value,
               last_in: r.last_in, last_out: r.last_out, age_days: ageDays, idle_days: idleDays,
               on_books_days: onBooks, bucket: key });
  }
  out.sort((a, b) => (b.idle_days === null ? 1e9 : b.idle_days) - (a.idle_days === null ? 1e9 : a.idle_days) || b.value - a.value);
  const total = +out.reduce((a, r) => a + r.value, 0).toFixed(2);
  const deadDays = Number(req.query.dead_days) || 90;
  /* Never sold counts as dead only once the item has been on the books for the
     whole window — otherwise something added minutes ago is called dead stock. */
  const dead = out.filter((r) =>
    (r.on_books_days === null || r.on_books_days >= deadDays) &&
    (r.idle_days === null || r.idle_days >= deadDays));
  res.success({
    total_value: total, buckets, rows: out.slice(0, 300),
    dead_days: deadDays,
    dead_value: +dead.reduce((a, r) => a + r.value, 0).toFixed(2),
    dead_count: dead.length,
  });
});

module.exports = router;
