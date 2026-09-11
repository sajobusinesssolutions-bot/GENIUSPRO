/**
 * receipt.spec — ring up a real sale and inspect the paper.
 *
 * The receipt is the one artifact a customer keeps, and it is built in a popup
 * via `window.open` + `document.write`, so it is invisible to every check that
 * only looks at the app's own DOM. Two defects lived there unnoticed:
 *
 *  - the barcode carried a fixed pixel width and ran 70px off a 2in roll, so
 *    the tail of the invoice number was cut off and the code would not scan;
 *  - a deducted tax printed as "Less: VAT 18", i.e. a withholding deduction
 *    described to the customer as VAT, while the till called the same figure
 *    "Withholding tax" and the ledger called it a WHT credit.
 *
 * This spec completes a genuine sale — it writes to the throwaway database the
 * harness created, never to `backend/data/genius.db`.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

export const name = "receipt — a real sale, on real paper widths";

/* 3in and 2in thermal rolls at 203dpi, plus a deliberately tight case. */
const ROLLS = [576, 384, 300];

export async function run({ browser, report }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 850 } });
  /* Neutralise print() so the run does not block on a print dialog, and keep
     a handle on the popup the receipt is written into. */
  const popups = [];
  ctx.on("page", (p) => popups.push(p));
  await ctx.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });

  const page = await ctx.newPage();
  const errs = watchErrors(page);
  /* signIn sets the viewport, so pass it explicitly rather than relying on the
     context default — and assert against the real height below, never a
     literal. Getting that wrong made this spec report a regression that was
     not there. */
  const VH = 850;
  await signIn(page, { width: 1440, height: VH });

  if (!(await go(page, "Till"))) { report.ok(false, "Till is reachable"); return; }
  await page.waitForTimeout(1500);

  const search = page.locator('input[placeholder*="Scan barcode"]');
  await search.click();
  await search.fill("Cement");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1300);

  await page.getByRole("button", { name: /take payment/i }).first().click();
  await page.waitForTimeout(1500);

  /* The action bar used to sit 79px below the visible panel. */
  const confirm = page.getByRole("button", { name: /confirm.*print|confirm/i }).first();
  const box = await confirm.boundingBox();
  const vh = page.viewportSize().height;
  report.ok(box && box.y + box.height <= vh,
            "'Confirm & print' is inside the viewport without scrolling",
            box ? `y ${Math.round(box.y)}–${Math.round(box.y + box.height)} of ${vh}` : "not found");

  /* Confirm stays disabled until the till has been paid — that is correct. */
  await page.getByRole("button", { name: /^Exact$/ }).first().click();
  await page.waitForTimeout(700);
  await confirm.click();
  await page.waitForTimeout(3500);

  const rc = popups[popups.length - 1];
  if (!rc) { report.ok(false, "a receipt window opened"); await page.close(); return; }
  await rc.waitForLoadState("domcontentloaded").catch(() => {});
  await rc.waitForTimeout(900);

  const info = await rc.evaluate(() => ({
    printed: window.__printed || 0,
    text: document.body.innerText,
    w: document.body.scrollWidth,
  }));

  report.ok(info.printed === 1, `print() called exactly once (${info.printed})`);
  report.ok(/INV-\d+/.test(info.text), "the receipt carries an invoice number");
  report.ok(/Total/i.test(info.text), "the receipt carries a total");
  report.ok(!/Less:/i.test(info.text),
            "a deducted tax is not described as 'Less: <tax name>'",
            (info.text.match(/^.*Less:.*$/mi) || [])[0]);
  report.ok(/Withholding/i.test(info.text) || !/−|-\s?Sh/.test(info.text),
            "a deduction is named as withholding, matching the till and the ledger");

  for (const roll of ROLLS) {
    await rc.setViewportSize({ width: roll, height: 900 });
    await rc.waitForTimeout(250);
    const m = await rc.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      over: [...document.querySelectorAll("*")]
        .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 2)
        .slice(0, 3).map((e) => e.tagName.toLowerCase()),
    }));
    report.ok(m.doc <= m.client + 2, `receipt fits a ${roll}px roll`,
              m.doc > m.client + 2 ? `${m.doc}px of content in ${m.client}px — overflowing: ${m.over.join(", ")}` : "");
  }

  report.ok(errs.length === 0, "no page errors completing a sale",
            [...new Set(errs)].slice(0, 4).join("\n      "));
  await page.close();
}
