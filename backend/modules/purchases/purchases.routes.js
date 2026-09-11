const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { baseQuantity } = require("../../shared/units");
const { listQuery, sendList } = require("../../shared/paginate");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { nextSeq, pad } = require("../../shared/sequences");
const { computeInvoice } = require("../../shared/tax.engine");
const { postDocument } = require("../../shared/stock.poster");
const { postJournal, templates, round2 } = require("../../shared/accounting.poster");
const { blockedReason, voidLedger, unwindStock, logAudit, today: todayStr } = require("../../shared/voucher");
const { clientRef, findByRef, isDuplicateRef, ensureKeys } = require("../../shared/idempotency");
const { CODES } = require("../../shared/account.codes");
const { getSetting } = require("../settings/settings.service");
const { blockClosed } = require("../../shared/periodlock");

router.use(verifyToken);

async function loadTaxRules(firmId) {
  return (await query("SELECT * FROM tax_rules WHERE firm_id = ? AND is_active = 1 ORDER BY apply_order", [firmId])).rows;
}

/* The status a bill shows is worked out, not stored: one still owing past its
   due date is overdue. Same approach as the sales list — the rule lives here
   so a filter narrows the whole book and the count under the table is the
   count for that filter, rather than describing only the page on screen. */
const P_OPEN = "b.balance_due > 0.005";
const PURCHASE_FILTERS = {
  paid:    "b.balance_due <= 0.005",
  overdue: `${P_OPEN} AND COALESCE(b.due_date, b.bill_date) < date('now')`,
  partial: `${P_OPEN} AND b.paid_amount > 0`,
  unpaid:  P_OPEN,
};

router.get("/", requirePermission("purchases", "view"), async (req, res) => {
  const where = ["b.firm_id = ?"];
  const cond = PURCHASE_FILTERS[String(req.query.status || "").trim()];
  if (cond) where.push(`(${cond})`);

  sendList(res, await listQuery({
    req,
    select: "SELECT b.*, p.name AS party_name FROM purchase_invoices b JOIN parties p ON p.id = b.party_id",
    countFrom: "FROM purchase_invoices b JOIN parties p ON p.id = b.party_id",
    where, args: [req.user.firm_id],
    orderBy: "b.id DESC",
    searchCols: ["b.bill_no", "p.name"],
    dateCol: "b.bill_date",
  }));
});

/* Whole-book figures for the panels above the list. Above "/:id" so the word
   "overview" is never taken for a bill id. */
require("./overview.routes").attach(router, requirePermission);

