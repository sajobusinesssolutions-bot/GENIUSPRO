/**
 * reportprint.spec — what every report actually puts on paper.
 *
 * `reports.spec.mjs` opens all 58 panes and checks what is on the *screen*.
 * That proves nothing about the printed copy, and the two came apart badly:
 * a shop running the app in dark mode printed every report as an empty ruled
 * grid. Nothing was hidden, nothing threw — the page simply went to the
 * printer carrying the dark theme's text colour (#E7EAF0), which is 1.18:1
 * against white paper. Browsers drop the dark *background* when printing
 * (background graphics are off by default), so the paper stayed white, the
 * figures came out as ghost-grey, and only the table rules — dark in dark mode
 * — printed. Every report, every time, and screen tests could not see it.
 *
 * ── How the printed page is observed ──────────────────────────────────────
 *
 * Printing is not observable in Playwright: window.print() hands over to the
 * browser. Two independent captures are used instead, and a report has to pass
 * both.
 *
 *  1. `page.pdf()` — Chromium's own print pipeline, the same code path that
 *     feeds the printer, with `printBackground` left at its default of false,
 *     which is what the print dialog does unless somebody ticks "Background
 *     graphics". The bytes it produces ARE the print document. Where poppler's
 *     `pdftotext` is installed the text is pulled back out of it and matched
 *     against the figures on screen; where it is not, the check degrades to
 *     the document's size and the run says so rather than passing quietly.
 *
 *  2. `emulateMedia({ media: "print" })` — applies the print stylesheet to the
 *     live DOM, so `getComputedStyle` and `getBoundingClientRect` report what
 *     the printer will get. This is the capture that can see *contrast*: for
 *     every element holding text it computes the WCAG ratio of its colour
 *     against white paper. A PDF full of 1.18:1 text is a valid PDF with
 *     plenty of characters in it — only this check calls it blank.
 *
 * Neither is a photograph of paper, and the suite says as much. Together they
 * catch the three ways a report goes blank: it is hidden, it is empty, or it
 * is the colour of the page.
 *
 * ── Why the list is generated ─────────────────────────────────────────────
 *
 * The report catalogue is parsed out of `pages/Reports.jsx` at run time rather
 * than copied here, so report number 59 is covered the day it is added and a
 * hand-maintained list cannot quietly fall behind the app. The parse itself is
 * asserted (a count, and every group accounted for) so a refactor that defeats
 * it fails loudly instead of testing nothing.
 *
 * ── Why nothing is seeded ─────────────────────────────────────────────────
 *
 * The specs share one database in file order, so seeding here would rewrite
 * the ground under the specs that follow. The property under test holds either
 * way: whatever a report shows on screen — rows or an empty state — has to
 * reach the paper legibly.
 *
 * Run with `E2E_PRINT_SEED=1` to ring up seventeen extra sales first, which
 * pushes half a dozen reports past one page and exercises the multi-page print
 * path. Use it when this spec is run on its own; never in a full-suite run.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signIn } from "../harness.mjs";

export const name = "report printing — every report reaches the paper";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ── The width paper actually gives the page ───────────────────────────────
 *
 * This spec used to print with `page.pdf({ format: "A4" })` and measure the
 * print DOM at the 1440px test viewport. Both are the wrong width, and that is
 * how it passed a run whose every table had collapsed.
 *
 * Playwright's page.pdf defaults to *no* margins, so the page was laid out at
 * the full 794px of an A4 sheet. Chrome's print dialog defaults to 0.4in
 * margins, leaving 717px. styles.css has a `@media (max-width: 780px)` block
 * that turns every `.tw` table into stacked cards for a counter tablet —
 * `tr { display:block }`, `td { display:flex; text-align:right }`. 794px misses
 * it by fourteen pixels; 717px is squarely inside it, so what the shop's
 * printer got was a column of bordered boxes and what the test measured was a
 * table. Everything printed here is now printed at the dialog's own margins,
 * and the print DOM is measured at the width those margins leave.
 */
