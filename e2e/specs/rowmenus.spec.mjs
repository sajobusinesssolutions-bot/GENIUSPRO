/**
 * rowmenus.spec.mjs — the ⋮ menu on every list row.
 *
 * What went wrong, and why this file exists
 * -----------------------------------------
 * The app had two row menus. `.rd-*` in styles.css was portalled and themed.
 * `.dk-rowmenu` in deck.css styled only the *panel* — surface, border, radius,
 * shadow — and had no rule at all for the buttons inside it. Chromium therefore
 * drew every option as a browser-default button: ButtonFace beige
 * (rgb(239,239,239)), a 2px outset bevel, `display: inline-block`. Inline-block
 * boxes flow like words, so the options packed two to a line and wrapped, and
 * the menu a shopkeeper opened on Items or on Sales was a staircase of loose
 * grey rectangles with nothing of the app's theme on it. Six screens used that
 * panel. It also sat `position: absolute` inside a card with `overflow:
 * hidden`, so the last rows of a long table opened their menu into the clip.
 *
 * Both are now one component (`src/lib/rowmenu.jsx`, `.dkm-*` in deck.css).
 * The assertions below are the three ways that can regress:
 *
 *   1. **A dropped action.** Every menu's option list is written out here in
 *      full and compared item by item. Losing "Send on WhatsApp" in a refactor
 *      is silent otherwise — nobody notices until a customer asks for a bill.
 *   2. **A panel off the screen or under something.** Measured: the whole box
 *      inside the viewport, and the four corners hit-testing to the panel
 *      itself, at two window sizes, including the bottom row of a table and a
 *      trigger at the right edge.
 *   3. **Unreadable text.** Contrast ratios measured in both themes, and the
 *      destructive options checked for a word as well as a colour (WCAG 1.4.1
 *      — red is not a warning to anyone who cannot see red).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signIn, go, watchErrors, BASE } from "../harness.mjs";

export const name = "row ⋮ menus — one panel, on screen, readable, nothing dropped";

/* Same convention as the other specs: screenshots go to a temp directory, so a
   test run never leaves files in the repository. */
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "genius-rowmenus-"));

const LAPTOP = { width: 1366, height: 768 };
const DESKTOP = { width: 1920, height: 1080 };

/* Every row menu in the app, with the option list it must still show.
   The six marked `converted` are the ones that were `.dk-rowmenu`; their lists
   are copied from the markup as it stood before the refactor (git show
   fbfaa99:frontend/src/pages/…), which is what makes a dropped action a
   failure rather than a diff nobody reads. */
