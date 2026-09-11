const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { listQuery, sendList } = require("../../shared/paginate");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { nextSeq, pad, ensureUniqueDocNumbers } = require("../../shared/sequences");
const { computeInvoice } = require("../../shared/tax.engine");
const { postDocument } = require("../../shared/stock.poster");
const { baseQuantity } = require("../../shared/units");
const { postJournal, reverseJournal, templates, round2 } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");
const { getSetting } = require("../settings/settings.service");
const { ensureKeys, clientRef, findByRef, isDuplicateRef } = require("./idempotency");
const { blockClosed } = require("../../shared/periodlock");

router.use(verifyToken);

async function loadTaxRules(firmId) {
  return (await query("SELECT * FROM tax_rules WHERE firm_id = ? AND is_active = 1 ORDER BY apply_order", [firmId])).rows;
}

/* The status the list shows is not the status stored on the row: a bill that
   is open and past its due date is overdue, and one that is part-paid is
   partial. That used to be worked out in the browser, which meant a filter
   could only sift the page already loaded — "Overdue" on page 1 of 25 showed
   the overdue rows on page 1, and the pager still counted all of them.
   The same rules live here now, in the WHERE clause, so a filter narrows the
   whole book and the count underneath it is true.

   Precedence matches the pill exactly: voided, then paid, then overdue, then
   partial, then unpaid. An overdue bill that is part-paid reads overdue,
   because the date is the more urgent fact. */
const OPEN = "COALESCE(s.status,'') <> 'voided' AND s.balance_due > 0.005";
const STATUS_FILTERS = {
  paid:    "COALESCE(s.status,'') <> 'voided' AND s.balance_due <= 0.005",
  overdue: `${OPEN} AND COALESCE(s.due_date, s.invoice_date) < date('now')`,
  partial: `${OPEN} AND s.paid_amount > 0 AND COALESCE(s.due_date, s.invoice_date) >= date('now')`,
  unpaid:  OPEN,
  voided:  "COALESCE(s.status,'') = 'voided'",
  credit:  "COALESCE(s.payment_type,'credit') = 'credit'",
  cash:    "COALESCE(s.payment_type,'credit') = 'cash'",
};

router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const where = ["s.firm_id = ?"];
  const cond = STATUS_FILTERS[String(req.query.status || "").trim()];
  if (cond) where.push(`(${cond})`);

  sendList(res, await listQuery({
    req,
    select: "SELECT s.*, p.name AS party_name FROM sale_invoices s JOIN parties p ON p.id = s.party_id",
    countFrom: "FROM sale_invoices s JOIN parties p ON p.id = s.party_id",
    where, args: [req.user.firm_id],
    orderBy: "s.id DESC",
    searchCols: ["s.invoice_no", "p.name", "s.notes"],
    dateCol: "s.invoice_date",
    sumCols: { paid: "s.paid_amount", unpaid: "s.balance_due", grand: "s.grand_total" },
  }));
});

/* Whole-book figures for the panels above the list. Registered above "/:id"
   so "overview" is never read as an invoice id. */
require("./overview.routes").attach(router, requirePermission);

router.get("/by-number/:no", requirePermission("sales", "view"), async (req, res) => {
  const no = String(req.params.no || "").trim();
  const inv = (await query(
    "SELECT s.*, (SELECT name FROM parties WHERE id = s.party_id) AS party_name, (SELECT COALESCE(full_name,username) FROM users WHERE id = s.sales_rep_id) AS sales_rep_name, (SELECT COALESCE(full_name,username) FROM users WHERE id = s.created_by) AS created_by_name FROM sale_invoices s WHERE s.firm_id = ? AND s.invoice_no = ?",
    [req.user.firm_id, no])).rows[0];
  if (!inv) return res.fail("No receipt found for " + no, 404);
  inv.lines = (await query("SELECT * FROM sale_invoice_lines WHERE firm_id = ? AND invoice_id = ?", [req.user.firm_id, inv.id])).rows;
  res.success(inv);
});

/* "Did my sale land?" answered as a lookup rather than a guess.
   The till asks this after a save whose outcome it could not see. Registered
   above "/:id" so "by-ref" is never read as an invoice id. */
router.get("/by-ref/:ref", requirePermission("sales", "view"), async (req, res) => {
  await ensureKeys();
  const ref = String(req.params.ref || "").trim();
  const inv = ref
    ? (await query("SELECT * FROM sale_invoices WHERE firm_id = ? AND client_ref = ?", [req.user.firm_id, ref])).rows[0]
    : null;
  if (!inv) return res.fail("No sale was posted under that reference", 404);
  res.success(existingSaleReply(inv));
});