const PRINT_MARGIN = { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" };
const A4_PX = 794;                       // 8.27in at 96dpi
const PRINT_W = Math.round(A4_PX - 2 * 0.4 * 96);   // 717 — the printable column

/* ── Does the printed table still have columns? ────────────────────────────
 *
 * Text extraction and contrast — the two checks this spec was built on — both
 * pass happily on a table that has lost its layout. Every character is still
 * on the page and still black; they are just stacked one per line, pushed to
 * the right, with no relationship to the heading above them. A report is a
 * grid, and nothing here was measuring the grid.
 *
 * So: measured under print media at the printable width, in the same DOM the
 * printer sees. A cell must still be a `table-cell` inside a `table-row`; the
 * cells of one row must sit on one line rather than stack; a column must hold
 * one x-origin down the rows; and the body columns must line up under their
 * own headings. Any one of those failing is the photograph the shop sent.
 */
const GEOMETRY = `(() => {
  const faults = [];
  const disp = (el) => getComputedStyle(el).display;
  const box = (el) => el.getBoundingClientRect();
  const tables = [...document.querySelectorAll(".dk-rp-body table")].filter((t) => t.getClientRects().length);
  if (!tables.length) return { noTable: true };
  let checked = 0, tallest = 0;

  for (const t of tables) {
    const all = [...t.querySelectorAll("tbody tr")].filter((r) => r.getClientRects().length);
    if (!all.length) continue;
    if (disp(t) !== "table") { faults.push(\`a table is display:\${disp(t)}\`); continue; }

    /* Section headings and [SUMMARY] lines use colspan, so a table legitimately
       holds rows of different widths. The columns are whatever shape most of
       the rows are; the odd ones out are not evidence of anything. */
    const cellsOf = (r) => [...r.children].filter((c) => c.getClientRects().length);
    const hs = [...t.querySelectorAll("thead tr:last-child th")].filter((h) => h.getClientRects().length);
    const tally = {};
    for (const r of all) { const k = cellsOf(r).length; tally[k] = (tally[k] || 0) + 1; }
    /* The full-width shape is what the headings describe where there are
       headings; otherwise the commonest row, widest wins a tie. */
    const modal = hs.length && tally[hs.length]
      ? hs.length
      : Number(Object.entries(tally).sort((a, b) => (b[1] - a[1]) || (Number(b[0]) - Number(a[0])))[0][0]);
    const rows = all.filter((r) => cellsOf(r).length === modal).slice(0, 8);
    if (!rows.length || modal < 2) continue;
    checked++;

    if (disp(rows[0]) !== "table-row") faults.push(\`a row is display:\${disp(rows[0])}, not table-row\`);
    const bad = cellsOf(rows[0]).find((c) => disp(c) !== "table-cell");
    if (bad) faults.push(\`a cell is display:\${disp(bad)}, not table-cell — cells stack when this happens\`);

    /* One row, one line: a stacked row puts its cells at four different tops. */
    for (const r of rows) {
      const tops = cellsOf(r).map((c) => Math.round(box(c).top));
      const spread = Math.max(...tops) - Math.min(...tops);
      if (spread > 2) { faults.push(\`a row's cells are spread over \${spread}px of height instead of sharing one line\`); break; }
    }

    /* One column, one x-origin, all the way down. */
    const xs = rows.map((r) => cellsOf(r).map((c) => Math.round(box(c).left)));
    if (modal > 1 && new Set(xs[0]).size === 1) faults.push(\`all \${modal} cells of a row start at x=\${xs[0][0]} — the columns have collapsed into one\`);
    for (let c = 0; c < modal; c++) {
      const col = xs.map((a) => a[c]);
      const spread = Math.max(...col) - Math.min(...col);
      if (spread > 1) { faults.push(\`column \${c + 1} starts at a different x on different rows (varies by \${spread}px)\`); break; }
    }

    /* Values under their own heading, where the table has headings at all —
       some report tables are headerless two-column summaries. */
    if (hs.length === modal) {
      for (let c = 0; c < modal; c++) {
        const d = Math.abs(Math.round(box(hs[c]).left) - xs[0][c]);
        if (d > 1) { faults.push(\`column \${c + 1} ("\${hs[c].innerText.trim().slice(0, 18)}") heading and values are \${d}px apart\`); break; }
      }
    } else if (hs.length) {
      faults.push(\`\${hs.length} column headings over rows of \${modal} cells\`);
    }

    /* A long item name may wrap — that is what a description column is for.
       A figure may not: "Sh 42,000.0" with the last zero on the next line, or
       running off the edge of its column, is a number nobody can read down a
       page. And no data row should be box-tall, columns or no columns. */
    for (const r of rows) {
      tallest = Math.max(tallest, Math.round(box(r).height));
      for (const c of cellsOf(r)) {
        if (!/\\b(num|amt)\\b/.test(c.className)) continue;
        const cs = getComputedStyle(c);
        const line = parseFloat(cs.lineHeight) || 14;
        /* The cell stretches to the tallest cell in its row, so the cell's own
           box says nothing. Measure the text: a Range over its contents. */
        const rng = document.createRange(); rng.selectNodeContents(c);
        const inner = rng.getBoundingClientRect().height;
        if (inner > line * 1.7) { faults.push(\`the figure "\${c.innerText.trim().slice(0, 20)}" is wrapped across \${Math.round(inner / line)} lines\`); break; }
        if (c.scrollWidth > c.clientWidth + 1) { faults.push(\`the figure "\${c.innerText.trim().slice(0, 20)}" is \${c.scrollWidth - c.clientWidth}px wider than its column\`); break; }
      }
    }
  }
  if (tallest > 110) faults.push(\`a data row is \${tallest}px tall — the row has grown into a box\`);
  if (!checked) return { noRows: true };
  return { faults, tables: checked, rowHeight: tallest, width: window.innerWidth };
})()`;

/** Parse the report catalogue out of the page that owns it. */
function enumerateReports() {
  const src = fs.readFileSync(path.join(ROOT, "frontend/src/pages/Reports.jsx"), "utf8");
  const at = src.indexOf("const REPORTS = [");
  if (at < 0) return [];
  const block = src.slice(at, src.indexOf("];", at));
  return [...block.matchAll(/\{\s*id:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*sub:\s*"([^"]*)",\s*group:\s*"([^"]+)"/g)]
    .map((m) => ({ id: m[1], title: m[2], group: m[4] }));
}

/* Contrast of every text-bearing element against white paper, measured with
   the print stylesheet applied. 3:1 is the WCAG floor for large text; a
   printer with low toner is harsher still, so anything under it is a report
   somebody will hold up to the light. */
const MEASURE = `(() => {
  const lum = (c) => {
    const m = (c.match(/[\\d.]+/g) || [0, 0, 0]).map(Number);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
  };
  const card = document.querySelector(".dk-rp .dk-tablecard");
  if (!card) return { missing: true };
  const body = card.querySelector(".dk-rp-body");
  let faint = 0, texts = 0, worst = 99, worstText = "";
  for (const el of card.querySelectorAll("*")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
    texts++;
    const ratio = 1.05 / (lum(cs.color) + 0.05);
    if (ratio < 3) { faint++; if (ratio < worst) { worst = ratio; worstText = el.innerText.slice(0, 40); } }
  }
  const r = body ? body.getBoundingClientRect() : { height: 0 };
  return {
    faint, texts, worst: texts ? +worst.toFixed(2) : null, worstText,
    bodyHeight: Math.round(r.height),
    printText: (card.innerText || "").replace(/\\s+/g, ""),
  };
})()`;

/* What the report shows on screen, as figures a printed copy must carry.
   Only tokens with a decimal or a thousands separator: bare digit runs are
   invoice numbers, which the PDF wraps mid-cell and which say nothing about
   whether the money made it onto the page. */
const SCREEN = `(() => {
  const body = document.querySelector(".dk-rp-body");
  const txt = body ? body.innerText : "";
  const figs = [...new Set(txt.match(/\\d[\\d,]*\\.\\d{2}|\\d{1,3}(?:,\\d{3})+/g) || [])];
  return {
    figs: figs.slice(0, 25),
    rows: document.querySelectorAll(".dk-rp-body tbody tr").length,
    empty: !!document.querySelector(".dk-rp-body .state-block, .dk-rp-body .dk-empty"),
    stuck: /Running the report/i.test(txt),
  };
})()`;

/* The Z and X reports head their figures with an animated counter (ui.jsx
   CountUp), so for the first few hundred milliseconds the pane is showing a
   number that is on its way to the real one. Reading the screen and the print
   document at two different points in that climb compares two different
   figures. Wait for the pane to stop changing before capturing either. */
async function settle(page, tries = 12) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const now = await page.evaluate(() => (document.querySelector(".dk-tablecard") || document.body).innerText);
    if (now === prev) return;
    prev = now;
    await page.waitForTimeout(120);
  }
}

