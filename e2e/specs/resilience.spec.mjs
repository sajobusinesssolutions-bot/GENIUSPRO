/**
 * resilience.spec — what the till does when the request does not come back.
 *
 * Every other spec in here drives a healthy app. In a shop with intermittent
 * power and a shared mobile connection, "the answer never arrived" is an
 * ordinary Tuesday, and it lands at the worst moment: the customer has handed
 * over the money and the cashier has pressed Confirm.
 *
 * Each assertion below is a behaviour that was missing before this spec:
 *
 *  - a failed save left a three-second toast and nothing else on screen, so a
 *    cashier who was looking at the customer saw a normal payment screen and
 *    no reason to think the sale had not been taken;
 *  - a request with no answer at all held the button on "Saving…" for as long
 *    as the browser held the socket — no error, no way out, no retry;
 *  - and the one that costs real money: when the server posted the sale but
 *    the response was lost, pressing Confirm again posted it a second time.
 *    Two invoices, one customer, one payment.
 *
 * Failures are injected with `page.route()` rather than by stopping the
 * server: the suite boots one real backend for every spec, and the point is
 * to test the browser's behaviour, not the server's.
 *
 * ── On idempotency, because it matters more than anything else here ──
 * POST /api/sales has no idempotency key. Nothing in the request identifies
 * the operator's intent, so a server that has already posted a sale cannot
 * recognise the retry of it, and no amount of frontend care can make a blind
 * retry safe. What the till does instead is refuse to retry blind: after an
 * ambiguous failure it reads the recent invoices back and looks for the
 * document it was trying to create, using the newest invoice id seen when the
 * payment screen opened as the cut-off. That is a reconciliation, and it is
 * what the assertions below lock in. The real fix is a backend one — a
 * client-supplied `client_ref` on the request, a UNIQUE index on
 * (firm_id, client_ref) in sale_invoices, and the create handler returning the
 * existing invoice when the reference repeats.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

export const name = "resilience — a request that fails, times out, or is lost";

/* Count invoices out of band, so a broken UI cannot hide a double posting. */
const invoiceCount = (page) => page.evaluate(async () => {
  const t = localStorage.getItem("vy_token");
  const r = await fetch("/api/sales?limit=500", { headers: { Authorization: `Bearer ${t}` } });
  const j = await r.json();
  return ((j.data && j.data.rows) || j.data || []).length;
});

const panelText = (page) =>
  page.locator(".dk-saveerr").innerText().catch(() => "").then((s) => s.replace(/\s+/g, " ").trim());

/** A till with one line on the bill, sitting on the payment screen, exact money in. */
async function readyToPay(browser) {
  const page = await (await browser.newContext()).newPage();
  const errs = watchErrors(page);
  await signIn(page);
  if (!(await go(page, "Till"))) return { page, errs, ok: false };
  await page.waitForTimeout(1200);
  const search = page.locator('input[placeholder*="Scan barcode"]');
  if (!(await search.count())) return { page, errs, ok: false };
  await search.click();
  await search.fill("Cement");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await page.getByText(/Take payment/i).first().click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /^Exact$/ }).click();
  await page.waitForTimeout(400);
  return { page, errs, ok: true };
}

const confirmBtn = (page) => page.getByRole("button", { name: /Confirm & print|Saving/i }).first();