router.get("/:id", requirePermission("purchases", "view"), async (req, res) => {
  const bill = (await query("SELECT * FROM purchase_invoices WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!bill) return res.notFound("Bill not found");
  bill.lines = (await query("SELECT * FROM purchase_invoice_lines WHERE firm_id = ? AND bill_id = ?", [req.user.firm_id, bill.id])).rows;
  bill.taxes = bill.tax_breakdown ? JSON.parse(bill.tax_breakdown) : [];
  /* Aliases, not a rename. The print templates read `invoice_no`,
     `invoice_date` and `party_name`, and a purchase bill calls the same three
     things `bill_no`, `bill_date` and nothing at all. Adding the aliases here
     rather than translating in the browser means one document shape reaches
     the templates from all six screens that print — renaming the real columns
     would break every existing consumer of this endpoint. */
  const supplier = (await query("SELECT name FROM parties WHERE id = ? AND firm_id = ?", [bill.party_id, req.user.firm_id])).rows[0];
  bill.party_name = supplier ? supplier.name : null;
  bill.invoice_no = bill.bill_no;
  bill.invoice_date = bill.bill_date;
  res.success(bill);
});

/* Named so the recurring-documents runner can reuse this exact handler —
   every guard, tax rule and posting stays identical to a hand-keyed one. */
/* What a replayed POST /purchases answers with — the same shape the first
   attempt returned, so the caller cannot tell a retry from the original. */
function existingBillReply(bill) {
  return {
    id: bill.id, bill_no: bill.bill_no,
    payment_type: Number(bill.balance_due) > 0 ? "credit" : "cash",
    totals: {
      sub_total: bill.sub_total, discount_total: bill.discount_total,
      tax_total: bill.tax_total, round_off: bill.round_off, grand_total: bill.grand_total,
      taxes: bill.tax_breakdown ? (() => { try { return JSON.parse(bill.tax_breakdown); } catch { return []; } })() : [],
    },
    replayed: true,
  };
}

const createPurchase = async (req, res, next) => {
  const conn = await pool.getConnection();
  let ref = null;
  try {
    const b = req.body || {};
    const firmId = req.user.firm_id;
    const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
    if (!party) return res.fail("Choose a supplier first", 400);
    if (!Array.isArray(b.lines) || !b.lines.length) return res.fail("Add at least one item", 400);

    /* Every line that names an item must name one of ours. Nothing checked
       this, so a bill could be filed against another business's item id, which
       then reads back through any report that joins items onto the line. */
    for (const ln of b.lines) {
      if (!ln.item_id) continue;
      const ok = (await query("SELECT 1 FROM items WHERE id = ? AND firm_id = ?", [ln.item_id, firmId])).rows[0];
      if (!ok) return res.fail("One of these lines refers to an item that isn't in this business", 400);
    }

    const paymentType = b.payment_type === "cash" ? "cash" : "credit";
    const cashCode = b.cash_account_code || CODES.CASH;

    /* Rep who is credited with the purchase (buyer/agent). Same rules as sales:
       defaults to the operator, validated against active users, required when
       the shop has turned that on. */
    let salesRepId = req.user.id;
    if (b.sales_rep_id != null && b.sales_rep_id !== "") {
      const rep = (await query("SELECT id FROM users WHERE id = ? AND active_firm_id = ? AND status = 'active'",
        [b.sales_rep_id, firmId])).rows[0];
      if (!rep) return res.fail("The chosen sales rep isn't a valid active user", 400);
      salesRepId = rep.id;
    } else if (await getSetting(firmId, "require_sales_rep", "1") === "1") {
      return res.fail("Choose a sales rep for this purchase", 400);
    }

    /* A bill posted twice puts stock on the shelf that never arrived and money
       in the payables that is not owed — and it does it silently, because both
       copies look like real deliveries. */
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("purchase_invoices", firmId, ref);
      if (prior) return res.success(existingBillReply(prior), "Purchase recorded");
    }

    const taxesOn = await getSetting(firmId, "taxes_enabled", "1") === "1";

    const { lines, totals } = computeInvoice({
      lines: b.lines,
      rules: taxesOn ? await loadTaxRules(firmId) : [],
      roundOff: await getSetting(firmId, "round_off", "1") === "1",
      /* Settings → Transactions → "Prices include tax". Read here rather than
         trusted from the request: what a price means is the shop's standing
         decision, not something a client should be able to assert per sale. */
      pricesIncludeTax: await getSetting(firmId, "tax_inclusive_default", "0") === "1",
    });

    await conn.beginTransaction();
    const seqNo = `PUR-${pad(await nextSeq(conn, `PUR:firm${firmId}`))}`;
    const billNo = b.bill_no ? `${b.bill_no}` : seqNo;
    const dt = b.bill_date || new Date().toISOString().slice(0, 10);
    if (await blockClosed(req, res, dt, "bill")) { await conn.rollback(); return; }
    const paid = paymentType === "cash" ? totals.grand_total : Math.min(Number(b.paid_amount) || 0, totals.grand_total);
    const balanceDue = +(totals.grand_total - paid).toFixed(2);
    const status = balanceDue <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

    const r = await conn.query(
      `INSERT INTO purchase_invoices
        (firm_id, bill_no, doc_type, party_id, bill_date, due_date,
         sub_total, discount_total, tax_breakdown, tax_total, round_off,
         grand_total, paid_amount, balance_due, status, created_by, sales_rep_id, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firmId, billNo, "purchase", party.id, dt, b.due_date || null,
       totals.sub_total, totals.discount_total,
       JSON.stringify(totals.taxes), totals.tax_total, totals.round_off,
       totals.grand_total, paid, balanceDue, status, req.user.id, salesRepId, ref]
    );
    const billId = r.insertId;

    for (const ln of lines) {
      await conn.query(
        `INSERT INTO purchase_invoice_lines
          (firm_id, bill_id, item_id, description, quantity, rate, discount_amt, taxable_value, line_total, batch_no, expiry_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [firmId, billId, ln.item_id || null, ln.description || null,
         ln.quantity, ln.rate, ln.discount_amt, ln.taxable_value, ln.line_total,
         ln.batch_no || "", ln.expiry_date || null]
      );
    }

    // Landed costs — transport, loading, clearing. Spread them across the lines by
    // value so each item's stock cost is what it ACTUALLY cost to get on the shelf,
    // otherwise every margin the shop sees is overstated.
    const extras = Array.isArray(b.landed_costs)
      ? b.landed_costs.filter((x) => x && Number(x.amount) > 0).map((x) => ({ label: String(x.label || "Extra cost").slice(0, 60), amount: round2(Number(x.amount)) }))
      : [];
    const landedTotal = round2(extras.reduce((a, x) => a + x.amount, 0));
    /* A loop, not .map(): converting a secondary unit reads the item, so the
       callback would be async and .map() would return promises — the stock
       posting below would then be handed objects that are not lines. */
    const costedLines = [];
    for (const ln of lines) {
      // landed-cost share, per the entered unit
      let unitCost = Number(ln.rate) || 0;
      let landedShare = 0;
      if (landedTotal && totals.sub_total) {
        landedShare = round2((Number(ln.taxable_value != null ? ln.taxable_value : ln.line_total) || 0) / totals.sub_total * landedTotal);
        const qty = Number(ln.quantity) || 1;
        unitCost = round2(unitCost + landedShare / qty);
      }
      // Stock is held in BASE units. A purchase entered in the secondary unit
      // (e.g. 100 KG of a 50 KG bag = 2 bags) must convert BOTH ways: the
      // quantity divides by the factor, and the cost per unit multiplies by it,
      // so the total value on the shelf is unchanged.
      const base = await baseQuantity(query, ln);
      if (ln.use_secondary && ln.item_id) {
        const it = (await query("SELECT conversion_rate FROM items WHERE id = ? AND firm_id = ?", [ln.item_id, firmId])).rows[0];
        const cr = it && Number(it.conversion_rate) > 0 ? Number(it.conversion_rate) : 0;
        if (cr > 0) { costedLines.push({ ...ln, quantity: base, unit_cost: round2(unitCost * cr), landed_share: landedShare }); continue; }
      }
      costedLines.push({ ...ln, unit_cost: unitCost, landed_share: landedShare });
    }

    if (await getSetting(firmId, "stock_maintenance", "1") === "1") {
      await postDocument(conn, { firmId, lines: costedLines, direction: "in", sourceModule: "purchases", sourceId: billId, userId: req.user.id });
    }
    // If this delivery fulfils an order, tick off what arrived and move the order on.
    if (b.po_id) {
      const po = (await conn.query("SELECT * FROM purchase_orders WHERE id=? AND firm_id=?", [b.po_id, firmId])).rows[0];
      if (po) {
        await conn.query("UPDATE purchase_invoices SET po_id=? WHERE id=?", [po.id, billId]);
        for (const ln of lines) {
          if (!ln.item_id) continue;
          await conn.query("UPDATE purchase_order_lines SET received_qty = ROUND(COALESCE(received_qty,0) + ?, 4) WHERE po_id=? AND item_id=?",
            [Number(ln.quantity) || 0, po.id, ln.item_id]);
        }
        const open = (await conn.query("SELECT COUNT(*) n FROM purchase_order_lines WHERE po_id=? AND COALESCE(received_qty,0) < quantity", [po.id])).rows[0].n;
        const any = (await conn.query("SELECT COUNT(*) n FROM purchase_order_lines WHERE po_id=? AND COALESCE(received_qty,0) > 0", [po.id])).rows[0].n;
        await conn.query("UPDATE purchase_orders SET status=? WHERE id=?", [open === 0 ? "received" : any > 0 ? "partial" : po.status, po.id]);
      }
    }

    if (landedTotal > 0) {
      await conn.query("UPDATE purchase_invoices SET landed_costs = ?, landed_total = ? WHERE id = ?",
        [JSON.stringify(extras), landedTotal, billId]);
      // the extras are usually paid in cash on delivery; they add to the value of stock
      await postJournal(conn, {
        firmId, date: dt, description: `Landed costs on ${billNo}`, reference: billNo,
        sourceModule: "purchases", sourceId: billId, userId: req.user.id,
        lines: [
          { account_code: "1020", debit: landedTotal, narration: extras.map((x) => x.label).join(", ") },
          { account_code: cashCode || "1001", credit: landedTotal },
        ],
      });
    }

    const glArgs = { subTotal: totals.sub_total, deducted: totals.deducted_total, added: totals.added_total, roundOff: totals.round_off };

    if (paymentType === "cash") {
      await postJournal(conn, {
        firmId, date: dt, description: `Cash purchase ${billNo}`, reference: billNo,
        sourceModule: "purchases", sourceId: billId, userId: req.user.id,
        lines: templates.purchaseCash({ ...glArgs, cashCode }),
      });
      await recordPayment(conn, { firmId, partyId: party.id, amount: paid, mode: b.payment_mode || "cash", billId, date: dt, userId: req.user.id });
    } else {
      await postJournal(conn, {
        firmId, date: dt, description: `Credit purchase ${billNo}`, reference: billNo,
        sourceModule: "purchases", sourceId: billId, userId: req.user.id,
        lines: templates.purchaseCredit(glArgs),
      });
      await conn.query("UPDATE parties SET balance = ROUND(balance - ?, 2) WHERE id = ?", [totals.grand_total, party.id]);
      if (paid > 0) {
        await postJournal(conn, {
          firmId, date: dt, description: `Payment on ${billNo}`, reference: billNo,
          sourceModule: "payments", sourceId: billId, userId: req.user.id,
          lines: templates.paymentOut({ amount: paid, cashCode }),
        });
        await conn.query("UPDATE parties SET balance = ROUND(balance + ?, 2) WHERE id = ?", [paid, party.id]);
        await recordPayment(conn, { firmId, partyId: party.id, amount: paid, mode: b.payment_mode || "cash", billId, date: dt, userId: req.user.id });
      }
    }

    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "purchases", "create", billId, `${billNo} (${paymentType})`]);

    await conn.commit();
    res.success({ id: billId, bill_no: billNo, payment_type: paymentType, totals }, "Purchase recorded");
  } catch (err) {
    await conn.rollback();
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("purchase_invoices", req.user.firm_id, ref);
      if (prior) return res.success(existingBillReply(prior), "Purchase recorded");
    }
    next(err);
  }
  finally { conn.release(); }
};
router.post("/", requirePermission("purchases", "create"), createPurchase);

