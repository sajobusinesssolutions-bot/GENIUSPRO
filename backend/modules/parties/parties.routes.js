const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { listQuery, sendList } = require("../../shared/paginate");
const { pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { nextSeq, pad } = require("../../shared/sequences");

router.use(verifyToken);

router.get("/", requirePermission("parties", "view"), async (req, res) => {
  /* Archived parties are out of the list and out of every picker that reads
     it. They are the ones who have traded and been removed: their history has
     to stay attached to something, but nobody should be able to sell to them
     again by accident. `?archived=1` is how the Parties screen shows them when
     somebody goes looking. */
  const where = ["firm_id = ?"];
  if (String(req.query.archived || "") !== "1") where.push("COALESCE(status,'active') <> 'inactive'");
  sendList(res, await listQuery({
    req,
    select: "SELECT * FROM parties",
    countFrom: "FROM parties",
    where, args: [req.user.firm_id],
    orderBy: "name",
    searchCols: ["name", "phone", "email"],
  }));
});

/* Assign a price list to a party (wholesale customers etc.) */
/* Whole-book figures for the panels above the list. Above "/:id" so the word
   "overview" is never taken for a party id. */
require("./overview.routes").attach(router, requirePermission);

router.put("/:id", requirePermission("parties", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const r = await conn.query(
    `UPDATE parties SET name = COALESCE(?, name), phone = ?, email = ?, gstin = ?,
            billing_address = ?, credit_limit = COALESCE(?, credit_limit), group_id = ?, account_code = ?
      WHERE id = ? AND firm_id = ?`,
    [b.name || null, b.phone || null, b.email || null, b.gstin || null,
     b.billing_address || null, b.credit_limit != null ? Number(b.credit_limit) : null,
     b.group_id || null, b.account_code || null, req.params.id, req.user.firm_id]);
  if (!r.changes) return res.fail("Party not found", 404);
  return () => res.success({ id: Number(req.params.id) }, "Party updated");
}));

router.put("/:id/price-list", requirePermission("parties", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const listId = (req.body || {}).price_list_id || null;
  /* The list has to be one of ours. Unchecked, a party could be pointed at
     another business's price book and then billed from it. */
  if (listId != null) {
    const list = (await query("SELECT id FROM price_lists WHERE id = ? AND firm_id = ?", [listId, req.user.firm_id])).rows[0];
    if (!list) return res.notFound("Price list not found");
  }
  const r = await conn.query("UPDATE parties SET price_list_id = ? WHERE id = ? AND firm_id = ?",
    [listId, req.params.id, req.user.firm_id]);
  if (!r.changes) return res.notFound("Party not found");
  return () => res.success({ ok: true }, "Price list assigned");
}));

/* ── What this customer pays ──────────────────────────────────────────────
 *
 * One answer, from their price list.
 *
 * There used to be two mechanisms: a price list assigned to the customer, and
 * a table of per-customer, per-item "special prices" that beat it. Two places
 * to look when a price is wrong, and the second was per customer — a shop
 * giving twelve traders the same wholesale rates set the same prices twelve
 * times, and changing one meant remembering all twelve.
 *
 * A price list does that job once and shares it, so the special-price table is
 * no longer written to or read. Existing rows are left where they are rather
 * than deleted: throwing away prices somebody agreed with a customer, on the
 * strength of a redesign, is not a thing an app should do quietly. They are
 * exportable and inspectable; nothing applies them any more.
 *
 * The route keeps its name because its meaning has not changed — "the rates
 * that apply to this party" — so the till and the invoice builder read it
 * exactly as they did.
 */
router.get("/:id/rates", requirePermission("parties", "view"), async (req, res) => {
  const firm = req.user.firm_id;
  const party = (await query("SELECT price_list_id FROM parties WHERE id = ? AND firm_id = ?",
    [req.params.id, firm])).rows[0];
  if (!party || !party.price_list_id) return res.success([]);

  res.success((await query(
    `SELECT p.item_id, p.price AS rate, i.name AS item_name, i.sale_price AS normal_rate
       FROM price_list_items p JOIN items i ON i.id = p.item_id AND i.firm_id = p.firm_id
      WHERE p.firm_id = ? AND p.list_id = ? ORDER BY i.name`,
    [firm, party.price_list_id])).rows);
});
/* The two routes that wrote and removed a per-customer special price used to
   be here. They are gone with the mechanism: a price list does the same job
   once and shares it between every customer on it, instead of the same rates
   being typed twelve times for twelve traders and one of them being missed on
   the day they change. Rows already in `party_item_rates` are left alone and
   applied by nothing — deleting prices somebody agreed with a customer, on the
   strength of a redesign, is not something to do quietly. */

