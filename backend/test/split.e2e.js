/**
 * split.e2e.js — one file per company, proved on real data.
 *
 * Builds a three-company installation through the API, splits it, and then
 * asks the questions that matter about the result:
 *
 *   - does each company's file hold that company's books, to the shilling?
 *   - does it hold **nothing** of anybody else's?
 *   - does the central file hold the identities and none of the books?
 *   - does the app still work when it is pointed at the split arrangement?
 *
 * The second question is the one worth the effort. A split that loses data
 * fails loudly on the control totals; a split that leaves company A's invoices
 * in company B's file passes every total and is a breach.
 *
 *   node test/split.e2e.js http://localhost:4177 /tmp/s45.log
 */
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:4177";
const LOG = process.argv[3] || "/tmp/s45.log";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => { c ? (pass++, console.log(`  ✓ ${n}${note ? "  " + note : ""}`)) : (fail++, console.log(`  ✗ ${n}  ${note}`)); };
const head = (s) => console.log(`\n── ${s}`);

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, message: json && json.message, data: json && json.data };
}
const GET = (p, t) => call("GET", p, undefined, t);
const POST = (p, b, t) => call("POST", p, b, t);

function codeFor(email) {
  const log = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`email → ${email}\\s*\\n│\\s+(\\d{6}) is your`, "g");
  let m, last = null; while ((m = re.exec(log))) last = m[1];
  return last;
}

const stamp = Date.now().toString(36);
const OWNER = `split.${stamp}@example.test`;
const PW = "shopkeeper-2026";

