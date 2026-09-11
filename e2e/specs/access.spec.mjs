/**
 * access.spec.mjs — who may read what, and whose books they are.
 *
 * Two things this app has always asserted and never tested:
 *
 *   1. Every table carries firm_id, and every query is supposed to carry the
 *      matching predicate. One that does not means firm A's records answer to
 *      firm B's token. Four did not, and two of those were not reads but
 *      writes — another business's counter PIN, and another business's Admin
 *      role emptied of every permission.
 *   2. requirePermission(resource, action) is supposed to be the whole story.
 *      Every verification pass before this one ran as `admin`, so a route with
 *      no check at all looked exactly like a route with one.
 *
 * Why this spec runs its own server. Nothing in the app creates a second
 * business — the installer ships one firm and the UI never offers another — so
 * a genuine cross-tenant test cannot be set up over HTTP. The suite's own
 * database copy is already open in the shared server's memory and cannot be
 * written behind its back, so this spec takes its own copy, writes firm B into
 * it with sql.js before anything opens it, and boots a second backend on its
 * own port. Everything after that is real HTTP against the real routes.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = path.join(ROOT, "backend");
const PORT = Number(process.env.E2E_ACCESS_PORT || (Number(process.env.E2E_PORT || 3199) + 100));
const BASE = `http://localhost:${PORT}`;

/* sql.js and bcryptjs are the backend's own dependencies — resolved from there
   rather than added to the suite, which installs nothing. */
const backendRequire = createRequire(path.join(BACKEND, "package.json"));

export const name = "tenant isolation and role permissions";

/* ── a second business, written into a private copy of the database ──────── */

const MODULES = ["parties", "items", "sales", "payments", "purchases", "expenses", "accounting", "reports", "settings", "users"];
const ACTIONS = ["view", "create", "edit", "delete"];

async function seedSecondFirm() {
  const src = path.join(BACKEND, "data", "genius.db");
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-access-"));
  const dbPath = path.join(dir, "genius.db");
  fs.copyFileSync(src, dbPath);

  const initSqlJs = backendRequire("sql.js");
  const bcrypt = backendRequire("bcryptjs");
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const one = (sql) => { const r = db.exec(sql); return r.length ? r[0].values[0][0] : null; };

  db.run("INSERT INTO firms (name, legal_name, gstin, state_code, invoice_prefix, status) VALUES ('Rival Traders','Rival Traders Ltd','TIN-B','B','BINV','active')");
  const firmB = one("SELECT MAX(id) FROM firms");

  /* Firm B's user holds every permission there is. That is deliberate: it
     removes RBAC from the question entirely, so anything that comes back is a
     tenancy failure and not a permission that happened to be missing. */
  db.run("INSERT INTO roles (firm_id, name, is_system) VALUES (?,'Owner',1)", [firmB]);
  const roleB = one("SELECT MAX(id) FROM roles");
  for (const m of MODULES) for (const a of ACTIONS) {
    db.run("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [roleB, m, a]);
  }
  db.run(
    "INSERT INTO users (username, password_hash, full_name, role_id, active_firm_id, status) VALUES ('rival',?,'Rival Owner',?,?,'active')",
    [bcrypt.hashSync("rival123", 10), roleB, firmB]);

  /* Firm B needs its own chart of accounts or its own postings cannot be made,
     and a spec that cannot write firm B data proves nothing about firm A. */
  const coa = db.exec("SELECT code, name, type, is_cash_bank, is_control, opening_balance FROM chart_of_accounts WHERE firm_id = 1");
  if (coa.length) for (const v of coa[0].values) {
    db.run("INSERT INTO chart_of_accounts (firm_id, code, name, type, is_cash_bank, is_control, opening_balance) VALUES (?,?,?,?,?,?,?)", [firmB, ...v]);
  }

  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  return { dir, dbPath, firmB };
}

async function startIsolatedServer(dbPath) {
  const proc = spawn("node", ["server.js"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      GENIUS_DB_PATH: dbPath,
      JWT_SECRET: process.env.JWT_SECRET || "e2e-only-not-a-production-secret",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return proc; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error("The access-spec backend never became healthy.\n" + log.join(""));
}

/* ── tiny request helpers over Playwright's APIRequestContext ────────────── */

function client(request, token) {
  const call = async (method, url, data) => {
    const res = await request.fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { data }),
      failOnStatusCode: false,
    });
    let body = null;
    try { body = await res.json(); } catch { /* not every reply is json */ }
    return { status: res.status(), body, data: body && body.data, message: body && body.message };
  };
  return {
    get: (u) => call("GET", u),
    post: (u, d) => call("POST", u, d ?? {}),
    put: (u, d) => call("PUT", u, d ?? {}),
    del: (u, d) => call("DELETE", u, d ?? {}),
  };
}

