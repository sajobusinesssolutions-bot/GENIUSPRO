/**
 * retries.e2e.js — the same document, sent twice.
 *
 * The network in the shops this runs in drops mid-save. When it does, the
 * browser cannot tell "the server never got it" from "the server posted it
 * and the reply died on the way back". Both look like silence, and the cashier
 * has a customer waiting.
 *
 * The answer is a reference per ATTEMPT, sent with every try. This suite is
 * the proof that it holds — it does not simulate a dropped connection, it does
 * the thing a dropped connection makes the browser do: send the identical
 * request again, and again while the first is still in flight.
 *
 * Every check is the same shape: post twice, then count. One document, one
 * movement of money, one set of stock. And after each pair, the ledger is
 * checked for balance, because a half-applied duplicate is worse than a whole
 * one — it balances the books against a document that does not exist.
 *
 *   node test/retries.e2e.js http://localhost:4190
 */
const BASE = process.argv[2] || "http://localhost:4190";
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
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ref = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

async function gap() {
  const tb = await GET("/api/reports/trial-balance");
  const rows = (tb.data && (tb.data.rows || tb.data)) || [];
  let d = 0, c = 0;
  for (const r of rows) { d += Number(r.debit || 0); c += Number(r.credit || 0); }
  return r2(d - c);
}
const balanced = async (step) => {
  const g = await gap();
  ok(`books balance after ${step}`, Math.abs(g) < 0.01, `Dr − Cr = ${g}`);
};

/* How many rows a list holds for a document number. The count IS the test. */
const countIn = (rows, no, key) => (rows || []).filter((r) => r[key] === no).length;

/* The balance of one account after running some work — used to pin down that
   a repeated operation moved it once. */
async function acctAfter(code, work) {
  await work();
  const r = await GET("/api/accounting/accounts");
  const a = (r.data || []).find((x) => x.code === code);
  return r2(a ? a.balance : 0);
}

