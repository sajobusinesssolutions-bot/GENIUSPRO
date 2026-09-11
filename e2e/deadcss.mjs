/**
 * deadcss.mjs — which rules in a stylesheet are actually reached.
 *
 * The design review's first recommendation was to finish killing
 * `styles.css`: *"every rule in it is either dead or a landmine — it is what
 * wrecked the printed tables."* Deleting it by reading it is guesswork; this
 * walks the running application instead and asks, per selector, whether
 * anything on any screen matches it.
 *
 * Two things it is careful about, because both would delete something live:
 *
 *   - **`@media print` rules never match on screen.** They are collected
 *     separately and reported as print, never as dead. The printed invoice is
 *     the one surface nobody sees fail until a customer is holding it.
 *   - **A selector that matches nothing on the pages walked is a candidate,
 *     not a verdict.** Modals, empty states and error screens are not on the
 *     happy path; anything matched by a screen this walk does not open would
 *     be reported dead and would not be.
 *
 *   node e2e/deadcss.mjs
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:4177";
const CSS = "frontend/src/styles.css";
const PAGES = ["Dashboard", "Sales", "Purchases", "Items", "Parties", "Cash & bank",
  "Reports", "Settings", "Staff", "Accounting", "Stock take", "Tax & URA", "Data tools", "Companies", "Shifts"];

/* Selectors, and whether the rule sits inside @media print. */
const src = fs.readFileSync(CSS, "utf8");
const selectors = [];
{
  let depth = 0, printDepth = -1, i = 0, buf = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "{") {
      const head = buf.trim(); buf = "";
      depth++;
      if (head.startsWith("@")) { if (/print/.test(head) && printDepth < 0) printDepth = depth; }
      else if (head && !head.startsWith("/*")) {
        for (const sel of head.split(",")) {
          const s = sel.replace(/\/\*[\s\S]*?\*\//g, "").trim();
          if (s) selectors.push({ sel: s, print: printDepth > 0 });
        }
      }
    } else if (c === "}") {
      if (printDepth === depth) printDepth = -1;
      depth--; buf = "";
    } else buf += c;
    i++;
  }
}

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

/* A pseudo-state never matches a resting page: `.btn:hover` would be reported
   dead on every screen. Match the base selector instead — if the button
   exists, its hover rule is live. */
const base = (sel) => sel
  .replace(/::?[a-z-]+(\([^)]*\))?/gi, "")
  .replace(/\[[^\]]*\]/g, (m) => m)
  .trim() || "*";

const live = new Set();
const check = async (list) => {
  const hits = await p.evaluate((pairs) => pairs.filter(([, b]) => {
    try { return !!document.querySelector(b); } catch { return true; }   // unparseable: keep it
  }).map(([sel]) => sel), list.map((s) => [s, base(s)]));
  hits.forEach((s) => live.add(s));
};
const screenSels = [...new Set(selectors.filter((s) => !s.print).map((s) => s.sel))];

await check(screenSels);                       // the sign-in screen we came through
for (const label of PAGES) {
  const nav = p.locator(".dk-rail .dk-nav").filter({ hasText: new RegExp(`${label}$`, "i") }).first();
  if (!(await nav.count())) continue;
  await nav.click();
  await p.waitForTimeout(1500);
  await check(screenSels);
}

const printSels = [...new Set(selectors.filter((s) => s.print).map((s) => s.sel))];
/* Second signal, because the walk does not open every modal: a class the
   application's source never mentions is dead whatever the walk saw. Both
   have to agree before a rule is called dead. */
const jsx = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
  const full = `${d}/${f.name}`;
  if (f.isDirectory()) walk(full); else if (/\.(jsx?|html)$/.test(f.name)) jsx.push(fs.readFileSync(full, "utf8"));
} };
walk("frontend/src");
const source = jsx.join("\n");
const mentioned = (sel) => {
  const classes = [...sel.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  if (!classes.length) return true;                 // element/attribute selectors: leave alone
  return classes.some((c) => source.includes(c));
};
const dead = screenSels.filter((s) => !live.has(s) && !mentioned(s));
const unsure = screenSels.filter((s) => !live.has(s) && mentioned(s));
console.log(`selectors in ${CSS}: ${screenSels.length} on screen, ${printSels.length} inside @media print`);
console.log(`matched somewhere: ${live.size}`);
console.log(`matched nowhere:   ${dead.length}`);
console.log(`named in the source but not seen: ${unsure.length}  (modals, empty states — left alone)`);
console.log(`dead on both counts: ${dead.length}`);
console.log("\ncandidates for deletion:");
for (const s of dead) console.log("  " + s);
await b.close();
