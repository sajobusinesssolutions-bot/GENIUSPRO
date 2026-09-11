/* Tax & URA — what is owed, what would stop a claim, and what has been filed.
 *
 * Everything here is computed from documents the shop already has. Nothing is
 * estimated and no rate is assumed: VAT comes from the rate snapshotted on
 * each line at the time of sale, not from a constant in this file, so a return
 * for last year uses last year's rate without anyone remembering to change
 * anything.
 *
 * Tax is read from `tax_total`, which is what the tax-rules engine writes.
 * The cgst/sgst/igst columns are heritage from a different tax system, are
 * never written, and a return built on them would read zero for ever while
 * looking perfectly healthy.
 *
 * Two deliberate limits:
 *
 *   • This does not talk to EFRIS. Fiscalisation is recorded here, not
 *     performed here — the app cannot invent a fiscal document number and
 *     should not pretend a queue is draining when nothing is sending.
 *
 *   • The due date is a reminder, not a legal position. The day of the month
 *     is a setting, and the screen says to check it. Deadlines change and an
 *     app that states one with confidence is the app somebody blames.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

/* Only the VAT part of a document's tax.
 *
 * `tax_total` is the sum of every tax rule the shop has set up — VAT, a local
 * levy, whatever else. A VAT return that included all of them would overstate
 * what is owed, which is a worse mistake than understating it.
 *
 * Each document stores its own breakdown, so the split is read back per
 * document rather than recomputed from today's rules. A shop that renames or
 * changes a rule does not silently rewrite last quarter's return.
 */
/* Which tax is the one the shop calls VAT?
 *
 * Settings -> General holds a name ("VAT"); the rule itself is normally named
 * with its rate ("VAT 18", "VAT-18%"). Comparing the two for string equality
 * meant a shop running the default setting against an ordinary rule name
 * matched nothing and filed a return of zero. So: case and punctuation are
 * dropped, an exact match wins outright, and only when nothing matches exactly
 * is a prefix in either direction accepted — and then only if exactly one name
 * matches. A loose prefix would otherwise fold "VAT Exempt" and "VAT 0%" in
 * beside "VAT 18", counting their amounts in the VAT figure while the screen
 * says they are left out. Ambiguity is reported as no match instead. */
