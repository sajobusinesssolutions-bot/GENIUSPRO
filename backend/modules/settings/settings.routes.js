const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { CATALOG, getAllSettings, setSetting } = require("./settings.service");
const { durable } = require("../../shared/durable");

router.use(verifyToken);

/* Settings catalog + current values, grouped by tab */
router.get("/", async (req, res) => {
  const values = await getAllSettings(req.user.firm_id);
  res.success({ catalog: CATALOG, values });
});

/* Every setting in one transaction: a page of preferences saves as a page, and
   "Settings saved" is only said once they are on disk. */
router.put("/", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async () => {
  const updates = req.body || {};
  const valid = new Set(CATALOG.map((c) => c.key));
  for (const [k, v] of Object.entries(updates)) if (valid.has(k)) await setSetting(req.user.firm_id, k, v);
  const saved = await getAllSettings(req.user.firm_id);
  return () => res.success(saved, "Settings saved");
}));

/* Firm profile */
router.get("/firm", async (req, res) => {
  res.success((await query("SELECT * FROM firms WHERE id = ?", [req.user.firm_id])).rows[0]);
});
router.put("/firm", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const f = ["name", "legal_name", "gstin", "state_code", "pan", "address", "phone", "email"];
  const sets = f.filter((k) => k in b).map((k) => `${k} = ?`);
  if (sets.length) await conn.query(`UPDATE firms SET ${sets.join(", ")} WHERE id = ?`, [...f.filter((k) => k in b).map((k) => b[k]), req.user.firm_id]);
  const firm = (await conn.query("SELECT * FROM firms WHERE id = ?", [req.user.firm_id])).rows[0];
  return () => res.success(firm, "Business updated");
}));

/* --- Master data: units, categories, party groups --- */
function masters(name, table) {
  router.get(`/${name}`, async (req, res) => res.success((await query(`SELECT * FROM ${table} WHERE firm_id = ? ORDER BY id`, [req.user.firm_id])).rows));
  router.post(`/${name}`, requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
    const b = req.body || {};
    try {
      if (table === "item_units") await conn.query("INSERT INTO item_units (firm_id, name, short) VALUES (?,?,?)", [req.user.firm_id, b.name, b.short || b.name]);
      else await conn.query(`INSERT INTO ${table} (firm_id, name) VALUES (?,?)`, [req.user.firm_id, b.name]);
      return () => res.success({ ok: true }, "Added");
    } catch (e) { return res.fail("Already exists"); }
  }));
}
masters("units", "item_units");
masters("categories", "item_categories");
masters("party-groups", "party_groups");

/* Rename a category, or give it the colour the Items screen dots its row with.
   Kept separate from masters() because only categories carry a colour. */
router.put("/categories/:id", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const sets = [], args = [];
  if ("name" in b) { sets.push("name = ?"); args.push(String(b.name || "").trim()); }
  if ("color" in b) { sets.push("color = ?"); args.push(b.color || null); }
  if (!sets.length) return res.fail("Nothing to change");
  args.push(req.params.id, req.user.firm_id);
  try {
    await conn.query(`UPDATE item_categories SET ${sets.join(", ")} WHERE id = ? AND firm_id = ?`, args);
  } catch (e) { return res.fail("A category with that name already exists"); }
  return () => res.success({ ok: true }, "Category updated");
}));
router.delete("/categories/:id", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  /* Items keep their own rows; they simply lose the grouping. Deleting the
     category must never delete what was filed under it. Both statements are one
     unit: unfiling the items and then failing to remove the category would
     scatter the grouping for nothing. */
  await conn.query("UPDATE items SET category_id = NULL WHERE category_id = ? AND firm_id = ?", [req.params.id, req.user.firm_id]);
  await conn.query("DELETE FROM item_categories WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id]);
  return () => res.success({ ok: true }, "Category removed");
}));