/* Party detail + transaction history (master-detail drill-down) */
/**
 * Delete a customer or supplier — or, when they have traded, archive them.
 *
 * The screen has offered this since it shipped and the route never existed:
 * pressing Delete asked for a dangerous confirmation and then answered
 * "Cannot DELETE /api/parties/12". Nobody could remove a customer entered by
 * mistake, and the failure looked like a bug in the screen.
 *
 * Three outcomes, and which one applies is decided by the books rather than by
 * the person pressing the button:
 *
 *   · **Refused** while money is outstanding either way. A balance is a claim,
 *     and deleting the name attached to one does not settle it — it only makes
 *     it unattributable. Settle it or write it off first.
 *   · **Archived** when they have traded. Every invoice, payment and note
 *     points at this row; removing it would leave documents naming nobody, and
 *     a VAT return that cannot say who it sold to. They leave the list and the
 *     pickers, and their history stays exactly where it is.
 *   · **Deleted** when nothing anywhere refers to them, which is the case this
 *     is usually wanted for: a name typed twice, or into the wrong box.
 *
 * The walk-in customer is never removable. The till cannot ring up a sale
 * without a party, so deleting it is deleting the ability to trade.
 */
router.delete("/:id", requirePermission("parties", "delete"), async (req, res, next) =>
  await durable(next, async (conn) => {
    const firm = req.user.firm_id;
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?",
      [req.params.id, firm])).rows[0];
    if (!party) return res.notFound("Party not found");
    if (party.party_no === "CUST-000000") {
      return res.fail("The walk-in customer cannot be deleted — the till needs it to ring up a sale", 400);
    }

    if (Math.abs(Number(party.balance) || 0) > 0.005) {
      const owed = Number(party.balance) > 0;
      return res.fail(
        `${party.name} still ${owed ? "owes you" : "is owed"} money. Settle or write off the balance first — ` +
        "deleting the name does not settle the debt, it only makes it unattributable.", 400);
    }

    /* Everything that points at a party. Counted rather than assumed: a table
       this build does not have must not stop the delete, and a table it does
       have must not be forgotten. */
    const refs = [
      ["sale_invoices", "sales"], ["purchase_invoices", "purchases"],
      ["sale_returns", "credit notes"], ["purchase_returns", "debit notes"],
      ["payments", "payments"], ["expenses", "expenses"],
      ["estimates", "estimates"], ["challans", "delivery notes"],
      ["installment_plans", "instalment plans"], ["warranties", "warranties"],
      ["recurring_docs", "recurring documents"], ["party_item_rates", "special prices"],
      ["loyalty_ledger", "loyalty points"], ["payment_reminders", "reminders"],
    ];
    const found = [];
    for (const [table, label] of refs) {
      try {
        const n = (await query(`SELECT COUNT(*) n FROM ${table} WHERE firm_id = ? AND party_id = ?`,
          [firm, req.params.id])).rows[0].n;
        if (n > 0) found.push(`${n} ${label}`);
      } catch { /* not a table in this build */ }
    }

    if (found.length) {
      await conn.query("UPDATE parties SET status = 'inactive' WHERE id = ? AND firm_id = ?",
        [req.params.id, firm]);
      return () => res.success({ archived: true, references: found },
        `${party.name} has ${found.join(", ")}, so the name has been archived rather than deleted. ` +
        "They are gone from the lists and the pickers, and their history is untouched.");
    }

    await conn.query("DELETE FROM parties WHERE id = ? AND firm_id = ?", [req.params.id, firm]);
    return () => res.success({ archived: false }, `${party.name} deleted`);
  }));