function normTax(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
/* The one name out of `names` that is the shop's VAT, or null. */
function pickVatName(names, ruleName) {
  const want = normTax(ruleName) || "vat";
  const uniq = [...new Set(names.map((n) => String(n || "")).filter(Boolean))];
  const exact = uniq.filter((n) => normTax(n) === want);
  if (exact.length) return exact[0];
  const near = uniq.filter((n) => {
    const a = normTax(n);
    return a && (a.startsWith(want) || want.startsWith(a));
  });
  return near.length === 1 ? near[0] : null;
}

function vatOf(row, ruleName) {
  let raw = row.tax_breakdown;
  if (!raw) return 0;
  let taxes;
  try { taxes = JSON.parse(raw); } catch { return 0; }
  if (!Array.isArray(taxes)) return 0;
  /* Resolved against this document's own breakdown, so a document written
     before a rule was renamed still reports its VAT. */
  const match = pickVatName(taxes.map((t) => t.name), ruleName);
  if (!match) return 0;
  const want = normTax(match);
  return r2(taxes
    .filter((t) => normTax(t.name) === want)
    .reduce((a, t) => a + (t.mode === "add" ? +t.amount || 0 : -(+t.amount || 0)), 0));
}

/* Sum the VAT across a set of documents. */
function sumVat(rows, ruleName) {
  return r2(rows.reduce((a, r) => a + vatOf(r, ruleName), 0));
}

function periodRange(period) {
  const p = /^\d{4}-\d{2}$/.test(String(period || "")) ? period : thisMonth();
  const d = new Date(`${p}-01`);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    period: p,
    from: `${p}-01`,
    to: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`,
    label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  };
}

/* Due date for a period: the configured day of the following month. */
async function dueDateFor(firmId, period) {
  const day = Math.min(28, Math.max(1, Number(await getSetting(firmId, "vat_due_day", "15")) || 15));
  const d = new Date(`${period}-01`);
  d.setMonth(d.getMonth() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(day)}`;
}

/* ── The VAT return ───────────────────────────────────────────────────────
   Output VAT is what was charged on sales, less what was credited back.
   Input VAT is what was paid on purchases — but only where the bill carries a
   supplier TIN, because a claim without one will not stand up. The
   unclaimable part is reported separately rather than quietly dropped, since
   the shop paid that money and deserves to know it is stuck. */
router.get("/vat-return", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const { period, from, to, label } = periodRange(req.query.period);
  const setName = await getSetting(f, "vat_rule_name", "VAT");

  /* Which taxes exist, so the screen can say plainly when the named VAT rule
     is not one of them — otherwise a return of zero looks like a quiet month
     rather than a misconfiguration. The one rule resolved here is also what
     the document sums below are matched against, so the figure and the "these
     are left out" line can never disagree. */
  const rules = (await query(
    "SELECT name, rate, mode, is_active FROM tax_rules WHERE firm_id = ? ORDER BY apply_order", [f])).rows;
  const matched = pickVatName(rules.map((r) => r.name), setName);
  const vatRule = matched ? rules.find((r) => r.name === matched) : null;
  const ruleName = matched || setName;

  const sales = (await query(
    `SELECT sub_total, tax_breakdown FROM sale_invoices
      WHERE firm_id = ? AND COALESCE(status,'') <> 'voided' AND invoice_date BETWEEN ? AND ?`,
    [f, from, to])).rows;

  const credits = (await query(
    `SELECT sub_total, tax_breakdown FROM sale_returns
      WHERE firm_id = ? AND return_date BETWEEN ? AND ?
        AND COALESCE(status,'posted') <> 'voided'`, [f, from, to])).rows;

  /* Purchases split by whether the supplier TIN is on file — a claim without
     one will not stand up, so it is reported separately rather than dropped. */
  const bills = (await query(
    `SELECT b.sub_total, b.tax_breakdown, COALESCE(TRIM(p.gstin), '') AS tin
       FROM purchase_invoices b JOIN parties p ON p.id = b.party_id
      WHERE b.firm_id = ? AND b.bill_date BETWEEN ? AND ?`, [f, from, to])).rows;
  const claimable = bills.filter((b) => b.tin !== "");
  const blockedRows = bills.filter((b) => b.tin === "");

  const net = (rows) => r2(rows.reduce((a, r) => a + (+r.sub_total || 0), 0));
  const salesVat = sumVat(sales, ruleName);
  const creditVat = sumVat(credits, ruleName);
  const outputVat = r2(salesVat - creditVat);
  const inputVat = sumVat(claimable, ruleName);
  const payable = r2(outputVat - inputVat);

  const filing = (await query(
    "SELECT * FROM tax_filings WHERE firm_id = ? AND tax_type = 'vat' AND period = ?", [f, period])).rows[0] || null;

  res.success({
    period, from, to, label,
    due_date: await dueDateFor(f, period),
    filing,
    vat_rule_name: setName,
    vat_rule: vatRule,
    /* What the rule is actually called, so the screen can name it rather than
       echoing the setting back at the reader. */
    vat_rule_matched_name: vatRule ? vatRule.name : null,
    all_taxes: rules.map((r) => r.name),
    other_taxes: rules.filter((r) => r !== vatRule).map((r) => r.name),
    sales: { count: sales.length, net: net(sales), vat: salesVat },
    credits: { count: credits.length, net: net(credits), vat: creditVat },
    purchases: { count: claimable.length, net: net(claimable), vat: inputVat },
    blocked: { count: blockedRows.length, net: net(blockedRows), vat: sumVat(blockedRows, ruleName) },
    outputVat, inputVat, payable,
    /* Negative means URA owes the shop, which reads very differently and
       should not be presented as a bill to pay. */
    direction: payable >= 0 ? "payable" : "refundable",
  });
});

/* ── What would stop a claim, or a filing ─────────────────────────────────
   A checklist that names the documents, not just the count. "9 bills have no
   TIN" is a statistic; the list of nine is something a shop can fix. */
