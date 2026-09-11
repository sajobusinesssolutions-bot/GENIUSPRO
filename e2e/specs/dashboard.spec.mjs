/**
 * dashboard.spec.mjs — the screen the shop opens on, checked figure by figure.
 *
 * The dashboard is the only screen a shopkeeper reads without cross-checking
 * anything, so a confident wrong number here is worse than no number at all.
 * Every figure on this page is therefore asserted against the ledger it claims
 * to come from — not against the dashboard endpoint that drew it, which would
 * only prove the browser can echo JSON:
 *
 *   takings today    → the sales list, summed for today
 *   owed to me       → /reports/ar-aging-details
 *   owed to suppliers→ /reports/ap-aging-details
 *   earned today     → /reports/bill-profit for today
 *   money I hold     → /accounting cash & bank balances
 *   collection gauge → invoiced vs paid on this month's sales list
 *
 * Then the things assertions usually miss and a screenshot catches: geometry at
 * 1366x768 and 1920x1080 in both themes (nothing outside its card, nothing
 * clipped, no chart with a zero dimension, no figure covered by something on
 * top of it), contrast for every text style and every chart mark, the empty
 * state on a shop that has not sold anything, and the module flags — a shop
 * with loyalty or manufacturing off must not be shown a widget for it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signIn, go, watchErrors, apiToken, BASE } from "../harness.mjs";

const BACKEND = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "backend");
const QUIET_PORT = Number(process.env.E2E_PORT || 3199) + 500;

export const name = "dashboard widgets: every figure traced to its ledger, in both themes";

const SHOTS = process.env.E2E_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "genius-dash-"));
const LAPTOP = { width: 1366, height: 768 };
const DESKTOP = { width: 1920, height: 1080 };
const TODAY = new Date().toISOString().slice(0, 10);

/* A second backend on its own copy of the shipped database.
   The empty state has to be tested on a shop that has not sold anything today,
   and the suite's shared server has by then been sold through by a dozen other
   specs — asserting "no sales today" against it passed alone and failed in the
   full run, which is exactly the kind of test that lies. */
async function startQuietBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-dash-quiet-"));
  const dbPath = path.join(dir, "genius.db");
  fs.copyFileSync(path.join(BACKEND, "data", "genius.db"), dbPath);
  const base = `http://localhost:${QUIET_PORT}`;
  const proc = spawn("node", ["server.js"], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(QUIET_PORT), GENIUS_DB_PATH: dbPath,
           JWT_SECRET: process.env.JWT_SECRET || "e2e-only-not-a-production-secret", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { proc, base, dir }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error("the quiet backend never became healthy\n" + log.join(""));
}
async function stopQuiet(s) {
  if (!s) return;
  const gone = new Promise((r) => s.proc.once("exit", r));
  s.proc.kill("SIGKILL");
  await gone;
  fs.rmSync(s.dir, { recursive: true, force: true });
}
async function signInAt(page, base) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="text"]', "admin").catch(() => {});
    await page.fill('input[type="password"]', "admin123");
    await page.getByRole("button", { name: /open shop/i }).click();
    await page.waitForSelector(".dk-rail", { timeout: 20000 });
    await page.waitForTimeout(1200);
  }
}

/* ── plumbing ─────────────────────────────────────────────────────────────── */
const mk = (page, token) => ({
  async get(p) {
    const r = await page.request.get(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    return j.data !== undefined ? j.data : j;
  },
  async post(p, data) {
    const r = await page.request.post(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` }, data });
    const j = await r.json();
    return { ok: r.ok(), ...(j.data !== undefined ? { data: j.data } : {}), message: j.message };
  },
  async put(p, data) {
    const r = await page.request.put(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` }, data });
    return r.ok();
  },
});

/* Money is printed through the firm's own formatter, so compare numbers, not
   strings — a currency-word change must not break the suite. */
