/**
 * settings.ui.mjs — the three shortlisted settings whose effect is a form.
 *
 * `low_stock_alert` and `tax_inclusive_default` change figures and are checked
 * through the API (backend/test/settings.e2e.js). These three change what a
 * shopkeeper sees, so they are checked by looking.
 *
 *   node e2e/settings.ui.mjs
 */
import { chromium } from "playwright";
const BASE = "http://localhost:4177";
let pass = 0, fail = 0;
const ok = (n, c, note = "") => { c ? (pass++, console.log(`  ✓ ${n}${note ? "  " + note : ""}`)) : (fail++, console.log(`  ✗ ${n}  ${note}`)); };
const head = (s) => console.log(`\n── ${s}`);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 1400, height: 820 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));

await p.goto(BASE, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
await p.getByRole("button", { name: "Username" }).click().catch(() => {});
await p.getByLabel("Username").fill("admin");
await p.locator('input[type="password"]').fill("admin123");
await p.getByRole("button", { name: "Open shop" }).click();
await p.waitForTimeout(3000);
ok("signed in", !(await p.locator(".dk-login-box").count()));

/* Settings are changed through the API from inside the page, so the check is
   about what the screen does with them rather than about the Settings page. */
const setKeys = (obj) => p.evaluate(async (o) => {
  const r = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("vy_token")}` },
    body: JSON.stringify(o),
  });
  return r.ok;
}, obj);

/* Opens the sale form AND proves it opened.
 *
 * The first version of this file clicked a button that was not there and then
 * asserted the received-amount box was absent — which it was, along with the
 * entire form. "The field is gone" is only worth asserting once the screen it
 * lives on is in front of you. */
const openInvoice = async () => {
  await p.getByRole("button", { name: /New invoice/i }).first().click();
  await p.waitForSelector(".invb-pay", { timeout: 15000 });
  await p.waitForTimeout(600);
  ok("the sale form is open", await p.getByText("Payment", { exact: false }).count() > 0);
};

const go = async (label) => {
  await p.locator(".dk-rail .dk-nav").filter({ hasText: new RegExp(`${label}$`, "i") }).first().click();
  await p.waitForTimeout(1600);
};

head("Default unit");
await setKeys({ default_unit: "BAG" });
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await go("Items");
await p.getByRole("button", { name: /New product/i }).first().click();
await p.waitForTimeout(1500);
let unit = await p.locator("select").filter({ hasText: /Bag|BAG/ }).first().inputValue().catch(() => "");
if (!unit) unit = await p.evaluate(() => {
  const s = [...document.querySelectorAll("select")].find((x) => x.previousElementSibling?.textContent?.match(/Base unit/i)
    || x.closest("label")?.textContent?.match(/Base unit/i));
  return s ? s.value : "";
});
ok("**a new item starts in the shop's own unit**", unit === "BAG", `unit is "${unit}"`);
await p.keyboard.press("Escape");
await p.waitForTimeout(600);

head("Received / balance on the sale form");
await setKeys({ show_received_amount: "1" });
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await go("Sales");
await openInvoice();
ok("with it on, the amount received is asked for", await p.getByText("Amount received", { exact: false }).count() > 0);
ok("…and the balance due is shown", await p.getByText("Balance due", { exact: false }).count() > 0);
await p.keyboard.press("Escape");
await p.waitForTimeout(800);

await setKeys({ show_received_amount: "0" });
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await go("Sales");
await openInvoice();
ok("**with it off, both boxes are gone**",
  (await p.getByText("Amount received", { exact: false }).count()) === 0
  && (await p.getByText("Balance due", { exact: false }).count()) === 0);
ok("…and the payment section is still there", await p.getByText("Received in", { exact: false }).count() > 0);
await p.locator(".invb-pay").scrollIntoViewIfNeeded();
await p.waitForTimeout(400);
await p.screenshot({ path: "/tmp/shots/12-noreceived.png" });
await p.keyboard.press("Escape");
await p.waitForTimeout(600);
await setKeys({ show_received_amount: "1" });

head("Batch and expiry on a purchase bill");
await setKeys({ enable_batches: "1" });
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await go("Purchases");
await p.getByRole("button", { name: /New bill/i }).first().click();
await p.waitForTimeout(1800);
const withBatch = await p.locator('input[placeholder="LOT-1"]').count();
ok("with tracking on, a line asks for the batch", withBatch > 0, `${withBatch} batch box(es)`);
ok("…and its expiry", await p.locator('input[type="date"]').count() > 0);
await p.keyboard.press("Escape");
await p.waitForTimeout(800);

await setKeys({ enable_batches: "0" });
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await go("Purchases");
await p.getByRole("button", { name: /New bill/i }).first().click();
await p.waitForTimeout(1800);
ok("**with it off, the two columns are gone**", (await p.locator('input[placeholder="LOT-1"]').count()) === 0);
ok("…and the rest of the line is intact", await p.locator(".doc-linegrid").count() > 0);
await p.screenshot({ path: "/tmp/shots/13-nobatch.png" });
await setKeys({ enable_batches: "1" });

ok("no React errors", errs.length === 0, errs.slice(0, 2).join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
