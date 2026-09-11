/**
 * pos-till.spec — three things a photograph of a real till showed going wrong.
 *
 *  1. A "new" till that opened with somebody else's bill already in it.
 *     `lines` was seeded straight from localStorage, and localStorage belongs
 *     to the browser rather than to the person signed into it, so the previous
 *     cashier's Sh 50,000 service was sitting in the cart under a green Take
 *     payment button before the next customer had said a word. The recovery is
 *     worth keeping; putting it on screen unasked is not. This asserts the till
 *     opens EMPTY and that the saved bill arrives as a question.
 *
 *  2. The End of day count. `repeat(4, 1fr)` over cells holding a bare <input>
 *     cannot shrink below the input's ~227px intrinsic width, so the grid
 *     measured 938px inside a 598px dialog that clips horizontally — half the
 *     denominations were drawn off the right edge where nobody could count
 *     them. Measured, not eyeballed, at the three sizes shops actually use.
 *
 *  3. Sales-rep attribution. Every sale_invoices row has sales_rep_id and the
 *     per-person reports group on it, but the only way to set it was a field on
 *     the payment screen that appeared only when require_sales_rep was on.
 *     This drives the cart-screen picker with the keyboard and follows the
 *     chosen rep all the way to the report.
 */
import { signIn, go, watchErrors, BASE } from "../harness.mjs";

export const name = "till — a clean start, the drawer count, and who sold it";

const cart = async (page) =>
  ((await page.locator("body").innerText()).match(/\d+ items? · [\d.]+ qty/) || ["(none)"])[0];

const token = (page) => page.evaluate(() => localStorage.getItem("vy_token"));