router.get("/exceptions", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const { from, to, period } = periodRange(req.query.period);

  /* Resolved against the rule list exactly as the return does, so the two
     screens count the same tax. */
  const setName = await getSetting(f, "vat_rule_name", "VAT");
  const ruleName = pickVatName(
    (await query("SELECT name FROM tax_rules WHERE firm_id = ? ORDER BY apply_order", [f])).rows.map((r) => r.name),
    setName) || setName;
  const noSupplierTin = (await query(
    `SELECT b.id, b.bill_no AS ref, b.bill_date AS d, p.name AS party, b.tax_breakdown
       FROM purchase_invoices b JOIN parties p ON p.id = b.party_id
      WHERE b.firm_id = ? AND b.bill_date BETWEEN ? AND ?
        AND COALESCE(TRIM(p.gstin), '') = ''
      ORDER BY b.bill_date DESC LIMIT 100`, [f, from, to])).rows
    .map((r) => ({ ...r, vat: vatOf(r, ruleName) }))
    .filter((r) => r.vat > 0)
    .sort((a, b) => b.vat - a.vat);

  /* A registered buyer wants a TIN on the invoice; without one they cannot
     claim, and they will ask. */
  const noBuyerTin = (await query(
    `SELECT s.id, s.invoice_no AS ref, s.invoice_date AS d, p.name AS party, s.grand_total AS amount
       FROM sale_invoices s JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
        AND COALESCE(s.status,'') <> 'voided'
        AND COALESCE(TRIM(p.gstin), '') = ''
        AND s.grand_total >= 1000000
      ORDER BY s.grand_total DESC LIMIT 100`, [f, from, to])).rows;

  const efrisOn = await getSetting(f, "efris_enabled", "0") === "1";
  const notFiscalised = efrisOn ? (await query(
    `SELECT s.id, s.invoice_no AS ref, s.invoice_date AS d,
            COALESCE(p.name, 'Cash Sale') AS party, s.grand_total AS amount,
            COALESCE(s.efris_status, 'pending') AS status, s.efris_note
       FROM sale_invoices s LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
        AND COALESCE(s.status,'') <> 'voided'
        AND COALESCE(s.efris_status, 'pending') NOT IN ('sent', 'exempt')
      ORDER BY s.invoice_date DESC LIMIT 100`, [f, from, to])).rows : [];

  /* A firm with no TIN of its own cannot file at all. Worth saying loudly and
     once, rather than as a row in a table. */
  const firm = (await query("SELECT gstin FROM firms WHERE id = ?", [f])).rows[0] || {};

  const groups = [
    {
      id: "supplier_tin",
      title: "Bills with no supplier TIN",
      why: "The VAT on these cannot be claimed back. Add the supplier's TIN to their record and it counts from then on.",
      tone: "bad",
      rows: noSupplierTin.map((r) => ({ ...r, amount: r2(r.vat) })),
      amountLabel: "VAT stuck",
    },
    {
      id: "buyer_tin",
      title: "Large invoices with no customer TIN",
      why: "A registered buyer cannot claim without a TIN on the invoice, and will come back asking for a corrected one.",
      tone: "warn",
      rows: noBuyerTin,
      amountLabel: "Invoice",
    },
  ];
  if (efrisOn) {
    groups.unshift({
      id: "efris",
      title: "Invoices with no fiscal number",
      why: "Nothing has been recorded against these on EFRIS. Send them, or mark them exempt so they stop appearing here.",
      tone: "bad",
      rows: notFiscalised,
      amountLabel: "Invoice",
    });
  }

  res.success({
    period,
    firm_tin: firm.gstin || null,
    groups: groups.filter((g) => g.rows.length > 0),
    clear: groups.every((g) => g.rows.length === 0) && !!firm.gstin,
    counts: Object.fromEntries(groups.map((g) => [g.id, g.rows.length])),
  });
});