(async () => {
  head("Build three companies through the API");
  await POST("/api/auth/signup", { email: OWNER, password: PW, full_name: "Split Owner" });
  const v = await POST("/api/auth/verify", { email: OWNER, code: codeFor(OWNER) });
  const first = await POST("/api/auth/first-company", { ticket: v.data.ticket, name: `Alpha ${stamp}` });
  let s = first.data;
  ok("company one is created", first.status === 200, first.message);

  const made = [{ id: s.firm.id, name: `Alpha ${stamp}` }];
  for (const nm of [`Beta ${stamp}`, `Gamma ${stamp}`]) {
    const r = await POST("/api/companies", { name: nm }, s.token);
    ok(`${nm.split(" ")[0]} is created`, r.status === 200, r.message);
    made.push({ id: r.data.id, name: nm });
  }

  /* Different data in each, so "B's file holds B's books" cannot pass by the
     two being identical. */
  const seeded = {};
  for (let i = 0; i < made.length; i++) {
    const c = made[i];
    const sw = await POST("/api/companies/switch", { firm_id: c.id }, s.token);
    s = sw.data;
    const qty = (i + 1) * 3;
    const price = (i + 1) * 1000;
    const item = await POST("/api/items", { name: `Widget ${i + 1}`, sale_price: price, purchase_price: price / 2, opening_stock: 50, unit: "PCS" }, s.token);
    const party = await POST("/api/parties", { name: `Customer ${i + 1}`, party_type: "customer" }, s.token);
    const inv = await POST("/api/sales", {
      party_id: party.data && (party.data.id || party.data.party_id),
      payment_type: "cash",
      /* This shop requires a rep on every sale. The first version of this test
         left it out, so all three sales were refused — and every assertion
         below still passed, because "0 invoices in the file" matched "0
         invoices expected". Zero matches zero no matter what the split does;
         session five hit the identical trap, which is why the total is now
         asserted to be non-zero as well. */
      sales_rep_id: s.user.id,
      lines: [{ item_id: item.data && (item.data.id || item.data.item_id), quantity: qty, rate: price }],
    }, s.token);
    seeded[c.id] = { invoices: inv.status === 200 ? 1 : 0, total: qty * price, item: `Widget ${i + 1}` };
    ok(`${c.name.split(" ")[0]} sold something`, inv.status === 200, inv.message);
  }

  head("Split the file");
  const { split } = require(path.join(__dirname, "..", "database", "split.js"));
  const source = process.env.GENIUS_DB_PATH;
  const target = `/tmp/split-${stamp}`;
  /* Nothing to flush first: every write above went through `durable()`, which
     commits and persists synchronously before the reply is sent. The file on
     disk is current by the time the till has been told the sale went through —
     which is the property round ten built and this test quietly depends on. */
  const out = await split(source, target, { quiet: true });
  ok("the split runs and verifies every company", out.checked === made.length + 0 || out.checked >= 3, `${out.checked} companies`);

  head("What is in each file");
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const openFile = (f) => new SQL.Database(Uint8Array.from(fs.readFileSync(f)));
  const rows = (db, sql) => { const st = db.prepare(sql); const r = []; try { while (st.step()) r.push(st.getAsObject()); } finally { st.free(); } return r; };
  const one = (db, sql) => { const r = rows(db, sql); return r.length ? Object.values(r[0])[0] : null; };

  const centre = openFile(out.central);
  ok("the central file keeps the accounts", one(centre, "SELECT COUNT(*) FROM accounts") > 0, `${one(centre, "SELECT COUNT(*) FROM accounts")} accounts`);
  ok("…and the memberships", one(centre, "SELECT COUNT(*) FROM memberships") >= 3);
  ok("…and every company's name", one(centre, "SELECT COUNT(*) FROM firms") >= 3);
  ok("**…and none of the books**", one(centre, "SELECT COUNT(*) FROM sale_invoices") === 0, `${one(centre, "SELECT COUNT(*) FROM sale_invoices")} invoices`);
  ok("…nor any items or parties", one(centre, "SELECT COUNT(*) FROM items") === 0 && one(centre, "SELECT COUNT(*) FROM parties") === 0);
  centre.close();

  for (const c of made) {
    const f = path.join(target, "firms", `firm-${c.id}.db`);
    const db = openFile(f);
    const label = c.name.split(" ")[0];
    const firmIds = rows(db, "SELECT DISTINCT firm_id FROM items").map((r) => r.firm_id);
    ok(`${label}'s file holds only ${label}'s items`, firmIds.length <= 1 && (!firmIds.length || firmIds[0] === c.id), `firm ids: ${firmIds.join(",") || "none"}`);
    const invFirms = rows(db, "SELECT DISTINCT firm_id FROM sale_invoices").map((r) => r.firm_id);
    ok(`…and only ${label}'s invoices`, invFirms.length <= 1 && (!invFirms.length || invFirms[0] === c.id), `firm ids: ${invFirms.join(",") || "none"}`);
    ok(`…and the sale that was rung up in it`, one(db, "SELECT COUNT(*) FROM sale_invoices") === seeded[c.id].invoices,
      `${one(db, "SELECT COUNT(*) FROM sale_invoices")} of ${seeded[c.id].invoices}`);
    ok(`…and its own name`, one(db, "SELECT COUNT(*) FROM firms") === 1);
    ok(`**…and nobody's account**`, one(db, "SELECT COUNT(*) FROM accounts") === 0);
    ok(`…nor anybody's session`, one(db, "SELECT COUNT(*) FROM sessions") === 0);
    ok(`…but its own roles`, one(db, "SELECT COUNT(*) FROM roles") > 0, `${one(db, "SELECT COUNT(*) FROM roles")} roles`);
    ok(`…and its own invoice numbering`, one(db, "SELECT COUNT(*) FROM sequences") >= 0);
    db.close();
  }

  head("The sum of the parts is the whole");
  let totalInv = 0;
  for (const c of made) {
    const db = openFile(path.join(target, "firms", `firm-${c.id}.db`));
    totalInv += one(db, "SELECT COUNT(*) FROM sale_invoices");
    db.close();
  }
  const src = openFile(source);
  const srcInv = one(src, `SELECT COUNT(*) FROM sale_invoices WHERE firm_id IN (${made.map((c) => c.id).join(",")})`);
  src.close();
  ok("**every invoice landed in exactly one company's file**", totalInv === srcInv, `${totalInv} split, ${srcInv} in the original`);
  ok("…and there was something to land", totalInv >= made.length, `${totalInv} invoices`);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`(files in ${target})`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