async function ringUpCement(page) {
  const search = page.locator('input[placeholder*="Scan barcode"]');
  await search.click();
  await search.fill("Cement");
  await page.waitForTimeout(1100);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

/** Sign in as somebody else without wiping the till's own saved bill — which
    is exactly what a shift handover does. */
async function switchUser(page, username, password) {
  await page.evaluate(() => {
    localStorage.removeItem("vy_token");
    localStorage.removeItem("vy_user");
    sessionStorage.clear();
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  /* The username box carries no type attribute, so anchor on "not a password". */
  await page.locator(".dk-login-field input:not([type=password])").fill(username);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole("button", { name: /open shop/i }).click();
  await page.waitForSelector(".dk-rail", { timeout: 20000 });
  await page.waitForTimeout(1500);
}

export async function run({ browser, report }) {
  const page = await (await browser.newContext()).newPage();
  const errs = watchErrors(page);
  await signIn(page);

  /* ── 1. the till opens empty ───────────────────────────────────────────── */
  if (!(await go(page, "Till"))) { report.ok(false, "Till is reachable"); return; }
  await page.waitForTimeout(1400);
  await ringUpCement(page);
  const rung = await cart(page);
  if (!/1 item/.test(rung)) { report.ok(false, "a line can be rung up", rung); return; }

  const savedByAdmin = await page.evaluate(() => localStorage.getItem("vy_pos_cart"));
  report.ok(!!savedByAdmin && /"byName"/.test(savedByAdmin),
            "the in-progress bill is saved with the name of who started it",
            String(savedByAdmin).slice(0, 120));

  await switchUser(page, "sales", "sales123");
  await go(page, "Till");
  await page.waitForTimeout(2200);

  report.ok(/^0 items/.test(await cart(page)),
            "a cashier signing on finds an EMPTY till, not the last cashier's bill",
            await cart(page));

  const offer = page.locator(".pos-recover");
  report.ok((await offer.count()) === 1,
            "the unfinished bill is offered as a question instead of loaded silently");
  const offerText = await offer.innerText().catch(() => "");
  report.ok(/Administrator/.test(offerText),
            "the offer names the cashier who left the bill", offerText.slice(0, 140));
  report.ok(/42,000/.test(offerText),
            "the offer shows what the bill would charge", offerText.slice(0, 200));
  report.ok((await page.locator(".pos-recover-who.stale").count()) === 1,
            "another cashier's bill is flagged rather than presented as yours");

  /* The whole failure mode is a till key charging a customer for a line nobody
     chose. F12 is "cash sale, print" — it must be inert until the offer is
     answered. */
  await page.keyboard.press("F12");
  await page.waitForTimeout(900);
  report.ok((await page.locator(".pos-recover").count()) === 1 && /^0 items/.test(await cart(page)),
            "F12 cannot ring up a sale while the unfinished-bill question is open",
            await cart(page));

  await page.locator(".pos-recover-btn.discard").click();
  await page.waitForTimeout(800);
  const afterDiscard = await page.evaluate(() => [
    localStorage.getItem("vy_pos_cart"), localStorage.getItem("vy_pos_ref")]);
  report.ok(/^0 items/.test(await cart(page)) && !afterDiscard[0],
            "Discard leaves an empty till and nothing on disk", JSON.stringify(afterDiscard));
  /* The idempotency reference has to go with the bill. Left behind, the next
     unrelated sale would look to the server like a retry of the discarded one
     and be answered with the wrong invoice. */
  report.ok(!afterDiscard[1], "Discard also retires the bill's idempotency reference");

  /* The power-cut case the recovery exists for still works — offered, then
     resumed on purpose. */
  await ringUpCement(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await go(page, "Till");
  await page.waitForTimeout(2000);
  report.ok((await page.locator(".pos-recover").count()) === 1 && /^0 items/.test(await cart(page)),
            "after a reload the cashier's own bill is offered, still not auto-loaded");
  report.ok((await page.locator(".pos-recover-who.stale").count()) === 0,
            "your own bill from this session is not flagged as somebody else's");
  await page.locator(".pos-recover-btn.resume").click();
  await page.waitForTimeout(1000);
  report.ok(/1 item/.test(await cart(page)),
            "Resume puts the bill back, so a power cut still costs nothing", await cart(page));

  /* ── 2. the End of day count fits ──────────────────────────────────────── */
  /* Back to admin, who holds the open shift the count belongs to. Clear the
     bill left behind above so the prompt is not covering the till bar. */
  await switchUser(page, "admin", "admin123");
  await go(page, "Till");
  await page.waitForTimeout(1800);
  if (await page.locator(".pos-recover").count()) {
    await page.locator(".pos-recover-btn.discard").click();
    await page.waitForTimeout(700);
  }
  for (const [w, h] of [[1366, 768], [1536, 864], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await go(page, "Till");
    await page.waitForTimeout(1300);
    const admin = page.locator("button", { hasText: /Administrator/i }).first();
    if (!(await admin.count())) { report.ok(false, `Administrator button at ${w}x${h}`); continue; }
    await admin.click();
    await page.waitForTimeout(600);
    await page.locator(".dk-drawer-item", { hasText: /End of day/ }).click();
    await page.waitForTimeout(1300);

    if (!(await page.locator(".eod-denom").count())) {
      report.ok(false, `the drawer count is on screen at ${w}x${h}`,
                "no open shift on this till — the count cannot be measured");
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      continue;
    }
    /* A difference, so the "Explain the difference" field is on screen too —
       that is the state the photograph was taken in. */
    await page.locator(".eod-denom input").nth(0).fill("3");
    await page.waitForTimeout(500);

    const m = await page.evaluate(() => {
      const bx = (el) => { const r = el.getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const modal = document.querySelector(".dk-modal");
      const mb = bx(modal);
      const cells = [...document.querySelectorAll(".eod-denom")].map((d) => {
        const lb = bx(d.querySelector("span")), ib = bx(d.querySelector("input"));
        return { box: bx(d), sameRow: !(lb.b <= ib.t || ib.b <= lb.t), before: lb.r <= ib.l + 0.5 };
      });
      const field = document.querySelector(".dk-mbody .dk-field");
      const foot = bx(document.querySelector(".dk-mfoot"));
      const varEl = document.querySelector(".dk-variance");
      return {
        cells: cells.length,
        widest: Math.max(...cells.map((c) => c.box.r)) - mb.r,
        inside: cells.every((c) => c.box.l >= mb.l - 0.5 && c.box.r <= mb.r + 0.5),
        joined: cells.every((c) => c.sameRow && c.before),
        overflowX: modal.scrollWidth - modal.clientWidth,
        overflowY: modal.scrollHeight - modal.clientHeight,
        modalH: mb.h,
        varianceText: varEl.innerText.replace(/\s+/g, " ").trim(),
        varianceW: bx(varEl).w,
        gap: field ? foot.t - bx(field).b : null,
      };
    });

    report.ok(m.cells === 8 && m.inside,
              `every denomination box is inside the dialog at ${w}x${h}`,
              `${m.cells} cells, widest overhangs the modal by ${m.widest.toFixed(0)}px`);
    report.ok(m.joined,
              `no denomination is separated from its input at ${w}x${h}`);
    report.ok(m.overflowX === 0,
              `the dialog has nothing clipped off its right edge at ${w}x${h}`,
              `scrollWidth − clientWidth = ${m.overflowX}px`);
    report.ok(m.overflowY <= 1,
              `the whole dialog fits without internal scrolling at ${w}x${h}`,
              `content ${m.modalH.toFixed(0)}px, overflow ${m.overflowY}px`);
    report.ok(/Short by/.test(m.varianceText) && /[\d,]{5,}/.test(m.varianceText) && m.varianceW > 200,
              `the Short-by figure is legible at ${w}x${h}`, `"${m.varianceText}" in ${m.varianceW.toFixed(0)}px`);
    report.ok(m.gap !== null && m.gap > 0,
              `"Explain the difference" clears the buttons at ${w}x${h}`,
              `${m.gap === null ? "field missing" : m.gap.toFixed(0) + "px gap"}`);

    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  /* ── 3. the sale is credited to the person who made it ─────────────────── */
  await go(page, "Till");
  await page.waitForTimeout(1500);
  if (await page.locator(".pos-recover").count()) {
    await page.locator(".pos-recover-btn.discard").click();
    await page.waitForTimeout(600);
  }

  const rep = page.locator(".pos-rep-sel");
  report.ok((await rep.count()) === 1,
            "the sales rep is chosen on the cart, before payment — not buried in checkout");
  const me = await page.evaluate(() => JSON.parse(localStorage.getItem("vy_user") || "{}"));
  report.ok(String(await rep.inputValue()) === String(me.id),
            "it defaults to whoever is signed in", `field ${await rep.inputValue()}, user ${me.id}`);

  /* Keyboard only: F4 from anywhere on the till must land on the control. A
     barcode scanner and an F-key layout is the whole point of this screen. */
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("F4");
  await page.waitForTimeout(400);
  report.ok(await page.evaluate(() => document.activeElement?.classList.contains("pos-rep-sel")),
            "F4 puts the cursor on the sales rep without touching the mouse");

  const other = await page.evaluate(() => {
    const s = document.querySelector(".pos-rep-sel");
    const me2 = JSON.parse(localStorage.getItem("vy_user") || "{}");
    const o = [...s.options].find((x) => x.value && String(x.value) !== String(me2.id));
    return o ? { value: o.value, label: o.textContent } : null;
  });
  if (!other) { report.ok(false, "a second member of staff can be credited"); return; }
  await rep.selectOption(other.value);
  await page.waitForTimeout(400);

  await ringUpCement(page);
  await page.keyboard.press("F10");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Exact$/ }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /Save, no print/i }).click();
  await page.waitForTimeout(2500);

  const doneText = await page.locator("body").innerText();
  const invoiceNo = (doneText.match(/\b(?:INV|SI)[-/\w]*\d+/) || [])[0] || null;
  report.ok(/served|sold/i.test(doneText) && doneText.includes(other.label.trim()),
            "the completion screen credits the rep who was chosen, not the operator",
            `looking for "${other.label.trim()}"`);

  /* The persisted row, read back from the API rather than from the screen. */
  const t = await token(page);
  const persisted = await page.evaluate(async ([tok, rid]) => {
    const j = async (u) => (await (await fetch(u, { headers: { Authorization: "Bearer " + tok } })).json()).data;
    const list = await j("/api/sales?limit=5");
    const rows = Array.isArray(list) ? list : (list.rows || list.items || []);
    const newest = rows[0];
    const full = newest ? await j(`/api/sales/${newest.id}`) : null;
    return full ? { id: full.id, no: full.invoice_no, rep: full.sales_rep_id, repName: full.sales_rep_name,
                    createdBy: full.created_by } : null;
  }, [t, invoiceNo]);
  report.ok(persisted && String(persisted.rep) === String(other.value),
            "the chosen rep is on the saved invoice row, not the signed-in user",
            JSON.stringify(persisted));
  report.ok(persisted && String(persisted.createdBy) !== String(persisted.rep),
            "cashier and rep are recorded separately, so the audit trail survives",
            JSON.stringify(persisted));

  const inReport = await page.evaluate(async ([tok, repId]) => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(`/api/reports/sale-summary-by-user?from=${today}&to=${today}`,
                          { headers: { Authorization: "Bearer " + tok } });
    const rows = (await r.json()).data || [];
    return (Array.isArray(rows) ? rows : rows.rows || []).find((x) => String(x.rep_id) === String(repId)) || null;
  }, [t, other.value]);
  report.ok(inReport && Number(inReport.invoices) > 0,
            "Sales by user shows the sale under the rep who was picked at the till",
            JSON.stringify(inReport));

  report.ok(errs.length === 0, "no page errors across the till, the drawer count and the sale",
            [...new Set(errs)].slice(0, 4).join("\n      "));
  await page.close();
}
