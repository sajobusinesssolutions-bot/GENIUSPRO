/**
 * shopcode.ui.mjs — the shop step, on an installation holding several shops.
 *
 * The desktop build never sees this screen: one company, and the server says
 * which. It only appears where it is needed, which is exactly what makes it
 * worth looking at in a browser rather than trusting.
 *
 *   GENIUS_DB_PATH=…/central.db SPLIT_STORAGE=1 … node backend/server.js
 *   node e2e/shopcode.ui.mjs <shop-code> <username> <password>
 */
import { chromium } from "playwright";
const BASE = "http://localhost:4177";
const [code, username, password] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (n, c, note = "") => { c ? (pass++, console.log(`  ✓ ${n}${note ? "  " + note : ""}`)) : (fail++, console.log(`  ✗ ${n}  ${note}`)); };

const errs = [];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 1280, height: 700 } })).newPage();
p.on("pageerror", (e) => errs.push(String(e)));
/* Google Fonts is blocked by this sandbox's proxy, and GET /settings answering
   401 on the sign-in screen is deliberate and documented in App.jsx. Neither is
   this page's doing; anything else counts. */
p.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error") return;
  if (/fonts\.g|ERR_TUNNEL_CONNECTION_FAILED|status of 401/.test(t)) return;
  errs.push(t);
});

await p.goto(BASE, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1800);
const box = () => p.locator(".dk-login-box").innerText();

ok("the screen asks which shop", /Which shop/i.test(await box()), (await box()).split("\n")[0]);
ok("…and says it is asked once", /only have to do this once/i.test(await box()));
await p.screenshot({ path: "/tmp/shots/8-shopcode.png" });

await p.getByLabel("Shop code").fill("definitely-not-a-shop");
await p.getByRole("button", { name: "Continue" }).click();
await p.waitForTimeout(1200);
ok("a wrong code says so plainly", /could not find that shop code/i.test(await box()), "");
/* The message does mention a password — to say the code is NOT one. What it
   must not do is blame the credentials for a mistyped shop code. */
ok("…and does not blame their password", !/wrong password|incorrect password/i.test(await box()));
await p.screenshot({ path: "/tmp/shots/9-wrongcode.png" });

/* The owner's way out of the shop step. Without it this screen is a dead end
   for the one person who could fix a forgotten shop code. */
await p.getByRole("button", { name: /I'm the owner/i }).click();
await p.waitForTimeout(600);
ok("**an owner can sign in from here without a shop code**", /Email address/i.test(await box()), "");
await p.screenshot({ path: "/tmp/shots/9b-ownerway.png" });
await p.getByRole("button", { name: /I work at the counter/i }).click();
await p.waitForTimeout(600);
ok("…and can go back to the shop step", /Which shop/i.test(await box()));

await p.getByLabel("Shop code").fill(code);
await p.getByRole("button", { name: "Continue" }).click();
await p.waitForTimeout(1500);
const t = await box();
ok("**the right code opens that shop's sign-in**", /Sign in to your shop/i.test(t), t.split("\n")[1]);
ok("…and names the shop", t.length > 0 && !/Which shop/i.test(t));
await p.screenshot({ path: "/tmp/shots/10-shopnamed.png" });

await p.getByRole("button", { name: "Username" }).click();
await p.waitForTimeout(300);
await p.getByLabel("Username").fill(username);
await p.locator('input[type="password"]').fill(password);
await p.getByRole("button", { name: "Open shop" }).click();
await p.waitForTimeout(3500);
ok("**the cashier gets in**", !(await p.locator(".dk-login-box").count()), (await p.locator("body").innerText()).slice(0, 60));
await p.screenshot({ path: "/tmp/shots/11-inside.png" });

/* Reload: the code is remembered, so tomorrow morning is one step shorter. */
await p.evaluate(() => { localStorage.removeItem("vy_token"); localStorage.removeItem("vy_user"); });
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForTimeout(1800);
ok("**the shop is remembered on this device**", !/Which shop/i.test(await box()), (await box()).split("\n")[0]);

ok("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