const MENUS = [
  { key: "items-products", converted: true, page: "Items", tab: "Products", trigger: ".dk-row .dk-dots",
    expect: ["Edit item", "Adjust stock", "Repack into smaller unit", "Stock ledger",
             "Print barcode label", "Mark inactive", "Delete item"] },
  { key: "items-services", converted: true, page: "Items", tab: "Services", trigger: ".dk-row .dk-dots",
    expect: ["Edit item", "Stock ledger", "Print barcode label", "Mark inactive", "Delete item"] },
  { key: "items-categories", converted: true, page: "Items", tab: "Categories", trigger: "tbody .dk-dots",
    expect: ["Delete category"], custom: ".dk-catswatch" },
  { key: "sales-invoices", converted: true, page: "Sales", tab: "Invoices", trigger: "tbody .dk-dots",
    /* "Receive payment" was added when money became attachable to the invoice
       it pays; it sits after Duplicate. It is always present on an invoice row
       — disabled with a reason on a paid or voided one — precisely so this
       list is the same on every row. */
    expect: ["View", "Edit", "Print", "Duplicate", "Receive payment", "Send on WhatsApp", "Void this sale"] },
  /* "Void bill" joined this menu when supplier bills became correctable — a
     bill was previously the one document in the app with no way back at all. */
  { key: "purchase-bills", converted: true, page: "Purchases", tab: "Bills", trigger: "tbody .dk-dots",
    expect: ["View bill", "Void bill"] },
  { key: "purchase-orders", converted: true, page: "Purchases", tab: "Purchase orders", trigger: "tbody .dk-dots",
    expect: ["Open & receive", "Send on WhatsApp"] },

  /* Already on the shared menu before this round; they change panel, not
     contents, so the same list check guards them. */
  { key: "sales-recurring", page: "Sales", tab: "Recurring", trigger: "tbody .dk-dots",
    expect: ["Raise now", "Pause", "Edit", "Delete schedule"] },
  { key: "sales-instalments", page: "Sales", tab: "Instalments", trigger: "tbody .dk-dots",
    expect: ["View schedule", "Cancel plan"] },
  /* This one never had a "Print / PDF" — the expectation was written from the
     design rather than from the screen, and it went unnoticed because the
     fixture above could not create a bill, so nothing in this table was ever
     opened and none of these lists were ever actually compared. Corrected to
     what the menu offers; adding the print action is a separate question. */
  { key: "money-accounts", page: "Cash & bank", tab: "Accounts", trigger: ".cb-tile .dk-dots",
    expect: ["View statement", "Record payment here"] },
  /* "Delete" was a permanently disabled row captioned "allocated to bills —
     reverse via new payment". A payment can now actually be corrected and
     voided, so it is Edit and Void, and both do what they say. */
  { key: "money-payments", page: "Cash & bank", tab: "Payments & expenses", trigger: "tbody .dk-dots",
    expect: ["View", "Edit", "Print this list", "Void"] },
  { key: "staff-owed", page: "Staff", tab: "What they are owed", trigger: "tbody .dk-dots",
    expect: ["Rate & rostered hours"] },
];

/* ── helpers ────────────────────────────────────────────────────────────── */

async function shoot(page, file) {
  const p = path.join(SHOTS, file);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

async function openTab(page, label) {
  if (!label) return true;
  const t = page.locator(".dk-tab").filter({ hasText: new RegExp(`^${label.replace(/[&]/g, "&")}`, "i") }).first();
  if (!(await t.count())) return false;
  await t.click();
  await page.waitForTimeout(1000);
  return true;
}

/** Options as the user reads them, with the destructive flag split out. */
function readPanel(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".dkm-panel");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      box: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
      position: cs.position,
      zIndex: cs.zIndex,
      panels: document.querySelectorAll(".dkm-panel").length,
      role: el.getAttribute("role"),
      options: [...el.querySelectorAll(".dkm-item")].map((b) => ({
        label: b.querySelector(".dkm-label")?.textContent.trim() || "",
        danger: b.classList.contains("danger"),
        flag: b.querySelector(".dkm-flag")?.textContent.trim() || "",
        role: b.getAttribute("role"),
        disabled: b.disabled,
        h: Math.round(b.getBoundingClientRect().height),
        display: getComputedStyle(b).display,
        appearance: getComputedStyle(b).appearance,
      })),
      customCount: el.querySelectorAll(".dkm-custom *").length,
    };
  });
}

/** Is every corner of the panel actually painted — nothing clipping or covering it? */
function hitTest(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".dkm-panel");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    /* Inset past the 12px corner radius: a point in the rounded corner is
       outside the painted panel and hit-tests to whatever is behind it,
       which would fail this check for the wrong reason. */
    const I = 14;
    const pts = [[r.left + I, r.top + I], [r.right - I, r.top + I],
                 [r.left + I, r.bottom - I], [r.right - I, r.bottom - I]];
    const inside = pts.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit));
    });
    /* An ancestor with overflow:hidden used to be what ate this panel, so
       state plainly that there is no clipping ancestor left: it is a direct
       child of <body>. */
    return { inside, parentIsBody: el.parentElement === document.body };
  });
}