router.get("/:id", requirePermission("sales", "view"), async (req, res) => {
  const inv = (await query("SELECT s.*, (SELECT name FROM parties WHERE id = s.party_id) AS party_name, (SELECT COALESCE(full_name,username) FROM users WHERE id = s.sales_rep_id) AS sales_rep_name, (SELECT COALESCE(full_name,username) FROM users WHERE id = s.created_by) AS created_by_name FROM sale_invoices s WHERE s.id = ? AND s.firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!inv) return res.notFound("Invoice not found");
  inv.lines = (await query("SELECT * FROM sale_invoice_lines WHERE firm_id = ? AND invoice_id = ?", [req.user.firm_id, inv.id])).rows;
  inv.taxes = inv.tax_breakdown ? JSON.parse(inv.tax_breakdown) : [];
  res.success(inv);
});

/* Named so the recurring-documents runner can reuse this exact handler —
   every guard, tax rule and posting stays identical to a hand-keyed one. */

/**
 * reverseSaleEffects — undo everything an invoice did to the books and shelf.
 *
 * Shared by voiding and by editing. An edit is a reversal followed by a fresh
 * posting under the same document number; keeping one implementation means the
 * two can never drift into reversing different things.
 */
/**
 * Put quantity back on the shelf, into the batch rows it came out of.
 *
 * `item_stock` holds ONE ROW PER BATCH — `UNIQUE(firm_id, item_id, batch_no)`.
 * This used to be a bare
 *
 *     UPDATE item_stock SET quantity = quantity + ? WHERE firm_id=? AND item_id=?
 *
 * with no batch in the WHERE, so it added the returned quantity to EVERY batch
 * row the item had. Void a 6-unit sale of an item held in three lots and 18
 * units came back: the shop's stock figure rose by 12 units it did not own, its
 * stock valuation rose with it, and the reorder report went quiet on an item
 * that was actually running out. An item kept in a single lot — most of them —
 * behaved correctly, which is why this survived: it only bites the shops that
 * track batches or expiry, and it bites them silently.
 *
 * The movement ledger already records which batch each unit left from, so the
 * return follows it: newest movement first, giving each batch back what it
 * gave, and anything left over (an older sale whose movements predate batch
 * tracking) goes to the batch the item is currently held in.
 */
async function restoreToBatches(conn, { firmId, itemId, quantity }) {
  let left = +Number(quantity).toFixed(4);
  if (!(left > 0)) return;
  const out = (await conn.query(
    `SELECT batch_no, SUM(quantity) q FROM stock_movements
      WHERE firm_id=? AND item_id=? AND direction='out'
      GROUP BY batch_no ORDER BY MAX(id) DESC`, [firmId, itemId])).rows;
  const give = async (batch, qty) => {
    const row = (await conn.query("SELECT id FROM item_stock WHERE firm_id=? AND item_id=? AND batch_no=?",
      [firmId, itemId, batch || ""])).rows[0];
    if (row) await conn.query("UPDATE item_stock SET quantity = ROUND(quantity + ?, 4) WHERE id = ?", [qty, row.id]);
    else await conn.query("INSERT INTO item_stock (firm_id, item_id, batch_no, quantity) VALUES (?,?,?,?)",
      [firmId, itemId, batch || "", qty]);
  };
  for (const o of out) {
    if (left <= 0.0001) break;
    const take = Math.min(left, Number(o.q) || 0);
    if (take <= 0) continue;
    await give(o.batch_no, +take.toFixed(4));
    left = +(left - take).toFixed(4);
  }
  if (left > 0.0001) {
    /* Nothing in the ledger to attribute it to. Put it where the item is
       actually held rather than creating a phantom batch nobody can sell. */
    const held = (await conn.query(
      "SELECT batch_no FROM item_stock WHERE firm_id=? AND item_id=? ORDER BY quantity DESC LIMIT 1",
      [firmId, itemId])).rows[0];
    await give(held ? held.batch_no : "", left);
  }
}

async function reverseSaleEffects(conn, { firmId, inv, userId, label }) {
  const today = new Date().toISOString().slice(0, 10);
  await reverseJournal(conn, { firmId, sourceModule: "sales", sourceId: inv.id, date: today, description: `${label} ${inv.invoice_no}`, userId });
  await reverseJournal(conn, { firmId, sourceModule: "payments", sourceId: inv.id, date: today, description: `${label} payment ${inv.invoice_no}`, userId });

  const lines = (await conn.query("SELECT * FROM sale_invoice_lines WHERE firm_id=? AND invoice_id=?", [firmId, inv.id])).rows;
  for (const l of lines) {
    if (!l.item_id) continue;
    /* base_quantity is what actually left the shelf; the raw line quantity
       would put 10 BAGS back for a 10 KG sale out of a 50 KG bag. */
    const qty = l.base_quantity != null ? Number(l.base_quantity) : await baseQuantity(conn.query, l);
    await conn.query(
      "INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module, source_id, move_date) VALUES (?,?,?,?,?,?,?,?)",
      [firmId, l.item_id, "in", qty, 0, label.toLowerCase(), inv.id, today]);
    await restoreToBatches(conn, { firmId, itemId: l.item_id, quantity: qty });
  }
  if (inv.balance_due > 0) {
    await conn.query("UPDATE parties SET balance = ROUND(balance - ?, 2) WHERE id=?", [inv.balance_due, inv.party_id]);
  }
  return lines;
}

/**
 * What POST /sales says about an invoice that already exists.
 *
 * A retry must be indistinguishable from the attempt it is retrying, so this
 * rebuilds the create response out of the stored row rather than inventing a
 * shorter "duplicate" shape the caller would have to know about. `duplicate`
 * is added for anything that cares (the till uses it to skip the receipt it
 * has already printed); nothing has to look at it.
 */
function existingSaleReply(row) {
  let taxes = [];
  try { taxes = JSON.parse(row.tax_breakdown || "[]") || []; } catch { taxes = []; }
  return {
    id: row.id,
    invoice_no: row.invoice_no,
    payment_type: row.payment_type || "cash",
    totals: {
      sub_total: row.sub_total, discount_total: row.discount_total, taxes,
      tax_total: row.tax_total, round_off: row.round_off, grand_total: row.grand_total,
    },
    points_earned: 0,
    /* Both names on purpose. `duplicate` is what this answered with before the
       other documents gained the same protection; `replayed` is what all seven
       of them say now, so a caller needs one test rather than a table of
       per-endpoint spellings. The old name stays until nothing reads it. */
    duplicate: true,
    replayed: true,
  };
}

const createSale = async (req, res, next) => {
  const conn = await pool.getConnection();
  /* Declared out here so the duplicate-key rescue in the catch can see it. */
  let ref = null;
  try {
    const b = req.body || {};
    const firmId = req.user.firm_id;

    /* An edit works from the row as it is now, not as it was when the route
       was entered. PUT /sales/:id checks the invoice before handing over, but
       that check runs before the write lock is taken; if a second till voided
       the same invoice in between, the edit would reverse a posting that had
       already been reversed and put the stock back on the shelf twice. Read it
       again here, under the lock, and refuse a document that has moved on. */
    if (req._editInvoiceId) {
      const fresh = (await query("SELECT * FROM sale_invoices WHERE id=? AND firm_id=?", [req._editInvoiceId, firmId])).rows[0];
      if (!fresh) return res.fail("Sale not found", 404);
      if (fresh.status === "voided") return res.fail("A voided sale can't be edited — issue a new one", 400);
      req._editInvoice = fresh;
    }

    /* ── idempotency ──
       An edit is deliberately excluded: PUT /sales/:id reuses this handler to
       rewrite one named document, and the caller already knows which. Only a
       *create* can be accidentally duplicated by a retry. */
    await ensureKeys();
    /* Outside the transaction below on purpose: creating an index inside it
       would put a failure on a shop that already has a duplicate number in
       the way of every sale it tries to ring up. */
    await ensureUniqueDocNumbers(query);
    ref = req._editInvoice ? null : clientRef(req);
    if (ref) {
      const prior = await findByRef("sale_invoices", firmId, ref);
      /* Already posted under this reference. Hand back the same invoice with
         the same 200 the first attempt got — the caller cannot tell whether
         its first try landed, and it must not have to. */
      if (prior) return res.success(existingSaleReply(prior), "Invoice created");
    }
    const firm = (await query("SELECT * FROM firms WHERE id = ?", [firmId])).rows[0];
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
    if (!party) return res.fail("Choose a customer first", 400);
    if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);

    const paymentType = b.payment_type === "cash" ? "cash" : "credit";

    /* ── Aronium-grade guards (server side, cannot be bypassed by UI) ── */
    if (paymentType === "credit" && await getSetting(firmId, "force_customer_on_credit", "1") === "1" && party.name === "Cash Sale") {
      return res.fail("Credit sales need a saved customer — pick or add one first", 400);
    }
    const belowCostOn = await getSetting(firmId, "prevent_below_cost", "1") === "1";
    const negStockOn = await getSetting(firmId, "prevent_negative_stock", "1") === "1";
    for (const ln of b.lines) {
      if (!ln.item_id) continue;
      const it = (await query("SELECT * FROM items WHERE id = ? AND firm_id = ?", [ln.item_id, firmId])).rows[0];
      /* An id we cannot find in this business is refused rather than waved
         through. Skipping it meant every guard below — price lock, below-cost,
         negative stock — was skipped too, and the line was still written,
         carrying a foreign item id into our own document. */
      if (!it) return res.fail("One of these lines refers to an item that isn't in this business", 400);
      if (it.is_active === 0) return res.fail(`"${it.name}" is inactive and can't be sold`, 400);
      // effective per-base-unit price the cashier is charging
      const perBase = ln.use_secondary && it.conversion_rate > 0 ? Number(ln.rate) * it.conversion_rate : Number(ln.rate);
      // compare like-for-like: when selling secondary, cost is per-secondary-unit (base cost / conversion)
      if (belowCostOn && it.purchase_price > 0 && !b.manager_override) {
        const unitCost = ln.use_secondary && it.conversion_rate > 0 ? it.purchase_price / it.conversion_rate : it.purchase_price;
        const unitRate = Number(ln.rate);
        if (unitRate < unitCost - 0.01) {
          const u = ln.use_secondary ? (it.secondary_unit || "unit") : it.unit;
          return res.fail(`Below cost: "${it.name}" costs Sh ${unitCost.toFixed(2)} per ${u} — blocked by Settings`, 400);
        }
      }
      if (it.price_change_allowed === 0 && !b.manager_override) {
        // allowed prices: default, party special rate, any price-list price
        const allowed = [it.sale_price];
        // A price-locked item sold in its secondary unit still charges the
        // configured secondary price — accept it rather than reading the
        // scaled-up equivalent as tampering.
        if (ln.use_secondary && it.conversion_rate > 0) {
          if (it.secondary_price > 0) allowed.push(Number(it.secondary_price) * it.conversion_rate);
          allowed.push(it.sale_price);
        }
        const pr = (await query("SELECT rate FROM party_item_rates WHERE firm_id=? AND party_id=? AND item_id=?", [firmId, party.id, ln.item_id])).rows[0];
        if (pr) allowed.push(pr.rate);
        for (const r of (await query("SELECT price FROM price_list_items WHERE firm_id=? AND item_id=?", [firmId, ln.item_id])).rows) allowed.push(r.price);
        if (!allowed.some((a) => Math.abs(a - perBase) < 0.01)) {
          return res.fail(`Price is fixed for "${it.name}" — changing it isn't allowed`, 400);
        }
      }
      if (negStockOn && it.is_inventory === 1) {
        const onHand = (await query("SELECT COALESCE(SUM(quantity),0) v FROM item_stock WHERE firm_id=? AND item_id=?", [firmId, ln.item_id])).rows[0].v;
        const baseQty = ln.use_secondary && it.conversion_rate > 0 ? Number(ln.quantity) / it.conversion_rate : Number(ln.quantity);
        if (baseQty > onHand + 1e-9) {
          return res.fail(`Only ${onHand} ${it.unit} of "${it.name}" in stock — negative stock is blocked`, 400);
        }
      }
    }
    if (b.manager_override) {
      await query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
        [req.user.id, "sales", "override", 0, b.manager_override_note || "manager override on guard"]);
    }
    const cashCode = b.cash_account_code || CODES.CASH;

    /* Sales rep — who the sale is credited to. Defaults to the operator, but the
       till can attribute it to another staff member. When the shop has made it
       mandatory, an explicit rep must be sent (the client always sends one, so
       this only bites API callers). The rep must be a real active user in this
       firm — never trust an id off the wire. */
    let salesRepId = req.user.id;
    if (b.sales_rep_id != null && b.sales_rep_id !== "") {
      const rep = (await query("SELECT id FROM users WHERE id = ? AND active_firm_id = ? AND status = 'active'",
        [b.sales_rep_id, firmId])).rows[0];
      if (!rep) return res.fail("The chosen sales rep isn't a valid active user", 400);
      salesRepId = rep.id;
    } else if (await getSetting(firmId, "require_sales_rep", "1") === "1") {
      return res.fail("Choose a sales rep for this sale", 400);
    }

    /* Optional till discipline: a shop can require an open shift before any sale.
       Off by default (passive tracking), turned on in Transaction settings. */
    if (await getSetting(firmId, "block_sales_without_shift", "0") === "1") {
      let open = null;
      try {
        open = (await query(
          "SELECT id FROM shifts WHERE firm_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
          [firmId, req.user.id])).rows[0];
      } catch { open = { id: 0 }; }   // shifts feature not installed yet — don't block
      if (!open) return res.fail("No open shift — start your shift before making sales", 409);
    }

    let taxesOn = await getSetting(firmId, "taxes_enabled", "1") === "1";
    // per-context gates: POS flag (client marks pos sales), plus cash/credit
    if (taxesOn && b.source === "pos" && await getSetting(firmId, "tax_on_pos", "1") !== "1") taxesOn = false;
    if (taxesOn && b.payment_type === "credit" && await getSetting(firmId, "tax_on_credit", "1") !== "1") taxesOn = false;
    if (taxesOn && b.payment_type !== "credit" && await getSetting(firmId, "tax_on_cash", "1") !== "1") taxesOn = false;
    const roundOffOn = await getSetting(firmId, "round_off", "1") === "1";
    const roundStep = Number(await getSetting(firmId, "cash_round_to", "1")) || 1;

    const { lines, totals } = computeInvoice({
      lines: b.lines,
      rules: taxesOn ? await loadTaxRules(firmId) : [],
      roundOff: roundOffOn, roundTo: roundStep,
      /* Settings → Transactions → "Prices include tax". Read here rather than
         trusted from the request: what a price means is the shop's standing
         decision, not something a client should be able to assert per sale. */
      pricesIncludeTax: await getSetting(firmId, "tax_inclusive_default", "0") === "1",
    });

    const paid = paymentType === "cash" ? totals.grand_total : Math.min(Number(b.paid_amount) || 0, totals.grand_total);
    const balanceDue = +(totals.grand_total - paid).toFixed(2);
    const status = balanceDue <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

    if (paymentType === "credit" && await getSetting(firmId, "enable_credit_limit", "0") === "1" && party.credit_limit > 0) {
      const projected = party.balance + balanceDue;
      if (projected > party.credit_limit) {
        return res.fail(`Credit limit exceeded: balance would be Sh ${projected.toFixed(2)} of Sh ${party.credit_limit} limit`, 400);
      }
    }

    await conn.beginTransaction();

    /* An edit rewrites the same document rather than issuing a new one, so the
       invoice number is kept, the previous posting is reversed first, and the
       row is marked as edited. A POS receipt stays a receipt — re-labelling a
       cash sale as an invoice on edit would change what it is. */
    const editing = req._editInvoice || null;
    const no = editing
      ? editing.invoice_no
      : `${await getSetting(firmId, "invoice_prefix", firm.invoice_prefix || "INV")}-${pad(await nextSeq(conn, `INV:firm${firmId}`))}`;
    const dt = b.invoice_date || new Date().toISOString().slice(0, 10);
    if (await blockClosed(req, res, dt, "sale")) { await conn.rollback(); return; }
    const docType = editing ? (editing.doc_type || "invoice") : "invoice";

    let invoiceId;
    if (editing) {
      await reverseSaleEffects(conn, { firmId, inv: editing, userId: req.user.id, label: "Edit" });
      await conn.query("DELETE FROM sale_invoice_lines WHERE firm_id=? AND invoice_id=?", [firmId, editing.id]);
      await conn.query(
        `UPDATE sale_invoices SET
           party_id=?, invoice_date=?, due_date=?, payment_type=?, cash_account_code=?,
           sub_total=?, discount_total=?, tax_breakdown=?, tax_total=?, round_off=?,
           grand_total=?, paid_amount=?, balance_due=?, notes=?, status=?, sales_rep_id=?,
           edited_at=?, edit_count=COALESCE(edit_count,0)+1
         WHERE id=? AND firm_id=?`,
        [party.id, dt, b.due_date || null, paymentType, paymentType === "cash" ? cashCode : null,
         totals.sub_total, totals.discount_total,
         JSON.stringify(totals.taxes), totals.tax_total, totals.round_off,
         totals.grand_total, paid, balanceDue, b.notes || null, status, salesRepId,
         new Date().toISOString(), editing.id, firmId]);
      invoiceId = editing.id;
    } else {
      const r = await conn.query(
        `INSERT INTO sale_invoices
          (firm_id, invoice_no, doc_type, party_id, invoice_date, due_date,
           payment_type, cash_account_code, sub_total, discount_total,
           tax_breakdown, tax_total, round_off, grand_total, paid_amount, balance_due, notes, status, created_by, sales_rep_id,
           client_ref)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [firmId, no, docType, party.id, dt, b.due_date || null,
         paymentType, paymentType === "cash" ? cashCode : null,
         totals.sub_total, totals.discount_total,
         JSON.stringify(totals.taxes), totals.tax_total, totals.round_off,
         totals.grand_total, paid, balanceDue, b.notes || null, status, req.user.id, salesRepId,
         ref]
      );
      invoiceId = r.insertId;
    }

    /* One authoritative conversion per line: how many BASE units left the shelf.
       Shared with returns and the stock poster so they can't disagree. */
    const baseQtyOf = async (ln) => await baseQuantity(query, ln);

    for (const ln of lines) {
      await conn.query(
        `INSERT INTO sale_invoice_lines
          (firm_id, invoice_id, item_id, description, batch_no, quantity, base_quantity, unit, rate,
           discount_pct, discount_amt, taxable_value, line_total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [firmId, invoiceId, ln.item_id || null, ln.description || null, ln.batch_no || "",
         ln.quantity, await baseQtyOf(ln), ln.unit || null, ln.rate,
         Number(ln.discount_pct) || 0, ln.discount_amt, ln.taxable_value, ln.line_total]
      );
    }

    let stockOut = null;   // cost of the goods that left, for the COGS entry
    if (await getSetting(firmId, "stock_maintenance", "1") === "1") {
      // Same conversion the lines were stored with — one source of truth.
      /* A loop, not .map(): the base-unit conversion reads the item, so the
         callback would be async and the stock posting would be handed
         promises instead of lines. */
      const stockLines = [];
      for (const ln of lines) stockLines.push({ ...ln, quantity: await baseQtyOf(ln) });
      stockOut = await postDocument(conn, { firmId, lines: stockLines, direction: "out", sourceModule: "sales", sourceId: invoiceId, userId: req.user.id });
    }

    const glArgs = { subTotal: totals.sub_total, deducted: totals.deducted_total, added: totals.added_total, roundOff: totals.round_off };
    // Per-item sales-account overrides: split the Sales credit across the accounts the
    // user chose on each item. Items with no override fall back to the default Sales account.
    const salesSplit = {};
    for (const ln of lines || []) {
      const it = ln.item_id ? (await conn.query("SELECT sales_account_code FROM items WHERE id=? AND firm_id=?", [ln.item_id, firmId])).rows[0] : null;
      const code = (it && it.sales_account_code) || null;
      if (code) salesSplit[code] = round2((salesSplit[code] || 0) + Number(ln.taxable_value || ln.line_total || 0));
    }
    if (Object.keys(salesSplit).length) glArgs.salesSplit = salesSplit;

    // Cost of goods sold — the other half of a sale. Without this the P&L shows
    // revenue with no matching cost, so gross profit is meaningless.
    const postCogs = async () => {
      if (!stockOut || stockOut.totalCost <= 0.004) return;
      const split = {};
      for (const [itemId, cost] of Object.entries(stockOut.costByItem || {})) {
        if (cost <= 0) continue;
        const it = (await conn.query("SELECT cogs_account_code FROM items WHERE id=? AND firm_id=?", [itemId, firmId])).rows[0];
        if (it && it.cogs_account_code) split[it.cogs_account_code] = round2((split[it.cogs_account_code] || 0) + cost);
      }
      const lines = templates.cogs({ totalCost: stockOut.totalCost, split });
      if (lines.length) {
        await postJournal(conn, {
          firmId, date: dt, description: `Cost of goods — ${no}`, reference: no,
          sourceModule: "sales", sourceId: invoiceId, userId: req.user.id, lines,
        });
      }
    };

    if (paymentType === "cash") {
      await postJournal(conn, {
        firmId, date: dt, description: `Cash sale ${no}`, reference: no,
        sourceModule: "sales", sourceId: invoiceId, userId: req.user.id,
        lines: templates.saleCash({ ...glArgs, cashCode }),
      });
      await postCogs();
      await recordPayment(conn, { firmId, party, amount: paid, mode: b.payment_mode || "cash", invoiceId, date: dt, userId: req.user.id });
    } else {
      await postJournal(conn, {
        firmId, date: dt, description: `Credit sale ${no}`, reference: no,
        sourceModule: "sales", sourceId: invoiceId, userId: req.user.id,
        lines: templates.saleCredit(glArgs),
      });
      await postCogs();
      await conn.query("UPDATE parties SET balance = ROUND(balance + ?, 2) WHERE id = ?", [totals.grand_total, party.id]);
      if (paid > 0) {
        await postJournal(conn, {
          firmId, date: dt, description: `Payment on ${no}`, reference: no,
          sourceModule: "payments", sourceId: invoiceId, userId: req.user.id,
          lines: templates.paymentIn({ amount: paid, cashCode }),
        });
        await conn.query("UPDATE parties SET balance = ROUND(balance - ?, 2) WHERE id = ?", [paid, party.id]);
        await recordPayment(conn, { firmId, party, amount: paid, mode: b.payment_mode || "cash", invoiceId, date: dt, userId: req.user.id });
      }
    }

    /* ── Turning a quotation into this invoice ────────────────────────────
     *
     * The conversion used to be two requests from the browser: post the sale,
     * then flip the quote to "converted". The comment on it read "atomic
     * enough: status only flips after the invoice exists" — which is true and
     * is not the risk. The risk is the other order: the invoice exists and the
     * second request never lands, because the connection dropped in between.
     * The quote then still reads "open", and the next person to look at it
     * converts it again — a second real invoice, a second lot of stock off the
     * shelf, for one job.
     *
     * Done here instead, inside the invoice's own transaction, so the two
     * facts are one fact. If anything below fails, the quote is untouched.
     */
    if (b.convert_estimate_id) {
      const est = (await conn.query("SELECT * FROM estimates WHERE id = ? AND firm_id = ?",
        [b.convert_estimate_id, firmId])).rows[0];
      if (!est) { await conn.rollback(); return res.fail("That quotation no longer exists", 404); }
      if (est.status === "converted") {
        await conn.rollback();
        return res.fail(`${est.doc_no} has already been turned into an invoice`, 409);
      }
      await conn.query("UPDATE estimates SET status='converted', converted_invoice_id=? WHERE id=? AND firm_id=?",
        [invoiceId, est.id, firmId]);
      await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
        [req.user.id, "sales", "convert_estimate", invoiceId, `${est.doc_no} → ${no}`]);
    }

    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "sales", "create", invoiceId, `${no} (${paymentType})`]);

    /* Loyalty points are a consequence of the sale, so they are awarded inside
       its transaction — a rolled-back invoice can never leave points behind.
       Does nothing unless the Loyalty module is switched on. */
    /* Warranty cover, like points, belongs to the sale's transaction. */
    const { coverForSale } = require("../warranty/warranty.routes");
    await coverForSale(conn, { firmId, partyId: party.id, invoiceId, lines, userId: req.user.id });

    const { awardForSale } = require("../loyalty/loyalty.routes");
    const pointsEarned = await awardForSale(conn, {
      firmId, partyId: party.id, invoiceId, amount: totals.grand_total,
      paymentType, userId: req.user.id, partyName: party.name,
    });

    await conn.commit();
    res.success({ id: invoiceId, invoice_no: no, payment_type: paymentType, totals, points_earned: pointsEarned || 0 },
      pointsEarned ? `Invoice created — ${party.name} earned ${pointsEarned} point${pointsEarned === 1 ? "" : "s"}` : editing ? `${no} updated` : "Invoice created");
  } catch (err) {
    await conn.rollback();
    /* Two copies of the same request in flight at once: both got past the
       lookup above, and the unique index stopped the second one writing. The
       first has committed by now, so answer with it — the retry still sees
       exactly what the original attempt saw. This is the layer that makes the
       key a guarantee rather than a narrower race. */
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("sale_invoices", req.user.firm_id, ref);
      if (prior) return res.success(existingSaleReply(prior), "Invoice created");
    }
    next(err);
  }
  finally { conn.release(); }
};
router.post("/", requirePermission("sales", "create"), createSale);

