/**
 * manufacturing.routes.js — bills of materials and production runs.
 *
 * A BOM is a recipe: so much of each component makes so many of a finished
 * item. Producing consumes the components from stock and puts the finished
 * goods on the shelf carrying their real cost, so margin on what you make is
 * as honest as margin on what you buy.
 *
 * Inventory value is preserved through the run — what leaves the components
 * arrives in the product — so the swap itself needs no journal entry. Labour
 * and overhead are new money spent, and those do raise the value on the shelf.
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { postMovement } = require("../../shared/stock.poster");
const { postJournal, round2 } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

const moduleOn = async (firmId) => await getSetting(firmId, "mod_manufacturing", "0") === "1";
const today = () => new Date().toISOString().slice(0, 10);

/** What one unit of an item is currently worth, falling back to its buy price. */
function unitCostOf(q, firmId, itemId) {
  const s = q("SELECT COALESCE(AVG(NULLIF(avg_cost,0)),0) c FROM item_stock WHERE firm_id=? AND item_id=?",
    [firmId, itemId]).rows[0];
  if (Number(s.c) > 0) return Number(s.c);
  const it = q("SELECT purchase_price FROM items WHERE id=? AND firm_id=?", [itemId, firmId]).rows[0];
  return Number(it?.purchase_price) || 0;
}
const onHandOf = (q, firmId, itemId) =>
  Number(q("SELECT COALESCE(SUM(quantity),0) v FROM item_stock WHERE firm_id=? AND item_id=?", [firmId, itemId]).rows[0].v);

/**
 * Cost a BOM for a given number of batches, and check the shelf can cover it.
 * Shared by the costing preview and the run itself so the number you are shown
 * is the number you get.
 */
function costBom(q, firmId, bom, batches) {
  const comps = q(
    `SELECT c.item_id, c.quantity, c.note, i.name, i.unit, i.is_inventory
       FROM bom_components c JOIN items i ON i.id = c.item_id AND i.firm_id = ?
      WHERE c.bom_id = ? ORDER BY c.id`, [firmId, bom.id]
  ).rows;

  const lines = comps.map((c) => {
    const need = round2(c.quantity * batches);
    const unit = unitCostOf(q, firmId, c.item_id);
    const have = c.is_inventory ? onHandOf(q, firmId, c.item_id) : Infinity;
    return {
      item_id: c.item_id, name: c.name, unit_name: c.unit, per_batch: c.quantity,
      quantity: need, unit_cost: +unit.toFixed(4), cost: round2(need * unit),
      on_hand: c.is_inventory ? have : null,
      short: c.is_inventory && have < need ? round2(need - have) : 0,
    };
  });

  const components = round2(lines.reduce((a, l) => a + l.cost, 0));
  const labour = round2((bom.labour_cost || 0) * batches);
  const overhead = round2((bom.overhead_cost || 0) * batches);
  const output = round2((bom.output_qty || 1) * batches);
  const total = round2(components + labour + overhead);
  return {
    lines, components, labour, overhead, total, output,
    unit_cost: output > 0 ? +(total / output).toFixed(4) : 0,
    shortages: lines.filter((l) => l.short > 0),
  };
}

/* ── Bills of materials ───────────────────────────────────────────────── */

router.get("/boms", requirePermission("items", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT b.*, i.name AS item_name, i.unit AS item_unit,
            (SELECT COUNT(*) FROM bom_components c WHERE c.bom_id = b.id) AS component_count
       FROM boms b JOIN items i ON i.id = b.item_id
      WHERE b.firm_id = ? ORDER BY b.is_active DESC, b.name`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

router.get("/boms/:id", requirePermission("items", "view"), async (req, res) => {
  const bom = (await query(
    `SELECT b.*, i.name AS item_name, i.unit AS item_unit FROM boms b
       JOIN items i ON i.id = b.item_id WHERE b.id = ? AND b.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!bom) return res.notFound("Recipe not found");
  const batches = Number(req.query.batches) || 1;
  res.success({ ...bom, ...costBom(query, req.user.firm_id, bom, batches), batches });
});

async function validateComponents(firmId, itemId, comps) {
  if (!Array.isArray(comps) || !comps.length) return "Add at least one component";
  const seen = new Set();
  for (const c of comps) {
    if (!c.item_id) return "Every component needs an item";
    /* A component id arrives off the wire. Unchecked, a recipe could be built
       from another business's items, and costing it would read back their
       names and buy prices. */
    if (!(await query("SELECT 1 FROM items WHERE id = ? AND firm_id = ?", [c.item_id, firmId])).rows[0]) {
      return "One of these components is not an item in this business";
    }
    if (Number(c.item_id) === Number(itemId)) return "A recipe cannot use the item it produces as a component";
    if (seen.has(Number(c.item_id))) return "The same component is listed twice — combine them into one line";
    seen.add(Number(c.item_id));
    if (!(Number(c.quantity) > 0)) return "Every component needs a quantity above zero";
  }
  return null;
}

