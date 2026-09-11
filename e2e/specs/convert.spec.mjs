/**
 * convert.spec — turning a quotation into an invoice.
 *
 * Two things were wrong with the old conversion, and they were different
 * kinds of wrong.
 *
 * The visible one: it was a confirm box. Press "Create the invoice" and the
 * quote's lines went through exactly as quoted — which is the one case that is
 * never quite right. A quotation is an offer made days ago; by the time it is
 * accepted the customer has taken two of the five and one line is out of
 * stock. It now opens the ordinary invoice editor, pre-filled, with every line
 * editable and removable, and raises the invoice from what is on screen.
 *
 * The invisible one, which is the reason this spec exists: it was TWO
 * requests. Post the sale, then flip the quote to "converted". If the line
 * dropped in between, the invoice existed and the quote still read "open" —
 * so the next person converted it again. A second real invoice, a second lot
 * of stock off the shelf, for one job. The flip happens inside the invoice's
 * own transaction now, and the checks below prove both halves move together.
 */
export const name = "converting a quotation — editable, and one invoice only";

export async function run({ browser, report }) {
  const ok = (n, c, note) => report.ok(!!c, n, note);
  const { signIn } = await import("../harness.mjs");
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  for (let i = 0; i < 3; i++) {
    const s = page.getByRole("button", { name: /skip setup/i }).first();
    if (!(await s.count())) break;
    await s.click(); await page.waitForTimeout(900);
    const c = page.getByRole("button", { name: /skip|yes|confirm/i }).last();
    if (await c.count()) await c.click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  const token = await page.evaluate(() => localStorage.getItem("vy_token"));
  const me = await page.evaluate(() => JSON.parse(localStorage.getItem("vy_user")).id);
  const api = (path, method = "GET", body) => page.evaluate(
    async ([p, m, b, t]) => {
      const r = await fetch(p, { method: m,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: b ? JSON.stringify(b) : undefined });
      const j = await r.json().catch(() => null);
      return { status: r.status, data: j && j.data, message: j && j.message };
    }, [path, method, body, token]);

  const cust = await api("/api/parties", "POST", { name: `Conv ${Date.now()}`, type: "customer" });
  const item = await api("/api/items", "POST", { name: `Conv item ${Date.now()}`, unit: "PCS",
    sale_price: 20000, purchase_price: 9000, opening_stock: 100 });
  const est = await api("/api/estimates", "POST", { party_id: cust.data.id,
    lines: [{ item_id: item.data.id, description: "x", quantity: 10, rate: 20000 }] });
  ok("a quotation exists", est.status === 200, est.data && est.data.doc_no);

  const onHand = async () => {
    const r = await api("/api/items?limit=500");
    const rows = r.data.rows || r.data || [];
    const it = rows.find((x) => x.id === item.data.id);
    return Number(it ? it.on_hand : NaN);
  };

  /* ── The editor opens, pre-filled ──────────────────────────────────────── */
  await page.reload(); await page.waitForTimeout(2000);
  const rail = page.locator(".dk-rail .dk-nav").filter({ hasText: /Sales$/i }).first();
  if (await rail.count()) { await rail.click(); await page.waitForTimeout(1600); }
  const tab = page.getByRole("button", { name: /Estimates/ }).first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(1600); }
  const menu = page.locator("button[aria-label^='Actions for EST']").first();
  ok("the quotation has a ⋮ menu", await menu.count() > 0);
  if (await menu.count()) {
    await menu.click(); await page.waitForTimeout(600);
    const conv = page.getByText("Convert to invoice", { exact: true }).first();
    ok("with a Convert to invoice on it", await conv.count() > 0);
    if (await conv.count()) {
      await conv.click(); await page.waitForTimeout(2000);
      const lines = await page.locator(".invb tbody tr").count();
      ok("the invoice editor opens with the quoted lines in it", lines >= 1, `${lines} line(s)`);
      const heading = await page.locator(".slide-head h2").first().innerText().catch(() => "");
      ok("and it names the quotation it came from", /EST-/.test(heading), heading);
      /* Every line has its own remove control — the whole point of showing
         the editor rather than a confirm box. */
      const removes = await page.locator(".invb tbody tr button[title='Remove']").count();
      ok("each line can be taken off before the invoice is raised", removes >= 1, `${removes} remove control(s)`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  /* ── Both halves move together, or neither does ────────────────────────── */
  const stockBefore = await onHand();
  const conv1 = await api("/api/sales", "POST", {
    client_ref: `conv-${Date.now()}`, party_id: cust.data.id, payment_type: "credit",
    sales_rep_id: me, convert_estimate_id: est.data.id,
    lines: [{ item_id: item.data.id, description: "x", quantity: 8, rate: 20000 }],
  });
  ok("converting raises the invoice", conv1.status === 200, conv1.data && conv1.data.invoice_no);
  ok("with the edited quantity, not the quoted one",
    Math.abs((await onHand()) - (stockBefore - 8)) < 0.001, `${stockBefore} → ${await onHand()}`);
  const after = await api(`/api/estimates/${est.data.id}`);
  ok("and the quotation is marked converted in the same breath",
    after.data.status === "converted", after.data.status);
  ok("pointing at the invoice it became",
    Number(after.data.converted_invoice_id) === Number(conv1.data.id));

  /* The failure this replaces: a quote left "open" beside a real invoice, and
     converted a second time by the next person to look at it. */
  const conv2 = await api("/api/sales", "POST", {
    client_ref: `conv2-${Date.now()}`, party_id: cust.data.id, payment_type: "credit",
    sales_rep_id: me, convert_estimate_id: est.data.id,
    lines: [{ item_id: item.data.id, description: "x", quantity: 8, rate: 20000 }],
  });
  ok("a second conversion of the same quotation is refused", conv2.status === 409, conv2.message);
  ok("and it took no stock while refusing",
    Math.abs((await onHand()) - (stockBefore - 8)) < 0.001, `on hand ${await onHand()}`);

  await context.close();
}
