import { chromium } from "playwright";
const B = "http://localhost:3100";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ok = (l, c, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`);

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto(B, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500);
await p.fill('input[type="password"]', "admin123"); await p.keyboard.press("Enter");
await p.waitForTimeout(2800);
const tok = await p.evaluate(() => localStorage.getItem("vy_token") || localStorage.getItem("token"));
const val = (k) => p.evaluate(async ([kk, t]) => {
  const r = await fetch("/api/settings", { headers: { Authorization: "Bearer " + t } });
  return (await r.json()).data.values[kk];
}, [k, tok]);

const rail = async (label) => {
  await p.locator('.dk-rail a, .dk-rail button').filter({ hasText: label }).first().click({ force: true });
  await p.waitForTimeout(1800);
};

await rail(/Settings/);

/* ── search ─────────────────────────────────────────────────────────────── */
await p.locator(".dk-set-find input").fill("decimal");
await p.waitForTimeout(700);
let rows = await p.locator(".dk-setfound").count();
ok("search finds settings by label", rows > 0, `${rows} matches for "decimal"`);
const where = await p.locator(".dk-setfound .where").first().innerText().catch(() => "");
/* Case-insensitive: the label is a §3 Caption, uppercased by CSS. */
ok("...and names the page each is on", /^in /i.test(where), where);

await p.locator(".dk-set-find input").fill("prevent_below_cost");
await p.waitForTimeout(700);
ok("search finds a setting by its key", await p.locator(".dk-setfound").count() === 1,
   `${await p.locator(".dk-setfound").count()} matches`);

await p.locator(".dk-set-find input").fill("chase overdue invoices by pigeon");
await p.waitForTimeout(700);
ok("a search with no matches says so", (await p.locator(".dk-empty").innerText()).includes("Nothing matches"));

/* an inert setting must not be findable either */
await p.locator(".dk-set-find input").fill("enable_batches");
await p.waitForTimeout(700);
ok("an inert setting is not findable", await p.locator(".dk-setfound").count() === 0);

/* editing from the search result must actually save */
await p.locator(".dk-set-find input").fill("Block selling below cost");
await p.waitForTimeout(700);
const before = await val("prevent_below_cost");
await p.locator(".dk-setfound .dk-switch").first().click();
await p.waitForTimeout(400);
ok("a result is editable in place", await p.locator(".dk-dockbar").count() > 0, "the save dock appeared");
await p.locator(".dk-dockbar .primary").click();
await p.waitForTimeout(1800);
const after = await val("prevent_below_cost");
ok("...and saving from a search result persists", after !== before, `${before} → ${after}`);
await p.locator(".dk-set-find input").fill("");
await p.waitForTimeout(500);

/* ── the signposts ──────────────────────────────────────────────────────── */
const moved = await p.locator(".dk-set-moved .dk-set-item").allTextContents();
ok("the three moved pages are signposted", moved.length === 3, moved.map((s) => s.trim()).join(" | "));
await p.locator(".dk-set-moved .dk-set-item").first().click();
await p.waitForTimeout(1800);
ok("...and a signpost navigates there", await p.locator(".dk-rail").count() > 0 &&
   (await p.locator("h1, h2, .dk-top").first().innerText().catch(() => "")).length > 0,
   "landed on " + (await p.title()));

/* ── saving from a relocated home ───────────────────────────────────────── */
await rail(/^Items/);
await p.locator(".dk-tool").first().click(); await p.waitForTimeout(400);
await p.getByRole("button", { name: /Item preferences/i }).click(); await p.waitForTimeout(1600);
const qBefore = await val("qty_decimals");
/* By id, not by position. The first select on this screen is
   reorder_lookback_days — the earlier version of this check changed that and
   then asserted qty_decimals had moved, which it had not. */
const sel = p.locator("#set-qty_decimals");
const opts = await sel.locator("option").allTextContents();
const pick = opts.find((o) => o.trim() !== String(qBefore)) || opts[0];
await sel.selectOption(pick.trim());
await p.waitForTimeout(400);
await p.getByRole("button", { name: /^Save \d+ change/ }).click();
await p.waitForTimeout(2000);
const qAfter = await val("qty_decimals");
ok("a setting saved from Items → Preferences persists", String(qAfter) !== String(qBefore),
   `qty_decimals ${qBefore} → ${qAfter}`);

console.log("\nERRORS:", errs.length ? errs : "none");
await ctx.close();

/* ── layout, at the viewports the review established ────────────────────── */
console.log("\nviewport      settings pages   clipped controls   dock reachable");
console.log("─".repeat(70));
for (const [w, h] of [[1254, 596], [1024, 640], [1707, 811]]) {
  const c2 = await b.newContext({ viewport: { width: w, height: h } });
  const pg = await c2.newPage();
  const e2 = []; pg.on("pageerror", (e) => e2.push(e.message));
  await pg.goto(B, { waitUntil: "domcontentloaded" }); await pg.waitForTimeout(1400);
  await pg.fill('input[type="password"]', "admin123"); await pg.keyboard.press("Enter");
  await pg.waitForTimeout(2600);
  await pg.locator('.dk-rail a, .dk-rail button').filter({ hasText: /Settings/ }).first().click({ force: true });
  await pg.waitForTimeout(1600);

  let clipped = 0, pagesWalked = 0;
  const names = (await pg.locator(".dk-list .dk-set-item:not(.is-link)").allTextContents()).map((s) => s.trim());
  for (const n of names) {
    await pg.locator(".dk-list .dk-set-item").filter({ hasText: n }).first().click({ force: true });
    await pg.waitForTimeout(600); pagesWalked++;
    clipped += await pg.evaluate(() => {
      let bad = 0;
      for (const el of document.querySelectorAll(".dk-set-body button, .dk-set-body input, .dk-set-body select")) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        let a = el.parentElement, hit = false;
        while (a && a !== document.body) {
          if (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2) break;
          const cs = getComputedStyle(a);
          if (/hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
            const ar = a.getBoundingClientRect();
            if (r.bottom > ar.bottom + 2 || r.right > ar.right + 2 || r.top < ar.top - 2) { hit = true; break; }
          }
          a = a.parentElement;
        }
        if (hit) bad++;
      }
      return bad;
    });
  }
  /* the dock must be on screen when there is something to save */
  /* Land on a page that definitely has a switch — Business is selects only, so
     clicking "the first switch" there dirtied nothing and the dock correctly
     never appeared, which the earlier version of this check read as a fault. */
  await pg.locator(".dk-list .dk-set-item").filter({ hasText: "Modules" }).first().click({ force: true });
  await pg.waitForTimeout(900);
  await pg.locator(".dk-setrow .dk-switch").first().click({ force: true }).catch(() => {});
  await pg.waitForTimeout(600);
  const dock = await pg.evaluate(() => {
    const d = document.querySelector(".dk-dockbar");
    if (!d) return "none";
    const r = d.getBoundingClientRect();
    return r.bottom <= innerHeight + 1 && r.top >= 0 ? "yes" : "OFF SCREEN";
  });
  console.log(`${String(w + "x" + h).padEnd(14)}${String(pagesWalked).padEnd(17)}${String(clipped).padEnd(19)}${dock}${e2.length ? "  errors: " + e2.length : ""}`);
  await c2.close();
}
await b.close();
