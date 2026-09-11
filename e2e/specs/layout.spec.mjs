/**
 * layout.spec — no control may be unreachable, at any supported viewport.
 *
 * This is the spec that pays for the suite. It walks every page and reports an
 * element only when it is clipped by an `overflow: hidden` ancestor **that
 * cannot scroll** — a scrollable ancestor anywhere up the chain counts as
 * reachable. An earlier hand-run audit that skipped that check produced 23
 * false positives on Settings alone and nearly triggered a bogus "fix".
 *
 * It also flags controls genuinely covered by the sticky header, requiring
 * overlap on *both* axes so the sidebar is not a false positive.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

const VIEWPORTS = [
  [1254, 596],   // smallest the original review observed
  [1280, 600],
  [1440, 900],
  [1707, 811],   // largest observed
  [900, 700],    // below the design range, where band containers used to collapse
];

const PAGES = ["Dashboard", "Sales", "Items", "Parties", "Purchases", "Cash & bank",
               "Reports", "Accounting", "Stock take", "Staff", "Shifts", "Tax & URA",
               "Settings"];

const AUDIT = `(() => {
  const scrollable = (el, axis) => {
    const cs = getComputedStyle(el);
    const o = axis === "y" ? cs.overflowY : cs.overflowX;
    if (o !== "auto" && o !== "scroll") return false;
    return axis === "y" ? el.scrollHeight > el.clientHeight + 1
                        : el.scrollWidth > el.clientWidth + 1;
  };
  const bad = [], seen = new Set();
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, table")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    let p = el.parentElement, verdict = null;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p), pr = p.getBoundingClientRect();
      const hidX = cs.overflowX === "hidden" || cs.overflow === "hidden";
      const hidY = cs.overflowY === "hidden" || cs.overflow === "hidden";
      const overR = r.right - pr.right, overB = r.bottom - pr.bottom, overT = pr.top - r.top;
      if (hidX && overR > 2 && !scrollable(p, "x")) { verdict = { why: "clipped-x", by: p, px: overR }; break; }
      if (hidY && overB > 2 && !scrollable(p, "y")) { verdict = { why: "clipped-y", by: p, px: overB }; break; }
      if (hidY && overT > 2 && !scrollable(p, "y")) { verdict = { why: "clipped-top", by: p, px: overT }; break; }
      if (scrollable(p, "y") && (overB > 2 || overT > 2)) break;   // rescued
      if (scrollable(p, "x") && overR > 2) break;
      p = p.parentElement;
    }
    if (!verdict) continue;
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    const key = el.tagName + text + verdict.why;
    if (seen.has(key)) continue;
    seen.add(key);
    bad.push(\`\${verdict.why} \${Math.round(verdict.px)}px <\${el.tagName.toLowerCase()}> "\${text}" by .\${(verdict.by.className || verdict.by.tagName).toString().split(" ")[0]}\`);
  }
  const hdr = document.querySelector(".dk-top");
  if (hdr) {
    const hb = hdr.getBoundingClientRect();
    for (const el of document.querySelectorAll("button, input, select")) {
      if (hdr.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 2) continue;
      if (Math.min(r.right, hb.right) - Math.max(r.left, hb.left) <= 0) continue;  // no x overlap
      const cover = Math.min(r.bottom, hb.bottom) - Math.max(r.top, hb.top);
      if (cover > r.height * 0.34) {
        bad.push(\`under-header \${Math.round(cover / r.height * 100)}% "\${(el.innerText || el.value || "").trim().slice(0, 40)}"\`);
      }
    }
  }
  return { bad, docOverX: document.documentElement.scrollWidth - innerWidth };
})()`;

export const name = "layout — nothing unreachable";

export async function run({ browser, report }) {
  const page = await (await browser.newContext()).newPage();
  const errs = watchErrors(page);

  for (const [w, h] of VIEWPORTS) {
    await signIn(page, { width: w, height: h });
    const problems = [];
    for (const label of PAGES) {
      if (!(await go(page, label))) continue;   // module off in this dataset
      const r = await page.evaluate(AUDIT);
      for (const b of r.bad) problems.push(`${label}: ${b}`);
      if (r.docOverX > 0) problems.push(`${label}: document overflows horizontally by ${r.docOverX}px`);
    }
    report.ok(problems.length === 0, `${w}×${h} — every control reachable`,
              problems.slice(0, 8).join("\n      "));
  }

  report.ok(errs.length === 0, "no page or console errors while walking every page",
            [...new Set(errs)].slice(0, 5).join("\n      "));
  await page.close();
}
