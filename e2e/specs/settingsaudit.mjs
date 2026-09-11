import { chromium } from "playwright";
const B = "http://localhost:3100";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const ok = (l, c, d = "") => console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`);

await p.goto(B, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500);
await p.fill('input[type="password"]', "admin123"); await p.keyboard.press("Enter");
await p.waitForTimeout(2800);
const tok = await p.evaluate(() => localStorage.getItem("vy_token") || localStorage.getItem("token"));
const catalog = await p.evaluate(async (t) => {
  const r = await fetch("/api/settings", { headers: { Authorization: "Bearer " + t } });
  return (await r.json()).data.catalog;
}, tok);

/* `hidden` settings are real and honoured but are not fields anybody types —
   the custom invoice template is JSON the builder writes. They are excluded
   from the reachability check for the same reason they are excluded from the
   pages. */
const live = catalog.filter((c) => !c.unbuilt && !c.hidden && c.group !== "internal");
const unbuilt = catalog.filter((c) => c.unbuilt);
console.log(`catalogue: ${catalog.length} settings — ${live.length} live, ${unbuilt.length} unbuilt, ${catalog.length - live.length - unbuilt.length} internal\n`);

/* The loyalty scheme lives behind mod_loyalty, which ships off. Switch it on
   for the run, so "unreachable" means unreachable rather than switched off. */
await p.evaluate(async (t) => {
  await fetch("/api/settings", { method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
    body: JSON.stringify({ mod_loyalty: "1" }) });
}, tok);
await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);

const go = async (label) => {
  await p.locator('.dk-rail a, .dk-rail button').filter({ hasText: label }).first().click({ force: true });
  await p.waitForTimeout(1800);
};

/* ── every live setting must be rendered somewhere ─────────────────────── */
const seen = new Set();
const collect = async () => {
  for (const id of await p.locator("[id^='set-']").evaluateAll((els) => els.map((e) => e.id))) seen.add(id.slice(4));
  for (const lbl of await p.locator(".dk-setrow .lb").allTextContents()) {
    const hit = live.find((c) => c.label === lbl.trim());
    if (hit) seen.add(hit.key);
  }
};

await go(/^Settings/);
const pages = await p.locator(".dk-list .dk-set-item:not(.is-link)").allTextContents();
console.log("Settings pages:", pages.map((s) => s.trim()).join(" · "), `(${pages.length})`);
ok("nine pages, down from fourteen", pages.length === 9, `${pages.length}`);
ok("the banner card is gone", await p.locator(".dk-set-head").count() === 0);
ok("the page title is a heading, not a card", await p.locator(".dk-set-title h2").count() === 1,
   (await p.locator(".dk-set-title h2").innerText().catch(() => "—")));
ok("the Save dock still exists", await p.evaluate(() => !!document.getElementById("dk-dock")));

for (const name of pages.map((s) => s.trim())) {
  await p.locator(".dk-list .dk-set-item").filter({ hasText: name }).first().click();
  await p.waitForTimeout(900);
  await collect();
}

/* the three relocated homes */
await go(/^Items/); await p.waitForTimeout(600);
await p.locator(".dk-tool").first().click(); await p.waitForTimeout(400);
await p.getByRole("button", { name: /Item preferences/i }).click(); await p.waitForTimeout(1600);
const itemRows = await p.locator(".dk-setrow").count();
ok("Items → Preferences shows the item settings", itemRows >= 8, `${itemRows} rows`);
await collect();
await p.keyboard.press("Escape"); await p.waitForTimeout(700);

await go(/^Parties/); await p.waitForTimeout(800);
await p.locator('[aria-label="Party preferences"]').click(); await p.waitForTimeout(1600);
const partyRows = await p.locator(".dk-setrow").count();
ok("Parties → Preferences shows the party settings", partyRows >= 2, `${partyRows} rows`);
await collect();
ok("...and the party groups list came with them", await p.getByText("Party groups").count() > 0);
/* Close by Escape rather than by button text: two modals in this run have a
   "Close" and Playwright's strict mode cannot tell them apart once one is
   already unmounting. */
await p.keyboard.press("Escape"); await p.waitForTimeout(800);
await p.locator(".modal-backdrop").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

/* Not /^Sales/ — some rail entries render a text icon before the label, so
   anchoring at the start misses them. */
await go(/Sales/); await p.waitForTimeout(1400);
const loyTab = p.getByRole("button", { name: /^Loyalty$/ }).first();
if (await loyTab.count()) {
  await loyTab.click(); await p.waitForTimeout(1500);
  const schemeBtn = p.getByRole("button", { name: /Scheme…/ });
  if (await schemeBtn.count()) {
    await schemeBtn.click(); await p.waitForTimeout(1500);
    const n = await p.locator(".dk-setrow").count();
    ok("Loyalty → Scheme shows the loyalty settings", n >= 4, `${n} rows`);
    await collect();
    await p.keyboard.press("Escape"); await p.waitForTimeout(600);
  } else ok("Loyalty → Scheme reachable", false, "button not found");
} else ok("Loyalty tab reachable", false, "tab not found (mod_loyalty may be off)");

/* The Print screen is its own hand-built component rather than catalogue rows,
   so nothing here can see its controls by class. It is checked at the source
   level instead — see the session-3 report — and excluded here rather than
   counted as unreachable, which would be a false failure. */
/* Two groups are edited by hand-built screens rather than catalogue rows, so
   nothing here can see their controls by class: Print has its own layout, and
   the four offsite_* keys are edited through the Backup screen's own
   /system/offsite form, which writes them by name on the server
   (offsite.service.js:569). Both are verified at the source level instead —
   see the session-3 report — rather than counted here as unreachable, which
   would be a false failure. */
const BY_OWN_SCREEN = new Set(["print", "backup"]);
const missing = live.filter((c) => !seen.has(c.key) && !BY_OWN_SCREEN.has(c.group));
ok("every live setting is reachable from some screen", missing.length === 0,
   missing.length ? `${missing.length} unreachable: ${missing.slice(0, 8).map((c) => c.key + "[" + c.group + "]").join(", ")}` : `${seen.size}/${live.length}`);

/* ── nothing inert is rendered ─────────────────────────────────────────── */
const inertShown = unbuilt.filter((c) => seen.has(c.key));
ok("no inert setting is rendered anywhere", inertShown.length === 0,
   inertShown.length ? inertShown.map((c) => c.key).join(", ") : `${unbuilt.length} kept out of the interface`);

console.log("\nERRORS:", errs.length ? errs : "none");
await b.close();