/* ── EFRIS register ───────────────────────────────────────────────────── */
router.get("/efris", requirePermission("sales", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const { from, to, period, label } = periodRange(req.query.period);

  const rows = (await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.grand_total,
            COALESCE(p.name, 'Cash Sale') AS party_name, p.gstin AS party_tin,
            COALESCE(s.efris_status, 'pending') AS efris_status,
            s.efris_fdn, s.efris_at, s.efris_note
       FROM sale_invoices s LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.firm_id = ? AND s.invoice_date BETWEEN ? AND ?
        AND COALESCE(s.status,'') <> 'voided'
      ORDER BY s.id DESC LIMIT 500`, [f, from, to])).rows;

  const by = (st) => rows.filter((r) => r.efris_status === st).length;
  const sent = by("sent"), exempt = by("exempt");
  const counted = rows.length - exempt;

  res.success({
    period, label, rows,
    enabled: await getSetting(f, "efris_enabled", "0") === "1",
    totals: {
      total: rows.length, sent, exempt,
      pending: by("pending"), rejected: by("rejected"),
      /* Exempt invoices are excluded from the denominator — a sale that never
         needed fiscalising should not drag the percentage down. */
      pct: counted > 0 ? Math.round((sent / counted) * 100) : 100,
    },
  });
});

/* Record what EFRIS said. Marking sent requires the fiscal number, because a
   sent invoice without one cannot be reconciled later and is the same as not
   sent for anyone checking. */
router.put("/efris/:invoiceId", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const status = String(b.status || "").trim();
  if (!["pending", "sent", "rejected", "exempt"].includes(status)) return res.fail("Unknown EFRIS status");

  const inv = (await query("SELECT id FROM sale_invoices WHERE id = ? AND firm_id = ?",
    [req.params.invoiceId, req.user.firm_id])).rows[0];
  if (!inv) return res.fail("Invoice not found", 404);

  const fdn = String(b.fdn || "").trim();
  if (status === "sent" && !fdn) return res.fail("A fiscal number is needed to mark an invoice as sent");
  if (status === "rejected" && !String(b.note || "").trim()) return res.fail("Say why URA rejected it");

  await conn.query(
    "UPDATE sale_invoices SET efris_status = ?, efris_fdn = ?, efris_at = ?, efris_note = ? WHERE id = ?",
    [status, status === "sent" ? fdn : null,
     status === "pending" ? null : new Date().toISOString().slice(0, 19).replace("T", " "),
     b.note || null, inv.id]);

  return () => res.success({ id: inv.id, status }, {
    sent: "Fiscal number recorded", rejected: "Rejection recorded",
    exempt: "Marked as not needing EFRIS", pending: "Put back in the queue",
  }[status]);
}));

/* ── Withholding ──────────────────────────────────────────────────────────
   Two directions, and they are easy to confuse: tax the shop withheld from a
   supplier and now owes URA, and tax a customer withheld from the shop, which
   is money already paid on its behalf. */
router.get("/withholding", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const { from, to, period, label } = periodRange(req.query.period);

  const rows = (await query(
    `SELECT pay.id, pay.payment_no, pay.payment_date, pay.direction, pay.amount,
            pay.tax_deducted, pay.reference, p.name AS party_name, p.gstin AS party_tin
       FROM payments pay LEFT JOIN parties p ON p.id = pay.party_id
      WHERE pay.firm_id = ? AND COALESCE(pay.tax_deducted, 0) > 0
        AND pay.payment_date BETWEEN ? AND ?
        AND COALESCE(pay.status,'paid') NOT IN ('voided','draft')
      ORDER BY pay.payment_date DESC, pay.id DESC`, [f, from, to])).rows;

  const owed = r2(rows.filter((r) => r.direction === "out").reduce((a, r) => a + (+r.tax_deducted || 0), 0));
  const suffered = r2(rows.filter((r) => r.direction === "in").reduce((a, r) => a + (+r.tax_deducted || 0), 0));

  res.success({
    period, label, rows,
    rate: Number(await getSetting(f, "wht_rate", "6")) || 0,
    totals: {
      owed, suffered, count: rows.length,
      owedCount: rows.filter((r) => r.direction === "out").length,
      sufferedCount: rows.filter((r) => r.direction === "in").length,
    },
  });
});

/* ── Filing register ──────────────────────────────────────────────────────
   The last twelve periods, each either filed or not, with what is coming.
   Nothing here judges lateness by a legal rule — it compares the filing date
   to the due date the shop configured. */
router.get("/filings", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const filed = (await query(
    "SELECT * FROM tax_filings WHERE firm_id = ? ORDER BY period DESC, tax_type", [f])).rows;
  const byKey = {};
  for (const r of filed) byKey[`${r.tax_type}:${r.period}`] = r;

  /* Build the last 12 VAT periods whether or not anything was filed, so a
     missed month is visible as a gap rather than absent from the list. */
  const rows = [];
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const due = await dueDateFor(f, period);
    const rec = byKey[`vat:${period}`];
    rows.push({
      tax_type: "vat", period, due_date: due,
      label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      filed_date: rec ? rec.filed_date : null,
      amount: rec ? rec.amount : null,
      reference: rec ? rec.reference : null,
      id: rec ? rec.id : null,
      status: !rec || !rec.filed_date
        ? (due < today() ? "overdue" : "due")
        : (rec.filed_date <= due ? "on time" : "late"),
    });
  }

  /* Anything filed that is not a VAT month — PAYE, WHT, whatever the shop
     records — is listed too rather than being invisible. */
  for (const r of filed) {
    if (r.tax_type === "vat" && rows.some((x) => x.period === r.period)) continue;
    rows.push({
      ...r,
      label: r.period,
      status: r.filed_date ? (r.due_date && r.filed_date > r.due_date ? "late" : "on time") : "due",
    });
  }

  const done = rows.filter((r) => r.filed_date);
  res.success({
    rows,
    totals: {
      filed: done.length,
      onTime: done.filter((r) => r.status === "on time").length,
      late: done.filter((r) => r.status === "late").length,
      overdue: rows.filter((r) => r.status === "overdue").length,
      paidThisYear: r2(done
        .filter((r) => String(r.filed_date).slice(0, 4) === String(new Date().getFullYear()))
        .reduce((a, r) => a + (+r.amount || 0), 0)),
      next: rows.filter((r) => !r.filed_date).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0] || null,
    },
  });
});

/* Record a filing. Deliberately a record of something done elsewhere — this
   app does not submit to URA, and saying otherwise would be a lie a shop
   might rely on. */
router.post("/filings", requirePermission("accounting", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const f = req.user.firm_id;
  const b = req.body || {};
  const type = String(b.tax_type || "vat").trim();
  const period = String(b.period || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return res.fail("Which period is this for?");
  if (!b.filed_date) return res.fail("When was it filed?");
  if (b.filed_date > today()) return res.fail("That date is in the future");

  const existing = (await query("SELECT id FROM tax_filings WHERE firm_id = ? AND tax_type = ? AND period = ?",
    [f, type, period])).rows[0];
  const args = [b.due_date || await dueDateFor(f, period), b.filed_date, r2(b.amount), r2(b.paid_amount || b.amount),
                b.reference || null, b.note || null];

  if (existing) {
    await conn.query(`UPDATE tax_filings SET due_date=?, filed_date=?, amount=?, paid_amount=?, reference=?, note=? WHERE id=?`,
      [...args, existing.id]);
    return () => res.success({ id: existing.id }, `${period} filing updated`);
  }
  const r = await conn.query(
    `INSERT INTO tax_filings (firm_id, tax_type, period, due_date, filed_date, amount, paid_amount, reference, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`, [f, type, period, ...args, req.user.id]);
  return () => res.success({ id: r.insertId }, `${period} recorded as filed`);
}));

router.delete("/filings/:id", requirePermission("accounting", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const row = (await conn.query("SELECT * FROM tax_filings WHERE id = ? AND firm_id = ?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!row) return res.fail("Filing not found", 404);
  await conn.query("DELETE FROM tax_filings WHERE id = ?", [row.id]);
  return () => res.success({ id: row.id }, `${row.period} filing removed`);
}));

module.exports = router;
