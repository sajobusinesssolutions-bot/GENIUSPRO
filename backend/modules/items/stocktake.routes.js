/**
 * stocktake.routes.js — physical stock counts.
 *
 * A count is a session: snapshot what the system thinks is on hand, let staff
 * key in what they actually counted, show the variance in shillings, then post
 * the difference as a single stock adjustment with a proper ledger entry.
 *
 * Nothing moves until the count is posted, so a half-finished count on a Friday
 * evening is safe to leave open.
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { postJournal, round2 } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");

router.use(verifyToken);

/* List counts, newest first */
/* Why a count came out different, and where the write-off lands. Kept here
   rather than in the browser so a count cannot be filed under a reason the
   books do not recognise, and so the variance report can group by it. */
const COUNT_REASONS = [
  "Recount — genuine variance",
  "Spoilage",
  "Theft / shrinkage",
  "Data entry error",
  "Breakage / damage",
];

router.get("/reasons", requirePermission("items", "view"), async (req, res) => {
  /* Only the expense accounts a write-off could sensibly go to. */
  const accounts = (await query(
    `SELECT code, name FROM chart_of_accounts
      WHERE firm_id = ? AND type = 'expense' AND COALESCE(status,'active') = 'active'
      ORDER BY code`, [req.user.firm_id])).rows;
  res.success({ reasons: COUNT_REASONS, accounts, defaultAccount: CODES.STOCK_ADJ });
});

/* Variance across posted counts — what the counting has actually been telling
   you, rather than one count at a time. */
router.get("/variance", requirePermission("items", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const from = req.query.from || null;
  const to = req.query.to || null;
  const cond = ["t.firm_id = ?", "t.status = 'posted'"];
  const args = [f];
  if (from) { cond.push("date(t.posted_at) >= ?"); args.push(from); }
  if (to) { cond.push("date(t.posted_at) <= ?"); args.push(to); }

  /* Per item: how often it was counted, how often it came out wrong, and what
     that has cost. An item that is always short is a different problem from
     one that was short once. */
  const rows = (await query(
    `SELECT i.id, i.name, i.unit,
            COUNT(l.id) AS counts,
            SUM(CASE WHEN ABS(COALESCE(l.counted_qty, l.system_qty) - l.system_qty) > 0.0001 THEN 1 ELSE 0 END) AS off_count,
            SUM(COALESCE(l.counted_qty, l.system_qty) - l.system_qty) AS net_qty,
            SUM((COALESCE(l.counted_qty, l.system_qty) - l.system_qty) * COALESCE(l.unit_cost, 0)) AS net_value
       FROM stock_take_lines l
       JOIN stock_takes t ON t.id = l.take_id
       JOIN items i ON i.id = l.item_id
      WHERE ${cond.join(" AND ")} AND l.counted_qty IS NOT NULL
      GROUP BY i.id, i.name, i.unit
     HAVING off_count > 0
      ORDER BY net_value ASC`, args)).rows;

  const byReason = (await query(
    `SELECT COALESCE(NULLIF(TRIM(t.reason), ''), 'Not recorded') AS reason,
            COUNT(*) AS counts, COALESCE(SUM(t.variance_value), 0) AS value
       FROM stock_takes t WHERE ${cond.join(" AND ")}
      GROUP BY reason ORDER BY value ASC`, args)).rows;

  const totals = rows.reduce((a, r) => {
    const v = +r.net_value || 0;
    if (v < 0) a.lost += -v; else a.gained += v;
    return a;
  }, { lost: 0, gained: 0 });

  res.success({
    rows: rows.map((r) => ({ ...r, net_qty: +Number(r.net_qty).toFixed(3), net_value: +Number(r.net_value).toFixed(2) })),
    byReason,
    totals: {
      lost: +totals.lost.toFixed(2), gained: +totals.gained.toFixed(2),
      net: +(totals.gained - totals.lost).toFixed(2), items: rows.length,
    },
    from, to,
  });
});