router.get("/:id", requirePermission("parties", "view"), async (req, res) => {
  const f = req.user.firm_id, pid = req.params.id;
  const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [pid, f])).rows[0];
  if (!party) return res.notFound("Party not found");
  /* `kind` says which screen owns the row. The statement offers Open, Print
     and Delete on each line, and every one of those needs to know what it is
     looking at — a credit note is not edited where an invoice is. Working it
     back out of the display label in the browser would break the first time
     somebody reworded one. */
  const txns = [
    ...(await query(`SELECT invoice_date AS d, CASE payment_type WHEN 'cash' THEN 'Cash sale' ELSE 'Credit sale' END AS type, 'sale' AS kind, invoice_no AS ref, grand_total AS amount, balance_due AS due, status, id FROM sale_invoices WHERE firm_id=? AND party_id=?`, [f, pid])).rows,
    ...(await query(`SELECT bill_date AS d, 'Purchase' AS type, 'purchase' AS kind, bill_no AS ref, grand_total AS amount, balance_due AS due, status, id FROM purchase_invoices WHERE firm_id=? AND party_id=?`, [f, pid])).rows,
    ...(await query(`SELECT return_date AS d, 'Credit note' AS type, 'sale_return' AS kind, note_no AS ref, grand_total AS amount, 0 AS due, 'issued' AS status, id FROM sale_returns WHERE firm_id=? AND party_id=? AND COALESCE(status,'posted') <> 'voided'`, [f, pid])).rows,
    ...(await query(`SELECT return_date AS d, 'Debit note' AS type, 'purchase_return' AS kind, note_no AS ref, grand_total AS amount, 0 AS due, 'issued' AS status, id FROM purchase_returns WHERE firm_id=? AND party_id=? AND COALESCE(status,'posted') <> 'voided'`, [f, pid])).rows,
    ...(await query(`SELECT payment_date AS d, CASE direction WHEN 'in' THEN 'Payment received' ELSE 'Payment made' END AS type, 'payment' AS kind, payment_no AS ref, amount, 0 AS due, mode AS status, id FROM payments WHERE firm_id=? AND party_id=? AND COALESCE(status,'paid') NOT IN ('voided','draft')`, [f, pid])).rows,
  ].sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.id - a.id));

  /* Which way each row moves the balance. The screen needs this to draw a
     running balance and to colour the amount; working it back out of the
     display label in the browser would break the moment a label is reworded. */
  const DIR = {
    "Cash sale": 1, "Credit sale": 1, "Purchase": -1,
    "Credit note": -1, "Debit note": 1,
    "Payment received": -1, "Payment made": 1,
  };
  for (const t of txns) t.sign = DIR[t.type] ?? 0;

  party.transactions = txns.slice(0, 100);

  /* How they pay, from their own record rather than a reputation someone
     typed in: anything still owing past its due date. */
  const late = (await query(
    `SELECT COUNT(*) AS n, MIN(COALESCE(due_date, invoice_date)) AS oldest
       FROM sale_invoices
      WHERE firm_id = ? AND party_id = ? AND COALESCE(status,'') <> 'voided'
        AND balance_due > 0.005 AND COALESCE(due_date, invoice_date) < date('now')`,
    [f, pid]
  )).rows[0] || {};
  party.overdue_count = +late.n || 0;
  party.oldest_overdue = late.oldest || null;

  party.price_list_name = party.price_list_id
    ? ((await query("SELECT name FROM price_lists WHERE id = ? AND firm_id = ?", [party.price_list_id, f])).rows[0] || {}).name || null
    : null;

  res.success(party);
});

router.post("/", requirePermission("parties", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const b = req.body || {};
    const prefix = b.party_type === "supplier" ? "SUPP" : "CUST";
    const no = `${prefix}-${pad(await nextSeq(conn, `${prefix}:firm${req.user.firm_id}`))}`;
    const r = await conn.query(
      /* shipping_address is on the table and exposed by the
         enable_shipping_address setting, but was missing from this insert —
         anything typed into it was silently dropped on save. */
      `INSERT INTO parties (firm_id, party_no, name, party_type, gstin, state_code, phone, email, billing_address, shipping_address, opening_balance, balance, credit_limit, credit_days, group_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.firm_id, no, b.name, b.party_type || "customer", b.gstin || null, b.state_code || null,
       b.phone || null, b.email || null, b.billing_address || null, b.shipping_address || null,
       Number(b.opening_balance) || 0, Number(b.opening_balance) || 0,
       Number(b.credit_limit) || 0, Number(b.credit_days) || 0, b.group_id || null]
    );
    await conn.commit();
    res.success({ id: r.insertId, party_no: no }, "Party saved");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
