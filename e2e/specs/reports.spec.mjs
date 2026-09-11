/**
 * reports.spec — open every report and look at what comes out.
 *
 * There are 58 reports across seven groups. They share one list component and
 * one currency helper, so a single careless edit breaks all of them at once —
 * which is the point: 48 currency call sites were rewritten in one pass and
 * nobody opened a single pane until afterwards.
 *
 * The artifact checks are cheap and catch the failures that actually happen:
 * a formatter returning `undefined`, a date that will not parse, a doubled
 * currency symbol, the `item(s)` plural bug creeping back.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

export const name = "reports — all 58 panes render clean";

const GROUPS = ["Sales", "Purchase", "Money", "Receivables", "Payables", "Stock", "Tax & books"];

const INSPECT = `(() => {
  const body = document.body.innerText;
  const bad = [];
  if (/NaN/.test(body)) bad.push("NaN");
  if (/\\bundefined\\b/.test(body)) bad.push("undefined");
  if (/\\[object Object\\]/.test(body)) bad.push("[object Object]");
  if (/ShSh|Sh\\s\\s+Sh/.test(body)) bad.push("doubled currency");
  if (/Invalid Date/.test(body)) bad.push("Invalid Date");
  if (/item\\(s\\)|\\b1 items\\b|\\b1 categories\\b/.test(body)) bad.push("plural");
  return {
    stuck: /Running the report/i.test(body),
    tables: document.querySelectorAll(".rpt-table, table").length,
    rows: document.querySelectorAll("tbody tr").length,
    /* An empty report must say so — a blank pane is a defect, not an empty set.
       Detected by the element the Empty/StateBlock component renders rather
       than by matching its prose, which differs per report and would make this
       a test of copy instead of a test of behaviour. */
    empty: document.querySelectorAll(".state-block, .dk-empty, .rpt-empty").length > 0,
    bad,
    print: [...document.querySelectorAll("button")].filter((b) => /^print$/i.test(b.innerText.trim())).length,
  };
})()`;

export async function run({ browser, report }) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = watchErrors(page);
  await signIn(page);

  /* The picker list stays on screen beside the output, so a report can be
     opened by clicking the next tile — no need to return to the index between
     reports. Doing that per report cost two navigations each and took the run
     from ~2 minutes to over 20. */
  const toIndex = async () => {
    await go(page, "Dashboard");
    await go(page, "Reports");
  };
  const selectGroup = async (g) => {
    const t = page.locator(".dk-tabs button").filter({ hasText: new RegExp(`^${g}\\s*\\d*$`, "i") }).first();
    if (!(await t.count())) return false;
    await t.click();
    await page.waitForTimeout(700);
    return true;
  };

  let opened = 0;
  const broken = [], blank = [], printCount = [];

  for (const g of GROUPS) {
    await toIndex();
    if (!(await selectGroup(g))) continue;
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll(".dk-rp-item")].map((e) => (e.innerText || "").split("\n")[0].trim()).filter(Boolean));

    for (const title of tiles) {
      const tile = page.locator(".dk-rp-item").filter({ hasText: title }).first();
      if (!(await tile.count())) continue;
      const before = errs.length;
      await tile.click();
      /* Wait for the pane to settle rather than guessing: the body carries
         "Running the report…" until the fetch resolves. */
      await page.waitForFunction(() => !/Running the report/i.test(document.body.innerText),
                                 null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(250);
      const st = await page.evaluate(INSPECT);
      opened++;

      const where = `${g} / ${title}`;
      if (st.stuck) broken.push(`${where} — stuck on "Running the report"`);
      else if (errs.length > before) broken.push(`${where} — ${errs.slice(before).join("; ")}`);
      else if (st.bad.length) broken.push(`${where} — ${st.bad.join(", ")}`);
      else if (!st.tables && !st.empty) blank.push(where);
      if (st.print !== 1) printCount.push(`${where} — ${st.print} Print buttons`);
    }
  }

  report.ok(opened >= 50, `opened ${opened} report panes`);
  report.ok(broken.length === 0, "no report errors or formatting artifacts",
            broken.slice(0, 6).join("\n      "));
  report.ok(blank.length === 0, "every report with no rows shows an empty state",
            blank.slice(0, 6).join("\n      "));
  report.ok(printCount.length === 0, "exactly one Print button per report",
            printCount.slice(0, 6).join("\n      "));

  await page.close();
}