router.get("/", requirePermission("items", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT t.*, (SELECT username FROM users WHERE id = t.created_by) AS created_by_name,
            (SELECT COUNT(*) FROM stock_take_lines l WHERE l.take_id = t.id) AS total_lines
       FROM stock_takes t WHERE t.firm_id = ? ORDER BY t.id DESC LIMIT 50`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

/* Start a count — snapshots current on-hand for every item in scope */
/* The count header and its snapshot lines are one document: a stock take with
   half its lines is a count nobody can complete or discard sensibly. */
router.post("/", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const b = req.body || {};
  const scope = b.category_id ? `category:${b.category_id}` : "all";

  const open = (await query("SELECT id FROM stock_takes WHERE firm_id=? AND status='draft'", [f])).rows[0];
  if (open) return res.fail("There's already a count in progress — finish or discard it first", 400);

  const ref = "CNT-" + String(
    ((await query("SELECT COUNT(*) n FROM stock_takes WHERE firm_id=?", [f])).rows[0].n || 0) + 1
  ).padStart(4, "0");

  await conn.query("INSERT INTO stock_takes (firm_id, reference, scope, status, created_by) VALUES (?,?,?,?,?)",
    [f, ref, scope, "draft", req.user.id]);
  const takeId = (await conn.query("SELECT id FROM stock_takes WHERE firm_id=? AND reference=?", [f, ref])).rows[0].id;

  const args = [f];
  let where = "i.firm_id = ? AND i.is_inventory = 1 AND i.is_active = 1";
  if (b.category_id) { where += " AND i.category_id = ?"; args.push(b.category_id); }

  const items = (await query(
    `SELECT i.id, i.purchase_price,
            COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS on_hand,
            COALESCE((SELECT AVG(NULLIF(avg_cost,0)) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS avg_cost
       FROM items i WHERE ${where} ORDER BY i.name`, args
  )).rows;

  for (const it of items) {
    await conn.query("INSERT INTO stock_take_lines (firm_id, take_id, item_id, system_qty, counted_qty, unit_cost) VALUES (?,?,?,?,?,?)",
      [f, takeId, it.id, it.on_hand, null, Number(it.avg_cost) || Number(it.purchase_price) || 0]);
  }
  return () => res.success({ id: takeId, reference: ref, lines: items.length }, `${ref} started — ${items.length} item(s) to count`);
}));

/* Open a count with its lines */
router.get("/:id", requirePermission("items", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const take = (await query("SELECT * FROM stock_takes WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!take) return res.fail("Count not found", 404);
  take.lines = (await query(
    `SELECT l.*, i.name, i.item_code, i.unit,
            (SELECT name FROM item_categories c WHERE c.id = i.category_id) AS category_name
       FROM stock_take_lines l JOIN items i ON i.id = l.item_id AND i.firm_id = l.firm_id
      WHERE l.firm_id = ? AND l.take_id = ? ORDER BY i.name`, [f, req.params.id]
  )).rows;
  res.success(take);
});

/* Save counted quantities (autosave-friendly: send only what changed) */
router.put("/:id/lines", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const take = (await query("SELECT * FROM stock_takes WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!take) return res.fail("Count not found", 404);
  if (take.status !== "draft") return res.fail("This count is already posted");
  for (const l of req.body.lines || []) {
    await conn.query("UPDATE stock_take_lines SET counted_qty = ?, note = ? WHERE id = ? AND take_id = ?",
      [l.counted_qty === "" || l.counted_qty == null ? null : Number(l.counted_qty), l.note || null, l.id, take.id]);
  }
  const counted = (await conn.query("SELECT COUNT(*) n FROM stock_take_lines WHERE take_id=? AND counted_qty IS NOT NULL", [take.id])).rows[0].n;
  await conn.query("UPDATE stock_takes SET counted_lines=?, note=? WHERE id=?", [counted, req.body.note || take.note, take.id]);
  return () => res.success({ counted });
}));

/* Abandon a draft. Only a draft — a posted count has moved stock and written
   to the ledger, and the way to undo that is another count, not a delete. */
router.delete("/:id", requirePermission("items", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const take = (await conn.query("SELECT * FROM stock_takes WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
  if (!take) return res.fail("Count not found", 404);
  if (take.status !== "draft") return res.fail("A posted count can't be deleted — count again to correct it");
  await conn.query("DELETE FROM stock_take_lines WHERE take_id=? AND firm_id=?", [take.id, f]);
  await conn.query("DELETE FROM stock_takes WHERE id=? AND firm_id=?", [take.id, f]);
  return () => res.success({ id: take.id }, `${take.reference} abandoned`);
}));

/* Post the count: apply variances as stock movements + one ledger entry */
router.post("/:id/post", requirePermission("items", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = req.user.firm_id;
    const take = (await conn.query("SELECT * FROM stock_takes WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
    if (!take) { conn.release(); return res.fail("Count not found", 404); }
    if (take.status !== "draft") { conn.release(); return res.fail("Already posted"); }

    const lines = (await conn.query(
      "SELECT l.*, i.name FROM stock_take_lines l JOIN items i ON i.id = l.item_id WHERE l.take_id = ? AND l.counted_qty IS NOT NULL",
      [take.id]
    )).rows;
    if (!lines.length) { conn.release(); return res.fail("Nothing counted yet"); }

    /* A difference has to be explained. Posting one without saying why is how
       a shop discovers a year later that it cannot tell theft from a typo. */
    const body = req.body || {};
    const reason = String(body.reason || "").trim();
    const account = String(body.account || CODES.STOCK_ADJ).trim();
    const anyDiff = lines.some((l) => Math.abs(Number(l.counted_qty) - Number(l.system_qty)) > 0.0001);
    if (anyDiff && !reason) { conn.release(); return res.fail("Say why the count differs before posting"); }
    if (reason && !COUNT_REASONS.includes(reason)) { conn.release(); return res.fail("That is not a reason this count offers"); }
    if (anyDiff) {
      const ok = (await conn.query(
        "SELECT 1 FROM chart_of_accounts WHERE firm_id=? AND code=? AND type='expense'", [f, account])).rows[0];
      if (!ok) { conn.release(); return res.fail("Post the write-off to an expense account"); }
    }

    const today = new Date().toISOString().slice(0, 10);
    let gain = 0, loss = 0, changed = 0;

    await conn.beginTransaction();
    for (const l of lines) {
      const diff = round2(Number(l.counted_qty) - Number(l.system_qty));
      if (Math.abs(diff) < 0.0001) continue;
      changed++;
      const dir = diff > 0 ? "in" : "out";
      const qty = Math.abs(diff);
      const value = round2(qty * (Number(l.unit_cost) || 0));

      await conn.query(
        `INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module, source_id, created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [f, l.item_id, dir, qty, l.unit_cost || 0, "stocktake", take.id, req.user.id]);

      const ex = (await conn.query("SELECT id FROM item_stock WHERE firm_id=? AND item_id=? AND batch_no=''", [f, l.item_id])).rows[0];
      if (ex) await conn.query("UPDATE item_stock SET quantity = quantity + ? WHERE id = ?", [diff, ex.id]);
      else await conn.query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity, avg_cost) VALUES (?,?,?,?,?)",
        [f, l.item_id, "", diff, l.unit_cost || 0]);

      if (diff > 0) gain = round2(gain + value); else loss = round2(loss + value);
    }

    // One ledger entry for the whole count — surplus reduces the write-off expense,
    // shortage increases it, and Inventory follows what was actually on the shelf.
    const net = round2(gain - loss);
    if (Math.abs(net) > 0.004) {
      await postJournal(conn, {
        firmId: f, date: today,
        description: `Stock count ${take.reference}`, reference: take.reference,
        sourceModule: "stocktake", sourceId: take.id, userId: req.user.id,
        lines: net > 0
          ? [{ account_code: CODES.STOCK, debit: net }, { account_code: account, credit: net }]
          : [{ account_code: account, debit: -net }, { account_code: CODES.STOCK, credit: -net }],
      });
    }

    await conn.query("UPDATE stock_takes SET status='posted', posted_at=?, variance_value=?, reason=?, post_account=? WHERE id=?",
      [new Date().toISOString(), net, reason || null, anyDiff ? account : null, take.id]);
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "items", "stocktake", take.id, `${take.reference}: ${changed} adjusted, net ${net}`]);

    await conn.commit();
    res.success({ id: take.id, reference: take.reference, adjusted: changed, gain, loss, net },
      `${take.reference} posted — ${changed} item(s) adjusted`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* A second DELETE /:id ("Discard a draft") used to sit here — dead code, since
   Express matches the first registration at line 171. It mattered because it
   read as authoritative while being the older, worse version: it deleted the
   lines and then the header with two bare query() calls outside any
   transaction, so a failure between them would have orphaned every line of the
   count while the client was told "Count discarded". The live handler above
   does the same work atomically and durably. Removed rather than repaired —
   two handlers for one route is itself the bug. */

module.exports = router;