/* A recipe is its components. Saved loose, a half-written recipe costs and
   produces the wrong thing on the next production run. */
router.post("/boms", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Manufacturing" in Settings → Modules first', 400);
  const b = req.body || {};
  if (!b.name) return res.fail("Give this recipe a name", 400);
  const out = (await query("SELECT * FROM items WHERE id = ? AND firm_id = ?", [b.item_id, firmId])).rows[0];
  if (!out) return res.fail("Choose what this recipe produces", 400);
  if (!out.is_inventory) return res.fail(`"${out.name}" is a service — production needs an item you hold in stock`, 400);
  if (!(Number(b.output_qty) > 0)) return res.fail("How many does one batch make?", 400);
  const bad = await validateComponents(firmId, b.item_id, b.components);
  if (bad) return res.fail(bad, 400);

  const r = await conn.query(
    `INSERT INTO boms (firm_id, name, item_id, output_qty, labour_cost, overhead_cost, notes, is_active, created_by)
     VALUES (?,?,?,?,?,?,?,1,?)`,
    [firmId, b.name, b.item_id, Number(b.output_qty), Number(b.labour_cost) || 0,
     Number(b.overhead_cost) || 0, b.notes || null, req.user.id]
  );
  for (const c of b.components) {
    await conn.query("INSERT INTO bom_components (bom_id, item_id, quantity, note) VALUES (?,?,?,?)",
      [r.insertId, c.item_id, Number(c.quantity), c.note || null]);
  }
  return () => res.success({ id: r.insertId }, `Recipe "${b.name}" saved`);
}));

/* The component rewrite is a delete followed by inserts: without a transaction
   a failure part-way through left the recipe with no components at all. */
router.put("/boms/:id", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const bom = (await query("SELECT * FROM boms WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
  if (!bom) return res.notFound("Recipe not found");
  const b = req.body || {};
  if (Array.isArray(b.components)) {
    const bad = await validateComponents(firmId, b.item_id || bom.item_id, b.components);
    if (bad) return res.fail(bad, 400);
  }
  await conn.query(
    `UPDATE boms SET name = COALESCE(?, name), output_qty = COALESCE(?, output_qty),
       labour_cost = COALESCE(?, labour_cost), overhead_cost = COALESCE(?, overhead_cost),
       notes = ?, is_active = COALESCE(?, is_active) WHERE id = ?`,
    [b.name || null, b.output_qty ?? null, b.labour_cost ?? null, b.overhead_cost ?? null,
     b.notes ?? bom.notes, b.is_active == null ? null : (b.is_active ? 1 : 0), bom.id]
  );
  if (Array.isArray(b.components)) {
    await conn.query("DELETE FROM bom_components WHERE bom_id = ?", [bom.id]);
    for (const c of b.components) {
      await conn.query("INSERT INTO bom_components (bom_id, item_id, quantity, note) VALUES (?,?,?,?)",
        [bom.id, c.item_id, Number(c.quantity), c.note || null]);
    }
  }
  return () => res.success({ id: bom.id }, "Recipe updated");
}));