/** Contrast of the panel's own text against the panel surface. */
function panelContrast(page) {
  return page.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    const el = document.querySelector(".dkm-panel");
    if (!el) return [];
    const bg = parse(getComputedStyle(el).backgroundColor).slice(0, 3);
    const ratio = (fg) => {
      const [a, b] = [lum(fg) + 0.05, lum(bg) + 0.05].sort((x, y) => y - x);
      return +(a / b).toFixed(2);
    };
    const out = [];
    const plain = el.querySelector(".dkm-item:not(.danger)");
    const danger = el.querySelector(".dkm-item.danger");
    const flag = el.querySelector(".dkm-flag");
    if (plain) out.push({ what: "option text", ratio: ratio(parse(getComputedStyle(plain).color).slice(0, 3)) });
    if (danger) out.push({ what: "destructive option text", ratio: ratio(parse(getComputedStyle(danger).color).slice(0, 3)) });
    if (flag) out.push({ what: "the word \"destructive\"", ratio: ratio(parse(getComputedStyle(flag).color).slice(0, 3)) });
    return out;
  });
}

async function closeMenu(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
  if (await page.locator(".dkm-panel").count()) {
    await page.mouse.click(6, 6).catch(() => {});
    await page.waitForTimeout(200);
  }
}

/** Navigate to a menu's screen and open the nth trigger. Returns false if the
    screen or its data is not present in this database. */
async function openMenu(page, m, nth = 0) {
  if (!(await go(page, m.page))) return false;
  if (!(await openTab(page, m.tab))) return false;
  const t = page.locator(m.trigger);
  const n = await t.count();
  if (n <= nth) return false;
  await t.nth(nth).click();
  await page.waitForTimeout(300);
  return await page.locator(".dkm-panel").count() > 0;
}

/* ── the spec ───────────────────────────────────────────────────────────── */