async function recordPayment(conn, { firmId, partyId, amount, mode, billId, date, userId }) {
  if (amount <= 0) return;
  const payNo = `PAY-${pad(await nextSeq(conn, `PAY:firm${firmId}`))}`;
  const pr = await conn.query(
    `INSERT INTO payments (firm_id, payment_no, direction, party_id, payment_date, amount, mode, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [firmId, payNo, "out", partyId, date, amount, mode, userId]
  );
  await conn.query("INSERT INTO payment_allocations (firm_id, payment_id, doc_table, doc_id, amount) VALUES (?,?,?,?,?)",
    [firmId, pr.insertId, "purchase_invoices", billId, amount]);
}

/**
 * Void a supplier bill.
 *
 * A purchase bill was the one document in the app with no way back at all —
 * no edit, no delete, no void. A bill keyed at 1,200,000 instead of 120,000
 * stayed in the books, in the payables, and in the stock valuation, and the
 * only remedy anybody could offer was a debit note for the difference: a
 * return of goods that were never returned, on a date they were not returned.
 *
 * A bill does four things when it is posted, and all four have to come back:
 *
 *   1. the ledger entries — the purchase itself, any landed costs, and the
 *      payment leg if it was paid on delivery;
 *   2. the goods, off the shelf again;
 *   3. the payment row and its allocation, if one was auto-recorded;
 *   4. the supplier's balance.
 *
 * The stock is the one that can refuse. If the goods have already been sold,
 * taking them back off would drive the shelf negative and quietly corrupt the
 * cost of everything sold since — so the void is refused with the shortfall
 * named, and the shop is told to reverse the sales first. That is a real
 * limit, and saying it plainly beats a number that is wrong.
 */
router.delete("/:id", requirePermission("purchases", "delete"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const bill = (await query("SELECT * FROM purchase_invoices WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    const stop = blockedReason(bill, { label: "Bill" });
    if (stop) return res.fail(stop, bill ? 400 : 404);

    /* What this bill put on the shelf, and what is on the shelf now. */
    const moved = (await query(
      `SELECT m.item_id, m.batch_no, SUM(CASE WHEN m.direction='in' THEN m.quantity ELSE -m.quantity END) q
         FROM stock_movements m
        WHERE m.firm_id = ? AND m.source_module = 'purchases' AND m.source_id = ?
        GROUP BY m.item_id, m.batch_no`, [firmId, bill.id])).rows;
    const short = [];
    for (const m of moved) {
      if (Number(m.q) <= 0) continue;
      const st = (await query("SELECT COALESCE(quantity,0) q FROM item_stock WHERE firm_id=? AND item_id=? AND batch_no=?",
        [firmId, m.item_id, m.batch_no || ""])).rows[0];
      const have = Number(st ? st.q : 0);
      if (have + 0.0001 < Number(m.q)) {
        const it = (await query("SELECT name, unit FROM items WHERE id = ?", [m.item_id])).rows[0] || {};
        short.push(`${it.name || "an item"}${m.batch_no ? ` (${m.batch_no})` : ""} — this bill brought in ${Number(m.q)} ${it.unit || ""} but only ${have} ${it.unit || ""} ${have === 1 ? "is" : "are"} left`);
      }
    }
    if (short.length) {
      return res.fail(
        `${bill.bill_no} cannot be voided — some of what it delivered has already been sold or used. ${short.join("; ")}. Void those sales first, or raise a debit note instead.`,
        409);
    }

    const paidNow = Number(bill.paid_amount) || 0;
    const owed = Number(bill.balance_due) || 0;

    await conn.beginTransaction();
    await voidLedger(conn, { firmId, sources: ["purchases", "payments"], sourceId: bill.id,
      docNo: bill.bill_no, userId: req.user.id, date: todayStr() });
    await unwindStock(conn, { firmId, sourceModule: "purchases", sourceId: bill.id, userId: req.user.id, date: todayStr() });

    /* The payment row this bill wrote for itself, if it was paid on delivery.
       Its allocation points back at this same bill, so releasing the balance
       would be pointless — the bill is going away. The row is marked so it
       stops appearing in the payments list and in the tender reports. */
    const own = (await conn.query(
      `SELECT p.id FROM payments p
        WHERE p.firm_id = ? AND EXISTS (
          SELECT 1 FROM payment_allocations a
           WHERE a.payment_id = p.id AND a.doc_table = 'purchase_invoices' AND a.doc_id = ?)`,
      [firmId, bill.id])).rows;
    for (const o of own) {
      await conn.query("UPDATE payments SET status='voided', unallocated=0, void_reason=?, voided_at=datetime('now') WHERE id=?",
        [`Bill ${bill.bill_no} voided`, o.id]);
    }
    await conn.query("DELETE FROM payment_allocations WHERE firm_id = ? AND doc_table = 'purchase_invoices' AND doc_id = ?",
      [firmId, bill.id]);

    /* The supplier is owed less by whatever is still outstanding on this bill.
       Only the unpaid part: the paid part was already settled and its own
       ledger leg has just been reversed above. */
    if (owed > 0) await conn.query("UPDATE parties SET balance = ROUND(balance + ?, 2) WHERE id = ?", [owed, bill.party_id]);

    /* An order this delivery ticked off has to be untucked, or the order reads
       as received against a bill that no longer exists. */
    if (bill.po_id) {
      const ls = (await conn.query("SELECT item_id, quantity FROM purchase_invoice_lines WHERE firm_id=? AND bill_id=?",
        [firmId, bill.id])).rows;
      for (const l of ls) {
        if (!l.item_id) continue;
        await conn.query("UPDATE purchase_order_lines SET received_qty = MAX(0, ROUND(COALESCE(received_qty,0) - ?, 4)) WHERE po_id=? AND item_id=?",
          [Number(l.quantity) || 0, bill.po_id, l.item_id]);
      }
      const openN = (await conn.query("SELECT COUNT(*) n FROM purchase_order_lines WHERE po_id=? AND COALESCE(received_qty,0) < quantity", [bill.po_id])).rows[0].n;
      const anyN = (await conn.query("SELECT COUNT(*) n FROM purchase_order_lines WHERE po_id=? AND COALESCE(received_qty,0) > 0", [bill.po_id])).rows[0].n;
      await conn.query("UPDATE purchase_orders SET status=? WHERE id=?",
        [openN === 0 ? "received" : anyN > 0 ? "partial" : "open", bill.po_id]);
    }

    await conn.query("UPDATE purchase_invoices SET status='voided', balance_due=0, paid_amount=0 WHERE id=? AND firm_id=?",
      [bill.id, firmId]);
    await logAudit(conn, { userId: req.user.id, module: "purchases", action: "void", entityId: bill.id,
      detail: `${bill.bill_no} ${bill.grand_total} (paid ${paidNow})` });
    await conn.commit();
    res.success({ id: bill.id, voided: true }, `${bill.bill_no} voided`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
module.exports.createPurchase = createPurchase;
