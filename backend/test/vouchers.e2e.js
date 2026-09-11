/**
 * vouchers.e2e.js — correcting and cancelling a posted document.
 *
 * Every voucher in this app writes to the double-entry ledger the moment it is
 * saved. Most of them could only ever be written: an expense typed as 450,000
 * instead of 45,000 stayed on the P&L for good. This suite exercises the edit
 * and void that were added for them, and it checks the one thing that actually
 * matters afterwards — that the books still balance.
 *
 * A trial balance that is out by a cent is not a cosmetic fault. It is the
 * symptom of a reversal that missed a leg, and by the time anybody notices, it
 * is buried under a month of trading. So the debits-equal-credits check runs
 * after EVERY operation here rather than once at the end: that way a failure
 * names the step that broke it.
 *
 *   node test/vouchers.e2e.js http://localhost:4188
 */
const BASE = process.argv[2] || "http://localhost:4188";
let pass = 0, fail = 0;
const ok = (n, c, note = "") => { c ? (pass++, console.log(`  ✓ ${n}${note ? "  " + note : ""}`)) : (fail++, console.log(`  ✗ ${n}  ${note}`)); };
const head = (s) => console.log(`\n── ${s}`);

let TOKEN = null;
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, message: json && json.message, data: json && json.data };
}
const GET = (p) => call("GET", p);
const POST = (p, b) => call("POST", p, b);
const PUT = (p, b) => call("PUT", p, b);
const DEL = (p, b) => call("DELETE", p, b);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Debits minus credits across the whole ledger. Zero, always, or something is
   wrong with the last thing that was posted. */
async function ledgerGap() {
  const tb = await GET("/api/reports/trial-balance");
  const rows = (tb.data && (tb.data.rows || tb.data)) || [];
  let d = 0, c = 0;
  for (const r of rows) { d += Number(r.debit || 0); c += Number(r.credit || 0); }
  return r2(d - c);
}
async function balanced(step) {
  const gap = await ledgerGap();
  ok(`books balance after ${step}`, Math.abs(gap) < 0.01, `Dr − Cr = ${gap}`);
}

/* What an account is worth right now, so a reversal can be proved to have
   landed rather than merely to have been accepted. */
async function acctBalance(code) {
  const r = await GET("/api/accounting/accounts");
  const a = (r.data || []).find((x) => x.code === code);
  return r2(a ? a.balance : 0);
}