/* Two readings of the same print document, because neither alone is a fair
   witness. `-layout` rebuilds the page geometrically, which reads like the
   paper but interleaves columns, so a figure that wraps inside a narrow cell
   comes back with another column's text spliced through the middle of it.
   `-raw` follows the PDF's own content stream, where a wrapped cell's pieces
   stay next to each other. A figure counts as printed if either reading finds
   it; a figure genuinely absent from the paper is in neither. */
let pdftotextOk = null;
function pdfText(file) {
  if (pdftotextOk === false) return null;
  try {
    const read = (mode) => execFileSync("pdftotext", [mode, file, "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const flat = read("-layout").replace(/\s+/g, "");
    const rawFlat = read("-raw").replace(/\s+/g, "");
    pdftotextOk = true;
    return { flat, rawFlat };
  } catch { pdftotextOk = false; return null; }
}

export async function run({ browser, report }) {
  const REPORTS = enumerateReports();
  const groups = [...new Set(REPORTS.map((r) => r.group))];
  report.ok(REPORTS.length >= 58, `catalogue parsed from Reports.jsx — ${REPORTS.length} reports`,
    REPORTS.length >= 58 ? null : "the REPORTS array could not be read; this spec would have tested nothing");
  if (!REPORTS.length) return;
  report.ok(groups.length === 7, `covering ${groups.length} groups: ${groups.join(", ")}`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "genius-print-"));
  /* A print bug is a thing you have to look at. Any report that fails leaves
     its print document behind here, so the next person opens the actual page
     rather than re-deriving it from a one-line message. */
  const kept = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "genius-print-failed-"));
  const keep = (id) => { try { fs.copyFileSync(path.join(tmp, `${id}.pdf`), path.join(kept, `${id}.pdf`)); } catch {} };

  try {
    await signIn(page);
    /* Dark mode is the harsher of the two themes and the one the failure was
       reported from. The fix pins paper colours regardless of theme, so a
       light-theme sample at the end confirms it did not overcorrect. */
    await page.evaluate(() => localStorage.setItem("vy_app_theme", "dark"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    const theme = await page.evaluate(() => document.body.getAttribute("data-theme"));
    report.ok(theme === "dark", `app is in dark mode for the walk (data-theme=${theme})`);

    if (process.env.E2E_PRINT_SEED) {
      const api = async (m, pth, body) => page.evaluate(async ([m, pth, body]) => {
        const t = localStorage.getItem("vy_token") || "";
        const r = await fetch("/api" + pth, { method: m, headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: body ? JSON.stringify(body) : undefined });
        const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch {}
        return { s: r.status, d: j && (j.data !== undefined ? j.data : j) };
      }, [m, pth, body]);
      const items = (await api("GET", "/items")).d, parties = (await api("GET", "/parties")).d;
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < 17; i++) await api("POST", "/sales", { party_id: parties[0].id, invoice_date: today, payment_type: "cash", sales_rep_id: 1, lines: [{ item_id: items[0].id, description: items[0].name, quantity: 1, rate: 41000 + i * 100 }] });
      await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000);
    }
    await page.locator(".dk-rail .dk-nav").filter({ hasText: /Reports$/i }).first().click();
    await page.waitForTimeout(1500);

    const wrongPane = [], blank = [], faint = [], lostFigures = [], emptyPdf = [], stuck = [], reprinted = [], broken = [];
    let walked = 0, withRows = 0, pdfChecked = 0, tablesChecked = 0, lastGroup = null;

    for (const rep of REPORTS) {
      if (rep.group !== lastGroup) {
        const tab = page.locator(".dk-tabs button").filter({ hasText: new RegExp(`^${rep.group}\\s*\\d*$`) }).first();
        if (!(await tab.count())) { wrongPane.push(`${rep.id} — no "${rep.group}" tab`); continue; }
        await tab.click();
        await page.waitForTimeout(600);
        lastGroup = rep.group;
      }
      const idx = REPORTS.filter((r) => r.group === rep.group).findIndex((r) => r.id === rep.id);
      await page.locator(".dk-rp-item").nth(idx).click();
      await page.waitForFunction(() => !/Running the report/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      await settle(page);
      walked++;

      const title = (await page.locator(".dk-rp-head h3").first().innerText().catch(() => "")).trim();
      if (title !== rep.title) { wrongPane.push(`${rep.id} — opened "${title}"`); continue; }

      const screen = await page.evaluate(SCREEN);
      if (screen.stuck) { stuck.push(rep.id); continue; }
      if (screen.rows) withRows++;

      /* The print document itself. printBackground is left off deliberately:
         that is what the print dialog does.
         Taken up to three times: Chromium's printToPDF occasionally returns a
         document that stops at the first page of a long table while the header
         group keeps repeating — a race in the print pipeline, not something the
         page does, since the very same page printed whole a moment earlier and
         a moment later. Retrying separates the race from a report that really
         does leave rows off the paper: a real loss is there every time. */
      const file = path.join(tmp, `${rep.id}.pdf`);
      let bytes = 0, txt = null, gone = [], attempts = 0;
      for (attempts = 1; attempts <= 3; attempts++) {
        await page.pdf({ path: file, format: "A4", margin: PRINT_MARGIN });
        bytes = fs.statSync(file).size;
        txt = pdfText(file);
        if (txt === null) break;
        gone = screen.figs.filter((f) => !txt.flat.includes(f) && !txt.rawFlat.includes(f));
        if (!gone.length) break;
        await page.waitForTimeout(250);
      }
      if (txt === null) {
        if (bytes < 2000) emptyPdf.push(`${rep.id} — print document is only ${bytes} bytes`);
      } else {
        pdfChecked++;
        if (attempts > 1 && !gone.length) reprinted.push(`${rep.id}×${attempts}`);
        if (txt.flat.length < 40) { emptyPdf.push(`${rep.id} — print document carries ${txt.flat.length} characters`); keep(rep.id); }
        if (gone.length) { lostFigures.push(`${rep.id} — printed page lost ${gone.join(", ")} on all three attempts`); keep(rep.id); }
      }

      /* Print media at the width the paper leaves — see PRINT_W. Measured at
         the test viewport instead, none of this sees what the printer does. */
      await page.setViewportSize({ width: PRINT_W, height: 900 });
      await page.emulateMedia({ media: "print" });
      const pm = await page.evaluate(MEASURE);
      const geo = await page.evaluate(GEOMETRY);
      await page.emulateMedia({ media: null });
      await page.setViewportSize({ width: 1440, height: 900 });

      if (geo.faults && geo.faults.length) { broken.push(`${rep.id} — ${geo.faults.join("; ")}`); keep(rep.id); }
      else if (!geo.noTable && !geo.noRows) tablesChecked++;

      if (pm.missing || pm.bodyHeight < 10 || !pm.texts) {
        blank.push(`${rep.id} — print DOM has ${pm.texts || 0} text elements, body ${pm.bodyHeight || 0}px tall`);
        continue;
      }
      if (pm.faint) faint.push(`${rep.id} — ${pm.faint}/${pm.texts} at ${pm.worst}:1 ("${pm.worstText}")`);

      /* Every figure on screen has to survive into the print DOM. Whitespace
         is stripped from both because printing re-wraps cells. */
      const goneFromDom = screen.figs.filter((f) => !pm.printText.includes(f.replace(/\s+/g, "")));
      if (goneFromDom.length) lostFigures.push(`${rep.id} — print DOM lost ${goneFromDom.join(", ")}`);

    }

    report.info(`${walked} reports walked, ${withRows} of them with rows in this database`);
    if (reprinted.length) report.info(`printToPDF had to be repeated for ${reprinted.join(", ")}`);
    report.info(pdftotextOk
      ? `${pdfChecked} print documents re-read with pdftotext`
      : "pdftotext is not installed — print documents checked by size only, not by their text");

    report.ok(walked === REPORTS.length, `every one of the ${REPORTS.length} reports was opened`,
      walked === REPORTS.length ? null : `only ${walked} opened`);
    report.ok(!wrongPane.length, "each tile opened the report it names", wrongPane.join("\n      "));
    report.ok(!stuck.length, "no report was still loading when it was printed", stuck.join(", "));
    report.ok(!blank.length, "no report prints an empty page", blank.join("\n      "));
    report.ok(!faint.length, "no report prints text too faint to read on white paper", faint.slice(0, 8).join("\n      ")
      + (faint.length > 8 ? `\n      …and ${faint.length - 8} more` : ""));
    report.ok(!lostFigures.length, "every figure on screen appears in the print output", lostFigures.slice(0, 8).join("\n      "));
    report.ok(!emptyPdf.length, "every print document has content in it", emptyPdf.join("\n      "));
    report.info(`${tablesChecked} report tables measured for column layout under print media at ${PRINT_W}px`);
    report.ok(!broken.length, "every printed table keeps its columns, with values under their own headings",
      broken.slice(0, 8).join("\n      ") + (broken.length > 8 ? `\n      …and ${broken.length - 8} more` : ""));

    /* Light theme, a sample: the paper rules must not have broken the theme
       that always worked. */
    await page.evaluate(() => localStorage.setItem("vy_app_theme", "light"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await page.locator(".dk-rail .dk-nav").filter({ hasText: /Reports$/i }).first().click();
    await page.waitForTimeout(1400);
    const lightFaint = [], lightBroken = [];
    for (const [group, tile] of [["Sales", 0], ["Money", 0], ["Tax & books", 2]]) {
      await page.locator(".dk-tabs button").filter({ hasText: new RegExp(`^${group}\\s*\\d*$`) }).first().click();
      await page.waitForTimeout(600);
      await page.locator(".dk-rp-item").nth(tile).click();
      await page.waitForFunction(() => !/Running the report/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
      await settle(page);
      await page.setViewportSize({ width: PRINT_W, height: 900 });
      await page.emulateMedia({ media: "print" });
      const pm = await page.evaluate(MEASURE);
      const geo = await page.evaluate(GEOMETRY);
      await page.emulateMedia({ media: null });
      await page.setViewportSize({ width: 1440, height: 900 });
      if (pm.faint) lightFaint.push(`${group} — ${pm.faint}/${pm.texts} at ${pm.worst}:1`);
      if (geo.faults && geo.faults.length) lightBroken.push(`${group} — ${geo.faults.join("; ")}`);
    }
    report.ok(!lightFaint.length, "light theme still prints legibly too", lightFaint.join("\n      "));
    report.ok(!lightBroken.length, "light theme keeps its printed table columns too", lightBroken.join("\n      "));
  } finally {
    const failures = fs.readdirSync(kept);
    if (failures.length) report.info(`print documents that failed are kept in ${kept}`);
    else fs.rmSync(kept, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    await ctx.close().catch(() => {});
  }
}