router.delete("/boms/:id", requirePermission("items", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const bom = (await query("SELECT * FROM boms WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!bom) return res.notFound("Recipe not found");
  const used = (await query("SELECT COUNT(*) n FROM production_runs WHERE bom_id = ?", [bom.id])).rows[0].n;
  if (used > 0) {
    /* Keep the recipe so past runs stay explainable; just take it out of use. */
    await conn.query("UPDATE boms SET is_active = 0 WHERE id = ?", [bom.id]);
    return () => res.success({ id: bom.id, deactivated: true },
      `"${bom.name}" has been used ${used} time${used === 1 ? "" : "s"}, so it was retired rather than deleted — past runs still make sense`);
  }
  await conn.query("DELETE FROM bom_components WHERE bom_id = ?", [bom.id]);
  await conn.query("DELETE FROM boms WHERE id = ?", [bom.id]);
  return () => res.success({ id: bom.id }, `"${bom.name}" deleted`);
}));

/* ── Production ───────────────────────────────────────────────────────── */

/** Cost a run before committing to it, including what the shelf is short of. */
router.get("/costing/:bomId", requirePermission("items", "view"), async (req, res) => {
  const bom = (await query("SELECT * FROM boms WHERE id = ? AND firm_id = ?", [req.params.bomId, req.user.firm_id])).rows[0];
  if (!bom) return res.notFound("Recipe not found");
  const batches = Number(req.query.batches) || 1;
  if (!(batches > 0)) return res.fail("How many batches?", 400);
  res.success({ bom_id: bom.id, batches, ...costBom(query, req.user.firm_id, bom, batches) });
});

router.get("/runs", requirePermission("items", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT r.*, i.name AS item_name, i.unit AS item_unit, b.name AS bom_name,
            (SELECT username FROM users WHERE id = r.created_by) AS who
       FROM production_runs r JOIN items i ON i.id = r.item_id
       LEFT JOIN boms b ON b.id = r.bom_id
      WHERE r.firm_id = ? ORDER BY r.id DESC LIMIT 200`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

router.get("/runs/:id", requirePermission("items", "view"), async (req, res) => {
  const run = (await query(
    `SELECT r.*, i.name AS item_name, i.unit AS item_unit, b.name AS bom_name
       FROM production_runs r JOIN items i ON i.id = r.item_id
       LEFT JOIN boms b ON b.id = r.bom_id WHERE r.id = ? AND r.firm_id = ?`,
    [req.params.id, req.user.firm_id]
  )).rows[0];
  if (!run) return res.notFound("Production run not found");
  const consumed = (await query(
    `SELECT c.*, i.name, i.unit FROM production_consumed c JOIN items i ON i.id = c.item_id AND i.firm_id = ?
      WHERE c.run_id = ? ORDER BY c.id`, [req.user.firm_id, run.id]
  )).rows;
  res.success({ ...run, consumed });
});

/** Make the goods: components off the shelf, finished stock on, cost carried. */
router.post("/produce", requirePermission("items", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    if (!await moduleOn(firmId)) { conn.release(); return res.fail('Switch on "Manufacturing" in Settings → Modules first', 400); }
    const b = req.body || {};
    const batches = Number(b.batches) || 0;
    if (!(batches > 0)) { conn.release(); return res.fail("How many batches are you making?", 400); }

    const bom = (await conn.query("SELECT * FROM boms WHERE id = ? AND firm_id = ?", [b.bom_id, firmId])).rows[0];
    if (!bom) { conn.release(); return res.fail("Recipe not found", 404); }
    if (!bom.is_active) { conn.release(); return res.fail(`"${bom.name}" has been retired — reactivate it to produce with it`, 400); }

    const costing = costBom(conn.query.bind(conn), firmId, bom, batches);
    if (!costing.lines.length) { conn.release(); return res.fail("This recipe has no components", 400); }

    /* Refuse rather than drive stock negative — a shortage is a real-world
       problem the shopkeeper needs to see, not something to paper over. */
    if (costing.shortages.length && await getSetting(firmId, "prevent_negative_stock", "1") === "1") {
      conn.release();
      const s = costing.shortages
        .map((x) => `${x.name} (short ${x.short} ${x.unit_name})`)
        .join(", ");
      return res.fail(`Not enough stock to make ${batches} batch${batches === 1 ? "" : "es"}: ${s}`, 400);
    }

    const dt = b.run_date || today();
    await conn.beginTransaction();
    const n = ((await conn.query("SELECT COUNT(*) n FROM production_runs WHERE firm_id=?", [firmId])).rows[0].n || 0) + 1;
    const ref = "MFG-" + String(n).padStart(4, "0");

    const r = await conn.query(
      `INSERT INTO production_runs (firm_id, reference, bom_id, item_id, quantity,
         cost_components, cost_labour, cost_overhead, unit_cost, run_date, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firmId, ref, bom.id, bom.item_id, costing.output, costing.components,
       costing.labour, costing.overhead, costing.unit_cost, dt, b.note || null, req.user.id]
    );
    const runId = r.insertId;

    for (const l of costing.lines) {
      await conn.query("INSERT INTO production_consumed (run_id, item_id, quantity, unit_cost, cost) VALUES (?,?,?,?,?)",
        [runId, l.item_id, l.quantity, l.unit_cost, l.cost]);
      await postMovement(conn, { firmId, itemId: l.item_id, direction: "out", quantity: l.quantity,
        unitCost: l.unit_cost, sourceModule: "production", sourceId: runId, userId: req.user.id });
    }
    await postMovement(conn, { firmId, itemId: bom.item_id, direction: "in", quantity: costing.output,
      unitCost: costing.unit_cost, sourceModule: "production", sourceId: runId, userId: req.user.id });

    /* Components turning into product is a move within Inventory, so it needs
       no entry. Labour and overhead are money spent, and they add to the value
       of what is now on the shelf. */
    const extra = round2(costing.labour + costing.overhead);
    if (extra > 0.004) {
      await postJournal(conn, {
        firmId, date: dt, description: `Production cost — ${ref}`, reference: ref,
        sourceModule: "production", sourceId: runId, userId: req.user.id,
        lines: [
          { account_code: CODES.STOCK, debit: extra, narration: `${bom.name} labour & overhead` },
          { account_code: b.cash_account_code || CODES.CASH, credit: extra },
        ],
      });
    }
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", "produce", runId, `${ref}: ${costing.output} of ${bom.item_id} from ${bom.name}`]);

    await conn.commit();
    res.success({ id: runId, reference: ref, quantity: costing.output, unit_cost: costing.unit_cost,
      cost_components: costing.components, cost_labour: costing.labour, cost_overhead: costing.overhead },
      `${ref}: made ${costing.output} at Sh ${costing.unit_cost.toFixed(2)} each`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
module.exports.costBom = costBom;