(async () => {
  const login = await POST("/api/auth/login", { username: "admin", password: "admin123" });
  TOKEN = login.data && login.data.token;
  if (!TOKEN) {
    console.log(`  ✗ signed in  ${login.message}`);
    console.log(`\n  This suite needs a database with one company in it. Give it a fresh copy.\n`);
    process.exit(1);
  }
  ok("signed in", !!TOKEN);
  await balanced("sign-in (baseline)");

  /* ── Expenses ─────────────────────────────────────────────────────────── */
  head("An expense can be corrected and cancelled");
  const expBefore = await acctBalance("5100");   /* Indirect Expenses */
  const mk = await POST("/api/expenses", { category: "Rent", amount: 450000, notes: "typed a zero too many" });
  ok("expense recorded", mk.status === 200 && mk.data.id, mk.data && mk.data.expense_no);
  await balanced("recording an expense");
  const expId = mk.data.id;

  const fix = await PUT(`/api/expenses/${expId}`, { amount: 45000 });
  ok("expense corrected", fix.status === 200, fix.message);
  await balanced("correcting an expense");
  const afterFix = await acctBalance("5100");
  ok("the ledger holds the corrected amount, not the sum of both",
    Math.abs(afterFix - r2(expBefore + 45000)) < 0.01,
    `expense account ${expBefore} → ${afterFix}`);

  const one = await GET(`/api/expenses/${expId}`);
  ok("the document says it was amended", Number(one.data.edit_count) === 1, `edit_count ${one.data.edit_count}`);
  ok("and it kept its number", one.data.expense_no === mk.data.expense_no, one.data.expense_no);

  const kill = await DEL(`/api/expenses/${expId}`, { reason: "duplicate" });
  ok("expense voided", kill.status === 200, kill.message);
  await balanced("voiding an expense");
  const afterVoid = await acctBalance("5100");
  ok("voiding put the account back exactly where it started",
    Math.abs(afterVoid - expBefore) < 0.01, `${expBefore} → ${afterVoid}`);

  const again = await DEL(`/api/expenses/${expId}`);
  ok("a voided expense cannot be voided twice", again.status === 400, again.message);
  const editVoided = await PUT(`/api/expenses/${expId}`, { amount: 1 });
  ok("and cannot be edited afterwards", editVoided.status === 400, editVoided.message);

  /* Paged, so the response carries the `sums` strip the screen shows. */
  const stillListed = await GET("/api/expenses?page=1&limit=200");
  const listRows = stillListed.data.rows || stillListed.data || [];
  const row = listRows.find((x) => x.id === expId);
  ok("the voided expense is still in the list", !!row, row && row.status);
  ok("and is marked as voided rather than quietly removed", row && row.status === "voided");
  const sums = stillListed.data.sums || {};
  ok("but the total above the list leaves it out",
    Math.abs(Number(sums.amount || 0)) < 0.01, `total shown ${sums.amount}`);

  /* ── Other income ─────────────────────────────────────────────────────── */
  head("Other income can be corrected and removed");
  const incBefore = await acctBalance("4100");
  const inc = await POST("/api/expenses/other-income", { amount: 90000, description: "Scrap sale" });
  ok("income recorded", inc.status === 200 && inc.data.entryId, inc.data && inc.data.entry_no);
  await balanced("recording other income");
  const incId = inc.data.entryId;

  const incFix = await PUT(`/api/expenses/other-income/${incId}`, { amount: 60000, description: "Scrap sale (corrected)" });
  ok("income corrected", incFix.status === 200, incFix.message);
  await balanced("correcting other income");
  const incAfter = await acctBalance("4100");
  /* Income is credit-natured, so the stored balance moves the other way. */
  ok("the ledger holds only the corrected amount",
    Math.abs(incAfter - r2(incBefore - 60000)) < 0.01, `${incBefore} → ${incAfter}`);

  const incKill = await DEL(`/api/expenses/other-income/${incId}`);
  ok("income removed", incKill.status === 200, incKill.message);
  await balanced("removing other income");
  ok("and the account is back where it started",
    Math.abs((await acctBalance("4100")) - incBefore) < 0.01);

  /* ── Payments ─────────────────────────────────────────────────────────── */
  head("A payment can be corrected and voided, and the invoice follows it");
  const cust = await POST("/api/parties", { name: `Voucher test ${Date.now()}`, type: "customer" });
  const partyId = cust.data.id;
  const item = await POST("/api/items", { name: `Voucher item ${Date.now()}`, unit: "PCS", sale_price: 100000, purchase_price: 60000, opening_stock: 50 });
  /* A sales rep is required by default, and this suite is not testing that —
     it is the signed-in admin's own sale. */
  const me = login.data.user.id;
  const sale = await POST("/api/sales", {
    party_id: partyId, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 2, rate: 100000 }],
  });
  ok("a credit sale exists to pay against", sale.status === 200, sale.message);
  if (sale.status !== 200) { console.log("\n  cannot continue without a sale\n"); process.exit(1); }
  await balanced("raising a credit sale");
  const invId = sale.data.id;
  const invTotal = r2(sale.data.totals ? sale.data.totals.grand_total : 200000);

  const pay = await POST("/api/payments", { party_id: partyId, direction: "in", amount: invTotal });
  ok("payment taken", pay.status === 200, pay.data && pay.data.payment_no);
  await balanced("taking a payment");
  const payId = pay.data.id;

  let inv = await GET(`/api/sales/${invId}`);
  ok("the invoice reads as settled", r2(inv.data.balance_due) === 0, `balance ${inv.data.balance_due}`);

  /* Halve it. The old allocation has to be unwound completely, not nudged. */
  const half = r2(invTotal / 2);
  const payFix = await PUT(`/api/payments/${payId}`, { amount: half });
  ok("payment corrected", payFix.status === 200, payFix.message);
  await balanced("correcting a payment");
  inv = await GET(`/api/sales/${invId}`);
  ok("the invoice is owed the difference again",
    Math.abs(r2(inv.data.balance_due) - half) < 0.01, `balance ${inv.data.balance_due}, expected ${half}`);
  ok("and its paid figure matches the corrected payment",
    Math.abs(r2(inv.data.paid_amount) - half) < 0.01, `paid ${inv.data.paid_amount}`);

  const moved = await PUT(`/api/payments/${payId}`, { party_id: partyId + 99999, amount: half });
  ok("a payment cannot be moved to another party", moved.status === 400, moved.message);

  const payKill = await DEL(`/api/payments/${payId}`, { reason: "banked twice" });
  ok("payment voided", payKill.status === 200, payKill.message);
  await balanced("voiding a payment");
  inv = await GET(`/api/sales/${invId}`);
  ok("the invoice is fully owed again",
    Math.abs(r2(inv.data.balance_due) - invTotal) < 0.01, `balance ${inv.data.balance_due}, expected ${invTotal}`);
  ok("and reads as unpaid, not partly paid", inv.data.status === "unpaid", inv.data.status);

  const party = await GET(`/api/parties/${partyId}`);
  ok("the customer owes the whole invoice again",
    Math.abs(r2(party.data.balance) - invTotal) < 0.01, `balance ${party.data.balance}`);

  /* ── Manual journals ──────────────────────────────────────────────────── */
  head("A journal made by hand can be rewritten");
  const je = await POST("/api/accounting/journal", {
    description: "Owner's drawings", lines: [
      { account_code: "3001", debit: 50000 },
      { account_code: "1001", credit: 50000 },
    ],
  });
  ok("journal posted", je.status === 200, je.data && je.data.entry_no);
  await balanced("posting a journal");

  const jeBad = await PUT(`/api/accounting/journal/${je.data.entryId}`, {
    lines: [{ account_code: "3001", debit: 70000 }, { account_code: "1001", credit: 50000 }],
  });
  ok("an unbalanced rewrite is refused", jeBad.status === 400, jeBad.message);
  await balanced("a refused rewrite");

  const jeGhost = await PUT(`/api/accounting/journal/${je.data.entryId}`, {
    lines: [{ account_code: "9999", debit: 10 }, { account_code: "1001", credit: 10 }],
  });
  ok("a line on an account that does not exist is refused, not dropped", jeGhost.status === 400, jeGhost.message);
  await balanced("a refused unknown account");

  const jeFix = await PUT(`/api/accounting/journal/${je.data.entryId}`, {
    description: "Owner's drawings (corrected)",
    lines: [{ account_code: "3001", debit: 30000 }, { account_code: "1001", credit: 30000 }],
  });
  ok("journal rewritten", jeFix.status === 200, jeFix.message);
  await balanced("rewriting a journal");

  /* The entry a document wrote must be refused here — it belongs to the sale. */
  const dayb = await GET("/api/accounting/daybook");
  const fromSale = (dayb.data && (dayb.data.rows || dayb.data) || [])
    .find((r) => r.source_module && r.source_module !== "manual" && r.source_module !== "other_income");
  if (fromSale) {
    const refuse = await PUT(`/api/accounting/journal/${fromSale.id}`, {
      lines: [{ account_code: "3001", debit: 1 }, { account_code: "1001", credit: 1 }],
    });
    ok("an entry a document posted cannot be rewritten here", refuse.status === 400, refuse.message);
    const refuseDel = await DEL(`/api/accounting/journal/${fromSale.id}`);
    ok("nor deleted here", refuseDel.status === 400, refuseDel.message);
  }

  /* ── Quotations ───────────────────────────────────────────────────────── */
  head("A quotation can be changed and withdrawn");
  const est = await POST("/api/estimates", {
    party_id: partyId, lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 1, rate: 100000 }],
  });
  ok("quotation raised", est.status === 200, est.data && est.data.doc_no);
  const estFix = await PUT(`/api/estimates/${est.data.id}`, {
    lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 3, rate: 90000 }],
  });
  ok("quotation changed", estFix.status === 200, estFix.message);
  const estRead = await GET(`/api/estimates/${est.data.id}`);
  ok("it kept its number", estRead.data.doc_no === est.data.doc_no, estRead.data.doc_no);
  ok("and holds the new lines only", estRead.data.lines.length === 1 && Number(estRead.data.lines[0].quantity) === 3,
    `${estRead.data.lines.length} line(s), qty ${estRead.data.lines[0] && estRead.data.lines[0].quantity}`);
  const estKill = await DEL(`/api/estimates/${est.data.id}`);
  ok("quotation withdrawn", estKill.status === 200, estKill.message);
  await balanced("withdrawing a quotation");

  /* ── Credit notes ─────────────────────────────────────────────────────── */
  head("A credit note can be voided, and the goods go back out");
  /* `on_hand` comes from the list, which is where the shelf figure lives. */
  const onHand = async (id) => {
    const r = await GET("/api/items?limit=500");
    const rows = r.data.rows || r.data || [];
    const it = rows.find((x) => x.id === id);
    return Number(it ? it.on_hand : NaN);
  };
  const stockBefore = await onHand(item.data.id);
  const cn = await POST("/api/returns/credit-notes", {
    party_id: partyId, invoice_id: invId, refund_mode: "adjust",
    lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 1, rate: 100000 }],
  });
  ok("credit note issued", cn.status === 200, cn.data && cn.data.note_no);
  await balanced("issuing a credit note");
  const stockAfterCn = await onHand(item.data.id);
  ok("the returned unit came back on the shelf",
    Math.abs(Number(stockAfterCn) - Number(stockBefore) - 1) < 0.001, `${stockBefore} → ${stockAfterCn}`);

  const cnKill = await DEL(`/api/returns/credit-notes/${cn.data.id}`, { reason: "raised against the wrong invoice" });
  ok("credit note voided", cnKill.status === 200, cnKill.message);
  await balanced("voiding a credit note");
  const stockAfterVoid = await onHand(item.data.id);
  ok("and the unit went back off the shelf",
    Math.abs(Number(stockAfterVoid) - Number(stockBefore)) < 0.001, `${stockAfterCn} → ${stockAfterVoid}`);

  const cnAgain = await DEL(`/api/returns/credit-notes/${cn.data.id}`);
  ok("a voided credit note cannot be voided twice", cnAgain.status === 400, cnAgain.message);

  /* ── The double reversal ──────────────────────────────────────────────── */
  head("Amending twice, then voiding, does not reverse the same entry twice");
  /* This is the fault that `reversed_at` was added for, and it was silent:
     every reversal is itself balanced, so the trial balance never noticed.
     Amend twice so there are three entries under one source, two of them
     already reversed, then void — and check the account lands on zero rather
     than on minus the amounts that were taken back. */
  const base = await acctBalance("5100");
  const e2 = await POST("/api/expenses", { category: "Transport", amount: 300000 });
  await PUT(`/api/expenses/${e2.data.id}`, { amount: 200000 });
  await PUT(`/api/expenses/${e2.data.id}`, { amount: 100000 });
  const twice = await acctBalance("5100");
  ok("after two amendments only the last one is in the books",
    Math.abs(twice - r2(base + 100000)) < 0.01, `${base} → ${twice}, expected ${r2(base + 100000)}`);
  await DEL(`/api/expenses/${e2.data.id}`);
  const back = await acctBalance("5100");
  ok("and voiding it leaves the account exactly where it began",
    Math.abs(back - base) < 0.01, `${base} → ${back}`);
  await balanced("an amend-amend-void cycle");

  head("The same, on a sale — the path that had this fault before today");
  const sBase = await acctBalance("4001");
  const s2 = await POST("/api/sales", {
    party_id: partyId, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 1, rate: 100000 }],
  });
  if (s2.status === 200) {
    const amend = await PUT(`/api/sales/${s2.data.id}`, {
      party_id: partyId, payment_type: "credit", sales_rep_id: me,
      lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 1, rate: 80000 }],
    });
    ok("the sale was amended", amend.status === 200, amend.message);
    await DEL(`/api/sales/${s2.data.id}`, { reason: "test" });
    const sBack = await acctBalance("4001");
    ok("an amended sale that is then voided leaves Sales where it began",
      Math.abs(sBack - sBase) < 0.01, `${sBase} → ${sBack}`);
    await balanced("amending and voiding a sale");
  }

  /* ── The figures outside the ledger ──────────────────────────────────── */
  head("A voided voucher drops out of the screens that count it, not just the ledger");
  /* Reversing the journal is only half a void. The dashboard, the shift
     drawer count and half the reports read the `expenses` and `payments`
     tables directly, and a void that fixed the books while leaving those
     figures standing would be the worse kind of half-fix: the P&L and the
     dashboard would disagree, and the shop would trust the one on the screen
     they look at every morning. */
  const dayOf = (r) => (r.data && (r.data.rows || r.data)) || [];
  const today = new Date().toISOString().slice(0, 10);

  const e3 = await POST("/api/expenses", { category: "Marketing", amount: 777000, expense_date: today });
  const dashBefore = await GET("/api/dashboard");
  const expBefore2 = Number((dashBefore.data && dashBefore.data.expensesToday) || 0);
  await DEL(`/api/expenses/${e3.data.id}`);
  const dashAfter = await GET("/api/dashboard");
  const expAfter2 = Number((dashAfter.data && dashAfter.data.expensesToday) || 0);
  ok("the dashboard's spend-today figure lets it go",
    Math.abs(expBefore2 - expAfter2 - 777000) < 0.01, `${expBefore2} → ${expAfter2}`);

  const summary = await GET(`/api/reports/sale-summary?from=${today}&to=${today}`);
  const expLine = dayOf(summary).find((r) => /expense/i.test(r.section || ""));
  if (expLine) {
    ok("and the sale summary's expense line does too",
      Math.abs(Number(expLine.amount || 0)) < 777000,
      `expenses on the report: ${expLine.amount}`);
  }

  /* Same for a payment, on the report that lists tenders taken. */
  const inv2 = await POST("/api/sales", {
    party_id: partyId, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "Voucher item", quantity: 1, rate: 100000 }],
  });
  const pay2 = await POST("/api/payments", { party_id: partyId, direction: "in", amount: 55000, mode: "mobile" });
  const modesBefore = dayOf(await GET(`/api/reports/payment-types?from=${today}&to=${today}`))
    .filter((r) => r.mode === "mobile").reduce((a, r) => a + Number(r.total || 0), 0);
  await DEL(`/api/payments/${pay2.data.id}`);
  const modesAfter = dayOf(await GET(`/api/reports/payment-types?from=${today}&to=${today}`))
    .filter((r) => r.mode === "mobile").reduce((a, r) => a + Number(r.total || 0), 0);
  ok("a voided payment leaves the tender report",
    Math.abs(modesBefore - modesAfter - 55000) < 0.01, `${modesBefore} → ${modesAfter}`);

  const stmt = await GET(`/api/reports/party-statement/${partyId}`);
  const stmtRows = (stmt.data && (stmt.data.rows || stmt.data)) || [];
  ok("and the customer's statement does not list it",
    !stmtRows.some((r) => String(r.ref || "") === pay2.data.payment_no),
    `${stmtRows.length} line(s) on the statement`);

  await balanced("everything above");

  /* ── Batches ─────────────────────────────────────────────────────────── */
  head("Voiding a sale returns the goods to their own batches, once each");
  /* `item_stock` holds one row per batch, and the void used to update by item
     id alone — so the returned quantity was added to every batch row the item
     had. On a single-lot item, which most are, it was right; on an item kept
     in three lots it invented two-thirds of the stock, quietly, and the
     valuation and reorder reports believed it. */
  const sup = await POST("/api/parties", { name: `Batch supplier ${Date.now()}`, type: "supplier" });
  const bItem = await POST("/api/items", { name: `Batch item ${Date.now()}`, unit: "PCS", sale_price: 1000, purchase_price: 500 });
  for (const lot of ["LOT-A", "LOT-B", "LOT-C"]) {
    await POST("/api/purchases", { party_id: sup.data.id, payment_type: "cash", sales_rep_id: me,
      lines: [{ item_id: bItem.data.id, description: "x", quantity: 10, rate: 500, batch_no: lot }] });
  }
  const held = await onHand(bItem.data.id);
  ok("thirty units across three lots", Math.abs(held - 30) < 0.001, `on hand ${held}`);
  const bSale = await POST("/api/sales", { party_id: partyId, payment_type: "cash", sales_rep_id: me,
    lines: [{ item_id: bItem.data.id, description: "x", quantity: 6, rate: 1000 }] });
  ok("six sold", bSale.status === 200, bSale.message);
  ok("twenty-four left", Math.abs((await onHand(bItem.data.id)) - 24) < 0.001);
  await DEL(`/api/sales/${bSale.data.id}`, { reason: "test" });
  const backOn = await onHand(bItem.data.id);
  ok("voiding it puts back six, not six per lot",
    Math.abs(backOn - 30) < 0.001, `expected 30, found ${backOn}`);
  await balanced("voiding a batched sale");

  /* ── Purchase bills ──────────────────────────────────────────────────── */
  head("A supplier bill can be voided — and refuses when the goods have gone");
  /* The bill was the one document with no way back at all: no edit, no
     delete, no void. A bill keyed at ten times its value stayed in the books,
     the payables and the stock valuation for good. */
  const sup2 = await POST("/api/parties", { name: `Bill supplier ${Date.now()}`, type: "supplier" });
  const pItem = await POST("/api/items", { name: `Bill item ${Date.now()}`, unit: "PCS", sale_price: 2000, purchase_price: 900 });
  const payBefore = (await GET(`/api/parties/${sup2.data.id}`)).data.balance;

  const bill = await POST("/api/purchases", { party_id: sup2.data.id, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: pItem.data.id, description: "x", quantity: 20, rate: 900 }] });
  ok("bill recorded", bill.status === 200, bill.data && bill.data.bill_no);
  await balanced("recording a purchase bill");
  ok("twenty units arrived", Math.abs((await onHand(pItem.data.id)) - 20) < 0.001);

  const voided = await DEL(`/api/purchases/${bill.data.id}`);
  ok("bill voided", voided.status === 200, voided.message);
  await balanced("voiding a purchase bill");
  ok("the goods went back off the shelf", Math.abs(await onHand(pItem.data.id)) < 0.001,
    `on hand ${await onHand(pItem.data.id)}`);
  ok("and the supplier is owed nothing for it",
    Math.abs(Number((await GET(`/api/parties/${sup2.data.id}`)).data.balance) - Number(payBefore)) < 0.01);
  ok("a voided bill cannot be voided twice", (await DEL(`/api/purchases/${bill.data.id}`)).status === 400);

  /* The refusal that protects the books: goods already sold cannot be un-received. */
  const bill2 = await POST("/api/purchases", { party_id: sup2.data.id, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: pItem.data.id, description: "x", quantity: 5, rate: 900 }] });
  await POST("/api/sales", { party_id: partyId, payment_type: "cash", sales_rep_id: me,
    lines: [{ item_id: pItem.data.id, description: "x", quantity: 4, rate: 2000 }] });
  const refused = await DEL(`/api/purchases/${bill2.data.id}`);
  ok("voiding a bill whose goods have been sold is refused, with the shortfall named",
    refused.status === 409 && /already been sold/i.test(refused.message || ""), refused.message);
  await balanced("a refused bill void");

  console.log(`\n${fail ? "✗" : "✓"}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
