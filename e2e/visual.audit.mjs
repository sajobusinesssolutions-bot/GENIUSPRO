/**
 * visual.audit.mjs — the design review, measured rather than argued.
 *
 * The review (UI-REVIEW.md) makes four claims that can be counted in a live
 * browser rather than debated in a pull request:
 *
 *   §2  two container levels, maximum. "Cards inside cards inside cards" costs
 *       32–48px of horizontal space per level and adds a border the eye has to
 *       parse.
 *   §3  a four-step type ramp — Figure, Title, Body, Caption — and nothing
 *       else. Eleven combinations is not a hierarchy, it is noise.
 *   §3  every money figure is tabular and right-aligned. Columns that do not
 *       align at the decimal point cannot be scanned, and scanning them is the
 *       whole job.
 *   §4  one accent for "the action you probably want", one for destructive,
 *       and the three money colours. Nothing else.
 *
 * It reports per page so a pass can be judged by a number that moves, not by
 * whether the screenshot feels tidier.
 *
 *   node e2e/visual.audit.mjs [page…]
 */
import { chromium } from "playwright";
const BASE = "http://localhost:4177";
const PAGES = process.argv.slice(2).length ? process.argv.slice(2)
  : ["Dashboard", "Sales", "Purchases", "Items", "Parties", "Cash & bank", "Reports", "Settings"];

const AUDIT = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inMain = (el) => !el.closest(".dk-rail") && !el.closest(".dk-topbar");

  /* A "box" is anything drawing its own container: a visible border or a
     background different from the page. That is what the eye parses as a
     level, whatever it is called in the markup. */
  const isBox = (el) => {
    const cs = getComputedStyle(el);
    const border = ["Top", "Right", "Bottom", "Left"]
      .filter((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none").length;
    const bg = cs.backgroundColor;
    const painted = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    const r = el.getBoundingClientRect();
    return (border >= 3 || (painted && parseFloat(cs.borderRadius) >= 6)) && r.width > 180 && r.height > 60;
  };

  const boxes = [...document.querySelectorAll("div, section, article, aside, form")]
    .filter((el) => vis(el) && inMain(el) && isBox(el));
  const depthOf = (el) => boxes.filter((b) => b !== el && b.contains(el)).length + 1;
  let maxDepth = 0;
  const deep = [];
  for (const b of boxes) {
    const d = depthOf(b);
    if (d > maxDepth) maxDepth = d;
    if (d >= 3) deep.push((b.className || b.tagName).toString().slice(0, 40));
  }

  /* Type combinations actually painted on text the eye reads. Empty nodes and
     one-off icon glyphs are not typography. */
  const combos = new Map();
  for (const el of document.querySelectorAll("*")) {
    if (!inMain(el) || !vis(el)) continue;
    /* SVG text is a chart label. It follows the visualisation's own rules
       (see the dataviz work in session 6), not the interface type ramp, and
       counting it here would report a chart axis as a typographic
       inconsistency. */
    if (el.ownerSVGElement || el.tagName === "svg") continue;
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (txt.length < 2) continue;
    const cs = getComputedStyle(el);
    const key = `${Math.round(parseFloat(cs.fontSize))}/${cs.fontWeight}${/upper/.test(cs.textTransform) ? "/caps" : ""}`;
    combos.set(key, (combos.get(key) || 0) + 1);
  }

  /* Money that cannot be scanned: a cell whose text is a figure but which is
     neither right-aligned nor tabular. */
  const MONEY = /^[^\w]*\d[\d,\s.]*(\.\d+)?$/;
  const bad = [];
  for (const el of document.querySelectorAll("td, th, .amt, .v, .big")) {
    if (!inMain(el) || !vis(el)) continue;
    const t = (el.textContent || "").trim();
    if (!MONEY.test(t) || t.length < 2) continue;
    const cs = getComputedStyle(el);
    const tabular = /tabular-nums/.test(cs.fontVariantNumeric) || /tabular/.test(cs.fontFeatureSettings);
    const right = cs.textAlign === "right" || cs.textAlign === "end";
    if (!tabular || !right) bad.push(`${t.slice(0, 12)}${right ? "" : " ←left"}${tabular ? "" : " ←not tabular"}`);
  }

  /* Filled buttons: how many different "primary" colours is the eye being
     taught? One accent and one destructive is the budget. */
  const fills = new Map();
  for (const el of document.querySelectorAll("button, .btn, a.btn")) {
    if (!inMain(el) || !vis(el)) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)") continue;
    const m = bg.match(/\d+/g) || [];
    const [r, g, b, a] = [ +m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3] ];
    if (a < 0.5) continue;
    const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (light > 0.82) continue;                     // a pale chip is not a filled button
    fills.set(bg, (fills.get(bg) || 0) + 1);
  }

  return {
    boxes: boxes.length, maxDepth, deep: [...new Set(deep)].slice(0, 4),
    typeCombos: [...combos.entries()].sort((a, b) => b[1] - a[1]),
    money: bad.length, moneyExamples: bad.slice(0, 4),
    fills: [...fills.entries()].sort((a, b) => b[1] - a[1]),
  };
};

