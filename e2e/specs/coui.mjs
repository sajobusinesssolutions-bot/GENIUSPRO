import { chromium } from "playwright";
const B = "http://localhost:3100";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ok = (l, c, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`);

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));

await p.goto(B, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1600);

/* ── the sign-in screen offers both tiers ─────────────────────────────────── */
const tabs = (await p.locator(".dk-login-seg button").allTextContents()).map((s) => s.trim());
ok("the sign-in screen offers the owner tier", tabs.some((t) => /email/i.test(t)), tabs.join(" · "));
ok("...and the staff tier", tabs.some((t) => /username|pin/i.test(t)));

await p.getByRole("button", { name: /Owner — email/i }).click();
await p.waitForTimeout(400);
await p.locator('input[type="email"]').fill("admin@local.invalid");
await p.locator('input[type="password"]').fill("admin123");
await p.getByRole("button", { name: /Open shop/i }).click();
await p.waitForTimeout(3000);
ok("signing in by email works from the screen", await p.locator(".dk-rail").count() > 0);

/* ── the rail entry ───────────────────────────────────────────────────────── */
const rail = (await p.locator(".dk-rail a, .dk-rail button").allTextContents()).map((s) => s.trim());
ok("Companies is in the sidebar", rail.some((r) => /Companies/.test(r)), rail.filter(Boolean).slice(-4).join(" · "));

await p.locator(".dk-rail a, .dk-rail button").filter({ hasText: /Companies/ }).first().click({ force: true });
await p.waitForTimeout(2200);
const rows = await p.locator(".dk-table tbody tr").count();
/* A fresh install has exactly one business until this run creates the
   second, so the floor is 1, not 2. */
ok("the screen lists the businesses", rows >= 1, `${rows} rows`);
const names = await p.locator("th.co-name .nm").allTextContents();
ok("...by name, not in capitals", names.every((n) => n !== n.toUpperCase() || n.length < 3), names.join(" · "));
const chips = await p.locator(".dk-chip").allTextContents();
ok("...with the status as a word, not only a colour", chips.some((c) => /Active|Suspended/.test(c)), chips.join(" · "));
ok("the open business is marked on its row", await p.locator("tr.is-active").count() === 1);

/* ── create from the screen ───────────────────────────────────────────────── */
const before = rows;
const newBtn = p.getByRole("button", { name: /New business/i });
if (await newBtn.count()) {
  await newBtn.click(); await p.waitForTimeout(1200);
  await p.locator('input[placeholder*="Kampala"]').fill("Screen Test Shop");
  await p.getByRole("button", { name: /Create business/i }).click();
  await p.waitForTimeout(2500);
  ok("a business can be created from the screen", await p.locator(".dk-table tbody tr").count() === before + 1,
     `${before} → ${await p.locator(".dk-table tbody tr").count()}`);
} else ok("the create button is present", false, "not rendered (limit reached?)");

/* ── switching ────────────────────────────────────────────────────────────── */
const openBtn = p.getByRole("button", { name: /^Open$/ }).first();
const target = await openBtn.locator("xpath=ancestor::tr").locator("th.co-name .nm").innerText();
await openBtn.click();
await p.waitForTimeout(4000);
const firm = await p.evaluate(() => JSON.parse(localStorage.getItem("vy_firm") || "{}"));
ok("switching changes the open business", firm.name === target.trim(), `now in "${firm.name}", wanted "${target.trim()}"`);

/* the new company starts empty — the isolation the whole feature rests on */
await p.locator(".dk-rail a, .dk-rail button").filter({ hasText: /^Items/ }).first().click({ force: true });
await p.waitForTimeout(2200);
const itemRows = await p.locator(".dk-table tbody tr").count();
const emptyish = await p.locator(".dk-empty").count();
ok("the business just opened has none of the other's stock", itemRows === 0 || emptyish > 0,
   `${itemRows} item rows, ${emptyish} empty states`);

/* ── people ───────────────────────────────────────────────────────────────── */
await p.locator(".dk-rail a, .dk-rail button").filter({ hasText: /Companies/ }).first().click({ force: true });
await p.waitForTimeout(2000);
await p.getByRole("button", { name: /^People$/ }).first().click();
await p.waitForTimeout(1600);
ok("the people list opens", await p.locator(".modal-backdrop, .modal").count() > 0);
const ownerRow = await p.getByText("cannot be removed").count();
ok("...and the owner cannot be removed from it", ownerRow > 0);

console.log("\nERRORS:", errs.length ? errs : "none");
await b.close();