const numOf = (s) => {
  const m = String(s == null ? "" : s).replace(/[^\d.,\-−]/g, "").replace(/−/g, "-").replace(/,/g, "");
  const v = parseFloat(m);
  return Number.isFinite(v) ? v : null;
};
const near = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;
const sum = (xs) => xs.reduce((a, b) => a + (+b || 0), 0);

async function shoot(page, file) {
  const p = path.join(SHOTS, file);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

/** Everything the new widgets are showing, scraped out of the rendered DOM. */
function readDash(page) {
  return page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.trim() : null);
    const stats = [...document.querySelectorAll(".dk-stat")].map((s) => ({
      label: txt(s.querySelector(".lab")),
      figure: txt(s.querySelector(".fig")),
      lines: [...s.querySelectorAll(".brk > span")].map((l) => ({
        value: txt(l.querySelector("b")),
        text: txt(l.querySelector(".k")),
        tone: l.className.trim(),
      })),
      caption: txt(s.querySelector(".cap")),
      bars: [...s.querySelectorAll(".dk-spark rect")].map((r) => ({
        cls: r.getAttribute("class"),
        h: +r.getAttribute("height"),
        w: +r.getAttribute("width"),
        title: txt(r.querySelector("title")),
      })),
      sparkBox: (() => { const g = s.querySelector(".dk-spark"); if (!g) return null;
        const b = g.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })(),
    }));
    const g = document.querySelector(".dk-gauge");
    const gauge = g ? {
      value: txt(g.querySelector(".val")),
      band: txt(g.querySelector(".st")),
      why: txt(g.querySelector(".why")),
      arcs: [...g.querySelectorAll("path")].map((p) => p.getAttribute("stroke-dasharray")),
      box: (() => { const b = g.querySelector("svg").getBoundingClientRect();
        return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })(),
      label: g.querySelector("svg").getAttribute("aria-label"),
    } : null;
    const watch = [...document.querySelectorAll(".dk-watch")].map((c) => ({
      title: txt(c.querySelector("h3")),
      figure: txt(c.querySelector(".fig")),
      rows: [...c.querySelectorAll(".rows > div")].map((r) => ({
        label: txt(r.querySelector("span")), value: txt(r.querySelector("b")), tone: r.className.trim(),
      })),
      note: txt(c.querySelector(".note")),
    }));
    return { stats, gauge, watch, body: document.querySelector(".dk-dash")?.innerText || "" };
  });
}

/** Contrast of one sample per selector against the surface it actually sits on. */
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
      return parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    };
    const ratio = (fg, bg) => {
      const [a, b] = [lum(fg) + 0.05, lum(bg) + 0.05].sort((x, y) => y - x);
      return +(a / b).toFixed(2);
    };
    const out = [];
    for (const { sel, fill } of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const style = getComputedStyle(el);
        if (fill) {
          const c = parse(style.fill).slice(0, 3);
          if (c.length < 3) continue;
          out.push({ sel, text: "(chart mark)", ratio: ratio(c, bgOf(el.parentElement)) });
        } else {
          const t = el.textContent.trim();
          if (!t) continue;
          out.push({ sel, text: t.slice(0, 28), ratio: ratio(parse(style.color).slice(0, 3), bgOf(el)) });
        }
        break;
      }
    }
    return out;
  }, selectors);
}

/**
 * Geometry: does anything stick out of the card it lives in, is anything
 * clipped, is any chart drawn at zero size, and is any headline figure covered
 * by something painted on top of it.
 */