async function signInApi(request, username, password) {
  const res = await request.fetch(`${BASE}/api/auth/login`, {
    method: "POST", data: { username, password }, failOnStatusCode: false,
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Could not sign in as ${username}: ${body?.message}`);
  return client(request, body.data.token);
}

const today = () => new Date().toISOString().slice(0, 10);

/* ── the spec ────────────────────────────────────────────────────────────── */

export async function run({ browser, report }) {
  const ctx = await browser.newContext();
  const request = ctx.request;

  let seeded, proc;
  try {
    seeded = await seedSecondFirm();
    proc = await startIsolatedServer(seeded.dbPath);

    const alice = await signInApi(request, "admin", "admin123");     // firm A, owner
    const cashier = await signInApi(request, "sales", "sales123");   // firm A, Salesman
    const rival = await signInApi(request, "rival", "rival123");     // firm B, all permissions

    const A = await buildFirmAData(alice, report);
    await tenantIsolation({ rival, alice, A, report });
    await rolePermissions({ cashier, A, report });
  } finally {
    proc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (proc && !proc.killed) proc.kill("SIGKILL");
    if (seeded) fs.rmSync(seeded.dir, { recursive: true, force: true });
    await ctx.close();
  }
}

/* Records in firm A, one of every family a cross-firm request could ask for.
   Created over the API as firm A's own owner, so each id is a real id that
   really exists — a 404 later means "not yours", not "not there". */
async function buildFirmAData(alice, report) {
  await alice.put("/api/settings", {
    mod_offers: "1", mod_manufacturing: "1", mod_installments: "1", mod_recurring_sales: "1",
  });

  const id = (r) => r.data?.id;
  const item = id(await alice.post("/api/items", {
    name: `Isolation Widget ${Date.now()}`, unit: "PCS", sale_price: 1000, purchase_price: 400,
    opening_stock: 50, is_inventory: 1,
  }));
  const party = id(await alice.post("/api/parties", { name: `Isolation Customer ${Date.now()}`, party_type: "customer" }));
  const cashSale = await alice.post("/api/sales", {
    party_id: party, payment_type: "cash", sales_rep_id: 1,
    lines: [{ item_id: item, description: "Isolation Widget", quantity: 1, rate: 1000, unit: "PCS" }],
  });
  const creditSale = await alice.post("/api/sales", {
    party_id: party, payment_type: "credit", paid_amount: 0, sales_rep_id: 1,
    lines: [{ item_id: item, description: "Isolation Widget", quantity: 2, rate: 1000, unit: "PCS" }],
  });
  const payment = id(await alice.post("/api/payments", { party_id: party, direction: "in", amount: 25, mode: "cash" }));
  const expense = id(await alice.post("/api/expenses", { category: "Rent", amount: 100, expense_date: today() }));
  const purchase = id(await alice.post("/api/purchases", {
    party_id: party, sales_rep_id: 1,
    lines: [{ item_id: item, description: "Isolation Widget", quantity: 5, rate: 400, unit: "PCS" }],
  }));
  const estimate = id(await alice.post("/api/estimates", {
    party_id: party, lines: [{ item_id: item, description: "Isolation Widget", quantity: 1, rate: 1000 }],
  }));
  const purchaseOrder = id(await alice.post("/api/purchase-orders", {
    party_id: party, lines: [{ item_id: item, quantity: 3, rate: 400 }],
  }));
  const stockTake = id(await alice.post("/api/stock-takes", { note: "Isolation count" }));
  await alice.post("/api/pos/held", { payload: { lines: [] }, label: "Isolation hold", total_hint: 10 });
  const held = (await alice.get("/api/pos/held")).data?.[0]?.id;
  const journal = (await alice.post("/api/accounting/journal", {
    date: today(), description: "Isolation journal",
    lines: [{ account_code: "1001", debit: 10, credit: 0 }, { account_code: "4001", debit: 0, credit: 10 }],
  })).data?.entryId;
  const offer = id(await alice.post("/api/offers", { name: "Isolation Offer", kind: "bill_percent", type: "bill_percent", value: 5 }));
  const recurring = id(await alice.post("/api/recurring", {
    name: "Isolation Schedule", kind: "sale", doc_type: "sale", party_id: party,
    frequency: "monthly", interval_n: 1, start_on: today(),
    lines: [{ item_id: item, quantity: 1, rate: 1000 }],
  }));
  const filing = id(await alice.post("/api/tax/filings", {
    tax_type: "vat", period: "2026-01", due_date: "2026-02-15", filed_date: "2026-02-10", amount: 100,
  }));
  const plan = id(await alice.post("/api/installments", {
    invoice_id: creditSale.data?.id, count_n: 3, start_date: today(),
  }));

  await alice.post("/api/settings/categories", { name: `Isolation Cat ${Date.now()}` });
  const category = (await alice.get("/api/settings/categories")).data?.slice(-1)[0]?.id;
  await alice.post("/api/settings/price-lists", { name: `Isolation List ${Date.now()}` });
  const priceList = (await alice.get("/api/settings/price-lists")).data?.slice(-1)[0]?.id;
  await alice.post("/api/settings/tax-rules", { name: "Isolation Tax", rate: 5, mode: "add" });
  const taxRule = (await alice.get("/api/settings/tax-rules")).data?.slice(-1)[0]?.id;

  const A = {
    item, party, category, priceList, taxRule,
    invoice: cashSale.data?.id, invoiceNo: cashSale.data?.invoice_no, creditInvoice: creditSale.data?.id,
    payment, expense, purchase, estimate, purchaseOrder, stockTake, held, journal,
    offer, recurring, filing, plan,
  };

  /* Every id below is asserted against, so a fixture that silently failed to
     save would turn a real leak into a passing test. */
  const missing = Object.entries(A).filter(([, v]) => v == null).map(([k]) => k);
  report.ok(missing.length === 0,
    "firm A has a record of every kind for the cross-firm attempts to aim at",
    missing.length ? `never got an id for: ${missing.join(", ")}` : undefined);
  return A;
}

/* ── Part 1: firm B may not touch firm A ─────────────────────────────────── */

async function tenantIsolation({ rival, alice, A, report }) {
  /* A firm-scoped route answering an id from another business must not return
     that record, and must not change it. 404 and 403 both satisfy that; 200
     with a body does not, and neither does 200 on a write. */
  const denied = async (label, res) => {
    const leaked = res.status === 200 && res.data != null && !(Array.isArray(res.data) && res.data.length === 0);
    report.ok(!leaked, label, `got ${res.status} ${JSON.stringify(res.data ?? res.message).slice(0, 160)}`);
  };

  /* Reads. */
  await denied("firm B cannot read firm A's item", await rival.get(`/api/items/${A.item}`));
  await denied("firm B cannot read firm A's item stock ledger", await rival.get(`/api/items/${A.item}/ledger`));
  await denied("firm B cannot read firm A's party", await rival.get(`/api/parties/${A.party}`));
  await denied("firm B cannot read firm A's party statement", await rival.get(`/api/reports/party-statement/${A.party}`));
  await denied("firm B cannot read firm A's invoice", await rival.get(`/api/sales/${A.invoice}`));
  await denied("firm B cannot read firm A's invoice by its number", await rival.get(`/api/sales/by-number/${encodeURIComponent(A.invoiceNo)}`));
  await denied("firm B cannot read firm A's purchase bill", await rival.get(`/api/purchases/${A.purchase}`));
  await denied("firm B cannot read firm A's estimate", await rival.get(`/api/estimates/${A.estimate}`));
  await denied("firm B cannot read firm A's purchase order", await rival.get(`/api/purchase-orders/${A.purchaseOrder}`));
  await denied("firm B cannot read firm A's stock take", await rival.get(`/api/stock-takes/${A.stockTake}`));
  await denied("firm B cannot read firm A's held bill", await rival.get(`/api/pos/held/${A.held}`));
  await denied("firm B cannot read firm A's payment plan", await rival.get(`/api/installments/${A.plan}`));
  await denied("firm B cannot read firm A's loyalty balance for a customer", await rival.get(`/api/loyalty/party/${A.party}`));
  await denied("firm B cannot read firm A's price list contents", await rival.get(`/api/settings/price-lists/${A.priceList}/items`));

  /* Writes. */
  await denied("firm B cannot rename firm A's item", await rival.put(`/api/items/${A.item}`, { name: "Taken", unit: "PCS" }));
  await denied("firm B cannot delete or deactivate firm A's item", await rival.del(`/api/items/${A.item}`));
  await denied("firm B cannot adjust firm A's stock", await rival.post(`/api/items/${A.item}/adjust`, { quantity: 10, direction: "in" }));
  await denied("firm B cannot rename firm A's party", await rival.put(`/api/parties/${A.party}`, { name: "Taken" }));
  await denied("firm B cannot set a special price on firm A's party", await rival.post(`/api/parties/${A.party}/rates`, { item_id: A.item, rate: 1 }));
  await denied("firm B cannot edit firm A's invoice", await rival.put(`/api/sales/${A.invoice}`, {
    party_id: A.party, lines: [{ description: "Taken", quantity: 1, rate: 1 }],
  }));
  await denied("firm B cannot void firm A's sale", await rival.del(`/api/sales/${A.invoice}`, { reason: "taken" }));
  await denied("firm B cannot mark firm A's invoice as fiscalised", await rival.put(`/api/tax/efris/${A.invoice}`, { status: "sent", fdn: "X" }));
  await denied("firm B cannot cancel firm A's payment plan", await rival.post(`/api/installments/${A.plan}/cancel`));
  await denied("firm B cannot delete firm A's payment plan", await rival.del(`/api/installments/${A.plan}`));
  await denied("firm B cannot delete firm A's journal entry", await rival.del(`/api/accounting/journal/${A.journal}`));
  await denied("firm B cannot edit firm A's offer", await rival.put(`/api/offers/${A.offer}`, { name: "Taken" }));
  await denied("firm B cannot delete firm A's offer", await rival.del(`/api/offers/${A.offer}`));
  await denied("firm B cannot pause firm A's recurring schedule", await rival.post(`/api/recurring/${A.recurring}/status`, { status: "paused" }));
  await denied("firm B cannot delete firm A's recurring schedule", await rival.del(`/api/recurring/${A.recurring}`));
  await denied("firm B cannot edit firm A's tax filing", await rival.del(`/api/tax/filings/${A.filing}`));
  await denied("firm B cannot edit firm A's tax rule", await rival.put(`/api/settings/tax-rules/${A.taxRule}`, { name: "Taken", rate: 99 }));
  await denied("firm B cannot delete firm A's purchase order", await rival.del(`/api/purchase-orders/${A.purchaseOrder}`));
  await denied("firm B cannot delete firm A's stock take", await rival.del(`/api/stock-takes/${A.stockTake}`));
  await denied("firm B cannot price an item into firm A's price list", await rival.post(`/api/settings/price-lists/${A.priceList}/items`, { item_id: A.item, price: 1 }));
  await denied("firm B cannot edit firm A's staff member", await rival.put("/api/users/1", { full_name: "Taken", status: "inactive" }));
  await denied("firm B cannot set a counter PIN on firm A's owner", await rival.put("/api/users/1/pin", { pin: "1357" }));
  await denied("firm B cannot set terms on firm A's staff member", await rival.put("/api/staff/1/terms", { commission_pct: 99 }));
  await denied("firm B cannot rewrite firm A's Admin role permissions", await rival.put("/api/users/roles/1/permissions", { permissions: [] }));
  await denied("firm B cannot rewrite firm A's Admin role from the catalogue", await rival.put("/api/users/roles/1/catalogue", { granted: [] }));

  /* Firm B cannot plant a foreign item id inside a document of its own, which
     is how another business's item name and buy price used to read back
     through any report that joins items onto a line. */
  const ownParty = await rival.post("/api/parties", { name: "Rival Customer", party_type: "customer" });
  const planted = await rival.post("/api/sales", {
    party_id: ownParty.data?.id, payment_type: "cash", sales_rep_id: null,
    lines: [{ item_id: A.item, description: "planted", quantity: 1, rate: 1000, unit: "PCS" }],
  });
  report.ok(planted.status !== 200,
    "firm B cannot bill one of firm A's items on its own invoice",
    `got ${planted.status} ${JSON.stringify(planted.data ?? planted.message).slice(0, 160)}`);

  /* Whole-book listings. Firm B may legitimately hold rows of its own (its
     owner, the customer created just above), so the assertion is not "empty"
     but "nothing of firm A's". */
  /* Document numbers restart per firm, so a number is no marker — the name is.
     Everything firm A made above carries the word Isolation, and firm A's two
     seeded staff are admin and sales. */
  const FIRM_A = /Isolation|Administrator|Sales Rep|"username":"(admin|sales)"/;
  const listExcludesFirmA = async (label, url, pick = (d) => (Array.isArray(d) ? d : d?.rows || [])) => {
    const res = await rival.get(url);
    const rows = pick(res.data) || [];
    const theirs = rows.filter((r) => r && (r.firm_id === 1 || FIRM_A.test(JSON.stringify(r))));
    report.ok(theirs.length === 0, label, `${theirs.length} of firm A's row(s) came back: ${JSON.stringify(theirs).slice(0, 200)}`);
  };
  await listExcludesFirmA("firm B's item list holds none of firm A's items", "/api/items");
  await listExcludesFirmA("firm B's party list holds none of firm A's parties", "/api/parties");
  await listExcludesFirmA("firm B's sales list holds none of firm A's invoices", "/api/sales");
  await listExcludesFirmA("firm B's purchase list holds none of firm A's bills", "/api/purchases");
  await listExcludesFirmA("firm B's payment list holds none of firm A's payments", "/api/payments");
  await listExcludesFirmA("firm B's expense list holds none of firm A's expenses", "/api/expenses");
  await listExcludesFirmA("firm B's shift history holds none of firm A's shifts", "/api/shifts");
  await listExcludesFirmA("firm B's day book holds none of firm A's journal entries", "/api/accounting/daybook");
  await listExcludesFirmA("firm B's sale summary counts none of firm A's sales", "/api/reports/sale-summary");
  await listExcludesFirmA("firm B's stock summary counts none of firm A's stock", "/api/reports/stock-summary");
  await listExcludesFirmA("firm B's general ledger holds none of firm A's postings", "/api/reports/general-ledger");
  await listExcludesFirmA("firm B's invoice-details report lists none of firm A's invoices", "/api/reports/invoice-details");
  await listExcludesFirmA("firm B's item-sales report counts none of firm A's sales", "/api/reports/item-sales");
  await listExcludesFirmA("firm B's staff list holds none of firm A's staff", "/api/users", (d) => d || []);
  await listExcludesFirmA("firm B's sales-rep picker offers none of firm A's staff", "/api/users/reps", (d) => d || []);
  await listExcludesFirmA("firm B's stock-take variance counts none of firm A's counts", "/api/stock-takes/variance");
  await listExcludesFirmA("firm B's credit-note list holds none of firm A's returns", "/api/returns/credit-notes");
  await listExcludesFirmA("firm B's estimate list holds none of firm A's quotes", "/api/estimates");
  await listExcludesFirmA("firm B's recurring list holds none of firm A's schedules", "/api/recurring");
  await listExcludesFirmA("firm B's offer list holds none of firm A's offers", "/api/offers");
  await listExcludesFirmA("firm B's warranty register holds none of firm A's cover", "/api/warranty");

  const search = await rival.get("/api/dashboard/search?q=Isolation");
  const hits = (search.data?.parties?.length || 0) + (search.data?.items?.length || 0) + (search.data?.invoices?.length || 0);
  report.ok(hits === 0, "firm B's global search finds none of firm A's records", `found ${hits} hit(s)`);

  const dash = await rival.get("/api/dashboard");
  report.ok((dash.data?.salesToday || 0) === 0 && (dash.data?.receivable || 0) === 0,
    "firm B's dashboard totals count none of firm A's money",
    `salesToday ${dash.data?.salesToday}, receivable ${dash.data?.receivable}`);

  /* And after all of that, firm A is exactly as it was. This is the assertion
     that catches a write which reported failure and landed anyway. */
  const item = await alice.get(`/api/items/${A.item}`);
  report.ok(item.status === 200 && !/Taken/.test(item.data?.name || "") && item.data?.is_active !== 0,
    "firm A's item survives everything firm B tried, still named and still active",
    `name "${item.data?.name}", is_active ${item.data?.is_active}`);

  const sale = await alice.get(`/api/sales/${A.invoice}`);
  report.ok(sale.status === 200 && sale.data?.status !== "voided",
    "firm A's sale is still posted after firm B tried to void it",
    `status ${sale.data?.status}`);

  const me = await alice.get("/api/auth/me");
  report.ok((me.data?.permissions?.length || 0) >= 40,
    "firm A's owner still holds every permission after firm B tried to empty the role",
    `holds ${me.data?.permissions?.length} permission pair(s)`);

  const staff = await alice.get("/api/users");
  const owner = (staff.data || []).find((u) => u.id === 1);
  report.ok(owner && owner.status === "active" && !owner.has_pin,
    "firm A's owner is still active and still has no counter PIN firm B chose",
    JSON.stringify(owner));
}

/* ── Part 2: the Salesman role gets its job and nothing beyond it ────────── */

async function rolePermissions({ cashier, A, report }) {
  const allowed = async (label, res) => report.ok(res.status === 200, label,
    `got ${res.status} ${String(res.message || "").slice(0, 120)}`);
  const refused = async (label, res) => report.ok(res.status === 403, label,
    `got ${res.status} ${String(res.message || "").slice(0, 120)}`);

  /* The job. A cashier blocked from any of these cannot work the counter. */
  await allowed("a cashier can see the item list", await cashier.get("/api/items"));
  await allowed("a cashier can see the customer list", await cashier.get("/api/parties"));
  await allowed("a cashier can add a customer at the counter", await cashier.post("/api/parties", { name: `Walk-in ${Date.now()}` }));
  await allowed("a cashier can ring up a sale", await cashier.post("/api/sales", {
    party_id: A.party, payment_type: "cash", sales_rep_id: 2,
    lines: [{ item_id: A.item, description: "Isolation Widget", quantity: 1, rate: 1000, unit: "PCS" }],
  }));
  await allowed("a cashier can reprint a past receipt", await cashier.get(`/api/sales/${A.invoice}`));
  await allowed("a cashier can park a bill and pick it up again", await cashier.post("/api/pos/held", { payload: { lines: [] }, label: "parked" }));
  await allowed("a cashier can record why a line was voided", await cashier.post("/api/pos/void", { scope: "item", reason: "customer changed their mind", amount: 1 }));
  await allowed("a cashier can choose which drawer a cash sale lands in", await cashier.get("/api/accounting/cash-accounts"));
  await allowed("a cashier can attribute a sale to a colleague", await cashier.get("/api/users/reps"));
  await allowed("a cashier can read the shop's settings their screens depend on", await cashier.get("/api/settings"));
  await allowed("a cashier can see what the till has taken today", await cashier.get("/api/pos/today-sales"));
  await allowed("a cashier can open the till for their shift", await cashier.post("/api/shifts/open", { opening_float: 100 }));
  await allowed("a cashier can see what the drawer should hold before counting it", await cashier.get("/api/shifts/preview"));
  await allowed("a cashier can count down and close their own shift", await cashier.post("/api/shifts/close", { counted_cash: 100 }));

  /* The cash/bank picker has to work without handing over the bank balance —
     "See account balances" is accounting.view, which this role does not hold. */
  const drawers = await cashier.get("/api/accounting/cash-accounts");
  report.ok((drawers.data || []).length > 0 && (drawers.data || []).every((a) => a.balance === undefined),
    "the drawer picker names the accounts for a cashier without showing what is in them",
    JSON.stringify(drawers.data).slice(0, 200));

  /* Not the job. */
  await refused("a cashier cannot void a paid sale", await cashier.del(`/api/sales/${A.invoice}`, { reason: "x" }));
  await refused("a cashier cannot rewrite a posted sale", await cashier.put(`/api/sales/${A.invoice}`, {
    party_id: A.party, lines: [{ description: "x", quantity: 1, rate: 1 }],
  }));
  await refused("a cashier cannot hand back a locked bill", await cashier.put(`/api/pos/held/${A.held}/lock`, { locked: 0 }));
  await refused("a cashier cannot hand out loyalty points by hand", await cashier.post("/api/loyalty/adjust", { party_id: A.party, points: 500 }));
  await refused("a cashier cannot change the shop's settings", await cashier.put("/api/settings", { currency_symbol: "€" }));
  await refused("a cashier cannot rename the business", await cashier.put("/api/settings/firm", { name: "Taken" }));
  await refused("a cashier cannot delete a tax rule", await cashier.del(`/api/settings/tax-rules/${A.taxRule}`));
  await refused("a cashier cannot see the staff list", await cashier.get("/api/users"));
  await refused("a cashier cannot edit another user", await cashier.put("/api/users/1", { full_name: "Taken" }));
  await refused("a cashier cannot set another user's counter PIN", await cashier.put("/api/users/1/pin", { pin: "1357" }));
  await refused("a cashier cannot grant themselves permissions", await cashier.put("/api/users/roles/2/permissions", {
    permissions: [{ module: "settings", action: "edit" }],
  }));
  await refused("a cashier cannot create a role", await cashier.post("/api/users/roles", { name: "Superuser" }));
  await refused("a cashier cannot download the database", await cashier.get("/api/system/backup"));
  await refused("a cashier cannot restore a backup over the shop", await cashier.post("/api/system/restore", { data: "" }));
  await refused("a cashier cannot restore one of the automatic backups", await cashier.post("/api/system/restore-file", { name: "auto-2026-01-01.db" }));
  await refused("a cashier cannot list the backups on disk", await cashier.get("/api/system/backups"));
  await refused("a cashier cannot push a new build over the app", await cashier.post("/api/system/update"));
  await refused("a cashier cannot read the ledger", await cashier.get("/api/accounting/daybook"));
  await refused("a cashier cannot read the trial balance", await cashier.get("/api/reports/trial-balance"));
  await refused("a cashier cannot read profit and loss", await cashier.get("/api/accounting/profit-loss"));
  await refused("a cashier cannot see what is in the bank", await cashier.get("/api/money/overview"));
  await refused("a cashier cannot post a journal entry", await cashier.post("/api/accounting/journal", { date: today(), lines: [] }));
  await refused("a cashier cannot read what staff are paid", await cashier.get("/api/staff/commission"));
  await refused("a cashier cannot read how other staff performed", await cashier.get("/api/staff/performance"));
  await refused("a cashier cannot change a colleague's commission rate", await cashier.put("/api/staff/2/terms", { commission_pct: 99 }));
  await refused("a cashier cannot read everyone's shift history", await cashier.get("/api/shifts"));
  await refused("a cashier cannot pull the Z report", await cashier.get("/api/reports/zreport-summary"));
  await refused("a cashier cannot read every day close ever taken", await cashier.get("/api/pos/day-close/history"));
  await refused("a cashier cannot read a customer's whole statement", await cashier.get(`/api/reports/party-statement/${A.party}`));
  await refused("a cashier cannot edit an item", await cashier.put(`/api/items/${A.item}`, { name: "Taken", unit: "PCS" }));
  await refused("a cashier cannot delete an item", await cashier.del(`/api/items/${A.item}`));
  await refused("a cashier cannot write stock up or down by hand", await cashier.post(`/api/items/${A.item}/adjust`, { quantity: 50, direction: "in" }));
  await refused("a cashier cannot start a stock take", await cashier.post("/api/stock-takes", { note: "x" }));
  await refused("a cashier cannot record a supplier bill", await cashier.post("/api/purchases", { party_id: A.party, lines: [] }));
  await refused("a cashier cannot record an expense", await cashier.post("/api/expenses", { amount: 100 }));
  await refused("a cashier cannot edit a customer's record", await cashier.put(`/api/parties/${A.party}`, { name: "Taken" }));
  await refused("a cashier cannot export the item list", await cashier.get("/api/utilities/export-items"));
  await refused("a cashier cannot import over the item list", await cashier.post("/api/utilities/import-items", { rows: [] }));
}
