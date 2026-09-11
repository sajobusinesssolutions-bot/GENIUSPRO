/**
 * typesource.mjs — where each type combination on a page comes from.
 *
 * `visual.audit.mjs` says a page carries thirteen type combinations. This says
 * which CSS rule produces each one, which is the difference between a number
 * to feel bad about and a list of edits. It walks the live stylesheets, finds
 * the rule that actually won for a sample element, and groups by
 * size/weight/case.
 *
 *   node e2e/typesource.mjs "Cash & bank"
 */
import { chromium } from "playwright";
const BASE="http://localhost:4177"; const page=process.argv[2]||"Cash & bank";
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
await p.goto(BASE,{waitUntil:"domcontentloaded"}); await p.waitForTimeout(1500);
await p.getByRole("button",{name:"Username"}).click().catch(()=>{});
await p.getByLabel("Username").fill("admin"); await p.locator('input[type="password"]').fill("admin123");
await p.getByRole("button",{name:"Open shop"}).click(); await p.waitForTimeout(3200);
await p.locator(".dk-rail .dk-nav").filter({hasText:new RegExp(`${page}$`,"i")}).first().click();
await p.waitForTimeout(1800);
console.log(await p.evaluate(() => {
  const rules=[];
  for (const sh of document.styleSheets) { let rs; try{rs=sh.cssRules}catch{continue}
    for (const r of rs) { if(r.style && (r.style.fontSize||r.style.fontWeight)) rules.push(r); } }
  const inMain=(el)=>!el.closest(".dk-rail")&&!el.closest(".dk-topbar");
  const vis=(el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
  const m=new Map();
  for (const el of document.querySelectorAll("*")) {
    if(!inMain(el)||!vis(el))continue;
    const txt=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join("");
    if(txt.length<2)continue;
    const cs=getComputedStyle(el);
    const key=`${Math.round(parseFloat(cs.fontSize)*10)/10}/${cs.fontWeight}${/upper/.test(cs.textTransform)?"/caps":""}`;
    if(!m.has(key))m.set(key,{n:0,who:new Set()});
    const e=m.get(key); e.n++;
    if(e.who.size<3){
      let src="(inherited) "+el.tagName.toLowerCase()+"."+(el.className||"").toString().split(/\s+/).slice(0,2).join(".");
      if(el.style.fontSize||el.style.fontWeight) src="inline style";
      else { for(const r of rules){ try{ if(el.matches(r.selectorText)) src=r.selectorText; }catch{} } }
      e.who.add(src);
    }
  }
  return [...m.entries()].sort((a,b)=>b[1].n-a[1].n)
    .map(([k,v])=>`${k} ×${v.n}  ←  ${[...v.who].join(" | ")}`).join("\n");
}));
await b.close();