/* ── Price lists: retail / wholesale price books ── */
router.get("/price-lists", async (req, res) => {
  res.success((await query("SELECT * FROM price_lists WHERE firm_id = ? ORDER BY name", [req.user.firm_id])).rows);
});
router.post("/price-lists", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  if (!(req.body || {}).name) return res.fail("Name the price list");
  await conn.query("INSERT INTO price_lists (firm_id, name) VALUES (?,?)", [req.user.firm_id, req.body.name]);
  return () => res.success({ ok: true }, "Price list created");
}));
/* Three statements, one unit — a book removed but still pointed at by parties,
   or prices orphaned under a book that is still there, are both worse than the
   delete not happening. */
router.delete("/price-lists/:id", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  await conn.query("DELETE FROM price_list_items WHERE list_id = ? AND firm_id = ?", [req.params.id, req.user.firm_id]);
  await conn.query("DELETE FROM price_lists WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id]);
  await conn.query("UPDATE parties SET price_list_id = NULL WHERE price_list_id = ? AND firm_id = ?", [req.params.id, req.user.firm_id]);
  return () => res.success({ ok: true }, "Price list removed");
}));
router.get("/price-lists/:id/items", async (req, res) => {
  res.success((await query(
    `SELECT p.item_id, p.price, i.name, i.sale_price AS default_price
       FROM price_list_items p JOIN items i ON i.id = p.item_id
       AND i.firm_id = p.firm_id
      WHERE p.firm_id = ? AND p.list_id = ? ORDER BY i.name`, [req.user.firm_id, req.params.id])).rows);
});
/**
 * The whole sheet: every item the shop sells, with what it costs, what it
 * normally sells for, and what this list says — set or not.
 *
 * The editor used to be "pick an item, type a price, press add", one at a
 * time, against a dropdown of four hundred names. Setting a wholesale book
 * that way is an afternoon, and the one number a person needs while doing it
 * — what the thing cost — was nowhere on the screen. Pricing without the cost
 * in front of you is guessing.
 *
 * So the sheet comes down whole and the browser filters it. Deactivated items
 * are left out: a price book for things nobody may sell is a longer list to
 * read for no gain.
 */
router.get("/price-lists/:id/sheet", requirePermission("settings", "view"), async (req, res) => {
  const firm = req.user.firm_id;
  const list = (await query("SELECT id, name FROM price_lists WHERE id = ? AND firm_id = ?",
    [req.params.id, firm])).rows[0];
  if (!list) return res.notFound("Price list not found");

  const rows = (await query(
    `SELECT i.id AS item_id, i.name, i.item_code, i.unit,
            i.sale_price AS default_price, i.purchase_price AS cost,
            c.name AS category,
            p.price AS list_price
       FROM items i
       LEFT JOIN item_categories c ON c.id = i.category_id AND c.firm_id = i.firm_id
       LEFT JOIN price_list_items p ON p.item_id = i.id AND p.firm_id = i.firm_id AND p.list_id = ?
      WHERE i.firm_id = ? AND COALESCE(i.is_active, 1) = 1
      ORDER BY i.name`, [list.id, firm])).rows;

  res.success({ list, rows });
});

/**
 * Set or clear several prices at once.
 *
 * A sheet is edited a screenful at a time, and one request per cell would mean
 * four hundred requests and four hundred chances for half a price book. A
 * `null` price removes the row, which is how a line goes back to the default
 * rather than being pinned at the default for ever — those two look the same
 * on screen and behave differently the day the default changes.
 */
router.put("/price-lists/:id/items", requirePermission("settings", "edit"), async (req, res, next) =>
  await durable(next, async (conn) => {
    const firm = req.user.firm_id;
    const list = (await query("SELECT id FROM price_lists WHERE id = ? AND firm_id = ?",
      [req.params.id, firm])).rows[0];
    if (!list) return res.notFound("Price list not found");

    const changes = Array.isArray((req.body || {}).prices) ? req.body.prices : [];
    if (!changes.length) return res.fail("Nothing to save");

    let set = 0, cleared = 0;
    for (const c of changes) {
      const itemId = Number(c && c.item_id);
      if (!itemId) continue;
      /* The item has to be ours. Both ids arrive off the wire, and a price
         filed against another business's item is a price nobody here can see
         or remove. */
      const own = (await query("SELECT id FROM items WHERE id = ? AND firm_id = ?", [itemId, firm])).rows[0];
      if (!own) continue;

      const price = c.price === null || c.price === "" ? null : Number(c.price);
      if (price === null || !Number.isFinite(price)) {
        await conn.query("DELETE FROM price_list_items WHERE firm_id = ? AND list_id = ? AND item_id = ?",
          [firm, list.id, itemId]);
        cleared++;
        continue;
      }
      if (price < 0) continue;
      const ex = (await query("SELECT id FROM price_list_items WHERE firm_id=? AND list_id=? AND item_id=?",
        [firm, list.id, itemId])).rows[0];
      if (ex) await conn.query("UPDATE price_list_items SET price = ? WHERE id = ?", [price, ex.id]);
      else await conn.query("INSERT INTO price_list_items (firm_id, list_id, item_id, price) VALUES (?,?,?,?)",
        [firm, list.id, itemId, price]);
      set++;
    }
    return () => res.success({ set, cleared },
      `${set} price${set === 1 ? "" : "s"} saved${cleared ? `, ${cleared} back to the default` : ""}`);
  }));

