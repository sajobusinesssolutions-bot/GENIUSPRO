/**
 * invoice.spec — the Create Invoice panel.
 *
 * Two things worth pinning down here.
 *
 * Escape must dismiss one layer at a time. The party combo opens its dropdown
 * on mount, and the panel's window-level handler could not see that list (it
 * is a fixed portal, not a `.modal-backdrop`), so the first Escape a user
 * pressed discarded the whole invoice they were part-way through.
 *
 * And the money must add up on screen before it is saved — the earlier layout
 * put the grand total at 18px next to a save button that repeated it, which is
 * how a wrong figure gets past someone.
 *
 * Note there are two components named `InvoiceBuilder` in this codebase's
 * history; the one under test is the sale-entry panel exported from
 * `pages/Invoices.jsx`. The print-template designer is now
 * `pages/InvoiceTemplateDesigner.jsx`, renamed precisely because a fix once
 * landed on the wrong one.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

export const name = "invoice — Escape layering and live totals";

const panelUp = async (page) => (await page.locator(".invb").count()) > 0;
const listUp = async (page) => (await page.locator(".combo-list-fixed").count()) > 0;

async function openPanel(page) {
  await go(page, "Sales");
  await page.getByRole("button", { name: /^New invoice$/i }).first().click();
  await page.waitForTimeout(1600);
}

export async function run({ browser, report }) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = watchErrors(page);
  await signIn(page);
  await openPanel(page);

  report.ok(await panelUp(page), "the Create Invoice panel opens");
  report.ok(await listUp(page), "the party dropdown is open on mount (autoFocus)");

  /* 1 — first Escape closes only the dropdown. */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const listGone = !(await listUp(page));
  const panelStill = await panelUp(page);
  report.ok(listGone && panelStill,
            "the first Escape closes the dropdown and leaves the invoice open",
            `dropdown ${listGone ? "closed" : "still open"}, panel ${panelStill ? "open" : "CLOSED"}`);

  /* 2 — second Escape closes the panel. */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  report.ok(!(await panelUp(page)), "the second Escape closes the invoice panel");

  /* 3 — Escape still works normally when no dropdown is open. */
  await openPanel(page);
  await page.keyboard.press("Escape");     // dismiss the auto-opened list
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  report.ok(!(await panelUp(page)), "Escape still closes the panel with no dropdown open");

  /* 4 — totals track the line, and the save action reflects them. */
  await openPanel(page);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);

  const itemInput = page.locator(".invb-grid input").first();
  if (await itemInput.count()) {
    await itemInput.click();
    await page.keyboard.type("Cement", { delay: 40 });
    await page.waitForTimeout(1000);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);

    /* Read the grand-total element, not the prose. A case-insensitive match on
       "total" also matches "Sub total", which is a different number and made
       this assertion look like it was passing on the wrong figure. */
    const grand = await page.locator(".invb-grand").last().innerText().catch(() => "");
    const digits = grand.replace(/[^\d.]/g, "");
    report.ok(parseFloat(digits) > 0, `the grand total reflects the line (${grand.replace(/\s+/g, " ").trim() || "not found"})`);

    const save = page.getByRole("button", { name: /^Save/i }).first();
    const label = (await save.innerText().catch(() => "")).trim();
    report.ok(await save.isEnabled(), `the save action is enabled ("${label}")`);

    /* The save button must be reachable without scrolling — it used to sit
       below the fold on a 600px viewport. */
    const box = await save.boundingBox();
    const vh = page.viewportSize().height;
    report.ok(box && box.y + box.height <= vh, "the save action is inside the viewport",
              box ? `y ${Math.round(box.y)}–${Math.round(box.y + box.height)} of ${vh}` : "not found");

    /* The header and the row must share one grid — they used to drift. */
    const aligned = await page.evaluate(() => {
      const t = document.querySelector(".invb-grid");
      if (!t) return null;
      const th = [...t.querySelectorAll("thead th")].map((c) => Math.round(c.getBoundingClientRect().left));
      const td = [...t.querySelectorAll("tbody tr")][0];
      if (!td) return null;
      const cells = [...td.children].map((c) => Math.round(c.getBoundingClientRect().left));
      return th.length === cells.length && th.every((x, i) => Math.abs(x - cells[i]) <= 1);
    });
    report.ok(aligned !== false, "the items table header lines up with its rows");
  } else {
    report.ok(false, "the items grid is present");
  }

  report.ok(errs.length === 0, "no page errors in the invoice panel",
            [...new Set(errs)].slice(0, 4).join("\n      "));
  await page.close();
}
