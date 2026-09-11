/**
 * cssinfluence.mjs — what a stylesheet is actually doing.
 *
 * `deadcss.mjs` answers "does anything match this rule". This answers the
 * harder question the review was really asking about `styles.css`: **if it
 * were not there, what would move?**
 *
 * It records the position and size of every element on every page, twice —
 * once as built, once with the stylesheet's rules removed from the live
 * CSSOM — and reports how many elements shift. Geometry rather than pixels,
 * because it needs no image tooling and it names the elements that move.
 *
 * A rule that changes only colour will not show up here, so a zero does not
 * mean "delete the file"; it means "nothing about the layout depends on it",
 * which is the half that breaks a screen when it is removed.
 *
 *   node e2e/cssinfluence.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:4177";
const PAGES = ["Dashboard", "Sales", "Purchases", "Items", "Parties", "Cash & bank", "Reports", "Settings", "Staff"];

/* Selector list, so the page can tell which rules came from this file. */
const src = fs.readFileSync("frontend/src/styles.css", "utf8");
const sels = [...new Set([...src.matchAll(/(^|[};])\s*([^@{};][^{}]*?)\s*\{/g)]
  .map((m) => m[2].replace(/\s+/g, " ").trim()).filter(Boolean))];

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

const geometry = () => p.evaluate(() => {
  const out = {};
  let i = 0;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    out[`${i++}:${el.tagName}.${(el.className || "").toString().split(/\s+/)[0]}`] =
      [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  }
  return out;
});

const strip = () => p.evaluate((sels) => {
  const want = new Set(sels);
  let removed = 0;
  for (const sh of document.styleSheets) {
    let rs; try { rs = sh.cssRules; } catch { continue; }
    for (let i = rs.length - 1; i >= 0; i--) {
      const r = rs[i];
      const key = r.selectorText && r.selectorText.replace(/\s+/g, " ").trim();
      if (key && want.has(key)) { sh.deleteRule(i); removed++; }
    }
  }
  return removed;
}, sels);

let totalMoved = 0, totalEls = 0;
for (const label of PAGES) {
  const nav = p.locator(".dk-rail .dk-nav").filter({ hasText: new RegExp(`${label}$`, "i") }).first();
  if (!(await nav.count())) continue;
  await nav.click();
  await p.waitForTimeout(1500);
  const before = await geometry();
  const removed = await strip();
  await p.waitForTimeout(400);
  const after = await geometry();
  let moved = [];
  for (const k of Object.keys(before)) {
    const a = before[k], c = after[k];
    if (!c) continue;
    if (a.some((v, i) => Math.abs(v - c[i]) > 1)) moved.push(k.split(":")[1]);
  }
  totalMoved += moved.length; totalEls += Object.keys(before).length;
  console.log(`${label.padEnd(13)} ${String(Object.keys(before).length).padStart(4)} elements, ` +
    `${removed} rules removed → ${moved.length} moved  ${[...new Set(moved)].slice(0, 5).join(" ")}`);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2200);
}
console.log(`\n${totalMoved} of ${totalEls} elements move when styles.css is taken out.`);
await b.close();