export async function run({ browser, report }) {
  /* ── 1. the connection dies before the sale reaches the server ─────────── */
  {
    const { page, ok } = await readyToPay(browser);
    if (!ok) { report.ok(false, "the till can reach the payment screen"); await page.close(); return; }
    const before = await invoiceCount(page);

    await page.route("**/api/sales", (r) =>
      r.request().method() === "POST" ? r.abort() : r.continue());
    await confirmBtn(page).click();
    await page.waitForTimeout(3000);

    const cart = await page.evaluate(() => localStorage.getItem("vy_pos_cart"));
    report.ok(!!cart && JSON.parse(cart).lines.length > 0,
      "the bill survives a save that never reached the server", `vy_pos_cart = ${cart}`);
    report.ok((await page.locator("body").innerText()).includes("Order summary"),
      "the payment screen stays put rather than clearing the sale");

    const panel = await panelText(page);
    report.ok(/may not have been saved/i.test(panel),
      "a failed save leaves a notice on screen, not just a toast that fades", panel || "(no notice)");
    report.ok(/reach the server/i.test(panel),
      "the notice says what went wrong", panel);
    report.ok(!/Saving…/.test(await confirmBtn(page).innerText()),
      "the button stops saying “Saving…” when the save has stopped");

    /* Nothing reached the server, so the check must say so and hand the sale
       back — a check that cried duplicate would strand a real sale. */
    await page.unroute("**/api/sales");
    await page.getByRole("button", { name: /Check whether it saved/i }).click();
    await page.waitForTimeout(2500);
    const checked = await panelText(page);
    report.ok(/safe to save again/i.test(checked),
      "a sale that never left the till is reported as safe to save again", checked);

    await confirmBtn(page).click();
    await page.waitForTimeout(3500);
    const after = await invoiceCount(page);
    report.ok(after === before + 1,
      "the sale can be completed once the connection returns, without a reload",
      `invoices ${before} → ${after}`);
    report.ok(/saved/i.test(await page.locator("body").innerText()),
      "the retry ends on the sale-complete screen");
    await page.close();
  }

  /* ── 2. the server answers, and the answer is "no" ─────────────────────── */
  {
    const { page, ok } = await readyToPay(browser);
    if (!ok) { report.ok(false, "the till can reach the payment screen (500 case)"); await page.close(); return; }
    const before = await invoiceCount(page);

    await page.route("**/api/sales", (r) => r.request().method() === "POST"
      ? r.fulfill({ status: 500, contentType: "application/json",
                    body: JSON.stringify({ success: false, message: "Database is locked" }) })
      : r.continue());
    await confirmBtn(page).click();
    await page.waitForTimeout(3000);

    const panel = await panelText(page);
    report.ok(/was not saved/i.test(panel) && /Database is locked/.test(panel),
      "a server error is shown with the reason the server gave", panel || "(no notice)");
    report.ok(!!(await page.evaluate(() => localStorage.getItem("vy_pos_cart"))),
      "a server error does not lose the bill");
    /* The server answered, so it decided: it wrote nothing, and Confirm is
       safe to press again without a reconciliation first. */
    report.ok(!(await confirmBtn(page).isDisabled()),
      "a sale the server rejected can be retried directly");

    await page.unroute("**/api/sales");
    await confirmBtn(page).click();
    await page.waitForTimeout(3500);
    const after = await invoiceCount(page);
    report.ok(after === before + 1,
      "retrying after a server error posts the sale exactly once", `invoices ${before} → ${after}`);
    await page.close();
  }

  /* ── 3. the sale is posted and the answer is lost — the double-post case ─ */
  {
    const { page, ok } = await readyToPay(browser);
    if (!ok) { report.ok(false, "the till can reach the payment screen (lost-answer case)"); await page.close(); return; }
    const before = await invoiceCount(page);

    /* Let the request through to the server, then throw the response away.
       From the browser this is indistinguishable from never having arrived —
       which is exactly why a blind retry is dangerous. */
    await page.route("**/api/sales", async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      await r.fetch();
      await new Promise((x) => setTimeout(x, 200));
      return r.abort();
    });
    await confirmBtn(page).click();
    await page.waitForTimeout(3500);
    await page.unroute("**/api/sales");

    report.ok(await confirmBtn(page).isDisabled(),
      "Confirm is held shut after a save whose outcome is unknown, so it cannot be posted twice");
    const panel = await panelText(page);
    report.ok(/may not have been saved/i.test(panel),
      "the operator is told the outcome is unknown rather than that it failed", panel);

    await page.getByRole("button", { name: /Check whether it saved/i }).click();
    await page.waitForTimeout(2500);
    const checked = await panelText(page);
    report.ok(/already saved/i.test(checked) && /INV-/.test(checked),
      "the check finds the sale that did post and names the invoice", checked);

    await page.getByRole("button", { name: /Finish without printing/i }).click();
    await page.waitForTimeout(1800);
    const after = await invoiceCount(page);
    report.ok(after === before + 1,
      "a sale posted with the answer lost ends as one invoice, not two", `invoices ${before} → ${after}`);
    report.ok(!(await page.evaluate(() => localStorage.getItem("vy_pos_cart"))),
      "finishing a recovered sale clears the till for the next customer");
    await page.close();
  }

  /* ── 4. no answer at all ───────────────────────────────────────────────── */
  {
    const { page, ok } = await readyToPay(browser);
    if (!ok) { report.ok(false, "the till can reach the payment screen (timeout case)"); await page.close(); return; }

    await page.route("**/api/sales", (r) =>
      r.request().method() === "POST" ? new Promise(() => {}) : r.continue());
    await confirmBtn(page).click();
    await page.waitForTimeout(4000);
    report.ok(/Saving…/.test(await confirmBtn(page).innerText()),
      "the button shows the save in progress while it is genuinely in progress");

    /* api.js gives every request 25s; nothing here is more than a local SQLite
       query, so silence past that is a dead connection, not a slow one. */
    const escaped = await page
      .waitForFunction(() => !!document.querySelector(".dk-saveerr"), null, { timeout: 40000 })
      .then(() => true).catch(() => false);
    report.ok(escaped,
      "a request that never answers gives up instead of spinning for ever");
    report.ok(escaped && !/Saving…/.test(await confirmBtn(page).innerText()),
      "the cashier is not left holding a dead button after a timeout");
    report.ok(!!(await page.evaluate(() => localStorage.getItem("vy_pos_cart"))),
      "a timed-out save does not lose the bill");
    await page.close();
  }

  /* ── 5. the standing connection banner ─────────────────────────────────── */
  {
    const page = await (await browser.newContext()).newPage();
    await signIn(page);
    await page.route("**/api/health", (r) => r.abort());
    const appeared = await page
      .waitForSelector('[data-conn="down"]', { timeout: 15000 })
      .then(() => true).catch(() => false);
    report.ok(appeared, "an unreachable server raises a banner the user cannot miss");
    if (appeared) {
      const txt = await page.locator('[data-conn="down"]').innerText();
      report.ok(/lost|kept|not been saved/i.test(txt),
        "the banner says what has happened to work in progress", txt.replace(/\s+/g, " "));
    }

    await page.unroute("**/api/health");
    const cleared = await page
      .waitForSelector('[data-conn="down"]', { state: "detached", timeout: 15000 })
      .then(() => true).catch(() => false);
    report.ok(cleared, "the banner clears itself when the server comes back, without a reload");
    await page.close();
  }
}
