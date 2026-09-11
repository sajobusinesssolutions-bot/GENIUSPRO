/**
 * layout.check.mjs — nothing unreachable, on every page, at every size.
 *
 * The detector rounds twelve and thirteen built: walk up from every control
 * and ask whether an ancestor clips it — stopping at the first ancestor that
 * SCROLLS, because a control inside a scroller is reachable. An earlier
 * version stopped at the first `overflow: hidden` and reported 930 phantom
 * failures.
 *
 * Run after anything that changes type or spacing: half a pixel of font-size,
 * multiplied through a flex row, is how a Save button ends up under the fold.
 *
 *   node e2e/layout.check.mjs
 */
import { chromium } from "playwright";
const BASE="http://localhost:4177";
const PAGES=["Dashboard","Sales","Purchases","Items","Parties","Cash & bank","Reports","Settings","Staff","Accounting"];
const VPS=[[1254,596],[1024,640],[1440,900],[1707,811]];
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

const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
await signIn(p, BASE);
const audit = () => p.evaluate(() => {
  const out=[];
  for (const el of document.querySelectorAll("button, a, input, select, [role=button]")) {
    const r=el.getBoundingClientRect(); if(!r.width||!r.height) continue;
    let n=el.parentElement, clipped=false;
    while(n&&n!==document.body){
      const cs=getComputedStyle(n);
      if(/(auto|scroll)/.test(cs.overflowY+cs.overflowX)) break;
      if(/hidden/.test(cs.overflowY+cs.overflowX)){
        const pr=n.getBoundingClientRect();
        if(r.bottom>pr.bottom+1||r.right>pr.right+1){clipped=true;break;}
      }
      n=n.parentElement;
    }
    if(clipped) out.push((el.innerText||el.getAttribute("aria-label")||el.tagName).slice(0,26));
  }
  const overflow = document.documentElement.scrollWidth > window.innerWidth+1;
  return { clipped: out, overflow };
});
let bad=0;
for (const label of PAGES) {
  const nav=p.locator(".dk-rail .dk-nav").filter({hasText:new RegExp(`${label}$`,"i")}).first();
  if(!(await nav.count())) continue;
  await nav.click(); await p.waitForTimeout(1500);
  for (const [w,h] of VPS) {
    await p.setViewportSize({width:w,height:h}); await p.waitForTimeout(500);
    const r = await audit();
    const ok = r.clipped.length===0 && !r.overflow;
    if(!ok){ bad++; console.log(`✗ ${label} @ ${w}×${h}: ${r.clipped.length} clipped${r.overflow?" + sideways scroll":""} ${r.clipped.slice(0,3).join(" | ")}`); }
  }
  await p.setViewportSize({width:1440,height:900});
}
console.log(bad ? `\n${bad} problem viewport(s)` : "\nevery control reachable, no sideways scroll, on 10 pages × 4 viewports");
await b.close(); process.exit(bad?1:0);