export async function run({ browser, report }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  await signIn(page, LAPTOP);

  /* Purchases ships empty in the seeded database, and a menu with no rows is a
     menu nobody tested. Two documents, through the real routes. */
  const me = await (async () => {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: "admin", password: "admin123" } });
    return (await r.json()).data || {};
  })();
  const auth = { headers: { Authorization: `Bearer ${me.token}` } };
  const seeded = await (async () => {
    try {
      const parties = await (await ctx.request.get(`${BASE}/api/parties`, auth)).json();
      const items = await (await ctx.request.get(`${BASE}/api/items`, auth)).json();
      const rowsOf = (j) => j.data?.rows || j.data?.items || j.data || [];
      const party = rowsOf(parties).find((p) => p.party_type !== "customer") || rowsOf(parties)[0];
      const item = rowsOf(items)[0];
      if (!party || !item) return "no supplier or item to bill";
      const bill = await ctx.request.post(`${BASE}/api/purchases`, {
        ...auth,
        /* This shop has "choose a sales rep" switched on, so a bill without
           one is refused — the same 400 a cashier would get. */
        data: { party_id: party.id, bill_date: new Date().toISOString().slice(0, 10), payment_type: "credit",
                sales_rep_id: me.user?.id,
                lines: [{ item_id: item.id, description: item.name, quantity: 2, rate: 1000 }] },
      });
      const po = await ctx.request.post(`${BASE}/api/purchase-orders`, {
        ...auth,
        data: { party_id: party.id, lines: [{ item_id: item.id, quantity: 3, rate: 900 }] },
      });
      return bill.ok() && po.ok() ? null : `bill ${bill.status()} / order ${po.status()}`;
    } catch (e) { return e.message; }
  })();
  report.ok(seeded === null, "a purchase bill and an order exist, so those two menus have rows to open",
    seeded || "seeded through /api/purchases and /api/purchase-orders");

  /* ── 1. every menu, both themes, both window sizes ─────────────────── */
  const found = [];
  const missing = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("vy_app_theme", t), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1600);
    report.ok(await page.evaluate(() => document.body.getAttribute("data-theme")) === theme,
      `the app is in ${theme} theme`);

    for (const size of [LAPTOP, DESKTOP]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      const at = `${size.width}x${size.height} ${theme}`;

      for (const m of MENUS) {
        if (!(await openMenu(page, m))) {
          if (theme === "light" && size === LAPTOP) missing.push(m.key);
          await closeMenu(page);
          continue;
        }
        if (theme === "light" && size === LAPTOP) found.push(m.key);
        const p = await readPanel(page);
        const hit = await hitTest(page);

        /* No action dropped, and none gained: item by item. */
        const labels = p.options.map((o) => o.label);
        const same = labels.length === m.expect.length && labels.every((l, i) => l === m.expect[i]);
        report.ok(same, `${m.key}: the same options as before, in order (${at})`,
          same ? "" : `expected [${m.expect.join(" | ")}] got [${labels.join(" | ")}]`);

        /* One panel of rows — the old bug was N loose boxes. */
        report.ok(p.panels === 1 && p.role === "menu" && p.options.every((o) => o.display === "flex" && o.appearance === "none"),
          `${m.key}: one panel, options are rows in it, no browser-default buttons (${at})`,
          `${p.panels} panel(s), displays [${[...new Set(p.options.map((o) => o.display))].join(",")}], appearance [${[...new Set(p.options.map((o) => o.appearance))].join(",")}]`);

        /* Geometry: the whole box on screen, and nothing clipping it. */
        const b = p.box;
        const onScreen = b.x >= 0 && b.y >= 0 && b.right <= size.width + 0.5 && b.bottom <= size.height + 0.5 && b.w > 100 && b.h > 20;
        report.ok(onScreen, `${m.key}: the whole panel is inside the window (${at})`,
          `[${Math.round(b.x)},${Math.round(b.y)}]–[${Math.round(b.right)},${Math.round(b.bottom)}] in ${size.width}x${size.height}`);
        report.ok(hit && hit.parentIsBody && hit.inside.every(Boolean),
          `${m.key}: all four corners are painted — no ancestor clips or covers it (${at})`,
          `corners ${JSON.stringify(hit?.inside)}, portalled to body: ${hit?.parentIsBody}`);

        /* Destructive options say so in words, not only in red. */
        for (const o of p.options.filter((x) => x.danger)) {
          report.ok(o.flag.toLowerCase() === "destructive",
            `${m.key}: "${o.label}" is marked destructive in text, not colour alone (${at})`, o.flag || "no flag");
        }
        if (m.custom) {
          report.ok(await page.locator(`.dkm-panel ${m.custom}`).count() > 0,
            `${m.key}: its non-action content survived the conversion (${at})`, m.custom);
        }
        if (theme === "light" && size === LAPTOP && m.key === "items-products") {
          report.info(`screenshot: ${await shoot(page, "rowmenu-items-light-1366x768.png")}`);
        }
        if (theme === "dark" && size === DESKTOP && m.key === "sales-invoices") {
          report.info(`screenshot: ${await shoot(page, "rowmenu-sales-dark-1920x1080.png")}`);
        }
        await closeMenu(page);
      }

      /* Contrast, once per theme and size, on the richest menu (it has a
         plain option, a destructive one and the flag). */
      if (await openMenu(page, MENUS.find((m) => m.key === "sales-invoices"))) {
        for (const c of await panelContrast(page)) {
          report.ok(c.ratio >= 4.5, `${theme}: ${c.what} in the menu is legible (${at})`, `${c.ratio}:1`);
        }
        await closeMenu(page);
      }
    }
  }
  report.ok(missing.length === 0 || found.length >= 8,
    `every row menu reachable in this database was opened (${found.length} of ${MENUS.length})`,
    missing.length ? `not reachable: ${missing.join(", ")}` : "all of them");

  /* ── 2. the bottom of a long table, and the right edge ──────────────── */
  await page.evaluate(() => localStorage.setItem("vy_app_theme", "light"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  await page.setViewportSize(LAPTOP);

  const last = await (async () => {
    if (!(await go(page, "Sales"))) return null;
    await openTab(page, "Invoices");
    const dots = page.locator("tbody .dk-dots");
    const n = await dots.count();
    if (!n) return null;
    const t = dots.nth(n - 1);
    await t.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const trig = await t.boundingBox();
    await t.click();
    await page.waitForTimeout(300);
    return { trig, panel: await readPanel(page), hit: await hitTest(page), rows: n };
  })();
  if (last?.panel) {
    const b = last.panel.box;
    report.ok(b.bottom <= LAPTOP.height + 0.5 && b.y >= 0,
      "the last row of the table opens a menu that is still fully on screen",
      `row ${last.rows} trigger at y=${Math.round(last.trig.y)}, panel [${Math.round(b.y)}–${Math.round(b.bottom)}] of ${LAPTOP.height}`);
    report.ok(b.y < last.trig.y,
      "…because it flipped above its trigger rather than running off the bottom",
      `panel top ${Math.round(b.y)} vs trigger top ${Math.round(last.trig.y)}`);
    report.ok(last.hit.inside.every(Boolean),
      "and it is not clipped by the table card it was opened from");
    report.info(`screenshot: ${await shoot(page, "rowmenu-lastrow-1366x768.png")}`);
    await closeMenu(page);
  } else {
    report.ok(false, "the last row of the sales table could be opened", "no rows found");
  }

  /* The trigger column is the last one, so a narrow window puts it against the
     right edge — the panel has to shift left, not hang off. */
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(400);
  if (await openMenu(page, MENUS.find((m) => m.key === "sales-invoices"))) {
    const p = await readPanel(page);
    report.ok(p.box.right <= 900 - 4 && p.box.x >= 4,
      "a menu whose trigger is at the right edge shifts back inside the window",
      `[${Math.round(p.box.x)}–${Math.round(p.box.right)}] in 900`);
    await closeMenu(page);
  }

  /* ── 3. keyboard, Escape, outside click, scroll ─────────────────────── */
  await page.setViewportSize(LAPTOP);
  await page.waitForTimeout(300);
  if (await openMenu(page, MENUS.find((m) => m.key === "sales-invoices"))) {
    await page.keyboard.press("ArrowDown");
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 20));
    report.ok(first?.startsWith("View") && second?.startsWith("Edit"),
      "arrow keys walk the options", `first "${first}", second "${second}"`);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    const wrapped = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 24));
    report.ok(/Void this sale/.test(wrapped || ""), "and wrap around at the ends", `landed on "${wrapped}"`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    report.ok(await page.locator(".dkm-panel").count() === 0, "Escape closes the menu");
    const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "");
    report.ok(/^Actions for/.test(back),
      "and focus goes back to the ⋮ button it came from, not to the top of the page", `focus on "${back}"`);
  }

  if (await openMenu(page, MENUS.find((m) => m.key === "sales-invoices"))) {
    await page.mouse.click(200, 600);
    await page.waitForTimeout(250);
    report.ok(await page.locator(".dkm-panel").count() === 0, "a click outside closes the menu");
  }
  if (await openMenu(page, MENUS.find((m) => m.key === "sales-invoices"))) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    report.ok(await page.locator(".dkm-panel").count() === 0,
      "scrolling closes it, so a fixed panel can never point at the wrong row");
  }

  /* ── 4. an action still runs ─────────────────────────────────────────── */
  if (await openMenu(page, MENUS.find((m) => m.key === "sales-invoices"))) {
    await page.locator(".dkm-panel .dkm-item").filter({ hasText: /^View$/ }).first().click();
    await page.waitForTimeout(1400);
    report.ok(await page.locator(".modal, .doc-fs, .dk-mveil").count() > 0,
      "choosing an option still does the thing — \"View\" opens the sale");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }

  report.ok(errs.length === 0, "no console or page errors while opening every menu", errs.slice(0, 3).join(" | "));
  await page.close();
  await ctx.close();
}