/* A genuine edit. Previously the interface offered "Edit" but posted a second
   invoice, so a correction double-counted the sale. This rewrites the document
   in place: the old posting is reversed, the new one applied, the number kept
   and the row stamped as edited. */
router.put("/:id", requirePermission("sales", "edit"), async (req, res, next) => {
  const inv = (await query("SELECT * FROM sale_invoices WHERE id=? AND firm_id=?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!inv) return res.fail("Sale not found", 404);
  if (inv.status === "voided") return res.fail("A voided sale can't be edited — issue a new one", 400);
  /* The id, not the row: createSale re-reads it once it holds the write lock,
     so a void that landed in between cannot be edited over the top of. */
  req._editInvoiceId = inv.id;
  return await createSale(req, res, next);
});

async function recordPayment(conn, { firmId, party, amount, mode, invoiceId, date, userId }) {
  if (amount <= 0) return;
  const payNo = `PAY-${pad(await nextSeq(conn, `PAY:firm${firmId}`))}`;
  const pr = await conn.query(
    `INSERT INTO payments (firm_id, payment_no, direction, party_id, payment_date, amount, mode, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [firmId, payNo, "in", party.id, date, amount, mode, userId]
  );
  await conn.query("INSERT INTO payment_allocations (firm_id, payment_id, doc_table, doc_id, amount) VALUES (?,?,?,?,?)",
    [firmId, pr.insertId, "sale_invoices", invoiceId, amount]);
}

/* Void a posted sale: reverse GL, restore stock, reverse party balance, mark voided, log for Z-report. */
router.delete("/:id", requirePermission("sales", "delete"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const inv = (await conn.query("SELECT * FROM sale_invoices WHERE id=? AND firm_id=?", [req.params.id, firmId])).rows[0];
    if (!inv) { conn.release(); return res.fail("Sale not found", 404); }
    if (inv.status === "voided") { conn.release(); return res.fail("Already voided", 400); }
    const lines = (await conn.query("SELECT * FROM sale_invoice_lines WHERE firm_id=? AND invoice_id=?", [firmId, inv.id])).rows;
    const today = new Date().toISOString().slice(0, 10);

    await conn.beginTransaction();
    // 1) reverse the accounting
    await reverseJournal(conn, { firmId, sourceModule: "sales", sourceId: inv.id, date: today, description: `Void ${inv.invoice_no}`, userId: req.user.id });
    await reverseJournal(conn, { firmId, sourceModule: "payments", sourceId: inv.id, date: today, description: `Void payment ${inv.invoice_no}`, userId: req.user.id });
    // 2) restore stock for each line, in BASE units.
    //    This restored the raw line quantity, so voiding a 10 KG sale of a
    //    50 KG bag put 10 whole BAGS back on the shelf. base_quantity is the
    //    figure the sale actually took off the shelf; older rows fall back to
    //    the same conversion the backfill applied.
    for (const l of lines) {
      if (!l.item_id) continue;
      const qty = l.base_quantity != null ? Number(l.base_quantity) : await baseQuantity(conn.query, l);
      await conn.query(
        "INSERT INTO stock_movements (firm_id, item_id, direction, quantity, unit_cost, source_module, source_id, move_date) VALUES (?,?,?,?,?,?,?,?)",
        [firmId, l.item_id, "in", qty, 0, "void", inv.id, today]);
      await restoreToBatches(conn, { firmId, itemId: l.item_id, quantity: qty });
    }
    // 3) reverse party balance (credit portion)
    if (inv.balance_due > 0) await conn.query("UPDATE parties SET balance = ROUND(balance - ?, 2) WHERE id=?", [inv.balance_due, inv.party_id]);
    // 4) mark voided
    await conn.query("UPDATE sale_invoices SET status='voided', balance_due=0 WHERE id=?", [inv.id]);
    // 5) log so X/Z reports show it (cash reduces via the paid amount)
    const voidQty = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
    const voidAmt = Number(inv.paid_amount) || Number(inv.grand_total) || 0;
    const voidReason = (req.body && req.body.reason) ? String(req.body.reason) : "Sale voided";
    await conn.query("INSERT INTO void_log (firm_id, user_id, scope, item_name, quantity, amount, reason) VALUES (?,?,?,?,?,?,?)",
      [firmId, req.user.id, "sale", String(inv.invoice_no), voidQty, voidAmt, voidReason]);
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "sales", "void", inv.id, inv.invoice_no]);
    await conn.commit();
    res.success({ id: inv.id, voided: true }, `${inv.invoice_no} voided`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
module.exports.createSale = createSale;