function geometryAudit(page) {
  return page.evaluate(() => {
    const problems = [];
    const R = (el) => el.getBoundingClientRect();

    for (const card of document.querySelectorAll(".dk-dash .dk-card")) {
      const cb = R(card);
      if (cb.width < 40 || cb.height < 30) problems.push(`card collapsed to ${cb.width}x${cb.height}`);
      /* A card that scrolls its own content is a card that is hiding some. */
      if (card.scrollWidth > card.clientWidth + 1) {
        problems.push(`card "${card.querySelector("h3,.lab")?.textContent.trim() || "?"}" overflows sideways `
          + `(${card.scrollWidth} in ${card.clientWidth})`);
      }
      for (const el of card.querySelectorAll(".fig, .lab, .val, .st, .why, .cap, .brk > span, .rows > div, h3")) {
        const b = R(el);
        if (b.width === 0 && b.height === 0) continue;
        if (b.right > cb.right + 1.5 || b.left < cb.left - 1.5 || b.bottom > cb.bottom + 1.5) {
          problems.push(`"${el.textContent.trim().slice(0, 26)}" escapes its card `
            + `(el ${b.left.toFixed(0)}–${b.right.toFixed(0)}x${b.bottom.toFixed(0)}, `
            + `card ${cb.left.toFixed(0)}–${cb.right.toFixed(0)}x${cb.bottom.toFixed(0)})`);
        }
        /* Clipped text: the box is narrower than the words inside it and the
           element cannot scroll to reveal them. */
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") {
          problems.push(`"${el.textContent.trim().slice(0, 26)}" is clipped (${el.scrollWidth} in ${el.clientWidth})`);
        }
      }
      for (const svg of card.querySelectorAll("svg.dk-spark, .dk-gauge > svg, .dk-chart svg")) {
        const b = R(svg);
        if (b.width < 20 || b.height < 8) problems.push(`a chart rendered at ${b.width.toFixed(1)}x${b.height.toFixed(1)}`);
      }
    }

    /* Nothing painted over the headline figures: whatever the browser finds at
       the middle of each figure must be the figure itself. */
    for (const el of document.querySelectorAll(".dk-dash .fig, .dk-gauge .val")) {
      const b = R(el);
      if (b.width < 2 || b.height < 2) continue;
      const hit = document.elementFromPoint(b.left + Math.min(b.width / 2, 20), b.top + b.height / 2);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        problems.push(`"${el.textContent.trim().slice(0, 22)}" is covered by <${hit.tagName.toLowerCase()} `
          + `class="${String(hit.className).slice(0, 30)}">`);
      }
    }
    return problems;
  });
}

const TEXT_SELECTORS = [
  { sel: ".dk-stat .lab" }, { sel: ".dk-stat .fig" }, { sel: ".dk-stat .cap" },
  { sel: ".dk-stat .brk > span .k" }, { sel: ".dk-stat .brk > span > b" },
  { sel: ".dk-stat .brk > span.good > b" }, { sel: ".dk-stat .brk > span.warn > b" },
  { sel: ".dk-gauge .val" }, { sel: ".dk-gauge .why" }, { sel: ".dk-gauge .st" },
  { sel: ".dk-watch h3" }, { sel: ".dk-watch .fig" }, { sel: ".dk-watch .rows span" },
  { sel: ".dk-watch .rows b" }, { sel: ".dk-watch .note" },
];
/* Chart marks are not text, so the bar is 3:1 (WCAG 1.4.11) rather than 4.5:1. */
const MARK_SELECTORS = [
  { sel: ".dk-spark rect.bar", fill: true },
  { sel: ".dk-spark rect.bar.today", fill: true },
  { sel: ".dk-spark rect.zero", fill: true },
];