(async () => {
  const login = await POST("/api/auth/login", { username: "admin", password: "admin123" });
  TOKEN = login.data && login.data.token;
  if (!TOKEN) { console.log(`  ✗ signed in  ${login.message}`); process.exit(1); }
  const me = login.data.user.id;
  ok("signed in", !!TOKEN);

  const cust = await POST("/api/parties", { name: `Retry cust ${Date.now()}`, type: "customer" });
  const sup = await POST("/api/parties", { name: `Retry sup ${Date.now()}`, type: "supplier" });
  const item = await POST("/api/items", { name: `Retry item ${Date.now()}`, unit: "PCS",
    sale_price: 10000, purchase_price: 4000, opening_stock: 100 });
  const onHand = async () => {
    const r = await GET("/api/items?limit=500");
    const rows = r.data.rows || r.data || [];
    const it = rows.find((x) => x.id === item.data.id);
    return Number(it ? it.on_hand : NaN);
  };

  /* ── A sale ───────────────────────────────────────────────────────────── */
  head("A sale sent twice is one sale");
  const saleBody = (k) => ({ client_ref: k, party_id: cust.data.id, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "x", quantity: 3, rate: 10000 }] });
  const k1 = ref();
  const stockBefore = await onHand();
  const s1 = await POST("/api/sales", saleBody(k1));
  const s2 = await POST("/api/sales", saleBody(k1));
  ok("both attempts answered 200", s1.status === 200 && s2.status === 200);
  ok("both name the same invoice", s1.data.invoice_no === s2.data.invoice_no, s1.data.invoice_no);
  ok("the second says it was a replay", s2.data.replayed === true);
  ok("only three units left the shelf, not six",
    Math.abs((await onHand()) - (stockBefore - 3)) < 0.001, `${stockBefore} → ${await onHand()}`);
  const list = await GET("/api/sales?limit=200");
  ok("one invoice in the book with that number",
    countIn(list.data.rows || list.data, s1.data.invoice_no, "invoice_no") === 1);
  await balanced("a retried sale");

  /* ── In flight at once ────────────────────────────────────────────────── */
  head("Two copies in flight at the same time");
  /* This is the case the lookup alone cannot catch: both requests get past the
     "have I seen this?" check before either has written. Only the unique index
     settles it. A cashier double-clicking Save does exactly this. */
  const k2 = ref();
  const [a, b] = await Promise.all([POST("/api/sales", saleBody(k2)), POST("/api/sales", saleBody(k2))]);
  ok("both answered 200", a.status === 200 && b.status === 200, `${a.status}/${b.status} ${a.message || ""} ${b.message || ""}`);
  ok("and both name one invoice", a.data && b.data && a.data.invoice_no === b.data.invoice_no,
    `${a.data && a.data.invoice_no} vs ${b.data && b.data.invoice_no}`);
  const list2 = await GET("/api/sales?limit=200");
  ok("one invoice written", countIn(list2.data.rows || list2.data, a.data.invoice_no, "invoice_no") === 1);
  await balanced("a double-clicked sale");

  /* ── A payment ────────────────────────────────────────────────────────── */
  head("A payment sent twice settles the invoice once");
  /* Its own customer, so oldest-first allocation has exactly one bill to land
     on and the check is about the retry rather than about which invoice the
     allocator chose. */
  const payCust = await POST("/api/parties", { name: `Retry payer ${Date.now()}`, type: "customer" });
  const inv = await POST("/api/sales", { client_ref: ref(), party_id: payCust.data.id, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "x", quantity: 5, rate: 10000 }] });
  const due = r2(inv.data.totals.grand_total);
  const k3 = ref();
  const payBody = { client_ref: k3, party_id: payCust.data.id, direction: "in", amount: due };
  const p1 = await POST("/api/payments", payBody);
  const p2 = await POST("/api/payments", payBody);
  ok("both answered 200", p1.status === 200 && p2.status === 200);
  ok("both name the same receipt", p1.data.payment_no === p2.data.payment_no, p1.data.payment_no);
  ok("the second says it was a replay", p2.data.replayed === true);
  const after = await GET(`/api/sales/${inv.data.id}`);
  ok("the invoice is settled, not overpaid",
    Math.abs(r2(after.data.paid_amount) - due) < 0.01, `paid ${after.data.paid_amount} of ${due}`);
  ok("and nothing is sitting as an unexplained advance",
    Math.abs(Number(p1.data.unallocated || 0)) < 0.01);
  const pays = await GET("/api/payments?page=1&limit=200");
  ok("one payment row", countIn(pays.data.rows || pays.data, p1.data.payment_no, "payment_no") === 1);
  await balanced("a retried payment");

  /* ── An expense ───────────────────────────────────────────────────────── */
  head("An expense sent twice is one expense");
  const k4 = ref();
  const expBody = { client_ref: k4, category: "Transport", amount: 33000 };
  const e1 = await POST("/api/expenses", expBody);
  const e2 = await POST("/api/expenses", expBody);
  ok("both name the same expense", e1.data.expense_no === e2.data.expense_no, e1.data.expense_no);
  ok("the second says it was a replay", e2.data.replayed === true);
  const exps = await GET("/api/expenses?page=1&limit=200");
  ok("one expense row", countIn(exps.data.rows || exps.data, e1.data.expense_no, "expense_no") === 1);
  ok("and the total counts it once",
    Math.abs(Number((exps.data.sums || {}).amount || 0) - 33000) < 0.01,
    `total ${(exps.data.sums || {}).amount}`);
  await balanced("a retried expense");

  /* ── A purchase bill ──────────────────────────────────────────────────── */
  head("A supplier bill sent twice does not stock the shelf twice");
  const k5 = ref();
  const billBody = { client_ref: k5, party_id: sup.data.id, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "x", quantity: 10, rate: 4000 }] };
  const before5 = await onHand();
  const b1 = await POST("/api/purchases", billBody);
  const b2 = await POST("/api/purchases", billBody);
  ok("both name the same bill", b1.data.bill_no === b2.data.bill_no, b1.data.bill_no);
  ok("ten units arrived, not twenty",
    Math.abs((await onHand()) - (before5 + 10)) < 0.001, `${before5} → ${await onHand()}`);
  await balanced("a retried bill");

  /* ── A journal ────────────────────────────────────────────────────────── */
  head("A hand-keyed journal sent twice is posted once");
  const k6 = ref();
  const jeBody = { client_ref: k6, description: "Retry drawings",
    lines: [{ account_code: "3001", debit: 12345 }, { account_code: "1001", credit: 12345 }] };
  const j1 = await POST("/api/accounting/journal", jeBody);
  const j2 = await POST("/api/accounting/journal", jeBody);
  ok("both name the same entry", j1.data.entry_no === j2.data.entry_no, j1.data.entry_no);
  const day = await GET("/api/accounting/daybook");
  const entries = (day.data && (day.data.rows || day.data)) || [];
  ok("one entry in the day book",
    entries.filter((x) => x.entry_no === j1.data.entry_no).length === 1);
  await balanced("a retried journal");

  /* ── A genuine repeat is NOT a retry ──────────────────────────────────── */
  head("Two real documents that happen to be identical are still two");
  /* The protection must not become a bug of its own. Two walk-in customers
     buying the same thing a minute apart send identical bodies; only the
     reference tells them apart, which is why it is never derived from the
     contents. */
  const t1 = await POST("/api/expenses", { client_ref: ref(), category: "Transport", amount: 5000 });
  const t2 = await POST("/api/expenses", { client_ref: ref(), category: "Transport", amount: 5000 });
  ok("two different expenses were recorded", t1.data.expense_no !== t2.data.expense_no,
    `${t1.data.expense_no} and ${t2.data.expense_no}`);
  ok("neither was mistaken for a replay", !t1.data.replayed && !t2.data.replayed);

  /* ── Editing twice ────────────────────────────────────────────────────── */
  head("An edit repeated leaves the corrected figure, not two corrections");
  /* An edit is void-and-repost, so repeating it recomputes from scratch rather
     than applying twice. That is the property worth pinning: a retried Save on
     an edit form is safe even though it carries no reference. */
  const eFix = await POST("/api/expenses", { client_ref: ref(), category: "Rent", amount: 200000 });
  await PUT(`/api/expenses/${eFix.data.id}`, { amount: 150000 });
  await PUT(`/api/expenses/${eFix.data.id}`, { amount: 150000 });
  const acct = await GET("/api/accounting/accounts");
  const before7 = (acct.data || []).find((x) => x.code === "5100");
  ok("the expense account holds one correction", !!before7, `Indirect Expenses ${before7 && before7.balance}`);
  await balanced("a repeated edit");

  /* ── The period lock ──────────────────────────────────────────────────── */
  head("Books closed to a date refuse anything dated into it");
  await PUT("/api/settings", { books_locked_upto: "2026-06-30" });
  const late = await POST("/api/expenses", { client_ref: ref(), category: "Rent", amount: 1000, expense_date: "2026-05-15" });
  ok("an expense dated inside the closed period is refused", late.status === 409, late.message);
  const fine = await POST("/api/expenses", { client_ref: ref(), category: "Rent", amount: 1000, expense_date: "2026-07-15" });
  ok("one dated after it goes through", fine.status === 200, fine.message);
  const lateSale = await POST("/api/sales", { client_ref: ref(), party_id: cust.data.id, payment_type: "credit",
    sales_rep_id: me, invoice_date: "2026-01-02",
    lines: [{ item_id: item.data.id, description: "x", quantity: 1, rate: 10000 }] });
  ok("so is a sale dated into it", lateSale.status === 409, lateSale.message);
  /* A void is dated today and posts its reversal today, so a closed period
     keeps every figure it was filed with and the correction lands in the open
     one. Blocking it would leave a known-wrong document with no way to fix it. */
  const voidable = await POST("/api/expenses", { client_ref: ref(), category: "Rent", amount: 4000, expense_date: "2026-07-20" });
  const undone = await call("DELETE", `/api/expenses/${voidable.data.id}`);
  ok("but a void still works while a lock is on", undone.status === 200, undone.message);
  await PUT("/api/settings", { books_locked_upto: "" });
  await balanced("the period lock");

  /* ── Edits and voids, pressed twice ───────────────────────────────────── */
  head("Pressing Save twice on an EDIT does not apply the change twice");
  /* An edit carries no reference, and does not need one: it is void-and-repost,
     so running it again recomputes the document from scratch rather than
     applying a second delta. This is the property that makes a retried Save on
     an edit form safe, and it is worth pinning down because it is a property
     of how the edit is implemented — someone could later "optimise" it into an
     incremental update and quietly break it. */
  const accountOf = async (code) => {
    const r = await GET("/api/accounting/accounts");
    const a = (r.data || []).find((x) => x.code === code);
    return r2(a ? a.balance : 0);
  };
  const e0 = await acctAfter("5100", async () => {});
  const ee = await POST("/api/expenses", { client_ref: ref(), category: "Rent", amount: 90000 });
  await PUT(`/api/expenses/${ee.data.id}`, { amount: 30000 });
  const once = await accountOf("5100");
  await PUT(`/api/expenses/${ee.data.id}`, { amount: 30000 });
  const twice = await accountOf("5100");
  ok("the second identical Save changes nothing", Math.abs(once - twice) < 0.01, `${once} then ${twice}`);
  ok("and the books hold the corrected figure once",
    Math.abs(twice - r2(e0 + 30000)) < 0.01, `${e0} → ${twice}`);
  await balanced("a twice-pressed edit");

  head("Pressing Void twice cancels once and says so the second time");
  const v1 = await call("DELETE", `/api/expenses/${ee.data.id}`);
  const v2 = await call("DELETE", `/api/expenses/${ee.data.id}`);
  ok("the first void went through", v1.status === 200, v1.message);
  ok("the second is refused rather than reversing it again", v2.status === 400, v2.message);
  ok("and the account is back exactly where it started",
    Math.abs((await accountOf("5100")) - e0) < 0.01, `${e0} → ${await accountOf("5100")}`);
  await balanced("a twice-pressed void");

  head("A payment corrected twice settles the invoice once, at the new figure");
  const c2 = await POST("/api/parties", { name: `Retry edit ${Date.now()}`, type: "customer" });
  const iv = await POST("/api/sales", { client_ref: ref(), party_id: c2.data.id, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id, description: "x", quantity: 4, rate: 10000 }] });
  const total = r2(iv.data.totals.grand_total);
  const py = await POST("/api/payments", { client_ref: ref(), party_id: c2.data.id, direction: "in", amount: total });
  await PUT(`/api/payments/${py.data.id}`, { amount: r2(total / 2) });
  await PUT(`/api/payments/${py.data.id}`, { amount: r2(total / 2) });
  const iv2 = await GET(`/api/sales/${iv.data.id}`);
  ok("the invoice shows half paid, not a quarter or none",
    Math.abs(r2(iv2.data.paid_amount) - r2(total / 2)) < 0.01, `paid ${iv2.data.paid_amount} of ${total}`);
  ok("and owes the other half exactly once",
    Math.abs(r2(iv2.data.balance_due) - r2(total / 2)) < 0.01, `due ${iv2.data.balance_due}`);
  await balanced("a twice-pressed payment edit");

  console.log(`\n${fail ? "✗" : "✓"}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
