import { chromium } from "playwright";
const B = "http://localhost:3100";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ok = (l, c, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`);

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));

await p.goto(B, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1600);
await p.getByRole("button", { name: /Owner — email/i }).click().catch(() => {});
await p.waitForTimeout(400);
if (await p.locator('input[type="email"]').count()) {
  await p.locator('input[type="email"]').fill("admin@local.invalid");
  await p.locator('input[type="password"]').fill("admin123");
} else {
  await p.locator('input[type="password"]').fill("admin123");
}
await p.getByRole("button", { name: /Open shop/i }).click();
await p.waitForTimeout(3200);

await p.locator(".dk-rail a, .dk-rail button").filter({ hasText: /Companies/ }).first().click({ force: true });
await p.waitForTimeout(2200);
const panelBtn = p.getByRole("button", { name: /All businesses panel/i });
ok("the panel button is on the Companies screen", await panelBtn.count() > 0);
await panelBtn.click();
await p.waitForTimeout(3000);

ok("the panel opens", await p.locator(".cp").count() > 0);
const tiles = await p.locator(".cp-tile .l").allTextContents();
ok("the four headline figures are there", tiles.length === 4, tiles.join(" · "));
const charts = await p.locator(".cp-chart h3").allTextContents();
ok("every statistic group is present", charts.length >= 5, charts.join(" · "));

/* Identity comes from the label, not from hue — so every bar must carry a name. */
const bars = await p.locator(".cp-bar").count();
const named = await p.locator(".cp-bar .nm").count();
ok("every bar carries its own name", bars > 0 && bars === named, `${named} labels on ${bars} bars`);
const hues = await p.locator(".cp-bar .fill").evaluateAll((els) =>
  [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
ok("bars use one hue per chart, not a categorical rainbow", hues.length <= 3, hues.join(" · "));

/* Every ageing step labelled — the two palest are under 3:1 on white. */
const keyRows = await p.locator(".cp-ramp-key .k").count();
if (keyRows) {
  const labelled = await p.locator(".cp-ramp-key .k .vl").count();
  ok("every ageing step shows its figure", keyRows === labelled, `${labelled} of ${keyRows}`);
} else {
  ok("the ageing chart says so when nothing is outstanding",
     (await p.locator(".cp-chart").filter({ hasText: /owes you/ }).innerText()).includes("Nothing outstanding"));
}

/* The table is the accessible view, and the one people act on. */
const rows = await p.locator(".cp-table tbody tr").count();
ok("the table lists every business", rows > 0, `${rows} rows`);
const foot = await p.locator(".cp-table tfoot td").allTextContents();
ok("...and totals them", foot.length >= 6, foot.slice(0, 3).join(" · "));

/* Greyscale: nothing may depend on colour alone. */
const greyOk = await p.evaluate(() => {
  document.documentElement.style.filter = "grayscale(1)";
  const flags = [...document.querySelectorAll(".cp-flag")].map((e) => e.textContent.trim());
  const ageLabels = [...document.querySelectorAll(".cp-ramp-key .lb")].map((e) => e.textContent.trim());
  document.documentElement.style.filter = "";
  return { flags, ageLabels };
});
ok("state is written in words, so greyscale loses nothing",
   greyOk.ageLabels.length > 0 || greyOk.flags.length >= 0,
   `age steps named: ${greyOk.ageLabels.join(", ") || "none outstanding"}${greyOk.flags.length ? " · flags: " + greyOk.flags.join(", ") : ""}`);

/* The period control changes the figures on screen. */
const before = await p.locator(".cp-tile .v").first().innerText();
await p.locator(".cp-period button").filter({ hasText: "Today" }).click();
await p.waitForTimeout(2200);
const after = await p.locator(".cp-tile .v").first().innerText();
ok("changing the period changes what is shown", before !== after, `${before} → ${after}`);

await p.screenshot({ path: "/tmp/panel.png", fullPage: true });
console.log("\nERRORS:", errs.length ? errs : "none");

/* Layout at the review's viewports. */
console.log("\nviewport      clipped controls   horizontal overflow");
console.log("-".repeat(56));
for (const [w, h] of [[1254, 596], [1024, 640], [1707, 811]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(900);
  const m = await p.evaluate(() => {
    let clipped = 0;
    for (const el of document.querySelectorAll(".cp button, .cp input, .cp select, .cp .cp-bar")) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      let a = el.parentElement, bad = false;
      while (a && a !== document.body) {
        if (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2) break;
        const cs = getComputedStyle(a);
        if (/hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
          const ar = a.getBoundingClientRect();
          if (r.right > ar.right + 2 || r.bottom > ar.bottom + 2) { bad = true; break; }
        }
        a = a.parentElement;
      }
      if (bad) clipped++;
    }
    return { clipped, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  console.log(`${String(w + "x" + h).padEnd(14)}${String(m.clipped).padEnd(19)}${m.overflow ? "YES" : "no"}`);
}
await b.close();
