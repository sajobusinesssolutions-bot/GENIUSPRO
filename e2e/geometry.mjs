/**
 * geometry.mjs — where everything is, as JSON, so two builds can be compared.
 *
 *   node e2e/geometry.mjs out.json
 */
import { chromium } from "playwright";
import fs from "fs";
const BASE = "http://localhost:4177";
const PAGES = ["Dashboard","Sales","Purchases","Items","Parties","Cash & bank","Reports","Settings","Staff"];
const out = {};
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
for (const label of PAGES) {
  const nav = p.locator(".dk-rail .dk-nav").filter({ hasText: new RegExp(`${label}$`, "i") }).first();
  if (!(await nav.count())) continue;
  await nav.click(); await p.waitForTimeout(1600);
  out[label] = await p.evaluate(() => {
    const o = {}; let i = 0;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      o[`${i++}:${el.tagName}.${(el.className||"").toString().split(/\s+/)[0]}`] =
        [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }
    return o;
  });
}
fs.writeFileSync(process.argv[2] || "/tmp/geom.json", JSON.stringify(out));
console.log("written", process.argv[2]);
await b.close();
