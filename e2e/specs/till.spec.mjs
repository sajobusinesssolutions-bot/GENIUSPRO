/**
 * till.spec — the till must never show a total the bill does not contain.
 *
 * Every assertion here is a bug that actually shipped:
 *  - quantity only committed on blur, so `Ctrl+P Save & print` was one
 *    keystroke away from a stale total on screen;
 *  - Enter reverted the typed quantity instead of committing it;
 *  - and the fix for those introduced a worse one — a "did I cause this?"
 *    guard that never cleared after a no-op commit, so typing the value that
 *    was already there and then pressing F6 silently undid the unit flip and
 *    sold 1 KG instead of 50.
 *
 * That last case is why this spec exists. It is invisible to a type check and
 * to any test that does not press the keys in that order.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

export const name = "till — quantity, Enter, and the unit flip";

const cart = async (page) => {
  const t = await page.locator("body").innerText();
  return (t.match(/\d+ items? · [\d.]+ qty/) || ["(empty)"])[0];
};
const payable = async (page) => {
  const t = await page.locator("body").innerText();
  return (t.match(/Take payment\s*\n?([^\n]*)/i) || [])[1]?.trim() || "";
};

export async function run({ browser, report }) {
  const page = await (await browser.newContext()).newPage();
  const errs = watchErrors(page);
  await signIn(page);

  if (!(await go(page, "Till"))) { report.ok(false, "Till is reachable"); return; }
  await page.waitForTimeout(1500);

  const search = page.locator('input[placeholder*="Scan barcode"]');
  if (!(await search.count())) { report.ok(false, "till search box present"); return; }
  await search.click();
  await search.fill("Cement");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1400);
  report.ok(/1 item/.test(await cart(page)), `a line was added (${await cart(page)})`);

  /* First input inside the cart body is the quantity cell — the item name is
     plain text, so this does not depend on column order elsewhere. */
  const qty = page.locator("tbody input").first();
  if (!(await qty.count())) { report.ok(false, "quantity cell present"); return; }
  /* Decimal places are configurable, so compare numerically, not as a string. */
  const qtyValue = async () => parseFloat(await qty.inputValue().catch(() => "NaN"));

  /* 1 — live commit. Type, do NOT blur. */
  const before = await payable(page);
  await qty.click();
  await qty.press("Control+a");
  await page.keyboard.type("3", { delay: 90 });
  await page.waitForTimeout(650);
  const during = await payable(page);
  report.ok(before !== during && during !== "",
            "total updates while typing, before any blur", `${before} → ${during}`);

  /* 2 — Enter commits rather than reverting. */
  await page.keyboard.press("Enter");
  await page.waitForTimeout(650);
  const cellAfterEnter = await qtyValue();
  report.ok(cellAfterEnter === 3, `Enter commits the typed quantity (cell reads ${cellAfterEnter})`);
  report.ok((await payable(page)) === during, "Enter does not change the total again");

  /* 3 — the data-loss case: a no-op commit must not swallow the next external
     change. Type the value that is already there, then flip the unit. */
  await qty.click();
  await qty.press("Control+a");
  await page.keyboard.type("3", { delay: 80 });
  await page.waitForTimeout(500);
  const beforeFlip = await cart(page);
  await page.keyboard.press("F6");
  await page.waitForTimeout(1000);
  const afterFlip = await cart(page);
  const cellAfterFlip = await qtyValue();
  report.ok(beforeFlip !== afterFlip,
            "a no-op commit does not silently undo the F6 unit flip",
            `${beforeFlip} → ${afterFlip}, cell "${cellAfterFlip}"`);

  /* 4 — line selection and the void-reason gate. */
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(350);
  report.ok((await page.locator("tr.on").count()) > 0, "ArrowDown selects a cart line");

  await page.keyboard.press("Delete");
  await page.waitForTimeout(900);
  const dialogUp = await page.locator(".dk-modal, .modal, [class*=veil]").count();
  report.ok(dialogUp > 0, "Del asks for a void reason rather than deleting silently");

  report.ok(errs.length === 0, "no page errors at the till",
            [...new Set(errs)].slice(0, 4).join("\n      "));
  await page.close();
}