async function auditAt(page, report, viewport, theme, tag) {
  await page.setViewportSize(viewport);
  await page.evaluate((t) => localStorage.setItem("vy_app_theme", t), theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dk-stat", { timeout: 20000 });
  await page.waitForTimeout(700);

  const actual = await page.evaluate(() => document.body.getAttribute("data-theme"));
  report.ok(theme === "dark" ? actual === "dark" : actual !== "dark",
    `${tag}: the app really is in ${theme} theme`, `data-theme=${actual}`);

  const problems = await geometryAudit(page);
  report.ok(problems.length === 0, `${tag}: nothing overflows, is clipped or is covered`,
    problems.slice(0, 6).join("\n      "));

  for (const c of await contrastAudit(page, TEXT_SELECTORS)) {
    report.ok(c.ratio >= 4.5, `${tag}: ${c.sel} is legible`, `${c.ratio}:1 ("${c.text}")`);
  }
  for (const c of await contrastAudit(page, MARK_SELECTORS)) {
    report.ok(c.ratio >= 3, `${tag}: ${c.sel} is visible against its card`, `${c.ratio}:1`);
  }

  const d = await readDash(page);
  report.ok(d.stats.length >= 4, `${tag}: all four stat blocks are on screen`, `${d.stats.length} found`);
  report.ok(d.stats.every((s) => s.sparkBox && s.sparkBox.w > 40 && s.sparkBox.h > 10),
    `${tag}: every trend strip has real dimensions`,
    JSON.stringify(d.stats.map((s) => s.sparkBox)));
  report.ok(d.gauge && d.gauge.box.w > 100 && d.gauge.box.h > 50,
    `${tag}: the gauge has real dimensions`, JSON.stringify(d.gauge && d.gauge.box));
  report.ok(!/NaN|undefined|\[object|Invalid Date/.test(d.body),
    `${tag}: no NaN, undefined or [object Object] anywhere on the dashboard`,
    (d.body.match(/.{0,40}(NaN|undefined|\[object|Invalid Date).{0,20}/) || [""])[0]);

  const shot = await shoot(page, `${tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
  report.info(`screenshot: ${shot}`);
  return d;
}

/* ── the spec ─────────────────────────────────────────────────────────────── */
export async function run({ browser, report }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  await signIn(page);
  const token = await apiToken(page.request);
  const api = mk(page, token);

  report.info(`screenshots in ${SHOTS}`);

  /* ── 1. the empty state, on a shop that has genuinely sold nothing ─────
     Run against a private copy of the shipped database, because by the time
     this spec runs the shared one has been traded through by other specs. The
     shipped fixture last sold a fortnight ago, so today and the whole
     fourteen-day window are empty. A new shop must see "nothing yet" said in
     words — not a broken chart and not a zero pretending to be a measurement. */
  const quiet = await startQuietBackend();
  try {
    const qpage = await ctx.newPage();
    const qerrs = watchErrors(qpage);
    await qpage.setViewportSize(DESKTOP);
    await signInAt(qpage, quiet.base);
    await go(qpage, "Dashboard");
    await qpage.waitForSelector(".dk-stat", { timeout: 20000 });
    await qpage.waitForTimeout(600);

    const qtok = (await (await qpage.request.post(`${quiet.base}/api/auth/login`,
      { data: { username: "admin", password: "admin123" } })).json()).data.token;
    const qdash = await (await (await qpage.request.get(`${quiet.base}/api/dashboard`,
      { headers: { Authorization: `Bearer ${qtok}` } })).json()).data;

    const emptyView = await readDash(qpage);
    const takings = emptyView.stats.find((s) => /takings today/i.test(s.label));
    report.ok(qdash.todayTotal === 0, "the quiet shop really has no sales today (so this is the empty state)",
      `todayTotal=${qdash.todayTotal}`);
    report.ok(numOf(takings.figure) === 0, "with nothing sold, takings today reads zero rather than a dash or NaN",
      takings.figure);
    report.ok(/nothing sold yesterday|no trade this day last week/i.test(takings.lines.map((l) => l.text).join(" ")),
      "with no yesterday to compare against, it says so instead of printing a percentage of zero",
      JSON.stringify(takings.lines));
    const silent = emptyView.stats.filter((s) => /nothing in the last 14 days/i.test(s.caption || ""));
    report.ok(silent.length === emptyView.stats.length,
      "every trend strip on a shop with no trade says so in words",
      emptyView.stats.map((s) => s.caption).join(" | "));
    report.ok(emptyView.stats.every((s) => s.bars.length === 14),
      "an empty fortnight still draws fourteen day slots, so a shut day is visible as a shut day",
      emptyView.stats.map((s) => s.bars.length).join(","));
    report.ok(emptyView.stats.every((s) => s.bars.every((b) => b.h > 0)),
      "no bar is drawn at zero height (a zero-height rect is an invisible chart, not an empty one)");
    report.ok(emptyView.watch.some((c) => /every supplier bill is settled/i.test(c.note || "")),
      "with no supplier bills open, the payables card says so rather than showing an empty list",
      emptyView.watch.map((c) => c.note).join(" | "));
    report.ok(!/NaN|undefined|\[object|Infinity/.test(emptyView.body),
      "an empty shop shows no NaN, undefined or Infinity",
      (emptyView.body.match(/.{0,40}(NaN|undefined|\[object|Infinity)/) || [""])[0]);
    report.ok((await geometryAudit(qpage)).length === 0,
      "the empty dashboard still lays out cleanly", (await geometryAudit(qpage)).slice(0, 4).join(" | "));
    report.ok(qerrs.length === 0, "the empty dashboard raises no console or page errors", qerrs.slice(0, 3).join("\n      "));
    await shoot(qpage, "empty-state.png");
    await qpage.close();
  } finally {
    await stopQuiet(quiet);
  }

  report.ok(await go(page, "Dashboard"), "the dashboard opens from the rail");
  await page.waitForSelector(".dk-stat", { timeout: 20000 });
  await page.waitForTimeout(600);

  /* ── 2. figures against the ledgers they claim to come from ──────────── */
  const item = await api.post("/items", {
    name: `Dash probe ${Date.now()}`, item_type: "product", unit: "PCS",
    sale_price: 5000, purchase_price: 3000, is_inventory: 1, opening_stock: 50,
  });
  const itemId = item.data?.id;
  report.ok(!!itemId, "a probe item with a known cost can be created", item.message);

  const me = await api.get("/auth/me").catch(() => null);
  const repId = me?.id || me?.user?.id || 1;
  const cashSale = await api.post("/sales", {
    party_id: 1, payment_type: "cash", source: "pos", sales_rep_id: repId,
    lines: [{ item_id: itemId, description: "Dash probe", quantity: 4, rate: 5000, unit: "PCS" }],
  });
  const customer = await api.post("/parties", {
    name: `Dash debtor ${Date.now()}`, party_type: "customer", phone: "0772000914",
  });
  const creditSale = await api.post("/sales", {
    party_id: customer.data?.id, payment_type: "credit", source: "pos", sales_rep_id: repId,
    lines: [{ item_id: itemId, description: "Dash probe", quantity: 2, rate: 5000, unit: "PCS" }],
  });
  report.ok(cashSale.ok && creditSale.ok, "two sales ring up today — one settled, one on credit",
    `${cashSale.message || ""} ${creditSale.message || ""}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dk-stat", { timeout: 20000 });
  await page.waitForTimeout(800);
  const v = await readDash(page);
  const dash = await api.get("/dashboard");

  /* takings today ← the sales list, summed independently of the dashboard */
  const salesList = await api.get("/sales");
  const salesRows = Array.isArray(salesList) ? salesList : (salesList.rows || salesList.data || []);
  const todaysBills = salesRows.filter((r) => String(r.invoice_date).slice(0, 10) === TODAY
    && String(r.status || "") !== "voided");
  const ledgerToday = +sum(todaysBills.map((r) => r.grand_total)).toFixed(2);
  const shownToday = numOf(v.stats.find((s) => /takings today/i.test(s.label)).figure);
  report.ok(near(shownToday, ledgerToday),
    "takings today equals today's invoices in the sales list",
    `screen ${shownToday} vs sales list ${ledgerToday} over ${todaysBills.length} bills`);
  report.ok(near(shownToday, dash.todayTotal), "takings today matches the endpoint that drew it",
    `${shownToday} vs ${dash.todayTotal}`);

  /* the number of bills, and the average, on the counter card */
  const counter = v.watch.find((c) => /today at the counter/i.test(c.title));
  report.ok(numOf(counter.figure) === todaysBills.length,
    "the counter card's bill count equals today's bills in the sales list",
    `${counter.figure} vs ${todaysBills.length}`);
  const avgRow = counter.rows.find((r) => /average bill/i.test(r.label));
  report.ok(near(numOf(avgRow.value), ledgerToday / todaysBills.length, 1),
    "the average bill is the takings divided by the bills, not a separately rounded figure",
    `${avgRow.value} vs ${(ledgerToday / todaysBills.length).toFixed(2)}`);

  /* earned today ← /reports/bill-profit for today */
  /* bill-profit does not filter voided invoices, and other specs in this suite
     void sales on the shared database — so the comparison is made row by row
     against today's *live* bills. Summing the report's own totals passed when
     this spec ran alone and failed in the full run, which is the sort of check
     that flatters itself. */
  const bp = await api.get(`/reports/bill-profit?from=${TODAY}&to=${TODAY}`);
  const liveNos = new Set(todaysBills.map((r) => String(r.invoice_no)));
  const bpRows = (bp.rows || []).filter((r) => liveNos.has(String(r.invoice_no)));
  const ledgerProfit = +sum(bpRows.map((r) => r.profit)).toFixed(2);
  const earned = v.stats.find((s) => /earned today/i.test(s.label));
  report.ok(near(numOf(earned.figure), ledgerProfit, 1),
    "earned today equals the bill-wise profit report for today",
    `screen ${earned.figure} vs /reports/bill-profit ${ledgerProfit}`);
  report.ok(near(numOf(earned.lines[0].value) - numOf(earned.lines[1].value), numOf(earned.figure), 1),
    "the two breakdown lines under 'earned today' subtract to the figure above them",
    `${earned.lines[0].value} − ${earned.lines[1].value} vs ${earned.figure}`);
  /* Margin is measured against the goods value, not the tax-inclusive grand
     total — the same basis /reports/bill-profit uses, so the two screens cannot
     print two different margins for the same day. */
  const ledgerNet = +sum(bpRows.map((r) => r.sale_value)).toFixed(2);
  report.ok(near(numOf(earned.lines[0].value), ledgerNet, 1),
    "the 'sold' line under earned today is the goods value the profit report uses",
    `${earned.lines[0].value} vs ${ledgerNet}`);
  const pctShown = /(\d+(?:\.\d+)?)% margin/.exec(earned.label);
  report.ok(pctShown && near(+pctShown[1], (ledgerProfit / ledgerNet) * 100, 0.2),
    "the margin percentage is the profit over that goods value",
    `${earned.label} vs ${((ledgerProfit / ledgerNet) * 100).toFixed(1)}%`);

  /* owed to me ← /reports/ar-aging-details */
  const ar = await api.get("/reports/ar-aging-details");
  const arRows = ar.rows || ar.details || [];
  const ledgerAr = +sum(arRows.map((r) => r.balance_due ?? r.amount ?? 0)).toFixed(2);
  const owed = v.stats.find((s) => /owed to me/i.test(s.label));
  report.ok(near(numOf(owed.figure), ledgerAr, 1.5),
    "money owed to me equals the receivables ageing report",
    `screen ${owed.figure} vs /reports/ar-aging-details ${ledgerAr}`);
  report.ok(near(numOf(owed.lines[0].value) + numOf(owed.lines[1].value), numOf(owed.figure), 1),
    "the within-30-days and overdue lines add up to the total owed",
    `${owed.lines[0].value} + ${owed.lines[1].value} vs ${owed.figure}`);
  report.ok(/30 days/.test(owed.lines[1].text) && /overdue/i.test(owed.lines[1].text),
    "the overdue line names the age band in words, so the red is not the only signal",
    owed.lines[1].text);

  /* money I hold ← the cash & bank accounts in the books */
  const cashRows = await api.get("/accounting/cash-bank").catch(() => null);
  const held = v.stats.find((s) => /money i hold/i.test(s.label));
  const accounts = dash.cashAccounts || [];
  report.ok(near(numOf(held.figure), +sum(accounts.map((a) => a.balance)).toFixed(2), 1),
    "money I hold is the sum of the cash and bank accounts listed beneath it",
    `${held.figure} vs ${sum(accounts.map((a) => a.balance))}`);
  if (cashRows) {
    const list = Array.isArray(cashRows) ? cashRows : (cashRows.rows || cashRows.accounts || []);
    if (list.length) {
      const ledgerCash = +sum(list.map((a) => a.balance ?? a.closing ?? 0)).toFixed(2);
      report.ok(near(numOf(held.figure), ledgerCash, 1),
        "money I hold equals the cash & bank ledger balances",
        `${held.figure} vs ${ledgerCash}`);
    }
  }
  report.ok(held.lines.every((l) => accounts.some((a) => a.name === l.text)) || accounts.length === 0,
    "each breakdown line under it names a real account", JSON.stringify(held.lines.map((l) => l.text)));

  /* owed to suppliers ← /reports/ap-aging-details */
  const ap = await api.get("/reports/ap-aging-details");
  const apRows = ap.rows || ap.details || [];
  const ledgerAp = +sum(apRows.map((r) => r.balance_due ?? r.amount ?? 0)).toFixed(2);
  const owe = v.watch.find((c) => /owe suppliers/i.test(c.title));
  report.ok(owe && near(numOf(owe.figure), ledgerAp, 1.5),
    "what I owe suppliers equals the payables ageing report",
    `screen ${owe && owe.figure} vs /reports/ap-aging-details ${ledgerAp}`);

  /* the collection gauge ← invoiced vs paid on this month's sales */
  const month = TODAY.slice(0, 7);
  const monthBills = salesRows.filter((r) => String(r.invoice_date).slice(0, 7) === month
    && String(r.status || "") !== "voided");
  const invoiced = sum(monthBills.map((r) => r.grand_total));
  const paid = sum(monthBills.map((r) => r.paid_amount));
  const expectPct = Math.round((paid / invoiced) * 100);
  report.ok(numOf(v.gauge.value) === expectPct,
    "the collection gauge is this month's paid over this month's invoiced",
    `screen ${v.gauge.value} vs ${paid}/${invoiced} = ${expectPct}%`);
  report.ok(/healthy|watch it|too much on credit|nothing invoiced/i.test(v.gauge.band),
    "the gauge band is named in words beside the colour", v.gauge.band);
  report.ok(near(numOf((v.gauge.why.match(/invoiced ([^ ]+ [\d,.]+)/) || [])[1]), +invoiced.toFixed(2), 1.5),
    "the sentence under the gauge quotes the same invoiced figure the gauge is drawn from",
    `"${v.gauge.why}" vs ${invoiced}`);
  const dash1 = v.gauge.arcs.filter(Boolean);
  report.ok(dash1.length === 1 && +dash1[0].split(" ")[0] > 0,
    "the gauge arc is actually drawn (a value arc with non-zero length)", JSON.stringify(v.gauge.arcs));

  /* the trend strips ← the same daily series, checked bar by bar */
  const takings2 = v.stats.find((s) => /takings today/i.test(s.label));
  report.ok(takings2.bars.length === 14, "the trend strip is fourteen days wide", `${takings2.bars.length}`);
  const todayBar = takings2.bars[13];
  report.ok(/today/.test(todayBar.cls || ""), "today's bar is marked out from the other thirteen", todayBar.cls);
  /* The tooltip reads "Wed 19 Aug: Sh 16,400.00" — take the figure after the
     colon, or the date's own digits are parsed as the money. */
  report.ok(near(numOf(String(todayBar.title).split(":").pop()), ledgerToday, 1),
    "the tooltip on today's bar quotes the day's real takings", `${todayBar.title} vs ${ledgerToday}`);
  report.ok(takings2.bars.filter((b) => b.cls === "zero").length === 13,
    "the thirteen days with no trade are drawn as empty slots, not omitted",
    takings2.bars.map((b) => b.cls).join(","));
  report.ok(/trend since/i.test(takings2.caption || ""), "the strip says what period it covers", takings2.caption);

  /* ── 2b. speed ────────────────────────────────────────────────────────────
     The whole screen is one request against a database held in WASM memory on
     a shop laptop. A dashboard that takes a second to appear is a dashboard
     nobody opens, so the budget is asserted rather than hoped for. */
  const timings = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dk-spark rect", { timeout: 20000 });
    const paint = Date.now() - t0;
    const req = await page.evaluate(() => {
      const e = performance.getEntriesByType("resource").filter((r) => /\/api\/dashboard$/.test(r.name)).pop();
      return e ? +e.duration.toFixed(1) : null;
    });
    timings.push({ paint, req });
  }
  const worstReq = Math.max(...timings.map((t) => t.req || 0));
  const worstPaint = Math.max(...timings.map((t) => t.paint));
  report.info(`dashboard timings over 3 loads: ${timings.map((t) => `${t.req}ms api / ${t.paint}ms to first bar`).join(", ")}`);
  report.ok(worstReq < 400, "one dashboard request answers well inside a shopkeeper's patience", `worst ${worstReq}ms`);
  report.ok(worstPaint < 4000, "the widgets are on screen quickly after a cold reload", `worst ${worstPaint}ms`);
  const calls = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((r) => /\/api\/dashboard$/.test(r.name)).length);
  report.ok(calls === 1, "the whole screen is still one dashboard request per load, not a dozen", `${calls} calls`);

  /* ── 3. module flags ───────────────────────────────────────────────────── */
  report.ok(dash.mods.loyalty === false && dash.mods.manufacturing === false,
    "the fixture shop has loyalty and manufacturing switched off",
    JSON.stringify(dash.mods));
  report.ok(!v.watch.some((c) => /loyalty|made today/i.test(c.title)),
    "a shop with loyalty and manufacturing off is shown no widget for either",
    v.watch.map((c) => c.title).join(" | "));
  report.ok(dash.loyalty === null && dash.production === null,
    "and the endpoint does not even compute those figures",
    `loyalty=${JSON.stringify(dash.loyalty)} production=${JSON.stringify(dash.production)}`);

  report.ok(await api.put("/settings", { mod_loyalty: "1", mod_manufacturing: "1" }),
    "loyalty and manufacturing can be switched on");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dk-watch", { timeout: 20000 });
  await page.waitForTimeout(700);
  const withMods = await readDash(page);
  report.ok(withMods.watch.some((c) => /loyalty/i.test(c.title)),
    "switching loyalty on brings its widget with it", withMods.watch.map((c) => c.title).join(" | "));
  report.ok(withMods.watch.some((c) => /made today/i.test(c.title)),
    "switching manufacturing on brings the production widget with it",
    withMods.watch.map((c) => c.title).join(" | "));
  await shoot(page, "modules-on.png");
  await api.put("/settings", { mod_loyalty: "0", mod_manufacturing: "0" });

  /* ── 4. geometry and contrast, four ways ───────────────────────────────── */
  await auditAt(page, report, LAPTOP, "light", "1366x768 light");
  await auditAt(page, report, LAPTOP, "dark", "1366x768 dark");
  await auditAt(page, report, DESKTOP, "dark", "1920x1080 dark");
  const last = await auditAt(page, report, DESKTOP, "light", "1920x1080 light");

  /* The figures must survive the theme switch unchanged — a re-render that
     re-reads a stale cache is how a dashboard starts lying quietly. */
  report.ok(numOf(last.stats.find((s) => /takings today/i.test(s.label)).figure) === shownToday,
    "the takings figure is the same number after four reloads and two theme switches",
    `${last.stats.find((s) => /takings today/i.test(s.label)).figure} vs ${shownToday}`);

  report.ok(errs.length === 0, "the dashboard raises no console or page errors", errs.slice(0, 3).join("\n      "));
  await page.close();
  await ctx.close();
}
