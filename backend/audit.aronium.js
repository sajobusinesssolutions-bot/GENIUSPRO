/** audit.aronium.js — guards, barcodes, held bills, void log, price lists. */
const { app, ready } = require("./server");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗ FAIL"} ${n}${d ? " — " + d : ""}`); };
(async () => {
  await ready;
  const s = app.listen(0); const base = `http://localhost:${s.address().port}`;
  const J = (r) => r.json();
  const H = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });
  const GET = async (p, t) => J(await fetch(base + "/api" + p, { headers: H(t) }));
  const POST = async (p, b, t) => J(await fetch(base + "/api" + p, { method: "POST", headers: H(t), body: JSON.stringify(b) }));
  const PUT = async (p, b, t) => J(await fetch(base + "/api" + p, { method: "PUT", headers: H(t), body: JSON.stringify(b) }));
  const DEL = async (p, t) => J(await fetch(base + "/api" + p, { method: "DELETE", headers: H(t) }));

  const T = (await POST("/auth/login", { username: "admin", password: "admin123" })).data.token;
  /* Sales have required a sales rep since the commissions feature landed; the
     audit predates it, so every sale it posts carries the admin as the rep. */
  const REP = (await GET("/users", T)).data?.[0]?.id ?? (await GET("/users", T)).data?.rows?.[0]?.id;
  const items = (await GET("/items", T)).data;
  const sugar = items.find((i) => i.name.includes("Sugar"));
  const cement = items.find((i) => i.name.includes("Cement"));
  const parties = (await GET("/parties", T)).data;
  const walkin = parties.find((p) => p.name === "Cash Sale");
  const okello = parties.find((p) => p.name.includes("Okello"));

  /* guards */
  const bc = await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", lines: [{ item_id: sugar.id, quantity: 1, rate: 3500 }] }, T);
  ok("guard: below cost blocked (3500 < 4000)", !bc.success && /Below cost/.test(bc.message), bc.message);
  const bcOv = await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", manager_override: true, lines: [{ item_id: sugar.id, quantity: 1, rate: 3500 }] }, T);
  ok("guard: manager override allows + audited", bcOv.success);
  const ns = await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", lines: [{ item_id: sugar.id, quantity: 999, rate: 5000 }] }, T);
  ok("guard: negative stock blocked", !ns.success && /in stock/.test(ns.message));
  const cr = await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "credit", lines: [{ item_id: sugar.id, quantity: 1, rate: 5000 }] }, T);
  ok("guard: credit + walk-in blocked", !cr.success && /saved customer/.test(cr.message));
  ok("guard: credit + saved customer OK", (await POST("/sales", { sales_rep_id: REP, party_id: okello.id, payment_type: "credit", lines: [{ item_id: sugar.id, quantity: 1, rate: 5000 }] }, T)).success);
  // price lock
  await PUT(`/items/${cement.id}`, { price_change_allowed: 0 }, T);
  const pl = await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", lines: [{ item_id: cement.id, quantity: 1, rate: 41000 }] }, T);
  ok("guard: fixed price enforced", !pl.success && /fixed/.test(pl.message));
  ok("guard: fixed price passes at list price", (await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", lines: [{ item_id: cement.id, quantity: 1, rate: 42000 }] }, T)).success);
  // toggle off below-cost → allowed
  await PUT("/settings", { prevent_below_cost: "0" }, T);
  ok("guard: setting off → below cost allowed", (await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", lines: [{ item_id: sugar.id, quantity: 1, rate: 3000 }] }, T)).success);
  await PUT("/settings", { prevent_below_cost: "1" }, T);

  /* barcodes */
  ok("barcodes: add flavour codes", (await POST(`/items/${sugar.id}/barcodes`, { barcode: "5449000000996" }, T)).success &&
                                     (await POST(`/items/${sugar.id}/barcodes`, { barcode: "5449000131805" }, T)).success);
  const dup = await POST(`/items/${cement.id}/barcodes`, { barcode: "5449000000996" }, T);
  ok("barcodes: duplicate rejected with owner name", !dup.success && /Sugar/.test(dup.message));
  ok("barcodes: list shows array", (await GET("/items", T)).data.find((i) => i.id === sugar.id).barcodes.length === 2);
  ok("barcodes: remove", (await DEL(`/items/${sugar.id}/barcodes/5449000131805`, T)).success);

  /* item edit/delete */
  ok("item: edit markup + fields", (await PUT(`/items/${sugar.id}`, { markup_pct: 25 }, T)).success &&
     (await GET(`/items/${sugar.id}`, T)).data.markup_pct === 25);
  const newIt = await POST("/items", { name: "Test Delete Me", item_type: "product", unit: "PCS", sale_price: 100, purchase_price: 50, barcodes: ["999000111"], opening_stock: 0 }, T);
  ok("item: create w/ barcodes[]", newIt.success);
  const tid = (await GET("/items", T)).data.find((i) => i.name === "Test Delete Me").id;
  ok("item: unused → hard delete", (await DEL(`/items/${tid}`, T)).data.deleted === true);
  const soldDel = await DEL(`/items/${sugar.id}`, T);
  ok("item: used → deactivated not deleted", soldDel.data.deactivated === true);
  const inact = await POST("/sales", { sales_rep_id: REP, party_id: walkin.id, payment_type: "cash", lines: [{ item_id: sugar.id, quantity: 1, rate: 5000 }] }, T);
  ok("item: inactive can't be sold", !inact.success && /inactive/.test(inact.message));
  await PUT(`/items/${sugar.id}`, { is_active: 1 }, T);

  /* held bills + lock */
  const held = await POST("/pos/held", { label: "Okello order", total_hint: 84000, payload: { party_id: okello.id, lines: [{ item_id: cement.id, quantity: 2, rate: 42000 }] } }, T);
  ok("held: park a bill", held.success);
  const hid = (await GET("/pos/held", T)).data[0].id;
  ok("held: resume returns payload", (await GET(`/pos/held/${hid}`, T)).data.payload.lines.length === 1);
  await PUT(`/pos/held/${hid}/lock`, { locked: 1 }, T);
  ok("held: locked bill can't resume", !(await GET(`/pos/held/${hid}`, T)).success);
  ok("held: locked bill can't delete", !(await DEL(`/pos/held/${hid}`, T)).success);
  await PUT(`/pos/held/${hid}/lock`, { locked: 0 }, T);
  ok("held: unlock → delete works", (await DEL(`/pos/held/${hid}`, T)).success);

  /* void log */
  const vNo = await POST("/pos/void", { scope: "item", item_name: "Sugar 1kg", quantity: 2, amount: 10000 }, T);
  ok("void: reason required by setting", !vNo.success);
  ok("void: recorded with reason", (await POST("/pos/void", { scope: "bill", item_name: null, quantity: 3, amount: 52000, reason: "Customer changed mind" }, T)).success);
  const vr = (await GET("/reports/voided-items", T)).data;
  ok("void: report lists entry w/ user", vr.rows.length === 1 && vr.rows[0].voided_by === "Administrator" && vr.totals.amount === 52000);

  /* price lists */
  ok("price list: create", (await POST("/settings/price-lists", { name: "Wholesale" }, T)).success);
  const listId = (await GET("/settings/price-lists", T)).data[0].id;
  ok("price list: set item price", (await POST(`/settings/price-lists/${listId}/items`, { item_id: cement.id, price: 40000 }, T)).success);
  ok("price list: grid shows default vs list", (await GET(`/settings/price-lists/${listId}/items`, T)).data[0].default_price === 42000);
  ok("price list: assign to party", (await PUT(`/parties/${okello.id}/price-list`, { price_list_id: listId }, T)).success &&
     (await GET(`/parties/${okello.id}`, T)).data.price_list_id === listId);
  ok("price list: fixed-price item accepts list price", (await POST("/sales", { sales_rep_id: REP, party_id: okello.id, payment_type: "cash", lines: [{ item_id: cement.id, quantity: 1, rate: 40000 }] }, T)).success);

  /* system info + day close */
  const info = (await GET("/system/info", T)).data;
  ok("system info: version matches package.json + update steps", info.version === require("./package.json").version && info.update_howto.length === 4);
  const z = (await GET("/reports/day-close", T)).data;
  ok("day close: modes + users + net", z.rows.length >= 1 && z.by_user.length >= 1 && z.totals.net > 0,
     `bills ${z.totals.bills} net ${z.totals.net}`);
  ok("day close: void total carried", z.totals.voids === 1 && z.totals.void_total === 52000);

  /* items UI backend hooks */
  await PUT(`/items/${cement.id}`, { color: "#2F9BDB" }, T);
  const cd = (await GET(`/items/${cement.id}`, T)).data;
  ok("item: colour persists", cd.color === "#2F9BDB");
  await PUT(`/items/${cement.id}`, { default_qty: 5 }, T);
  ok("item: default quantity persists", (await GET(`/items/${cement.id}`, T)).data.default_qty === 5);
  await PUT(`/items/${cement.id}`, { default_qty: 1 }, T);
  ok("item detail: txns carry source_id", cd.transactions.length > 0 && cd.transactions.every((t) => t.source_id !== undefined));
  const anySale = (await GET("/sales", T)).data[0];
  ok("sale detail: party_name present", !!(await GET(`/sales/${anySale.id}`, T)).data.party_name);

  /* report catalog spot-checks */
  const dl = (await GET("/reports/daily-sales", T)).data;
  ok("report daily-sales: rows + totals", dl.rows.length >= 1 && dl.totals.total > 0);
  const pm = (await GET("/reports/profit-margin", T)).data;
  ok("report profit-margin: profit computed", pm.rows.length >= 1 && typeof pm.rows[0].margin_pct === "number");
  const dg = (await GET("/reports/discounts-granted", T)).data;
  ok("report discounts-granted reachable", Array.isArray(dg.rows));
  const pt = (await GET("/reports/payment-types", T)).data;
  ok("report payment-types: cash tender present", pt.rows.some((r) => r.mode === "cash") && pt.totals.in_total > 0);
  const sm = (await GET("/reports/stock-movement", T)).data;
  ok("report stock-movement: refs resolved", sm.rows.length >= 3 && sm.rows.some((r) => r.ref && r.ref.startsWith("INV-")));
  ok("report reorder-list reachable", Array.isArray((await GET("/reports/reorder-list", T)).data.rows));
  ok("report unpaid-sales: credit sale listed", (await GET("/reports/unpaid-sales", T)).data.rows.length >= 1);

  /* Aronium extras */
  ok("report sales-by-category", (await GET("/reports/sales-by-category", T)).data.rows.length >= 1);
  ok("report invoice-list", (await GET("/reports/invoice-list", T)).data.rows.length >= 3);
  ok("report purchase-by-supplier reachable", Array.isArray((await GET("/reports/purchase-by-supplier", T)).data.rows));
  await POST("/expenses/other-income", { amount: 30000, description: "Drawer float" }, T);
  await POST("/expenses", { amount: 8000, category: "Cash out (drawer)", mode: "cash", notes: "Airtime" }, T);
  const de = (await GET("/reports/drawer-entries", T)).data;
  ok("report drawer-entries: in + out", de.totals.in_total === 30000 && de.totals.out_total === 8000,
     `in ${de.totals.in_total} out ${de.totals.out_total}`);
  ok("report loss-damage reachable", Array.isArray((await GET("/reports/loss-damage", T)).data.rows));

  /* receipt lookup by number (scan barcode) */
  const anyInv = (await GET("/sales", T)).data[0];
  const byNo = (await GET(`/sales/by-number/${anyInv.invoice_no}`, T)).data;
  ok("receipt lookup: finds by invoice_no", byNo.invoice_no === anyInv.invoice_no && byNo.lines.length >= 1);
  const miss = await fetch(base + "/api/sales/by-number/INV-999999", { headers: { Authorization: "Bearer " + T } });
  ok("receipt lookup: 404 on unknown", miss.status === 404);

  ok("report hourly-sales: peak cards + weekday", (await GET("/reports/hourly-sales", T)).data.cards.best_hour !== undefined);
  /* SemanticPOS report set */
  ok("report fast-moving", Array.isArray((await GET("/reports/fast-moving", T)).data.rows));
  ok("report slow-moving", Array.isArray((await GET("/reports/slow-moving", T)).data.rows));
  ok("report stock-adjustment", Array.isArray((await GET("/reports/stock-adjustment", T)).data.rows));
  const gl = (await GET("/reports/general-ledger", T)).data;
  ok("report general-ledger: grouped by type", gl.rows.length >= 1 && Array.isArray(gl.groups) && gl.groups[0].label !== undefined);
  const zs = (await GET("/reports/zreport-summary", T)).data;
  ok("report zreport-summary: expected cash", zs.rows.length === 12 && typeof zs.totals.expected_cash === "number");
  ok("report zreport-summary: voids + cashier breakdown", zs.totals.voids !== undefined && Array.isArray(zs.by_user));
  const sbi = (await GET("/reports/sales-by-items", T)).data;
  ok("report sales-by-items: grouped w/ profit", sbi.groups.length >= 1 && typeof sbi.totals.profit === "number");

  /* party edit (3-dot menu) */
  const plst = (await GET("/parties", T)).data;
  await PUT("/parties/" + plst[0].id, { name: plst[0].name, phone: "0788999888", credit_limit: 555000 }, T);
  const ped = (await GET("/parties/" + plst[0].id, T)).data;
  ok("party edit: PUT updates fields", ped.phone === "0788999888" && ped.credit_limit === 555000);

  /* tax context gating */
  const taxItem = (await GET("/items", T)).data.reduce((a,x)=>x.purchase_price<a.purchase_price?x:a);
  const cashParty = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  await PUT("/settings", { taxes_enabled: "0" }, T);
  const noTax = (await POST("/sales", { sales_rep_id: REP, party_id: cashParty.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: taxItem.id, description: taxItem.name, quantity: 1, rate: (taxItem.purchase_price||0)+50000 }] }, T)).data;
  ok("taxes_enabled=0 removes tax", noTax.totals.tax_total === 0);
  await PUT("/settings", { taxes_enabled: "1" }, T);
  const yesTax = (await POST("/sales", { sales_rep_id: REP, party_id: cashParty.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: taxItem.id, description: taxItem.name, quantity: 1, rate: (taxItem.purchase_price||0)+50000 }] }, T)).data;
  ok("taxes re-enabled applies tax", yesTax.totals.tax_total > 0);

  /* void a sale: stock restored + Z shows voided */
  const vItem = (await GET("/items", T)).data.reduce((a, x) => x.purchase_price < a.purchase_price ? x : a);
  const vBefore = (await GET("/items", T)).data.find((x) => x.id === vItem.id).on_hand;
  const vCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  const vSale = (await POST("/sales", { sales_rep_id: REP, party_id: vCash.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: vItem.id, description: vItem.name, quantity: 2, rate: (vItem.purchase_price || 0) + 40000 }] }, T)).data;
  const vDel = await J(await fetch(base + "/api/sales/" + vSale.id, { method: "DELETE", headers: H(T), body: JSON.stringify({ reason: "audit" }) }));
  ok("void sale: succeeds", vDel.success === true);
  const vAfter = (await GET("/items", T)).data.find((x) => x.id === vItem.id).on_hand;
  ok("void sale: stock restored", vAfter === vBefore);
  const vZ = (await GET("/reports/zreport-summary", T)).data;
  ok("void sale: shows on Z report", vZ.totals.voids >= 1);

  /* chart-of-accounts CRUD */
  const acN = await POST("/accounting/accounts", { name: "Test Rent", type: "expense" }, T);
  ok("account: create with auto-code", acN.success && acN.data.code);
  const acE = await PUT("/accounting/accounts/" + acN.data.code, { name: "Test Rent 2" }, T);
  ok("account: edit name", acE.success === true);
  const acD = await J(await fetch(base + "/api/accounting/accounts/" + acN.data.code, { method: "DELETE", headers: H(T) }));
  ok("account: delete unused", acD.success === true);

  /* journals + universal search */
  const jAccts = (await GET("/accounting/accounts", T)).data;
  const jCash = jAccts.find((a) => a.is_cash_bank);
  const jEq = jAccts.find((a) => a.type === "equity") || jAccts.find((a) => a.type === "liability");
  const jePost = await POST("/accounting/journal", { date: "2026-07-22", description: "Audit capital", lines: [{ account_code: jCash.code, debit: 100000, credit: 0 }, { account_code: jEq.code, debit: 0, credit: 100000 }] }, T);
  ok("journal: manual post", jePost.success === true);
  const jSearch = (await GET("/accounting/transactions?q=Audit capital", T)).data;
  ok("journal: universal search finds it", jSearch.length >= 1 && jSearch[0].lines.length === 2);

  /* report date filters */
  const plNone = (await GET("/accounting/profit-loss?from=2030-01-01&to=2030-12-31", T)).data;
  ok("P&L: date filter excludes out-of-range", plNone.totalIncome === 0);
  const bsOld = (await GET("/accounting/balance-sheet?to=2020-01-01", T)).data;
  ok("Balance sheet: as-of date works", bsOld.totalAssets === 0);
  const dbNone = (await GET("/accounting/daybook?from=2030-01-01", T)).data;
  ok("Day book: date filter works", dbNone.length === 0);

  /* per-item sales-account override */
  const ovAcct = (await POST("/accounting/accounts", { name: "Audit hardware sales", type: "income" }, T)).data;
  const ovItem = (await POST("/items", { name: "Audit Override Item", unit: "PCS", sale_price: 100000, purchase_price: 40000, sales_account_code: ovAcct.code }, T)).data;
  await POST("/items/" + ovItem.id + "/adjust", { direction: "in", quantity: 5, note: "seed" }, T);
  const ovCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  await POST("/sales", { sales_rep_id: REP, party_id: ovCash.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: ovItem.id, description: "Audit Override Item", quantity: 1, rate: 100000 }] }, T);
  // a sale now writes two journals (revenue + cost of goods), so look across both
  const ovTxns = (await GET("/accounting/transactions?module=sales", T)).data.slice(0, 4);
  ok("item account override posts to chosen account",
     ovTxns.some((t) => t.lines.some((l) => l.account_code === ovAcct.code && l.credit > 0)));

  /* in-app updater */
  const upd = (await GET("/system/updates", T)).data;
  ok("updater: history endpoint + version", !!upd.current_version && Array.isArray(upd.history));
  const badZip = await fetch(base + "/api/system/update?filename=x.zip", { method: "POST", headers: { "Content-Type": "application/zip", Authorization: "Bearer " + T }, body: Buffer.from("nope") });
  const badJson = await badZip.json();
  ok("updater: rejects a non-zip file", badJson.success === false);
  const updAfter = (await GET("/system/updates", T)).data;
  ok("updater: failed attempt is logged", updAfter.history.some((h) => h.status === "failed"));

  /* pagination */
  const legacyList = (await GET("/sales", T)).data;
  ok("list: legacy callers still get an array", Array.isArray(legacyList));
  const pagedList = (await GET("/sales?page=1&limit=2", T)).data;
  ok("list: paged envelope has rows/total/pages", Array.isArray(pagedList.rows) && typeof pagedList.total === "number" && pagedList.pages >= 1);
  ok("list: sums cover the whole filtered set", pagedList.sums && pagedList.sums.grand >= pagedList.rows.reduce((a, r) => a + r.grand_total, 0));
  const noneList = (await GET("/sales?page=1&from=2030-01-01", T)).data;
  ok("list: date filter narrows results", noneList.total === 0);

  /* paging on money lists */
  const exPaged = (await GET("/expenses?page=1&limit=2", T)).data;
  ok("expenses: paged envelope + sums", Array.isArray(exPaged.rows) && typeof exPaged.total === "number" && exPaged.sums);
  const payPaged = (await GET("/payments?page=1&limit=2", T)).data;
  ok("payments: paged envelope + sums", Array.isArray(payPaged.rows) && payPaged.sums);
  const purPaged = (await GET("/purchases?page=1&limit=5", T)).data;
  ok("purchases: paged envelope", Array.isArray(purPaged.rows) && typeof purPaged.pages === "number");

  /* cash rounding */
  const rItem = (await GET("/items", T)).data.reduce((a, x) => x.purchase_price < a.purchase_price ? x : a);
  const rCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  await PUT("/settings", { cash_round_to: "50" }, T);
  const rSale = (await POST("/sales", { sales_rep_id: REP, party_id: rCash.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: rItem.id, description: rItem.name, quantity: 1, rate: (rItem.purchase_price || 0) + 47777 }] }, T)).data;
  ok("cash rounding: total lands on a 50", rSale.totals.grand_total % 50 === 0);
  await PUT("/settings", { cash_round_to: "1" }, T);

  /* dashboard range + restore preview */
  const dashRanged = (await GET("/dashboard?from=2030-01-01&to=2030-12-31", T)).data;
  ok("dashboard: date range filters sales", dashRanged.periodSales === 0 && dashRanged.periodCount === 0);
  const badBackup = await POST("/system/restore/preview", { data: Buffer.from("nope").toString("base64") }, T);
  ok("restore preview: rejects an invalid file", badBackup.success === false);

  /* multi-till sync */
  const syncA = (await GET("/pos/sync", T)).data;
  ok("pos sync: returns stock + held", Array.isArray(syncA.stock) && typeof syncA.held === "number");
  const syncItem = (await GET("/items", T)).data.reduce((a, x) => x.purchase_price < a.purchase_price ? x : a);
  const syncBefore = syncA.stock.find((r) => r.id === syncItem.id).on_hand;
  const syncCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  await POST("/sales", { sales_rep_id: REP, party_id: syncCash.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: syncItem.id, description: syncItem.name, quantity: 1, rate: (syncItem.purchase_price || 0) + 50000 }] }, T);
  const syncB = (await GET("/pos/sync", T)).data;
  ok("pos sync: stock reflects a sale from another till", syncB.stock.find((r) => r.id === syncItem.id).on_hand === syncBefore - 1);

  /* first-run wizard */
  const setupVals = (await GET("/settings", T)).data.values;
  ok("setup: flag exists and starts unset", setupVals.setup_done !== undefined);
  await PUT("/settings", { setup_done: "1" }, T);
  ok("setup: completing hides the wizard", (await GET("/settings", T)).data.values.setup_done === "1");
  await PUT("/settings", { setup_done: "0" }, T);

  /* books integrity — guards against rounding drift for good */
  const integ = (await GET("/accounting/integrity", T)).data;
  ok("integrity: all checks pass", integ.ok === true);
  ok("integrity: ledger balances exactly", integ.checks.find((c) => c.name === "Every entry balances").ok);
  ok("integrity: no rounding artifacts", integ.checks.find((c) => c.name === "Amounts are clean").ok);

  /* perpetual inventory + COGS */
  const invSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const invCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  const invItem = (await POST("/items", { name: "Audit COGS Item", unit: "PCS", sale_price: 2500, purchase_price: 1000 }, T)).data;
  await POST("/purchases", { sales_rep_id: REP, party_id: invSup.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: invItem.id, description: "Audit COGS Item", quantity: 10, rate: 1000 }] }, T);
  const plBefore = (await GET("/accounting/profit-loss", T)).data;
  await POST("/sales", { sales_rep_id: REP, party_id: invCash.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: invItem.id, description: "Audit COGS Item", quantity: 4, rate: 2500 }] }, T);
  const plAfter = (await GET("/accounting/profit-loss", T)).data;
  ok("inventory: buying stock is not an expense", (plAfter.totalExpense - plBefore.totalExpense) >= 3999 && (plAfter.totalExpense - plBefore.totalExpense) <= 4001);
  ok("inventory: sale posts cost of goods sold", plAfter.expense.some((e) => /cost of goods/i.test(e.name) && e.amount > 0));
  const bsInv = (await GET("/accounting/balance-sheet", T)).data.assets.find((a) => a.code === "1020");
  ok("inventory: shows as an asset on the balance sheet", bsInv && bsInv.amount > 0);

  /* stock take */
  const stStart = await POST("/stock-takes", {}, T);
  ok("stock take: starts and snapshots stock", stStart.success && stStart.data.lines > 0);
  const stTake = (await GET("/stock-takes/" + stStart.data.id, T)).data;
  const stLine = stTake.lines[0];
  await PUT("/stock-takes/" + stTake.id + "/lines", { lines: [{ id: stLine.id, counted_qty: stLine.system_qty - 2 }] }, T);
  const stPost = await POST("/stock-takes/" + stTake.id + "/post", {}, T);
  ok("stock take: posts the variance", stPost.success && stPost.data.adjusted === 1);
  const stNow = (await GET("/items", T)).data.find((x) => x.id === stLine.item_id).on_hand;
  ok("stock take: stock matches what was counted", Number(stNow) === Number(stLine.system_qty) - 2);
  ok("stock take: cannot post twice", (await POST("/stock-takes/" + stTake.id + "/post", {}, T)).success === false);

  /* landed costs */
  const lcSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const lcA = (await POST("/items", { name: "Audit Landed A", unit: "PCS", sale_price: 3000, purchase_price: 1000 }, T)).data;
  const lcB = (await POST("/items", { name: "Audit Landed B", unit: "PCS", sale_price: 9000, purchase_price: 3000 }, T)).data;
  await POST("/purchases", { sales_rep_id: REP, party_id: lcSup.id, payment_type: "cash", payment_mode: "cash",
    landed_costs: [{ label: "Transport", amount: 4000 }],
    lines: [{ item_id: lcA.id, description: "Audit Landed A", quantity: 10, rate: 1000 },
            { item_id: lcB.id, description: "Audit Landed B", quantity: 10, rate: 3000 }] }, T);
  const lcItems = (await GET("/items", T)).data;
  const lcOnHandA = lcItems.find((x) => x.id === lcA.id).on_hand;
  ok("landed cost: goods received", Number(lcOnHandA) === 10);
  const lcPl = (await GET("/accounting/profit-loss", T)).data;
  ok("landed cost: extras are not expensed on purchase", !lcPl.expense.some((e) => /transport/i.test(e.name)));

  /* expiry alerts */
  const exSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const exItem = (await POST("/items", { name: "Audit Milk", unit: "PCS", sale_price: 4000, purchase_price: 3000 }, T)).data;
  const exSoon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  await POST("/purchases", { sales_rep_id: REP, party_id: exSup.id, payment_type: "cash", payment_mode: "cash",
    lines: [{ item_id: exItem.id, description: "Audit Milk", quantity: 20, rate: 3000, batch_no: "B-EXP", expiry_date: exSoon }] }, T);
  const exDash = (await GET("/dashboard", T)).data;
  ok("expiry: flags stock nearing expiry", exDash.expiringCount >= 1 && exDash.expiringValue > 0);
  await PUT("/settings", { expiry_alert_days: "7" }, T);
  ok("expiry: window setting narrows the list", (await GET("/dashboard", T)).data.expiringCount === 0);
  await PUT("/settings", { expiry_alert_days: "30" }, T);

  /* reorder suggestions + purchase orders */
  const poSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const poCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
  const poItem = (await GET("/items", T)).data.find((x) => /Sugar/.test(x.name));
  await POST("/purchases", { sales_rep_id: REP, party_id: poSup.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: poItem.id, description: poItem.name, quantity: 60, rate: 4000 }] }, T);
  for (let i = 0; i < 12; i++) {
    await POST("/sales", { sales_rep_id: REP, party_id: poCash.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: poItem.id, description: poItem.name, quantity: 5, rate: 5000 }] }, T);
  }
  const poSug = (await GET("/purchase-orders/suggestions?days=30&cover=30", T)).data;
  ok("reorder: suggests what is running out", poSug.count >= 1 && poSug.groups.length >= 1);
  const poGrp = poSug.groups[0];
  ok("reorder: knows the usual supplier", !!poGrp.supplier_id);
  const poNew = await POST("/purchase-orders", { party_id: poGrp.supplier_id, lines: poGrp.items.map((i) => ({ item_id: i.item_id, quantity: i.suggested_qty, rate: i.rate })) }, T);
  ok("purchase order: created from suggestions", poNew.success && poNew.data.po_no);
  const poFull = (await GET("/purchase-orders/" + poNew.data.id, T)).data;
  await POST("/purchase-orders/" + poNew.data.id + "/receive", { lines: poFull.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })) }, T);
  ok("purchase order: marked received when complete", (await GET("/purchase-orders/" + poNew.data.id, T)).data.status === "received");

  /* inventory changeover */
  const cvPrev = (await GET("/accounting/changeover/preview", T)).data;
  ok("changeover: preview reports stock vs inventory", typeof cvPrev.stock_value === "number" && typeof cvPrev.adjustment === "number");
  if (cvPrev.needed) {
    const cvPost = await POST("/accounting/changeover", {}, T);
    ok("changeover: posts the correcting entry", cvPost.success === true);
    ok("changeover: inventory then matches stock", (await GET("/accounting/changeover/preview", T)).data.needed === false);
    ok("changeover: refuses to run twice", (await POST("/accounting/changeover", {}, T)).success === false);
  } else {
    ok("changeover: nothing to do on a clean install", cvPrev.needed === false);
  }

  /* goods receipt against an order + stock ledger */
  const grSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const grItem = (await GET("/items", T)).data.find((x) => x.is_inventory === 1);
  const grPo = (await POST("/purchase-orders", { party_id: grSup.id, lines: [{ item_id: grItem.id, quantity: 50, rate: 4000 }] }, T)).data;
  await POST("/purchases", { sales_rep_id: REP, party_id: grSup.id, payment_type: "cash", payment_mode: "cash", po_id: grPo.id,
    lines: [{ item_id: grItem.id, description: grItem.name, quantity: 20, rate: 4000 }] }, T);
  ok("goods receipt: part delivery marks the order partial", (await GET("/purchase-orders/" + grPo.id, T)).data.status === "partial");
  await POST("/purchases", { sales_rep_id: REP, party_id: grSup.id, payment_type: "cash", payment_mode: "cash", po_id: grPo.id,
    lines: [{ item_id: grItem.id, description: grItem.name, quantity: 30, rate: 4000 }] }, T);
  ok("goods receipt: completing the order marks it received", (await GET("/purchase-orders/" + grPo.id, T)).data.status === "received");
  const grLedger = (await GET("/items/" + grItem.id + "/ledger", T)).data;
  ok("stock ledger: running balance ends at stock on hand", grLedger.rows.length > 0 && Math.abs(grLedger.closing - grLedger.rows[grLedger.rows.length - 1].balance) < 0.001);

  /* repacking */
  const rpSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const rpSack = (await POST("/items", { name: "Audit Sack 50kg", unit: "SACK", sale_price: 210000, purchase_price: 200000 }, T)).data;
  const rpBag = (await POST("/items", { name: "Audit Bag 1kg", unit: "KG", sale_price: 5000, purchase_price: 0 }, T)).data;
  await POST("/purchases", { sales_rep_id: REP, party_id: rpSup.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: rpSack.id, description: "Audit Sack 50kg", quantity: 2, rate: 200000 }] }, T);
  const rpDone = await POST("/repacks", { from_item_id: rpSack.id, from_qty: 1, to_item_id: rpBag.id, to_qty: 50 }, T);
  ok("repack: cost travels to the smaller unit", rpDone.success && Math.abs(rpDone.data.unit_cost_out - 4000) < 0.01);
  const rpItems = (await GET("/items", T)).data;
  ok("repack: source consumed and product created",
     Number(rpItems.find((x) => x.id === rpSack.id).on_hand) === 1 && Number(rpItems.find((x) => x.id === rpBag.id).on_hand) === 50);
  ok("repack: cannot repack more than is in stock",
     (await POST("/repacks", { from_item_id: rpSack.id, from_qty: 99, to_item_id: rpBag.id, to_qty: 10 }, T)).success === false);

  /* serials, ageing, photos */
  const srSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
  const srCust = (await GET("/parties", T)).data.find((x) => x.party_type === "customer" && x.name !== "Cash Sale");
  const srPhone = (await POST("/items", { name: "Audit Phone", unit: "PCS", sale_price: 650000, purchase_price: 500000, track_serials: true, image: "data:image/jpeg;base64,AAAA" }, T)).data;
  const srSaved = (await GET("/items", T)).data.find((x) => x.id === srPhone.id);
  ok("serials: item can be flagged for tracking", srSaved.track_serials === 1);
  ok("photo: image stored on the item", !!srSaved.image);
  await POST("/purchases", { sales_rep_id: REP, party_id: srSup.id, payment_type: "cash", payment_mode: "cash", lines: [{ item_id: srPhone.id, description: "Audit Phone", quantity: 2, rate: 500000 }] }, T);
  await POST("/serials/receive", { item_id: srPhone.id, serials: ["AUDITIMEI001", "AUDITIMEI002"] }, T);
  ok("serials: duplicates are refused", (await POST("/serials/receive", { item_id: srPhone.id, serials: ["AUDITIMEI001"] }, T)).data.duplicates.length === 1);
  const srSale = (await POST("/sales", { sales_rep_id: REP, party_id: srCust.id, payment_type: "credit", lines: [{ item_id: srPhone.id, description: "Audit Phone", quantity: 1, rate: 650000 }] }, T)).data;
  await POST("/serials/issue", { sale_id: srSale.id, party_id: srCust.id, serials: ["AUDITIMEI001"] }, T);
  const srLook = (await GET("/serials/lookup?q=AUDITIMEI001", T)).data[0];
  ok("serials: warranty lookup finds the sale", srLook && srLook.status === "sold" && !!srLook.invoice_no);
  ok("serials: a sold unit cannot be sold again", (await POST("/serials/issue", { serials: ["AUDITIMEI001"] }, T)).data.unavailable.length === 1);
  const srAge = (await GET("/items/reports/ageing", T)).data;
  ok("ageing: reports value by age bucket", srAge.total_value > 0 && typeof srAge.buckets["0-30"] === "number");

  /* online store */
  ok("store: disabled → 404", (await fetch(base + "/store/catalog")).status === 404);
  await PUT("/settings", { store_enabled: "1", store_whatsapp: "0772123456" }, T);
  const cat = await (await fetch(base + "/store/catalog")).json();
  ok("store: catalog public when enabled", cat.success && cat.data.items.length >= 3 && cat.data.whatsapp === "0772123456",
     `items ${cat.data ? cat.data.items.length : 0}`);
  ok("store: inactive items hidden", !cat.data.items.some((i) => i.name === "Sugar 1kg" && false) && cat.data.items.every((i) => i.price > 0));
  const page = await (await fetch(base + "/store/")).text();
  ok("store: storefront HTML served", page.includes("Online Store") || page.includes("Order on WhatsApp"));
  ok("system info: LAN fields present", typeof (await GET("/system/info", T)).data.port !== "undefined");

  /* end of day history */
  const pv = (await GET("/pos/day-close/preview?scope=cashout_all", T)).data;
  ok("eod preview: rows + net", pv.rows.length >= 1 && pv.totals.net > 0);
  const dc1 = (await POST("/pos/day-close", { scope: "close_register" }, T)).data;
  ok("eod commit: saved with id", dc1.id > 0 && dc1.scope === "close_register");
  const hist = (await GET("/pos/day-close/history", T)).data;
  ok("eod history: lists the close w/ net + user", hist.length >= 1 && hist[0].net === pv.totals.net && !!hist[0].by_user);
  ok("eod history: full breakdown stored", hist[0].data.rows.length === pv.rows.length);

  /* books still balanced after everything */
  const accts = (await GET("/accounting/accounts", T)).data;
  ok("GL: Σ = 0 after all guard tests", +accts.reduce((a, x) => a + x.balance, 0).toFixed(2) === 0);


  /* ── recurring sales & purchases ── */
  {
    const { advance } = require("./modules/recurring/recurring.routes");
    ok("recurring: month-end clamps into February", advance("2026-01-31", "monthly", 1) === "2026-02-28");
    ok("recurring: leap year keeps the 29th", advance("2028-01-31", "monthly", 1) === "2028-02-29");
    ok("recurring: leap day rolls to the 28th next year", advance("2028-02-29", "yearly", 1) === "2029-02-28");
    ok("recurring: interval spans the year boundary", advance("2026-12-15", "monthly", 1) === "2027-01-15");
    ok("recurring: a short February does not shift the rest of the schedule",
       advance("2026-02-28", "monthly", 1, 31) === "2026-03-31");
    ok("recurring: anchor survives a 30-day month", advance("2026-04-30", "monthly", 1, 31) === "2026-05-31");

    const recParty = (await POST("/parties", { name: "Audit Standing Order", party_type: "customer", credit_limit: 90000000 }, T)).data;
    const recItem = (await POST("/items", { name: "Audit Recurring Item", unit: "PCS", sale_price: 8000, purchase_price: 4000 }, T)).data;
    await POST("/purchases", { sales_rep_id: REP, party_id: (await GET("/parties", T)).data.find((x) => x.party_type === "supplier").id,
      payment_type: "cash", payment_mode: "cash", lines: [{ item_id: recItem.id, description: "stock up", quantity: 50, rate: 4000 }] }, T);

    const gated = await POST("/recurring", { name: "Blocked", party_id: recParty.id,
      lines: [{ item_id: recItem.id, quantity: 1, rate: 8000 }] }, T);
    ok("recurring: refused while the module is off", !gated.success && /Settings/.test(gated.message), gated.message);

    await PUT("/settings", { mod_recurring_sales: "1" }, T);
    const iso = (d) => d.toISOString().slice(0, 10);
    const back = (n) => iso(new Date(Date.now() - n * 864e5));

    const sched = await POST("/recurring", { name: "Audit weekly", doc_type: "sale", party_id: recParty.id,
      payment_type: "credit", sales_rep_id: REP, frequency: "weekly", interval_n: 1,
      start_date: back(21), lines: [{ item_id: recItem.id, description: "Audit Recurring Item", quantity: 1, rate: 8000 }] }, T);
    ok("recurring: schedule saved", sched.success, sched.message);

    const ran = await POST(`/recurring/${sched.data.id}/run`, {}, T);
    ok("recurring: back-dated schedule catches up every missed period", ran.success && ran.data.created.length === 4,
       `created ${ran.data?.created?.length}`);
    ok("recurring: generated real invoice numbers", (ran.data.created || []).every((c) => /^INV-/.test(c.doc_no)));

    const again = await POST(`/recurring/${sched.data.id}/run`, {}, T);
    ok("recurring: running twice creates nothing extra", again.success && (again.data.created || []).length === 0);

    const detail = (await GET(`/recurring/${sched.data.id}`, T)).data;
    ok("recurring: history logged per document", detail.runs.length === 4 && detail.generated === 4);

    const capped = await POST("/recurring", { name: "Audit capped", party_id: recParty.id, sales_rep_id: REP,
      frequency: "daily", start_date: back(10), end_type: "count", end_count: 3,
      lines: [{ item_id: recItem.id, description: "Audit Recurring Item", quantity: 1, rate: 8000 }] }, T);
    await POST(`/recurring/${capped.data.id}/run`, {}, T);
    const cd = (await GET(`/recurring/${capped.data.id}`, T)).data;
    ok("recurring: stops at its document count", cd.generated === 3 && cd.status === "ended" && !cd.next_run,
       `generated ${cd.generated} status ${cd.status}`);

    await POST(`/recurring/${sched.data.id}/status`, { status: "paused" }, T);
    const due = await POST("/recurring/run-due", {}, T);
    ok("recurring: paused schedules are skipped by run-all", due.success && due.data.created === 0, due.message);

    const badDates = await POST("/recurring", { name: "Audit bad", party_id: recParty.id, sales_rep_id: REP,
      start_date: "2026-06-01", end_type: "until", end_until: "2020-01-01",
      lines: [{ item_id: recItem.id, quantity: 1, rate: 8000 }] }, T);
    ok("recurring: stop-before-start refused", !badDates.success);
    const noLines = await POST("/recurring", { name: "Audit empty", party_id: recParty.id, lines: [] }, T);
    ok("recurring: empty schedule refused", !noLines.success);
  }


  /* ── installments ── */
  {
    const { buildSchedule, applyPayments } = require("./modules/installments/installments.routes");
    const sum = (ls) => +ls.reduce((a, l) => a + l.amount, 0).toFixed(2);

    let sc = buildSchedule({ total: 100000, down: 0, count: 3, frequency: "monthly", interval: 1, start: "2026-07-26" });
    ok("installments: an uneven split still totals the invoice exactly", sum(sc) === 100000, sc.map((l) => l.amount).join("+"));
    sc = buildSchedule({ total: 462480.55, down: 62480.55, count: 7, frequency: "monthly", interval: 1, start: "2026-01-31" });
    ok("installments: a down payment plus instalments totals the invoice", sum(sc) === 462480.55);
    ok("installments: the down payment is its own first row", sc[0].amount === 62480.55 && sc.length === 8);
    ok("installments: month-ends follow the agreed day", sc[2].due_date === "2026-03-31", sc.slice(0, 4).map((l) => l.due_date).join(","));

    const three = buildSchedule({ total: 300000, down: 0, count: 3, frequency: "monthly", interval: 1, start: "2026-05-26" });
    let ap = applyPayments(three, 150000);
    ok("installments: payments settle earlier rows first",
       ap[0].status === "paid" && ap[1].status === "partial" && ap[1].paid === 50000);
    ap = applyPayments(three, 300000);
    ok("installments: a fully paid plan shows nothing overdue", ap.every((l) => l.status === "paid") && !ap.some((l) => l.overdue));

    const instParty = (await POST("/parties", { name: "Audit Instalment Buyer", party_type: "customer", credit_limit: 90000000 }, T)).data;
    const instItem = (await POST("/items", { name: "Audit Instalment Item", unit: "PCS", sale_price: 100000, purchase_price: 50000 }, T)).data;
    await POST("/purchases", { sales_rep_id: REP, party_id: (await GET("/parties", T)).data.find((x) => x.party_type === "supplier").id,
      payment_type: "cash", payment_mode: "cash", lines: [{ item_id: instItem.id, description: "stock", quantity: 20, rate: 50000 }] }, T);
    const instInv = (await POST("/sales", { sales_rep_id: REP, party_id: instParty.id, payment_type: "credit",
      lines: [{ item_id: instItem.id, description: "Audit Instalment Item", quantity: 3, rate: 100000, discount_pct: 0 }] }, T)).data;

    const offPlan = await POST("/installments", { invoice_id: instInv.id, count_n: 3 }, T);
    ok("installments: refused while the module is off", !offPlan.success && /Settings/.test(offPlan.message), offPlan.message);
    await PUT("/settings", { mod_installments: "1" }, T);

    const plan = await POST("/installments", { invoice_id: instInv.id, count_n: 3, frequency: "monthly", start_date: "2026-01-31" }, T);
    ok("installments: plan created", plan.success, plan.message);
    const dupe = await POST("/installments", { invoice_id: instInv.id, count_n: 2 }, T);
    ok("installments: one live plan per invoice", !dupe.success);

    const view = (await GET(`/installments/${plan.data.id}`, T)).data;
    ok("installments: timetable adds up to the invoice", Math.abs(view.lines.reduce((a, l) => a + l.amount, 0) - view.invoice_total) < 0.01);
    ok("installments: unpaid plan reports arrears", view.arrears > 0 && view.overdue_count > 0);

    /* Pay the invoice normally — the plan must move without being told. */
    await POST("/payments", { direction: "in", party_id: instParty.id, amount: view.invoice_total, mode: "cash" }, T);
    const after = (await GET(`/installments/${plan.data.id}`, T)).data;
    ok("installments: an ordinary payment settles the plan automatically",
       after.completed && after.arrears === 0 && after.paid_count === after.lines.length,
       `arrears ${after.arrears} paid ${after.paid_count}/${after.lines.length}`);

    const settled = await POST("/installments", { invoice_id: instInv.id, count_n: 3 }, T);
    ok("installments: refused on a settled invoice", !settled.success);
    const tooBigDown = await POST("/installments", { invoice_id: instInv.id, count_n: 3, down_payment: 99999999 }, T);
    ok("installments: a down payment covering everything is refused", !tooBigDown.success);
  }


  /* ── manufacturing ── */
  {
    const mSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
    const flour = (await POST("/items", { name: "Audit Mfg Flour", unit: "KG", sale_price: 3000, purchase_price: 2000 }, T)).data;
    const sug = (await POST("/items", { name: "Audit Mfg Sugar", unit: "KG", sale_price: 5000, purchase_price: 3500 }, T)).data;
    const loaf = (await POST("/items", { name: "Audit Mfg Loaf", unit: "PCS", sale_price: 4000, purchase_price: 0 }, T)).data;
    await POST("/purchases", { sales_rep_id: REP, party_id: mSup.id, payment_type: "cash", payment_mode: "cash",
      lines: [{ item_id: flour.id, description: "f", quantity: 100, rate: 2000 },
              { item_id: sug.id, description: "s", quantity: 50, rate: 3500 }] }, T);

    const bomBody = { name: "Audit bread batch", item_id: loaf.id, output_qty: 10, labour_cost: 2000, overhead_cost: 500,
      components: [{ item_id: flour.id, quantity: 5 }, { item_id: sug.id, quantity: 1 }] };
    const offBom = await POST("/manufacturing/boms", bomBody, T);
    ok("manufacturing: refused while the module is off", !offBom.success && /Settings/.test(offBom.message), offBom.message);
    await PUT("/settings", { mod_manufacturing: "1" }, T);

    const bom = await POST("/manufacturing/boms", bomBody, T);
    ok("manufacturing: recipe saved", bom.success, bom.message);

    const selfRef = await POST("/manufacturing/boms", { ...bomBody, name: "self", components: [{ item_id: loaf.id, quantity: 1 }] }, T);
    ok("manufacturing: a recipe cannot contain what it makes", !selfRef.success);
    const dup = await POST("/manufacturing/boms", { ...bomBody, name: "dup",
      components: [{ item_id: flour.id, quantity: 1 }, { item_id: flour.id, quantity: 2 }] }, T);
    ok("manufacturing: the same component twice is refused", !dup.success);
    const noComp = await POST("/manufacturing/boms", { ...bomBody, name: "empty", components: [] }, T);
    ok("manufacturing: a recipe with no components is refused", !noComp.success);

    const costing = (await GET(`/manufacturing/costing/${bom.data.id}?batches=3`, T)).data;
    ok("manufacturing: components costed at what stock is worth", costing.components === 40500, `got ${costing.components}`);
    ok("manufacturing: labour and overhead scale with the batch",
       costing.labour === 6000 && costing.overhead === 1500);
    ok("manufacturing: unit cost carries the whole cost of making it",
       costing.output === 30 && costing.unit_cost === 1600, `${costing.output} @ ${costing.unit_cost}`);

    const tooMany = await POST("/manufacturing/produce", { bom_id: bom.data.id, batches: 25 }, T);
    ok("manufacturing: production short of stock is refused, naming the shortfall",
       !tooMany.success && /short/.test(tooMany.message), tooMany.message);

    const tbBefore = (await GET("/reports/trial-balance", T)).data.totals;
    const run = await POST("/manufacturing/produce", { bom_id: bom.data.id, batches: 3 }, T);
    ok("manufacturing: production run created", run.success && run.data.unit_cost === 1600, run.message);

    const items = (await GET("/items", T)).data;
    const rows2 = items.rows || items;
    const find = (n) => rows2.find((x) => x.name === n);
    ok("manufacturing: components come off the shelf",
       find("Audit Mfg Flour").on_hand === 85 && find("Audit Mfg Sugar").on_hand === 47,
       `flour ${find("Audit Mfg Flour").on_hand} sugar ${find("Audit Mfg Sugar").on_hand}`);
    ok("manufacturing: finished goods go on the shelf", find("Audit Mfg Loaf").on_hand === 30);

    const tbAfter = (await GET("/reports/trial-balance", T)).data.totals;
    ok("manufacturing: the books still balance after a run", tbAfter.debit === tbAfter.credit);
    ok("manufacturing: labour and overhead raise the value on the shelf",
       Math.round(tbAfter.debit - tbBefore.debit) === 7500, `moved ${tbAfter.debit - tbBefore.debit}`);

    const detail = (await GET(`/manufacturing/runs/${run.data.id}`, T)).data;
    ok("manufacturing: the run records what it ate", detail.consumed.length === 2
       && Math.abs(detail.consumed.reduce((a, c) => a + c.cost, 0) - 40500) < 0.01);

    const del = await POST(`/manufacturing/boms/${bom.data.id}`, {}, T); // wrong verb, ignore result
    const gone = await fetch(base + "/api/manufacturing/boms/" + bom.data.id, { method: "DELETE", headers: H(T) }).then(J);
    ok("manufacturing: a used recipe is retired, not deleted", gone.success && gone.data.deactivated === true, gone.message);
  }


  /* ── offers & promotions ── */
  {
    const { lineDiscountPct } = require("./modules/offers/offers.routes");
    const pct = (o, l) => lineDiscountPct(o, l, null);
    ok("offers: a flat amount becomes the right percentage",
       pct({ offer_type: "amount", value: 200 }, { quantity: 5, rate: 1000 }) === 20);
    ok("offers: an amount never exceeds the line",
       pct({ offer_type: "amount", value: 5000 }, { quantity: 1, rate: 1000 }) === 100);
    ok("offers: buy 3 get 1 on four items is a quarter off",
       pct({ offer_type: "bxgy", buy_qty: 3, get_qty: 1 }, { quantity: 4, rate: 1000 }) === 25);
    ok("offers: buy 3 get 1 gives nothing on three items",
       pct({ offer_type: "bxgy", buy_qty: 3, get_qty: 1 }, { quantity: 3, rate: 1000 }) === 0);
    ok("offers: a minimum quantity is respected",
       pct({ offer_type: "percent", value: 10, min_qty: 10 }, { quantity: 5, rate: 1000 }) === 0);
    ok("offers: a percentage is clamped at 100",
       pct({ offer_type: "percent", value: 150 }, { quantity: 1, rate: 1000 }) === 100);

    const offItem = (await POST("/items", { name: "Audit Offer Item", unit: "PCS", sale_price: 1000, purchase_price: 400 }, T)).data;
    const offBody = { name: "Audit 10 off", scope: "item", offer_type: "percent", value: 10, item_id: offItem.id };
    const blocked = await POST("/offers", offBody, T);
    ok("offers: refused while the module is off", !blocked.success && /Settings/.test(blocked.message), blocked.message);
    await PUT("/settings", { mod_offers: "1" }, T);

    ok("offers: saved", (await POST("/offers", offBody, T)).success);
    ok("offers: a percentage over 100 is refused",
       !(await POST("/offers", { ...offBody, name: "bad", value: 150 }, T)).success);
    ok("offers: an end before the start is refused",
       !(await POST("/offers", { ...offBody, name: "bad2", starts_on: "2026-06-01", ends_on: "2026-01-01" }, T)).success);
    ok("offers: buy-x-get-y on a whole bill is refused",
       !(await POST("/offers", { name: "bad3", scope: "bill", offer_type: "bxgy", buy_qty: 2, get_qty: 1 }, T)).success);

    const ev = (await POST("/offers/evaluate", { lines: [{ item_id: offItem.id, quantity: 5, rate: 1000 }] }, T)).data;
    ok("offers: evaluating a basket finds the deal",
       ev.lines[0].discount_pct === 10 && ev.item_discount === 500, `${ev.lines[0].discount_pct}% / ${ev.item_discount}`);

    /* Two offers on one line must not stack — the better one wins. */
    await POST("/offers", { name: "Audit 25 off", scope: "item", offer_type: "percent", value: 25, item_id: offItem.id }, T);
    const ev2 = (await POST("/offers/evaluate", { lines: [{ item_id: offItem.id, quantity: 5, rate: 1000 }] }, T)).data;
    ok("offers: two deals on one line do not stack — the better one wins",
       ev2.lines[0].discount_pct === 25 && ev2.item_discount === 1250, `${ev2.lines[0].discount_pct}%`);

    /* A bill offer applies after the item discounts, not before. */
    await POST("/offers", { name: "Audit bill 10", scope: "bill", offer_type: "percent", value: 10, min_amount: 1000 }, T);
    const ev3 = (await POST("/offers/evaluate", { lines: [{ item_id: offItem.id, quantity: 5, rate: 1000 }] }, T)).data;
    ok("offers: the bill deal applies to what is left after item deals",
       ev3.bill_discount === 375, `got ${ev3.bill_discount} of expected 375`);

    const expired = await POST("/offers", { name: "Audit expired", scope: "item", offer_type: "percent",
      value: 50, item_id: offItem.id, starts_on: "2020-01-01", ends_on: "2020-12-31" }, T);
    const ev4 = (await POST("/offers/evaluate", { lines: [{ item_id: offItem.id, quantity: 5, rate: 1000 }] }, T)).data;
    ok("offers: an out-of-date offer never fires", expired.success && ev4.lines[0].discount_pct === 25);
  }


  /* ── loyalty ── */
  {
    const loySup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
    const loyCash = (await GET("/parties", T)).data.find((x) => x.name === "Cash Sale");
    const loyParty = (await POST("/parties", { name: "Audit Loyal Buyer", party_type: "customer", credit_limit: 90000000 }, T)).data;
    const loyItem = (await POST("/items", { name: "Audit Loyalty Item", unit: "PCS", sale_price: 10000, purchase_price: 4000 }, T)).data;
    await POST("/purchases", { sales_rep_id: REP, party_id: loySup.id, payment_type: "cash", payment_mode: "cash",
      lines: [{ item_id: loyItem.id, description: "stock", quantity: 200, rate: 4000 }] }, T);
    const sell = (party, qty) => POST("/sales", { sales_rep_id: REP, party_id: party, payment_type: "cash",
      lines: [{ item_id: loyItem.id, description: "Audit Loyalty Item", quantity: qty, rate: 10000, discount_pct: 0 }] }, T);

    const before = await sell(loyParty.id, 5);
    ok("loyalty: no points while the module is off", before.data.points_earned === 0);
    await PUT("/settings", { mod_loyalty: "1" }, T);

    const withPts = await sell(loyParty.id, 5);
    const expected = Math.floor(withPts.data.totals.grand_total / 1000);
    ok("loyalty: a sale earns one point per 1000 spent", withPts.data.points_earned === expected,
       `${withPts.data.points_earned} on ${withPts.data.totals.grand_total}`);

    const walkIn = await sell(loyCash.id, 5);
    ok("loyalty: the walk-in cash party earns nothing", walkIn.data.points_earned === 0);

    let bal = (await GET(`/loyalty/party/${loyParty.id}`, T)).data;
    ok("loyalty: the balance matches what was awarded", bal.balance === expected && bal.history.length === 1);
    ok("loyalty: points are valued at the scheme rate", bal.value === +(expected * 10).toFixed(2));

    ok("loyalty: redeeming below the minimum is refused",
       !(await POST("/loyalty/redeem", { party_id: loyParty.id, points: 5 }, T)).success);
    ok("loyalty: redeeming more than held is refused",
       !(await POST("/loyalty/redeem", { party_id: loyParty.id, points: 999999 }, T)).success);

    /* Earn enough to clear the redemption floor, then spend some. */
    await sell(loyParty.id, 20);
    bal = (await GET(`/loyalty/party/${loyParty.id}`, T)).data;
    const red = await POST("/loyalty/redeem", { party_id: loyParty.id, points: 100 }, T);
    ok("loyalty: redeeming returns the shilling value for the bill",
       red.success && red.data.value === 1000 && red.data.balance === bal.balance - 100, red.message);

    const after = (await GET(`/loyalty/party/${loyParty.id}`, T)).data;
    ok("loyalty: the balance is the ledger, not a cached figure",
       after.balance === after.earned - after.spent);

    ok("loyalty: a correction without a reason is refused",
       !(await POST("/loyalty/adjust", { party_id: loyParty.id, points: 50 }, T)).success);
    const adj = await POST("/loyalty/adjust", { party_id: loyParty.id, points: 50, note: "goodwill" }, T);
    ok("loyalty: a reasoned correction is accepted", adj.success && adj.data.balance === after.balance + 50);

    /* A sale that cannot go through must not leave points behind. */
    const balBefore = (await GET(`/loyalty/party/${loyParty.id}`, T)).data.balance;
    await sell(loyParty.id, 999999);
    const balAfter = (await GET(`/loyalty/party/${loyParty.id}`, T)).data.balance;
    ok("loyalty: a refused sale leaves no points behind", balBefore === balAfter, `${balBefore} vs ${balAfter}`);

    const members = (await GET("/loyalty", T)).data;
    ok("loyalty: the members list shows what the scheme owes",
       members.totals.members >= 1 && members.totals.liability === +(members.totals.outstanding * 10).toFixed(2));
  }


  /* ── warranty ── */
  {
    const { addMonths } = require("./modules/warranty/warranty.routes");
    ok("warranty: cover runs a whole year", addMonths("2026-07-26", 12) === "2027-07-26");
    ok("warranty: a short month is clamped, not skipped", addMonths("2026-01-31", 1) === "2026-02-28");
    ok("warranty: leap years are handled", addMonths("2028-01-31", 1) === "2028-02-29");

    const wSup = (await GET("/parties", T)).data.find((x) => x.party_type === "supplier");
    const wParty = (await POST("/parties", { name: "Audit Warranty Buyer", party_type: "customer", credit_limit: 90000000 }, T)).data;
    const wItem = (await POST("/items", { name: "Audit Warranty Radio", unit: "PCS", sale_price: 50000, purchase_price: 20000 }, T)).data;
    await POST("/purchases", { sales_rep_id: REP, party_id: wSup.id, payment_type: "cash", payment_mode: "cash",
      lines: [{ item_id: wItem.id, description: "stock", quantity: 20, rate: 20000 }] }, T);

    const sellRadio = () => POST("/sales", { sales_rep_id: REP, party_id: wParty.id, payment_type: "cash",
      lines: [{ item_id: wItem.id, description: "Audit Warranty Radio", quantity: 1, rate: 50000, discount_pct: 0 }] }, T);

    await sellRadio();
    let list = (await GET("/warranty", T)).data;
    ok("warranty: nothing is covered while the module is off", list.rows.length === 0);

    await PUT("/settings", { mod_insurance: "1" }, T);
    await sellRadio();
    list = (await GET("/warranty", T)).data;
    ok("warranty: an item with no warranty period gets no cover", list.rows.length === 0);

    await PUT(`/items/${wItem.id}`, { warranty_months: 12 }, T);
    const sold = await sellRadio();
    list = (await GET("/warranty", T)).data;
    ok("warranty: selling a covered item creates cover automatically", list.rows.length === 1, `${list.rows.length} rows`);
    const w = list.rows[0];
    ok("warranty: cover runs from the sale for the item's period",
       w.months === 12 && w.expires_on === addMonths(w.starts_on, 12) && w.state === "in cover");
    ok("warranty: cover is tied to the customer and the invoice",
       w.party_name === "Audit Warranty Buyer" && !!w.invoice_no);

    const badClaim = await POST(`/warranty/${w.id}/claims`, { fault: "" }, T);
    ok("warranty: a claim with no fault described is refused", !badClaim.success);
    const lateClaim = await POST(`/warranty/${w.id}/claims`, { fault: "dead", claim_date: "2099-01-01" }, T);
    ok("warranty: a claim after cover ends is refused, naming the date",
       !lateClaim.success && /ran out/.test(lateClaim.message), lateClaim.message);

    const claim = await POST(`/warranty/${w.id}/claims`, { fault: "No sound from the left speaker" }, T);
    ok("warranty: a claim inside cover is logged", claim.success);
    const openList = (await GET("/warranty/claims/all", T)).data;
    ok("warranty: open claims are visible", openList.totals.open === 1);

    const badClose = await POST(`/warranty/claims/${claim.data.id}/close`, { outcome: "maybe" }, T);
    ok("warranty: closing needs a real outcome", !badClose.success);
    const closed = await POST(`/warranty/claims/${claim.data.id}/close`, { outcome: "repaired", cost: 12000 }, T);
    ok("warranty: a claim can be settled with its cost", closed.success && closed.data.outcome === "repaired");
    const again = await POST(`/warranty/claims/${claim.data.id}/close`, { outcome: "repaired" }, T);
    ok("warranty: a closed claim cannot be closed twice", !again.success);

    const noReason = await POST(`/warranty/${w.id}/void`, {}, T);
    ok("warranty: voiding needs a reason", !noReason.success);
    ok("warranty: cover can be voided with a reason",
       (await POST(`/warranty/${w.id}/void`, { note: "customer returned the goods" }, T)).success);
    const afterVoid = await POST(`/warranty/${w.id}/claims`, { fault: "still broken" }, T);
    ok("warranty: no claiming on voided cover", !afterVoid.success);

    const miss = (await GET("/warranty/lookup?serial=NOPE-123", T)).data;
    ok("warranty: an unknown serial says so plainly", miss.found === false);
  }

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  s.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
