/**
 * cashbank.spec — the Cash & Bank tiles, and the payment form that fills them.
 *
 * Two things are being guarded, and both are the same kind of bug: a number on
 * screen that the database does not agree with.
 *
 *   1. **The tiles.** Cash & Bank was a strip and a table; it is now a tile per
 *      account carrying three figures — the balance, where the account opened
 *      today, and where it closed. Two of those three are derived, so the
 *      obvious failure is a tile that looks plausible and is wrong. Every
 *      figure on every tile is therefore read out of the DOM and compared with
 *      `/api/money/overview`, and the section chips are compared with the sum
 *      of the tiles under them.
 *
 *   2. **The allocation.** The payment form used to claim, in prose, that money
 *      is applied to the oldest open invoices first, and then show nothing. It
 *      now shows the actual plan. A preview that disagrees with what the server
 *      does is worse than no preview — it is a promise the save breaks — so
 *      this spec fills the form in a real browser, reads the plan off the
 *      screen, saves it, and then asserts through the API that each invoice
 *      moved by exactly the amount the screen said it would.
 *
 * Also checked, because both are how this app has been bitten before: the form
 * is reachable at 1366x768 as well as 1920x1080 (a footer below the fold is the
 * bug docforms.spec exists for), and the tiles are legible in dark as well as
 * light — measured as a contrast ratio, not eyeballed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signIn, go, watchErrors, apiToken, BASE } from "../harness.mjs";

export const name = "cash & bank tiles, and a payment that lands where the screen said";

const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "genius-cashbank-"));
const LAPTOP = { width: 1366, height: 768 };
const DESKTOP = { width: 1920, height: 1080 };

/* ── helpers ──────────────────────────────────────────────────────────── */
async function apiGet(page, token, p) {
  const r = await page.request.get(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  return j.data !== undefined ? j.data : j;
}
async function apiPost(page, token, p, data) {
  const r = await page.request.post(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` }, data });
  const j = await r.json();
  return j.data !== undefined ? j.data : j;
}

/* Money is printed through the firm's own formatter (thousands separators, a
   currency word that the shop can change), so the tests compare numbers rather
   than strings — otherwise a settings change breaks the suite and tells you
   nothing about the tiles. */
const numOf = (s) => {
  const m = String(s || "").replace(/[^\d.,\-−]/g, "").replace(/−/g, "-").replace(/,/g, "");
  const v = parseFloat(m);
  return Number.isFinite(v) ? v : null;
};
const near = (a, b, tol = 0.02) => a != null && b != null && Math.abs(a - b) <= tol;

async function shoot(page, file) {
  const p = path.join(SHOTS, file);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

/** Everything the tiles are showing, scraped from the DOM. */
function readTiles(page) {
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll(".cb-section")].map((s) => ({
      title: s.querySelector(".cb-head h3")?.textContent.trim() || "",
      chip: s.querySelector(".cb-chip")?.textContent.trim() || "",
      createBtn: s.querySelector(".cb-head .dk-create")?.textContent.trim() || "",
      tiles: [...s.querySelectorAll(".cb-tile")].map((t) => {
        const stats = [...t.querySelectorAll(".cb-stat")];
        return {
          name: t.querySelector(".cb-name")?.textContent.trim() || "",
          code: (t.querySelector(".cb-code")?.textContent.trim() || "").replace(/\D/g, ""),
          big: t.querySelector(".cb-big")?.textContent.trim() || "",
          cap: t.querySelector(".cb-cap")?.textContent.trim() || "",
          hasIcon: !!t.querySelector(".cb-ic svg"),
          hasMenu: !!t.querySelector("button"),
          stats: stats.map((r) => ({
            label: r.querySelector(".l")?.childNodes[0]?.textContent.trim() || "",
            word: r.querySelector(".l small")?.textContent.trim() || "",
            value: r.querySelector(".v")?.textContent.trim() || "",
            cls: r.className,
          })),
          action: t.querySelector(".cb-act")?.textContent.trim() || "",
        };
      }),
    }));
    return sections;
  });
}

/** Contrast ratio of every named element against the surface it sits on. */
function contrastAudit(page, selectors) {
  return page.evaluate((sels) => {
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const out = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el.textContent.trim()) continue;
        const fg = parse(getComputedStyle(el).color).slice(0, 3);
        const bg = bgOf(el);
        const [a, b] = [lum(fg) + 0.05, lum(bg) + 0.05].sort((x, y) => y - x);
        out.push({ sel, text: el.textContent.trim().slice(0, 24), ratio: +(a / b).toFixed(2) });
        break;   // one sample per selector is enough; they share a rule
      }
    }
    return out;
  }, selectors);
}

/** The plan the allocation panel is showing, row by row. */
function readPlan(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".pay-alloc-row")].map((r) => ({
      doc: r.querySelector(".d b")?.textContent.trim() || "",
      due: r.querySelectorAll(".r")[0]?.textContent.trim() || "",
      pays: r.querySelectorAll(".r")[1]?.querySelector("b")?.textContent.trim() || "",
      word: r.querySelectorAll(".r")[1]?.querySelector("small")?.textContent.trim() || "",
      cls: r.className,
    }));
    return {
      rows,
      foot: document.querySelector(".pay-alloc-foot")?.textContent.trim() || "",
      advance: document.querySelector(".pay-advance")?.textContent.trim() || "",
      summary: [...document.querySelectorAll(".doc-fs-sum")].map((s) => s.textContent.trim()),
      grand: document.querySelector(".doc-fs-grand .v")?.textContent.trim() || "",
    };
  });
}

async function openMoneyTab(page, tab) {
  await go(page, "Cash & bank");
  await page.locator(".dk-tab").filter({ hasText: new RegExp(`^${tab}`, "i") }).first().click();
  await page.waitForTimeout(1100);
}

/* ── the spec ─────────────────────────────────────────────────────────── */
export async function run({ browser, report }) {
  const ctx = await browser.newContext({ viewport: LAPTOP });
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  await signIn(page, LAPTOP);
  const token = await apiToken(page.request);
  const today = new Date().toISOString().slice(0, 10);

  /* ── fixtures ──────────────────────────────────────────────────────────
     A customer of our own with three unpaid invoices of known size. Reusing a
     seeded customer would make the allocation assertions depend on whatever
     another spec had already done to them. */
  const items = await apiGet(page, token, "/items");
  const item = items[0];
  await apiPost(page, token, "/parties", { name: "Tilecheck Traders", party_type: "customer", phone: "0772000771" });
  const parties = await apiGet(page, token, "/parties");
  const cust = parties.find((p) => p.name === "Tilecheck Traders");
  report.ok(cust && item, "the fixture customer and an item exist", `${cust?.name} / ${item?.name}`);

  /* 120,000 / 80,000 / 50,000 on credit. A payment of 150,000 must clear the
     first, part-pay the second and leave the third alone — three different
     outcomes in one save, which is what makes the preview worth checking. */
  const wanted = [120000, 80000, 50000];
  const invs = [];
  for (const amt of wanted) {
    const r = await apiPost(page, token, "/sales", {
      party_id: cust.id, invoice_date: today, payment_type: "credit", paid_amount: 0, sales_rep_id: 1,
      lines: [{ item_id: item.id, description: item.name, quantity: 1, rate: amt, tax_rate: 0, discount: 0 }],
    });
    invs.push(r);
  }
  const openBefore = await apiGet(page, token, `/payments/open?party_id=${cust.id}&direction=in`);
  report.ok(openBefore.rows.length >= 3, "the fixture customer has three open invoices",
    `${openBefore.rows.length} open, ${openBefore.totalDue} due`);
  /* The endpoint the panel reads must hand documents back oldest-first, in the
     same order the allocator takes them — that is the whole contract. */
  const ids = openBefore.rows.map((r) => r.id);
  report.ok(ids.every((v, i) => i === 0 || v > ids[i - 1]),
    "/payments/open returns documents in the order the allocator takes them (oldest first)",
    ids.join(", "));

  /* ── 1. the tiles agree with the API ───────────────────────────────── */
  const ov = await apiGet(page, token, "/money/overview");
  report.ok(Array.isArray(ov.accounts) && ov.accounts.length > 0, "the API has cash/bank accounts to draw",
    ov.accounts?.map((a) => `${a.code} ${a.name}`).join(" · "));
  for (const a of ov.accounts) {
    report.ok(near(a.openingToday + a.inToday - a.outToday, a.closeToday),
      `${a.name}: the API's own opening + today's movement equals its close`,
      `${a.openingToday} + ${a.inToday} − ${a.outToday} vs ${a.closeToday}`);
    report.ok(near(a.closeToday, a.balance), `${a.name}: today's close is the live balance, not a second opinion`,
      `${a.closeToday} vs ${a.balance}`);
  }

  await openMoneyTab(page, "Accounts");
  const sections = await readTiles(page);
  const domTiles = sections.flatMap((s) => s.tiles);
  report.ok(sections.length === 2, "cash and bank are two sections, not one list",
    sections.map((s) => `${s.title} (${s.tiles.length})`).join(" · "));
  report.ok(sections.every((s) => /New (cash|bank) account/i.test(s.createBtn)),
    "each section header carries its own primary create button",
    sections.map((s) => s.createBtn).join(" · "));
  report.ok(domTiles.length === ov.accounts.length,
    "there is exactly one tile per cash/bank account the API reports",
    `${domTiles.length} tiles, ${ov.accounts.length} accounts`);

  for (const a of ov.accounts) {
    const t = domTiles.find((x) => x.code === String(a.code));
    if (!t) { report.ok(false, `${a.name}: has a tile`, `no tile with code ${a.code}`); continue; }
    report.ok(near(Math.abs(numOf(t.big) ?? NaN), Math.abs(a.balance)),
      `${a.name}: the large figure is the balance the API reports`,
      `tile "${t.big}" vs api ${a.balance}`);
    report.ok(/current balance/i.test(t.cap), `${a.name}: the large figure is captioned`, t.cap);
    report.ok(t.hasIcon && t.hasMenu, `${a.name}: the tile has its icon and its row menu`);
    report.ok(t.stats.length === 2, `${a.name}: two stat rows`, t.stats.map((s) => s.label).join(" / "));
    report.ok(near(numOf(t.stats[0]?.value), a.openingToday),
      `${a.name}: the opening row is the API's opening`, `tile "${t.stats[0]?.value}" vs api ${a.openingToday}`);
    report.ok(near(numOf(t.stats[1]?.value), a.closeToday),
      `${a.name}: the close row is the API's close`, `tile "${t.stats[1]?.value}" vs api ${a.closeToday}`);
    /* Colour is never the only signal: the direction of the day is written out
       in words as well as being tinted (WCAG 1.4.1). */
    const net = +(a.inToday - a.outToday).toFixed(2);
    const expect = net > 0.005 ? /in today$/ : net < -0.005 ? /out today$/ : /no movement today/;
    report.ok(expect.test(t.stats[1]?.word || ""),
      `${a.name}: the day's direction is stated in words, not only in colour`,
      `net ${net}, row says "${t.stats[1]?.word}" (${t.stats[1]?.cls})`);
    report.ok(/view statement/i.test(t.action), `${a.name}: the tile ends in a full-width action`, t.action);
  }

  /* The chip beside each heading is the sum of the tiles under it — the figure
     somebody quotes without opening anything. */
  for (const s of sections) {
    /* Three groups now, not two: mobile money was split out of "Bank & mobile
       money" once the schema could tell them apart. */
    const kind = /cash/i.test(s.title) ? "cash" : /mobile/i.test(s.title) ? "mobile" : "bank";
    const sum = ov.accounts.filter((a) => a.kind === kind).reduce((x, a) => x + a.balance, 0);
    const chipN = numOf(s.chip.split("·").pop());
    report.ok(near(Math.abs(chipN ?? NaN), Math.abs(sum)),
      `${s.title}: the header chip totals the tiles beneath it`, `chip "${s.chip}" vs ${sum}`);
    report.ok(s.chip.includes(`${s.tiles.length} account`),
      `${s.title}: the chip says how many accounts, not only how much`, s.chip);
  }
  report.info(`screenshot: ${await shoot(page, "tiles-light-1366x768.png")}`);

  /* Drilling in and back — the per-account page tabs were removed, so the tile
     is now the only way to a statement and it had better work. */
  await page.locator(".cb-tile .cb-act").first().click();
  await page.waitForTimeout(1400);
  report.ok(await page.locator(".dk-tablecard h3").filter({ hasText: /Statement/i }).count() > 0,
    "the tile's action opens that account's statement");
  await page.locator(".cb-back button").click();
  await page.waitForTimeout(900);
  report.ok(await page.locator(".cb-tile").count() > 0, "and there is a way back to the tiles");

  /* ── 2. dark theme and the wide viewport ───────────────────────────── */
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(500);
  const wide = await readTiles(page);
  report.ok(wide.flatMap((s) => s.tiles).length === domTiles.length,
    "the same tiles are drawn at 1920x1080", `${wide.flatMap((s) => s.tiles).length}`);
  const clipped = await page.evaluate(() => [...document.querySelectorAll(".cb-tile")]
    .filter((t) => { const r = t.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.width < 200; }).length);
  report.ok(clipped === 0, "no tile is clipped or squeezed at 1920x1080", `${clipped} bad tiles`);
  report.info(`screenshot: ${await shoot(page, "tiles-light-1920x1080.png")}`);

  const lightContrast = await contrastAudit(page, [".cb-big", ".cb-cap", ".cb-stat .l", ".cb-stat .v", ".cb-chip", ".cb-act", ".cb-code"]);
  for (const c of lightContrast) {
    report.ok(c.ratio >= 4.5, `light theme: ${c.sel} is legible on its surface`, `${c.ratio}:1 ("${c.text}")`);
  }

  await page.evaluate(() => localStorage.setItem("vy_app_theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await openMoneyTab(page, "Accounts");
  report.ok(await page.evaluate(() => document.body.getAttribute("data-theme")) === "dark", "the app is in dark theme");
  const darkTiles = await readTiles(page);
  report.ok(darkTiles.flatMap((s) => s.tiles).length === domTiles.length, "every tile survives the theme switch");
  const darkContrast = await contrastAudit(page, [".cb-big", ".cb-cap", ".cb-stat .l", ".cb-stat .v", ".cb-chip", ".cb-act", ".cb-code"]);
  for (const c of darkContrast) {
    report.ok(c.ratio >= 4.5, `dark theme: ${c.sel} is legible on its surface`, `${c.ratio}:1 ("${c.text}")`);
  }
  report.info(`screenshot: ${await shoot(page, "tiles-dark-1920x1080.png")}`);

  /* ── 3. the payment form, in dark, at 1920 ─────────────────────────── */
  await openMoneyTab(page, "Payments & expenses");
  await page.getByRole("button", { name: /Record payment/i }).first().click();
  await page.waitForTimeout(1200);
  report.ok(await page.locator(".doc-fs").count() > 0,
    "Record payment opens in the shared full-screen document shell, not a second pattern");
  report.ok((await page.locator(".doc-fs-head h2").innerText()).trim() === "Payment received",
    "the header names what is being recorded");

  /* Empty state first: the panel must say it is waiting, not imply nothing is
     owed. A blank allocation on a customer who owes 250,000 is a lie. */
  report.ok(/pick a customer/i.test(await page.locator(".pay-alloc.empty").innerText()),
    "with nobody chosen the allocation panel says so rather than showing nothing");

  await page.locator(".pay-amount input").fill("150000");
  await page.selectOption(".doc-fs select >> nth=0", { label: cust.name });
  await page.waitForTimeout(1400);

  const plan = await readPlan(page);
  report.ok(plan.rows.length === openBefore.rows.length,
    "the panel lists every open invoice, not just the ones the money reaches",
    `${plan.rows.length} rows for ${openBefore.rows.length} open invoices`);
  report.ok(plan.rows[0].doc === openBefore.rows[0].doc_no,
    "the oldest invoice is at the top", `${plan.rows[0].doc} vs ${openBefore.rows[0].doc_no}`);

  /* The plan the screen is promising, worked out independently here from the
     API's own figures. If these two ever disagree the panel is lying. */
  let left = 150000;
  const expected = openBefore.rows.map((r) => {
    const alloc = Math.max(0, Math.min(left, r.balance_due));
    left = +(left - alloc).toFixed(2);
    return { doc: r.doc_no, alloc, clears: alloc >= r.balance_due - 0.005 && alloc > 0 };
  });
  for (const e of expected) {
    const row = plan.rows.find((r) => r.doc === e.doc);
    if (!row) { report.ok(false, `${e.doc} appears in the plan`); continue; }
    report.ok(near(numOf(row.pays) ?? 0, e.alloc) || (e.alloc === 0 && row.pays === "—"),
      `${e.doc}: the screen promises the amount the allocator would take`,
      `screen "${row.pays}" vs computed ${e.alloc}`);
    const word = e.alloc === 0 ? "not reached" : e.clears ? "cleared" : "part paid";
    report.ok(row.word === word, `${e.doc}: its outcome is written in words as well as tinted`,
      `"${row.word}" expected "${word}" (${row.cls})`);
  }
  report.ok(/3 invoices touched|2 of 3 invoices touched/.test(plan.foot),
    "the panel foots the plan", plan.foot);
  report.ok(plan.summary.some((s) => /Clears invoices/i.test(s)),
    "the footer names what is cleared, separately from what was received", plan.summary.join(" | "));

  /* Geometry, at the laptop size that made the old purchase form unusable. */
  await page.setViewportSize(LAPTOP);
  await page.waitForTimeout(600);
  const geo = await page.evaluate(() => {
    const s = document.querySelector(".doc-fs"), f = document.querySelector(".doc-fs-foot");
    const save = document.querySelector(".doc-fs-acts .btn-primary");
    const b = document.querySelector(".doc-fs-body");
    return {
      vh: window.innerHeight, shellBottom: Math.round(s.getBoundingClientRect().bottom),
      footBottom: Math.round(f.getBoundingClientRect().bottom),
      saveBottom: Math.round(save.getBoundingClientRect().bottom),
      bodyOverflow: getComputedStyle(b).overflowY,
    };
  });
  report.ok(geo.shellBottom <= geo.vh + 1 && geo.footBottom <= geo.vh && geo.saveBottom <= geo.vh,
    "at 1366x768 the whole form, its total and its Save button are on screen",
    JSON.stringify(geo));
  report.ok(geo.bodyOverflow === "auto" || geo.bodyOverflow === "scroll",
    "the body is what scrolls, not the shell", geo.bodyOverflow);
  const payContrast = await contrastAudit(page, [".pay-amount input", ".pay-alloc-head", ".pay-alloc-row .d b", ".pay-alloc-foot", ".pay-advance"]);
  for (const c of payContrast) {
    report.ok(c.ratio >= 4.5, `dark theme: ${c.sel} is legible in the payment form`, `${c.ratio}:1 ("${c.text}")`);
  }
  report.info(`screenshot: ${await shoot(page, "payment-dark-1366x768.png")}`);

  /* ── 4. save it, and prove the money went where the screen said ────── */
  await page.locator(".doc-fs-acts .btn-primary").click();
  await page.waitForTimeout(2600);
  report.ok(await page.locator(".doc-fs").count() === 0, "the form closes once the payment is recorded");

  const after = await apiGet(page, token, `/payments/open?party_id=${cust.id}&direction=in`);
  const byNo = Object.fromEntries(after.rows.map((r) => [r.doc_no, r]));
  for (const e of expected) {
    const before = openBefore.rows.find((r) => r.doc_no === e.doc);
    const now = byNo[e.doc];
    if (e.clears) {
      report.ok(!now, `${e.doc}: the invoice the screen said it would clear is closed in the database`,
        now ? `still open with ${now.balance_due}` : "gone from the open list");
    } else {
      report.ok(now && near(now.balance_due, +(before.balance_due - e.alloc).toFixed(2)),
        `${e.doc}: the database took exactly what the screen promised`,
        `${before.balance_due} − ${e.alloc} should be ${(before.balance_due - e.alloc).toFixed(2)}, is ${now?.balance_due}`);
    }
  }
  const totalTaken = +(openBefore.totalDue - after.totalDue).toFixed(2);
  report.ok(near(totalTaken, 150000), "the whole payment was allocated, nothing lost or double-counted",
    `${openBefore.totalDue} → ${after.totalDue} = ${totalTaken} taken`);

  const paidInv = await apiGet(page, token, `/sales/${invs[0].id}`);
  report.ok(String(paidInv.status || paidInv.invoice?.status) === "paid" ||
            near(Number(paidInv.balance_due ?? paidInv.invoice?.balance_due), 0),
    "the fully-settled invoice is marked paid, not left showing a balance",
    JSON.stringify({ status: paidInv.status ?? paidInv.invoice?.status, due: paidInv.balance_due ?? paidInv.invoice?.balance_due }));

  const list = await apiGet(page, token, `/payments?q=Tilecheck&limit=20`);
  const rows = list.rows || list;
  report.ok(rows.length === 1 && near(Number(rows[0].amount), 150000) && rows[0].status === "paid",
    "exactly one payment of the amount typed was written, and it is posted",
    JSON.stringify(rows.map((r) => [r.payment_no, r.amount, r.status])));

  /* And the tile the money landed in moved by the same amount. Cash in Hand is
     the default deposit account, so its close should be up by 150,000. */
  const ovAfter = await apiGet(page, token, "/money/overview");
  const cashBefore = ov.accounts.find((a) => a.code === "1001");
  const cashAfter = ovAfter.accounts.find((a) => a.code === "1001");
  report.ok(near(cashAfter.balance - cashBefore.balance, 150000),
    "the account the payment was deposited to is up by the amount received",
    `${cashBefore.balance} → ${cashAfter.balance}`);
  await openMoneyTab(page, "Accounts");
  const tilesAfter = (await readTiles(page)).flatMap((s) => s.tiles).find((t) => t.code === "1001");
  report.ok(near(numOf(tilesAfter.big), cashAfter.balance),
    "and the tile shows the new balance, not a cached one", `tile "${tilesAfter.big}" vs ${cashAfter.balance}`);
  report.ok(/in today$/.test(tilesAfter.stats[1].word) && tilesAfter.stats[1].cls.includes("up"),
    "the tile now reports money in today, in words and in tint", JSON.stringify(tilesAfter.stats[1]));

  /* ── 5. overpayment becomes an advance, and says so before saving ──── */
  await openMoneyTab(page, "Payments & expenses");
  await page.getByRole("button", { name: /Record payment/i }).first().click();
  await page.waitForTimeout(1200);
  await page.locator(".pay-amount input").fill("500000");
  await page.selectOption(".doc-fs select >> nth=0", { label: cust.name });
  await page.waitForTimeout(1400);
  const over = await readPlan(page);
  const stillDue = after.totalDue;
  report.ok(/advance/i.test(over.advance) && near(numOf(over.advance), +(500000 - stillDue).toFixed(2)),
    "paying more than is owed is named as an advance, with the right amount, before saving",
    `"${over.advance}" — expected ${(500000 - stillDue).toFixed(2)}`);
  report.ok(over.summary.some((s) => /Left as advance/i.test(s)),
    "the advance is repeated in the footer summary", over.summary.join(" | "));
  await page.locator(".doc-fs-acts .btn-ghost").first().click();
  await page.waitForTimeout(600);

  /* ── 6. a draft allocates nothing ──────────────────────────────────── */
  await page.getByRole("button", { name: /Record payment/i }).first().click();
  await page.waitForTimeout(1200);
  await page.locator(".pay-amount input").fill("9000");
  await page.selectOption(".doc-fs select >> nth=0", { label: cust.name });
  await page.waitForTimeout(1200);
  const dueBeforeDraft = (await apiGet(page, token, `/payments/open?party_id=${cust.id}&direction=in`)).totalDue;
  await page.locator(".doc-fs-head .pay-draft").click();
  await page.waitForTimeout(2200);
  const dueAfterDraft = (await apiGet(page, token, `/payments/open?party_id=${cust.id}&direction=in`)).totalDue;
  report.ok(near(dueBeforeDraft, dueAfterDraft),
    "a draft parks the payment without touching a single invoice",
    `${dueBeforeDraft} → ${dueAfterDraft}`);
  /* sendList answers with a bare array when the result fits one page and an
     envelope when it does not, so both shapes have to be accepted. */
  const rawPays = await apiGet(page, token, "/payments?q=Tilecheck&limit=20");
  const allPays = rawPays.rows || rawPays;
  const drafts = allPays.filter((r) => r.status === "draft");
  report.ok(drafts.length === 1 && near(Number(drafts[0].amount), 9000),
    "the draft itself was saved and is marked as one",
    `all payments for this party: ${JSON.stringify(allPays.map((d) => [d.payment_no, d.amount, d.status]))}`);

  /* ── 7. paid-to-supplier still works ───────────────────────────────── */
  await page.getByRole("button", { name: /Record payment/i }).first().click();
  await page.waitForTimeout(1200);
  await page.locator(".pay-dir button").nth(1).click();
  await page.waitForTimeout(900);
  report.ok((await page.locator(".doc-fs-head h2").innerText()).trim() === "Payment made",
    "the outgoing direction is still available and renames the document");
  report.ok(/supplier/i.test(await page.locator(".pay-alloc.empty").innerText()),
    "and the allocation panel switches to talking about bills, not invoices",
    (await page.locator(".pay-alloc.empty").innerText()).slice(0, 80));
  /* Withholding tax is the capability most easily lost in a redesign: it
     settles more than arrives, and the form must say both numbers. */
  await page.locator(".pay-dir button").nth(0).click();
  await page.waitForTimeout(500);
  await page.locator(".pay-amount input").fill("100000");
  await page.locator('.pay-wht input[type="radio"]').nth(1).check();
  await page.waitForTimeout(400);
  await page.locator('.pay-wht input[type="number"]').fill("6000");
  await page.locator('.doc-fs input[type="number"]').last().fill("1500");   // bank charges
  await page.waitForTimeout(700);
  const wht = await readPlan(page);
  report.ok(wht.summary.some((s) => /Tax withheld/i.test(s)) && wht.summary.some((s) => /Bank charges/i.test(s)),
    "withholding tax and bank charges both survive and are both named", wht.summary.join(" | "));
  report.ok(near(numOf(wht.grand), 98500),
    "the total is what actually reaches the account — amount less bank charges",
    `"${wht.grand}" expected 98,500`);
  await page.locator(".doc-fs-acts .btn-ghost").first().click();
  await page.waitForTimeout(500);

  /* ── 8. and the same form in light, at the desktop size ────────────── */
  await page.evaluate(() => localStorage.setItem("vy_app_theme", "light"));
  await page.setViewportSize(DESKTOP);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await openMoneyTab(page, "Payments & expenses");
  await page.getByRole("button", { name: /Record payment/i }).first().click();
  await page.waitForTimeout(1200);
  await page.locator(".pay-amount input").fill("60000");
  await page.selectOption(".doc-fs select >> nth=0", { label: cust.name });
  await page.waitForTimeout(1400);
  report.ok(await page.locator(".pay-alloc-row").count() > 0,
    "the allocation panel works in light theme too at 1920x1080");
  const lightPay = await contrastAudit(page, [".pay-amount input", ".pay-alloc-head", ".pay-alloc-row .d b", ".pay-alloc-foot", ".pay-advance", ".pay-wht-q"]);
  for (const c of lightPay) {
    report.ok(c.ratio >= 4.5, `light theme: ${c.sel} is legible in the payment form`, `${c.ratio}:1 ("${c.text}")`);
  }
  report.info(`screenshot: ${await shoot(page, "payment-light-1920x1080.png")}`);
  await page.locator(".doc-fs-acts .btn-ghost").first().click();
  await page.waitForTimeout(500);

  /* ── 8b. one expense form, not two ──────────────────────────────────
     Cash & bank had its own four-field dialog (category, amount, mode, note)
     while Purchases had the full editor. The same expense saved from two
     screens wrote two different rows: no date — so last week's rent landed in
     this week's figures — no supplier, no tax and no account it came out of.
     Both screens now open the one editor. */
  await openMoneyTab(page, "Payments & expenses");
  await page.locator(".dk-seg2 button").filter({ hasText: "Expenses" }).first().click();
  await page.waitForTimeout(900);
  await page.locator(".dk-create").filter({ hasText: /Add expense/ }).first().click();
  await page.waitForTimeout(1300);
  const expForm = await page.evaluate(() => ({
    fullScreen: document.querySelectorAll(".doc-fs").length,
    modal: document.querySelectorAll(".modal").length,
    fields: [...document.querySelectorAll(".doc-fs label, .doc-fs .lbl, .doc-fs .fld > span")]
      .map((n) => n.textContent.trim().toLowerCase()),
  }));
  report.ok(expForm.fullScreen === 1 && expForm.modal === 0,
    "Add expense here opens the full-screen editor Purchases uses, not a second dialog",
    `${expForm.fullScreen} full-screen, ${expForm.modal} modal`);
  const expWanted = ["date", "tax", "out of", "paid to"];
  const has = expWanted.filter((w) => expForm.fields.some((f) => f.includes(w)));
  report.ok(has.length === expWanted.length,
    "…so the fields the old dialog dropped are here: date, tax, which account, who it was paid to",
    `found ${has.join(", ")} of ${expWanted.join(", ")}`);
  await page.locator(".doc-fs").getByText(/^Cancel$/).first().click().catch(() => {});
  await page.waitForTimeout(600);

  /* ── 9. the `kind` column, migrated onto a real database ────────────
     The suite runs against a copy of the shipped `backend/data/genius.db`,
     which has real accounts in it, so this is the migration happening to a
     populated book rather than to an empty one.

     What must not happen is a reclassification. `kind` is added NULL and is
     not backfilled; every account that existed before it keeps grouping by the
     old name rule. A stored value only exists for accounts saved since, and
     then it wins over the name — which is the whole point, because the name
     rule files "Cash at Stanbic" in the till drawer. */
  const CASHY = /\b(cash|till|drawer|petty|float|safe)\b/i;
  const nameRule = (a) => (a.code === "1001" || CASHY.test(a.name)) ? "cash" : "bank";
  const coa = await apiGet(page, token, "/accounting/accounts");
  const money = coa.filter((a) => a.is_cash_bank === 1);
  report.ok(money.length > 0 && money.every((a) => a.kind === null || a.kind === undefined),
    "the kind column arrives empty on a database that predates it — nothing is backfilled",
    money.map((a) => `${a.code} ${a.name}=${JSON.stringify(a.kind)}`).join(", "));

  const kindBefore = new Map(money.map((a) => [a.code, nameRule(a)]));
  const grouped = await apiGet(page, token, "/money/overview");
  const kindAfter = new Map(grouped.accounts.map((a) => [a.code, a.kind]));
  const moved = [...kindBefore].filter(([code, k]) => kindAfter.get(code) !== k);
  report.ok(moved.length === 0,
    "and every account that was already there groups exactly as it did before",
    moved.map(([c, k]) => `${c}: was ${k}, now ${kindAfter.get(c)}`).join(", ") || `${kindBefore.size} accounts checked`);

  /* The case the name rule gets wrong, saved through the real route. */
  await apiPost(page, token, "/accounting/accounts",
    { name: "Stanbic current account", type: "asset", is_cash_bank: true, kind: "bank" });
  await apiPost(page, token, "/accounting/accounts",
    { name: "Front counter", type: "asset", is_cash_bank: true, kind: "cash" });
  const regrouped = await apiGet(page, token, "/money/overview");
  const byName = (n) => regrouped.accounts.find((a) => a.name === n);
  report.ok(byName("Stanbic current account")?.kind === "bank",
    "a new account says where it sits: \"Stanbic current account\" is a bank account",
    `kind ${byName("Stanbic current account")?.kind}`);
  report.ok(byName("Front counter")?.kind === "cash",
    "…and \"Front counter\", which the name rule would have called a bank, is cash",
    `kind ${byName("Front counter")?.kind}`);

  report.ok(errs.length === 0, "no page errors across the tiles and the payment form",
    [...new Set(errs)].slice(0, 5).join("\n      "));
  report.info(`screenshots in ${SHOTS}`);
  await page.close();
}
