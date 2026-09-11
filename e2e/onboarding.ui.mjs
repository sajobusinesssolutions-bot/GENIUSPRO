/**
 * onboarding.ui.mjs — session 7 in a browser.
 *
 * Standalone rather than a run.mjs spec: it needs the server started with
 * EMAIL_PROVIDER=console and reads the codes back out of that log, which the
 * shared harness does not do.
 *
 *   GENIUS_DB_PATH=/tmp/s7ui.db JWT_SECRET=... PORT=4177 EMAIL_PROVIDER=console \
 *     LOGIN_MAX_PER_IP=500 node backend/server.js > /tmp/s7ui.log
 *   node e2e/onboarding.ui.mjs
 */
import { chromium } from "playwright";
import fs from "fs";
const BASE = "http://localhost:4177";
const LOG = "/tmp/s7ui.log";
let pass=0, fail=0;
let step="start";
const ok=(n,c,note="")=>{ step=n; c?(pass++,console.log(`  ✓ ${n}${note?"  "+note:""}`)):(fail++,console.log(`  ✗ ${n}  ${note}`)); };
const stamp = Date.now().toString(36);
const EMAIL = `ui.${stamp}@example.test`;
const codeFor = (email) => {
  const log = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`email → ${email}\\s*\\n│\\s+(\\d{6}) is your`, "g");
  let m, last=null; while ((m=re.exec(log))) last=m[1];
  return last;
};
const errs=[];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport:{width:1280,height:600} });
const p = await ctx.newPage();
p.on("console", (m)=>{ if(m.type()==="error") errs.push(m.text()); });
p.on("pageerror", (e)=>errs.push("pageerror: "+String(e)));
p.on("requestfailed",(r)=>errs.push("reqfail "+r.url()+" "+(r.failure()&&r.failure().errorText)));
p.on("response",(r)=>{ if(r.status()>=400) errs.push(`http ${r.status()} ${r.url()} [after: ${step}]`); });

await p.goto(BASE, { waitUntil:"networkidle" });
await p.getByRole("button", { name:"Owner — email" }).click();
ok("the sign-in screen offers a way to create an account", await p.getByRole("button",{name:"Create an account"}).isVisible());
ok("…and a way to recover a password", await p.getByRole("button",{name:"Forgotten your password?"}).isVisible());

await p.getByRole("button",{name:"Create an account"}).click();
await p.waitForSelector("text=Create your account");
ok("the sign-up screen opens", true);
await p.getByLabel("Your name").fill("Aisha Nakato");
await p.getByLabel("Email address").fill(EMAIL);
await p.getByLabel("Choose a password").fill("shopkeeper-2026");
await p.getByRole("button",{name:"Send me a code"}).click();
await p.waitForSelector("text=Check your email", { timeout: 15000 });
ok("it asks for the code next", true);
ok("…and says where the code went", (await p.locator(".dk-login-box").innerText()).includes(EMAIL));

const code = codeFor(EMAIL);
await p.locator("#dk-code-input").fill(code);
const cells = await p.locator(".dk-pin .cell").allInnerTexts();
ok("a pasted code fills all six boxes", cells.filter(Boolean).length === 6, cells.join(""));
await p.getByRole("button",{name:"Confirm"}).click();
await p.waitForSelector("text=Tell us about the business", { timeout: 15000 });
ok("the last step asks about the business", true);
await p.getByLabel("Business name").fill(`UI Test Shop ${stamp}`);
await p.getByRole("button",{name:"Open the shop"}).click();
await p.waitForSelector(".dk-rail, .dk-page", { timeout: 20000 });
await p.waitForTimeout(1500);
ok("**a brand-new shopkeeper lands inside the app**", !(await p.locator(".dk-login-box").count()));