router.post("/price-lists/:id/items", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  if (!b.item_id || !(Number(b.price) >= 0)) return res.fail("Item and price required");
  /* Both ends of the row have to belong here. The list id and the item id both
     arrive off the wire, and neither was checked — a price could be filed
     against another business's price book. */
  const list = (await query("SELECT id FROM price_lists WHERE id = ? AND firm_id = ?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!list) return res.notFound("Price list not found");
  const item = (await query("SELECT id FROM items WHERE id = ? AND firm_id = ?",
    [b.item_id, req.user.firm_id])).rows[0];
  if (!item) return res.notFound("Item not found");
  const ex = (await query("SELECT id FROM price_list_items WHERE firm_id=? AND list_id=? AND item_id=?",
    [req.user.firm_id, req.params.id, b.item_id])).rows[0];
  if (ex) await conn.query("UPDATE price_list_items SET price=? WHERE id=?", [Number(b.price), ex.id]);
  else await conn.query("INSERT INTO price_list_items (firm_id, list_id, item_id, price) VALUES (?,?,?,?)",
    [req.user.firm_id, req.params.id, b.item_id, Number(b.price)]);
  return () => res.success({ ok: true }, "Price saved");
}));

/* ── Tax rules: the configurable Uganda tax chain (Settings → Taxes) ── */
router.get("/tax-rules", async (req, res) => {
  res.success((await query("SELECT * FROM tax_rules WHERE firm_id = ? ORDER BY apply_order, id", [req.user.firm_id])).rows);
});
router.post("/tax-rules", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  if (!b.name || isNaN(Number(b.rate))) return res.fail("Name and rate are required");
  const mode = b.mode === "add" ? "add" : "deduct";
  const maxOrder = (await query("SELECT COALESCE(MAX(apply_order),0) AS m FROM tax_rules WHERE firm_id = ?", [req.user.firm_id])).rows[0].m;
  await conn.query("INSERT INTO tax_rules (firm_id, name, rate, mode, apply_order, is_active) VALUES (?,?,?,?,?,1)",
    [req.user.firm_id, b.name, Number(b.rate), mode, b.apply_order ? Number(b.apply_order) : maxOrder + 1]);
  return () => res.success({ ok: true }, "Tax rule added");
}));
router.put("/tax-rules/:id", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const rule = (await query("SELECT * FROM tax_rules WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!rule) return res.notFound("Rule not found");
  await conn.query("UPDATE tax_rules SET name = ?, rate = ?, mode = ?, apply_order = ?, is_active = ? WHERE id = ?",
    [b.name ?? rule.name, b.rate != null ? Number(b.rate) : rule.rate,
     b.mode === "add" ? "add" : b.mode === "deduct" ? "deduct" : rule.mode,
     b.apply_order != null ? Number(b.apply_order) : rule.apply_order,
     b.is_active != null ? (b.is_active ? 1 : 0) : rule.is_active, req.params.id]);
  return () => res.success({ ok: true }, "Tax rule updated");
}));
router.delete("/tax-rules/:id", requirePermission("settings", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  await conn.query("DELETE FROM tax_rules WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id]);
  return () => res.success({ ok: true }, "Tax rule removed");
}));

module.exports = router;