/* Signing in for an audit run.
 *
 * On a single-shop database this is a username and a password. On one holding
 * several — which any database an onboarding suite has run against does — the
 * screen asks which shop first, and an unauthenticated tool cannot guess.
 * `GENIUS_SHOP` answers it; without one, say so plainly rather than time out
 * waiting for a field that is not there. */
async function signIn(p, BASE) {
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  if (await p.getByLabel("Shop code").count()) {
    const shop = process.env.GENIUS_SHOP;
    if (!shop) {
      console.error("This installation holds several shops, so sign-in needs a shop code.\n" +
        "  Set GENIUS_SHOP=<code>, or point the server at a fresh copy of backend/data/genius.db.");
      process.exit(2);
    }
    await p.getByLabel("Shop code").fill(shop);
    await p.getByRole("button", { name: "Continue" }).click();
    await p.waitForTimeout(1200);
  }
  await p.getByRole("button", { name: "Username" }).click().catch(() => {});
  await p.getByLabel("Username").fill(process.env.GENIUS_USER || "admin");
  await p.locator('input[type="password"]').fill(process.env.GENIUS_PASS || "admin123");
  await p.getByRole("button", { name: "Open shop" }).click();
  await p.waitForTimeout(3200);
}

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await signIn(p, BASE);

const results = [];
for (const label of PAGES) {
  const nav = p.locator(".dk-rail .dk-nav").filter({ hasText: new RegExp(`${label}$`, "i") }).first();
  if (!(await nav.count())) { console.log(`(no rail entry for ${label})`); continue; }
  await nav.click();
  await p.waitForTimeout(1800);
  const r = await p.evaluate(AUDIT);
  results.push({ label, ...r });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + pad("page", 14) + pad("boxes", 7) + pad("depth", 7) + pad("type", 6) + pad("money✗", 8) + "fills");
for (const r of results) {
  console.log(pad(r.label, 14) + pad(r.boxes, 7) + pad(r.maxDepth, 7) + pad(r.typeCombos.length, 6)
    + pad(r.money, 8) + r.fills.length);
}
console.log("\ndetail");
for (const r of results) {
  console.log(`\n${r.label}`);
  if (r.maxDepth >= 3) console.log(`  nesting ${r.maxDepth}: ${r.deep.join(" | ")}`);
  console.log(`  type: ${r.typeCombos.map(([k, n]) => `${k}×${n}`).join("  ")}`);
  if (r.money) console.log(`  money: ${r.moneyExamples.join(" | ")}`);
  if (r.fills.length > 2) console.log(`  fills: ${r.fills.map(([k, n]) => `${k}×${n}`).join("  ")}`);
}
await b.close();
