/**
 * staffsignin.e2e.js — a cashier signing in when the server holds many shops.
 *
 * Session 4.5 moved counter staff into their company's own database, which
 * left one thing designed and not built: `login` and `login-pin` look a
 * username up before any company is known. On a desktop installation there is
 * one company and the question answers itself. On a hosted one it does not,
 * and two shops may each employ a James.
 *
 * This checks the shop code that closes it, and — the part worth the effort —
 * that naming one shop cannot reach into another.
 *
 *   node test/staffsignin.e2e.js http://localhost:4177 /tmp/log
 */
const fs = require("fs");

const BASE = process.argv[2] || "http://localhost:4177";
const LOG = process.argv[3] || "/tmp/s45.log";

let pass = 0, fail = 0;
const ok = (n, c, note = "") => { c ? (pass++, console.log(`  ✓ ${n}${note ? "  " + note : ""}`)) : (fail++, console.log(`  ✗ ${n}  ${note}`)); };
const head = (s) => console.log(`\n── ${s}`);

async function call(method, p, body, token, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, message: json && json.message, data: json && json.data, errors: json && json.errors };
}
const GET = (p, t, h) => call("GET", p, undefined, t, h);
const POST = (p, b, t, h) => call("POST", p, b, t, h);

function codeFor(email) {
  const log = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`email → ${email}\\s*\\n│\\s+(\\d{6}) is your`, "g");
  let m, last = null; while ((m = re.exec(log))) last = m[1];
  return last;
}

const stamp = Date.now().toString(36);
const OWNER = `shops.${stamp}@example.test`;
const PW = "shopkeeper-2026";
const STAFF_PW = "counter-pass-2026";

