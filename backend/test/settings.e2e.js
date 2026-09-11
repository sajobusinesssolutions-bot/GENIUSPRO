/**
 * settings.e2e.js — the settings that used to do nothing.
 *
 * Session 3 found 25 switches on the Settings page that no code anywhere read.
 * A switch that does nothing is worse than a missing one, because the shop
 * believes it. Five were shortlisted for building; these are the two whose
 * effect lives on the server and can be proved through the API — the other
 * three change what a form shows and are checked in the browser instead.
 *
 *   node test/settings.e2e.js http://localhost:4177
 */
const BASE = process.argv[2] || "http://localhost:4177";
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
const set = (k, v) => PUT("/api/settings", { [k]: v });

(async () => {
  const login = await POST("/api/auth/login", { username: "admin", password: "admin123" });
  TOKEN = login.data && login.data.token;
  if (!TOKEN) {
    /* Staff sign-in names its shop, and an installation holding several
       companies cannot guess which. That happens when this suite is pointed
       at a database an earlier suite has already added companies to — so it
       says which mistake was made rather than dying on `undefined.user`.
       Every API suite wants its own copy; see the README. */
    console.log(`  ✗ signed in  ${login.message}`);
    console.log(`\n  This suite needs a database with one company in it. Give it a fresh copy:`);
    console.log(`    cp backend/data/genius.db /tmp/settings.db  &&  GENIUS_DB_PATH=/tmp/settings.db … node backend/server.js\n`);
    process.exit(1);
  }
  ok("signed in", !!TOKEN, login.message);
  const me = login.data.user.id;

  head("Low stock alerts");
  /* An item that is definitely running out, so "no alerts" cannot pass by
     there being nothing to alert about. */
  const item = await POST("/api/items", {
    name: `Alert probe ${Date.now().toString(36)}`, sale_price: 1000, purchase_price: 500,
    /* Plenty of stock, and a reorder level far above it: the item is
       genuinely "running out" by the shop's own rule, and the two sales
       below still have something to sell. An earlier version opened with
       one unit and the second sale was refused for negative stock — the
       check that mattered never ran. */
    unit: "PCS", opening_stock: 500, reorder_level: 5000,
  });
  ok("an item below its reorder level exists", item.status === 200, item.message);

  await set("low_stock_alert", "1");
  let ov = await GET("/api/items/overview");
  const onCount = ov.data && ov.data.lowStock.count;
  ok("with alerts on, Items reports it", onCount > 0, `${onCount} running out`);
  let dash = await GET("/api/dashboard");
  ok("…and so does the dashboard", (dash.data.lowStock || []).length > 0, `${(dash.data.lowStock || []).length} listed`);

  await set("low_stock_alert", "0");
  ov = await GET("/api/items/overview");
  ok("**with alerts off, Items goes quiet**", ov.data.lowStock.count === 0, `${ov.data.lowStock.count} running out`);
  dash = await GET("/api/dashboard");
  ok("**…and so does the dashboard**", (dash.data.lowStock || []).length === 0, `${(dash.data.lowStock || []).length} listed`);
  ok("…and the stock itself is untouched", onCount > 0, "the item is still below its level; only the alarm is off");
  await set("low_stock_alert", "1");

  head("Prices that already include tax");
  /* The shipped chain deducts, so this needs an add-mode rule to mean
     anything — which is exactly what the setting's label now says. */
  const rules = await GET("/api/settings/tax-rules");
  const before = (rules.data || []).map((r) => ({ id: r.id, is_active: r.is_active }));
  for (const r of before) await PUT(`/api/settings/tax-rules/${r.id}`, { is_active: 0 });
  const vat = await POST("/api/settings/tax-rules", { name: "VAT-probe", rate: 18, mode: "add", apply_order: 1, is_active: 1 });
  ok("an add-mode VAT rule is in place", vat.status === 200, vat.message);

  const party = (await GET("/api/parties")).data[0];
  const sell = async () => POST("/api/sales", {
    party_id: party.id, payment_type: "cash", sales_rep_id: me,
    lines: [{ item_id: item.data.id || item.data.item_id, quantity: 1, rate: 11800 }],
  });

  await set("tax_inclusive_default", "0");
  await set("round_off", "0");
  const exclusive = await sell();
  ok("exclusive: the tax is added on top", exclusive.status === 200, exclusive.message);
  const ex = await GET(`/api/sales/${exclusive.data.id}`);
  ok("…so 11,800 becomes 13,924", Number(ex.data.grand_total) === 13924, `grand ${ex.data.grand_total}`);

  await set("tax_inclusive_default", "1");
  const inclusive = await sell();
  ok("inclusive: the sale saves", inclusive.status === 200, inclusive.message);
  const inc = await GET(`/api/sales/${inclusive.data.id}`);
  ok("**…and the customer pays the shelf price**", Number(inc.data.grand_total) === 11800, `grand ${inc.data.grand_total}`);
  ok("…with the tax taken out of it, not added to it", Number(inc.data.sub_total) === 10000, `sub ${inc.data.sub_total}`);
  const line = (inc.data.lines || [])[0];
  ok("**…and the line agrees with the invoice**", line && Number(line.taxable_value) === 10000,
    line ? `line ${line.taxable_value}` : "no lines");

  /* Put the shop back as it was. A test that leaves a firm's tax rules
     rewritten is a test nobody dares run twice. */
  await PUT(`/api/settings/tax-rules/${vat.data.id}`, { is_active: 0 });
  for (const r of before) await PUT(`/api/settings/tax-rules/${r.id}`, { is_active: r.is_active });
  await set("tax_inclusive_default", "0");
  await set("round_off", "1");

  head("Batches");
  const bill = await POST("/api/purchases", {
    party_id: (await GET("/api/parties")).data.find((p) => p.party_type !== "customer")?.id || party.id,
    bill_no: `B-${Date.now().toString(36)}`, payment_type: "credit", sales_rep_id: me,
    lines: [{ item_id: item.data.id || item.data.item_id, quantity: 5, rate: 400, batch_no: "LOT-9", expiry_date: "2030-01-01" }],
  });
  ok("a purchase can name a batch and an expiry", bill.status === 200, bill.message);
  /* The item's own stock ledger, which is where a batch becomes visible: the
     item record carries no batches because `item_stock` holds one row per
     batch, not per item. */
  const ledger = await GET(`/api/items/${item.data.id || item.data.item_id}/ledger`);
  const rows = (ledger.data && (ledger.data.rows || ledger.data)) || [];
  const inBatch = (Array.isArray(rows) ? rows : []).filter((r) => r.batch_no === "LOT-9");
  ok("**…and the stock lands in that batch**", inBatch.length > 0,
    inBatch.length ? `${inBatch[0].quantity} in LOT-9` : `no LOT-9 among ${Array.isArray(rows) ? rows.length : 0} movements`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