/* clipped-control audit, the round-nine detector */
const audit = async () => p.evaluate(() => {
  const out=[];
  for (const el of document.querySelectorAll("button, a, input, select, [role=button]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let n = el.parentElement, clipped=false;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      const scrolls = /(auto|scroll)/.test(cs.overflowY + cs.overflowX);
      if (scrolls) break;
      if (/hidden/.test(cs.overflowY+cs.overflowX)) {
        const pr = n.getBoundingClientRect();
        if (r.bottom > pr.bottom + 1 || r.right > pr.right + 1) { clipped = true; break; }
      }
      n = n.parentElement;
    }
    if (clipped) out.push((el.innerText||el.getAttribute("aria-label")||el.tagName).slice(0,30));
  }
  return out;
});

for (const vp of [[1254,596],[1024,640],[1707,811]]) {
  await p.setViewportSize({width:vp[0],height:vp[1]});
  await p.waitForTimeout(400);
  const clipped = await audit();
  const overflow = await p.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth+1);
  ok(`no clipped controls at ${vp[0]}×${vp[1]}`, clipped.length===0, clipped.slice(0,4).join(" | "));
  ok(`no sideways scroll at ${vp[0]}×${vp[1]}`, !overflow);
}
await p.setViewportSize({width:1280,height:600});

/* Companies → invitations */
await p.waitForTimeout(800);
const rail = p.locator(".dk-rail button, nav button");
await p.getByRole("button", { name: /Businesses|Companies/i }).first().click().catch(()=>{});
await p.waitForTimeout(1200);
const onCompanies = await p.getByText("Your businesses").count();
ok("the Businesses screen opens from the rail", onCompanies > 0);
if (onCompanies) {
  await p.getByRole("button",{name:/People|Who can open|Access/i}).first().click().catch(()=>{});
  await p.waitForTimeout(900);
  const modal = await p.locator(".dk-modal, [role=dialog]").innerText().catch(()=>"");
  ok("the access modal offers an invitation", /Send invitation/i.test(modal), modal.split("\n").slice(0,3).join(" · "));
  ok("…and explains it works without an account", /whether or not they already have an account/i.test(modal));
  const inviteEmail = `inv.${stamp}@example.test`;
  await p.locator('input[placeholder="their@email.address"]').fill(inviteEmail);
  await p.getByRole("button",{name:"Send invitation"}).click();
  await p.waitForTimeout(1400);
  await p.screenshot({path:"/tmp/shots/6-people.png"});
  const after = await p.locator(".dk-modal, [role=dialog]").innerText().catch(()=>"");
  ok("the invitation is listed as waiting", after.includes(inviteEmail), "");
  ok("…and the link is shown because no mail provider is set up", /no email provider/i.test(after));

  /* the accept screen, as the invited person would see it */
  const url = (after.match(/https?:\/\/\S+/)||[])[0];
  if (url) {
    const p2 = await (await b.newContext({viewport:{width:1280,height:600}})).newPage();
    await p2.goto(url.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil:"domcontentloaded" });
    await p2.waitForTimeout(1200);
    await p2.screenshot({path:"/tmp/shots/7-join.png"});
    const t = await p2.locator(".dk-login-box").innerText().catch(()=>"");
    ok("**the invitation link opens a join screen**", /Join /i.test(t), t.split("\n")[0]);
    ok("…naming the business", t.includes("UI Test Shop"));
    ok("…and asking them to choose a password", /Choose a password/i.test(t));
  } else ok("the invitation link is shown", false, "no url found");
}

/* fonts.googleapis.com is blocked by this sandbox's proxy, not by the app.
   Everything else counts. */
const real = errs.filter((e)=>!/fonts\.g(oogleapis|static)\.com|ERR_TUNNEL_CONNECTION_FAILED/.test(e))
  /* GET /settings answering 401 on the sign-in screen is deliberate and
     documented in App.jsx: the effect depends on `user` so that the currency
     and date formats are re-read the moment somebody signs in, and the price
     of that is one swallowed 401 before they do. Anything else counts. */
  .filter((e)=>!/http 401 .*\/api\/settings \[after: start\]|status of 401/.test(e));
ok("no React, console or request errors anywhere", real.length===0, real.slice(0,3).join(" | "));
console.log(`\n${pass} passed, ${fail} failed\n`);
await b.close();
process.exit(fail?1:0);