(async () => {
  head("Two shops, each with a cashier called James");
  await POST("/api/auth/signup", { email: OWNER, password: PW, full_name: "Shop Owner" });
  const v = await POST("/api/auth/verify", { email: OWNER, code: codeFor(OWNER) });
  let s = (await POST("/api/auth/first-company", { ticket: v.data.ticket, name: `Northside ${stamp}` })).data;
  ok("the first shop is created", !!s.token);
  const shops = [{ id: s.firm.id }];
  const second = await POST("/api/companies", { name: `Southside ${stamp}` }, s.token);
  ok("the second shop is created", second.status === 200, second.message);
  shops.push({ id: second.data.id });

  /* Each shop gets a cashier with the SAME username. That is the case a single
     shared `users` table could not express — `username` was unique across the
     whole installation — and it is ordinary: James works at Northside, a
     different James works at Southside. */
  for (let i = 0; i < shops.length; i++) {
    const sw = await POST("/api/companies/switch", { firm_id: shops[i].id }, s.token);
    s = sw.data;
    shops[i].code = (await GET("/api/companies", s.token)).data.companies.find((c) => c.id === shops[i].id).shop_code;
    shops[i].name = (await GET("/api/companies", s.token)).data.companies.find((c) => c.id === shops[i].id).name;
    const roles = await GET("/api/users/roles", s.token);
    const role = (roles.data || []).find((r) => r.name === "Salesman") || (roles.data || [])[0];
    shops[i].adminRole = ((roles.data || []).find((x) => x.name === "Admin") || {}).id;
    let made = await POST("/api/users", {
      username: "james", password: STAFF_PW, full_name: `James at shop ${i + 1}`, role_id: role && role.id,
    }, s.token);
    shops[i].username = "james";
    if (made.status !== 200 && /taken/i.test(made.message || "")) {
      /* Single-file installation: `users.username` is UNIQUE across the whole
         file, so the two shops cannot both employ a James. That is a real
         limitation and it is the honest half of the boundary story — it goes
         away when storage is split, because the two rows are then in two
         files. The rest of the checks still mean something with a different
         name, so the test says which world it is in and carries on. */
      shops[i].username = `james${i + 1}`;
      made = await POST("/api/users", {
        username: shops[i].username, password: STAFF_PW, full_name: `James at shop ${i + 1}`, role_id: role && role.id,
      }, s.token);
      shops[i].sharedNameRefused = true;
    }
    ok(`shop ${i + 1} has a cashier (${shops[i].username})`, made.status === 200, made.message);
  }

  const oneFile = shops.some((x) => x.sharedNameRefused);
  ok(oneFile
      ? "one file: two shops cannot share a username, as expected"
      : "**split storage: two shops each employ a James, and that is fine**",
    true, oneFile ? "usernames are unique across a single-file installation" : "same username, different files");

  ok("**each shop got its own shop code**", !!shops[0].code && !!shops[1].code && shops[0].code !== shops[1].code,
    `${shops[0].code} / ${shops[1].code}`);

  head("Signing in as a cashier");
  let r = await POST("/api/auth/login", { username: shops[0].username, password: STAFF_PW, shop: shops[0].code });
  ok("naming the shop signs the right James in", r.status === 200, r.message);
  const j1 = r.data;
  ok("…into that shop", j1 && j1.firm && j1.firm.id === shops[0].id, j1 && j1.firm && j1.firm.name);
  ok("…and it is that shop's James", j1 && /shop 1/.test(j1.user.full_name || ""), j1 && j1.user.full_name);

  r = await POST("/api/auth/login", { username: shops[1].username, password: STAFF_PW, shop: shops[1].code });
  ok("the other shop code signs the other James in", r.status === 200 && r.data.firm.id === shops[1].id, r.message);
  ok("…and it is the other James", /shop 2/.test(r.data.user.full_name || ""), r.data.user.full_name);
  const j2 = r.data;

  head("Staff cannot reach the other shop");
  /* Deliberately NOT as the Salesman: a cashier is refused `companies.view` by
     permission, so a refusal proves the permission gate and says nothing about
     shops. This one is an administrator of shop 1 — every companies permission
     there is — who simply has no account, and therefore no membership of shop
     2. That is the check that means something. */
  /* Switch back to shop 1 AND keep the new session. The first version threw
     the reply away and went on using shop 2's token, so the manager was
     created in shop 2 with shop 1's role id — which the server refused,
     correctly, and the refusal read like a missing role. */
  s = (await POST("/api/companies/switch", { firm_id: shops[0].id }, s.token)).data;
  const mgr = await POST("/api/users", {
    username: `manager-${stamp}`, password: STAFF_PW, full_name: "Shop 1 Manager", role_id: shops[0].adminRole,
  }, s.token);
  ok("shop 1 has an administrator with no email account", mgr.status === 200, mgr.message);
  const m = (await POST("/api/auth/login",
    { username: `manager-${stamp}`, password: STAFF_PW, shop: shops[0].code })).data;
  ok("…who can sign in", !!(m && m.token));
  r = await GET("/api/companies", m && m.token);
  ok("…and does hold the companies permission", r.status === 200, `${r.status} ${r.message || ""}`);
  ok("**…yet sees only the shop they work in**", r.status === 200 && (r.data.companies || []).length === 1,
    `${r.status === 200 ? (r.data.companies || []).length : r.status} compan(y/ies)`);
  r = await POST("/api/companies/switch", { firm_id: shops[1].id }, m && m.token);
  ok("**…and cannot switch into the other shop**", r.status !== 200, `${r.status} ${r.message}`);
  r = await GET("/api/items", j1.token);
  ok("a cashier's session reads their own shop's stock", r.status === 200, r.message);

  head("Getting the shop wrong");
  r = await POST("/api/auth/login", { username: shops[0].username, password: STAFF_PW });
  ok("no shop at all is refused, and says so", r.status === 400 && /which shop/i.test(r.message || ""), r.message);
  ok("…and tells the screen to ask for one", !!(r.errors && r.errors.needs_shop));

  r = await POST("/api/auth/login", { username: shops[0].username, password: STAFF_PW, shop: `no-such-shop-${stamp}` });
  ok("**an unknown shop code answers exactly like a wrong password**", r.status === 401, r.message);
  const wrongPw = await POST("/api/auth/login", { username: shops[0].username, password: "not-the-password", shop: shops[0].code });
  ok("…the same sentence, so it cannot be used to find out which shops exist",
    r.message === wrongPw.message, `"${r.message}" vs "${wrongPw.message}"`);

  head("The sign-in screen");
  r = await GET("/api/auth/signin-options");
  ok("with several shops it asks for a code", r.data && r.data.needs_shop === true, JSON.stringify(r.data && r.data.firm));
  r = await GET(`/api/auth/signin-options?shop=${shops[0].code}`);
  ok("with a code it names that shop", r.data && r.data.firm === shops[0].name, r.data && r.data.firm);
  r = await GET(`/api/auth/signin-options?shop=nope-${stamp}`);
  ok("a mistyped code says so plainly rather than pretending", r.data && r.data.unknown_shop === true);
  r = await GET("/api/auth/signin-options", null, { "X-Shop-Code": shops[1].code });
  ok("a header works too, for an app that is set up once", r.data && r.data.firm === shops[1].name, r.data && r.data.firm);

  head("Changing a shop code");
  const want = `renamed-${stamp}`;
  r = await POST("/api/companies/switch", { firm_id: shops[0].id }, s.token);
  s = r.data;
  const put = await call("PUT", `/api/companies/${shops[0].id}`, { shop_code: want }, s.token);
  ok("the owner can change it", put.status === 200, put.message);
  r = await GET(`/api/auth/signin-options?shop=${want}`);
  ok("…and the new one works", r.data && r.data.firm === shops[0].name);
  const clash = await call("PUT", `/api/companies/${shops[1].id}`, { shop_code: want }, s.token);
  ok("**two shops cannot share a code**", clash.status === 400, clash.message);
  const bad = await call("PUT", `/api/companies/${shops[1].id}`, { shop_code: "no spaces!" }, s.token);
  ok("…and it has to be typable", bad.status === 400, bad.message);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
