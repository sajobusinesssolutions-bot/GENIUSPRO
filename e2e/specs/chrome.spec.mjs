/**
 * chrome.spec — the window furniture: sticky headers, the collapsed rail, and
 * the one popover that opens inside a card that clips.
 *
 * Four defects reported from a 1920×1080 laptop, all of them geometry, none of
 * them visible to a test that only asks whether an element exists:
 *
 *   1. The Settings head card — the one carrying Discard/Save — was dragged out
 *      of the content viewport and in behind the app header once you scrolled,
 *      because `.dk-set` was capped at viewport height and a sticky element
 *      cannot outlive its containing block.
 *   2. Pinning that card to fix (1) traded one fault for a worse one: the
 *      header then sat on top of whatever was scrolling under it, and the
 *      shopkeeper photographed the "Services & Products" dropdown with its top
 *      half sliced off by the band. Every assertion here passed, because they
 *      all asked where the header was and none asked what was underneath it.
 *      `coveredControls` below is the assertion that was missing: it hit-tests
 *      each control's own edges and fails if the answer is a pinned element.
 *      A sticky bar is not merely an overlap, it is an *unrecoverable* one —
 *      it travels with the scroll, so no scroll position frees the control.
 *   3. The date-range popover on Reports was clipped on the left and the bottom
 *      by `.dk-card.dk-tablecard`'s overflow, and had nowhere to flip to.
 *   4. The collapsed rail hid its icons rather than its labels, so it showed
 *      "Dashbc", "Partie", "Purcha" and no glyphs at all.
 *
 * Everything here asserts on measured boxes and computed styles. Prose about a
 * header "looking right" is what let all four ship.
 */
import { signIn, go, watchErrors } from "../harness.mjs";

/* The reported window: 1920×1080 at 125% scaling, less the browser's chrome.
   Settings has to overflow for the sticky to be exercised at all. */
const VP = { width: 1536, height: 730 };

const box = (loc) => loc.evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1),
           w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
});

/* ── Is any control sitting underneath something pinned? ──────────────────
   Run in the page. For every focusable control, hit-test its own top and
   bottom edges with elementFromPoint; if the element that answers belongs to a
   `position: sticky` or `fixed` subtree rather than to the control, the
   control is partly covered by something the user cannot scroll away.

   Two exclusions, both deliberate:

   · A point outside the control's own scroll container is skipped. Content
     clipped by the edge of a scrollport is not covered — one flick of the
     wheel brings it back, which is the ordinary way a page works. Only a
     *pinned* thing on top is unrecoverable, and that is what this looks for.

   · While a modal dialog is open, only controls inside the dialog count. The
     page behind is meant to be unreachable.

   This is the assertion whose absence let the reported fault ship: the header
   really was on screen, inside the content viewport, correctly stacked — and
   sitting on the switch row being read. */
const coveredControls = () => {
  const FOCUSABLE = "input,select,textarea,button,[role=switch]";
  const pinnedAncestor = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === "sticky" || p === "fixed") return e;
    }
    return null;
  };
  const scrollport = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e;
      if (/auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1) return e;
    }
    return null;
  };
  const desc = (e) => e.tagName.toLowerCase() +
    ((e.className || "").toString().trim() ? "." + e.className.toString().trim().split(/\s+/).join(".") : "");
  const nameOf = (e) =>
    (e.getAttribute?.("aria-label") || e.title || (e.textContent || "").trim() || e.tagName).slice(0, 40);

  const dialog = document.querySelector("[role=dialog][aria-modal=true]");
  const out = [];
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    if (dialog && !dialog.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    if (pinnedAncestor(el)) continue;                 /* the pinned bar's own buttons */
    const sp = scrollport(el);
    const clip = sp ? sp.getBoundingClientRect()
                    : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let done = false;
    for (const y of [r.top + 1, r.bottom - 1]) {
      for (const x of [r.left + 3, (r.left + r.right) / 2, r.right - 3]) {
        if (x < clip.left + 1 || x > clip.right - 1 || y < clip.top + 1 || y > clip.bottom - 1) continue;
        if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || el.contains(hit) || hit.contains(el)) continue;
        const pin = pinnedAncestor(hit);
        if (!pin) continue;                            /* an ordinary sibling, not a pin */
        out.push(`"${nameOf(el)}" (${desc(el)}) ${y === r.top + 1 ? "top" : "bottom"} edge under ${desc(pin)}`);
        done = true; break;
      }
      if (done) break;
    }
  }
  return out;
};

export const name = "chrome — sticky headers, collapsed rail, date popover";

export async function run({ browser, report }) {
  const page = await (await browser.newContext()).newPage();
  const errs = watchErrors(page);
  await signIn(page, VP);

  /* ── 1 + 2. Settings: nothing pinned over the settings you are reading ── */
  if (await go(page, "Settings")) {
    await page.getByRole("button", { name: "Modules", exact: true }).click().catch(() => {});
    await page.waitForTimeout(700);

    const content = page.locator(".dk-content");

    /* No page-level sticky bar inside the scroll area at all. Save lives in
       the dock below .dk-content instead — see deck.css C4.2. */
    report.ok(await page.locator(".dk-set-body .dk-stickhead").count() === 0,
      "no Settings card is pinned inside the scroll area, so none can cover the settings under it",
      `${await page.locator(".dk-set-body .dk-stickhead").count()} pinned cards`);

    /* The collapse this still guards: .dk-set stopping at viewport height while
       its content is half as tall again, so the settings escape the box
       instead of the page scrolling. */
    const set = await page.locator(".dk-set").evaluate((e) => ({
      h: e.getBoundingClientRect().height, sh: e.scrollHeight,
    }));
    report.ok(set.h >= set.sh - 2,
      "the Settings body is as tall as the settings in it, so the page scrolls rather than the content escaping",
      `box ${Math.round(set.h)}px vs content ${set.sh}px`);

    const scrollMax = await content.evaluate((e) => e.scrollHeight - e.clientHeight);
    report.ok(scrollMax > 100, "Modules is long enough to scroll, so the geometry below is actually exercised",
      `scrollable ${scrollMax}px`);

    /* The reported fault, at every section, both themes, both windows, and at
       scroll positions including the very bottom. The photograph was Modules
       in the light theme scrolled about half way; nothing about the fault was
       specific to that, so nothing about the check is either. */
    const SECTIONS = ["General", "Modules", "Taxes", "Price lists", "Users & roles", "Print",
                      "Item defaults", "Units & categories", "Party defaults", "Transaction",
                      "Loyalty", "Backup", "About & updates"];
    let checked = 0;
    const covered = [];
    for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(vp);
      for (const theme of ["light", "dark"]) {
        /* The app puts the theme on <body> (App.jsx:284). Setting it here rather
           than driving the menu keeps this a geometry test; App only rewrites the
           attribute when its own theme state changes, so it stays put. */
        await page.evaluate((t) => document.body.setAttribute("data-theme", t), theme);
        await page.waitForTimeout(200);
        for (const sec of SECTIONS) {
          const btn = page.getByRole("button", { name: sec, exact: true });
          if (!(await btn.count())) continue;          /* module switched off */
          await btn.click();
          await page.waitForTimeout(320);
          const max = await content.evaluate((e) => e.scrollHeight - e.clientHeight);
          for (const f of [0, 0.33, 0.66, 1]) {
            await content.evaluate((e, s2) => { e.scrollTop = s2; }, Math.round(max * f));
            await page.waitForTimeout(120);
            checked++;
            for (const hit of await page.evaluate(coveredControls)) {
              covered.push(`${vp.width}px ${theme} ${sec} @${Math.round(max * f)}: ${hit}`);
            }
          }
        }
      }
    }
    report.ok(checked > 100, "every Settings section was walked at several scroll positions",
      `${checked} section/scroll combinations`);
    report.ok(!covered.length,
      "no control in Settings is ever partly hidden under a pinned bar, at any section, theme, window or scroll position",
      `${covered.length} covered: ${covered.slice(0, 4).join(" | ")}`);

    await page.setViewportSize(VP);
    await page.evaluate(() => document.body.setAttribute("data-theme", "light"));
    await page.waitForTimeout(300);

    /* Reaching Save was the whole reason the header was pinned. It has to
       still be solved, or this is a regression dressed as a fix. */
    await page.getByRole("button", { name: "Modules", exact: true }).click();
    await page.waitForTimeout(500);
    report.ok(await page.locator(".dk-dockbar").count() === 0,
      "with nothing to save, the action dock takes no room at all");

    const max2 = await content.evaluate((e) => e.scrollHeight - e.clientHeight);
    await content.evaluate((e, s2) => { e.scrollTop = s2; }, max2);
    await page.waitForTimeout(200);
    await page.locator(".dk-set-body .dk-switch").last().click();
    await page.waitForTimeout(400);

    const dock = page.locator(".dk-dockbar");
    report.ok(await dock.count() === 1,
      "flipping a switch at the very bottom of Modules brings up the save bar");

    const save = dock.getByRole("button", { name: /^Save/ });
    const sBox = await box(save);
    const cBox = await box(content);
    report.ok(sBox.w > 2 && sBox.t >= 0 && sBox.b <= (await page.evaluate(() => innerHeight)) + 1,
      "Save is on screen from the bottom of the longest settings page, without scrolling back up",
      JSON.stringify(sBox));
    /* The point of docking it: the bar is below the scrollport, not over it. */
    report.ok(sBox.t >= cBox.b - 1,
      "the save bar sits below the scrolling area rather than on top of it, so it covers nothing",
      `dock top ${sBox.t}, content bottom ${cBox.b}`);
    report.ok(!(await page.evaluate(coveredControls)).length,
      "…and with the save bar up, still nothing in the page is hidden under it",
      (await page.evaluate(coveredControls)).slice(0, 3).join(" | "));

    const tBox = await box(page.locator(".dk-top"));
    report.ok(tBox.t === 0, "the page title block is pinned at the top of the window", `top ${tBox.t}`);
    report.ok(tBox.b <= cBox.t + 1,
      "the page title block sits above the scrolling content, never over it",
      `.dk-top bottom ${tBox.b}, content top ${cBox.t}`);

    await page.getByRole("button", { name: /^Discard/ }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).last().click().catch(() => {});
    await page.waitForTimeout(600);
  }

  /* ── 3. Reports: the date-range popover ───────────────────────────────── */
  await go(page, "Reports");
  await page.waitForTimeout(500);
  await page.getByText("Sale summary", { exact: true }).first().click();
  await page.waitForTimeout(1200);

  const trigger = page.locator(".drp-trigger").first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(400);
    const panel = page.locator(".drp-panel");
    report.ok(await panel.count() === 1, "clicking the date range opens the calendar");

    const geo = await page.evaluate(() => {
      const p = document.querySelector(".drp-panel");
      const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      /* An overflow:hidden ancestor that cannot scroll is what clipped this. */
      const clippers = [];
      for (let e = p.parentElement; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (!/hidden|clip|auto|scroll/.test(cs.overflow)) continue;
        const b = e.getBoundingClientRect(), q = r(p);
        if (q.l < b.left - 1 || q.r > b.right + 1 || q.t < b.top - 1 || q.b > b.bottom + 1) {
          if (cs.position !== "static" && getComputedStyle(p).position === "fixed") continue;
          if (getComputedStyle(p).position === "fixed") continue;   /* fixed escapes overflow */
          clippers.push(`${(e.className || e.tagName).toString().split(" ")[0]} ${cs.overflow}`);
        }
      }
      const apply = [...p.querySelectorAll("button")].find((b) => /apply/i.test(b.textContent));
      const cancel = [...p.querySelectorAll("button")].find((b) => /cancel/i.test(b.textContent));
      const dows = [...p.querySelectorAll(".drp-grid .dow")].map((d) => r(d));
      return { panel: r(p), pos: getComputedStyle(p).position, clippers,
               apply: apply && r(apply), cancel: cancel && r(cancel), dows,
               vw: innerWidth, vh: innerHeight };
    });

    const inside = (b) => b && b.l >= -1 && b.t >= -1 && b.r <= geo.vw + 1 && b.b <= geo.vh + 1;
    report.ok(inside(geo.panel), "the whole calendar is inside the window",
      `${JSON.stringify(geo.panel)} in ${geo.vw}×${geo.vh}`);
    report.ok(!geo.clippers.length, "nothing up the tree clips the calendar", geo.clippers.join(", "));
    report.ok(geo.dows.length === 7 && geo.dows.every(inside),
      "every weekday column is on screen — the left of the month was the reported symptom",
      `${geo.dows.length} columns, first left ${geo.dows[0] && Math.round(geo.dows[0].l)}`);
    report.ok(inside(geo.apply) && inside(geo.cancel),
      "Cancel and Apply are on screen, so a chosen range can be applied",
      `apply ${JSON.stringify(geo.apply)} cancel ${JSON.stringify(geo.cancel)}`);

    /* The panel must stay glued to its trigger, not merely somewhere legal. */
    const tBox = await box(trigger);
    report.ok(geo.panel.r >= tBox.l - 4 && geo.panel.l <= tBox.r + 4,
      "the calendar still reads as belonging to the button that opened it",
      `panel ${Math.round(geo.panel.l)}–${Math.round(geo.panel.r)}, trigger ${Math.round(tBox.l)}–${Math.round(tBox.r)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    /* Short window, and a narrow one where the panel cannot hang leftwards:
       both are the cases the flip fallbacks exist for. */
    for (const vp of [{ width: 1280, height: 600 }, { width: 1100, height: 900 }]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(400);
      await page.locator(".drp-trigger").first().click();
      await page.waitForTimeout(400);
      const g = await page.evaluate(() => {
        const p = document.querySelector(".drp-panel");
        const b = p.getBoundingClientRect();
        const apply = [...p.querySelectorAll("button")].find((x) => /apply/i.test(x.textContent)).getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, bo: b.bottom, ap: { l: apply.left, t: apply.top, r: apply.right, b: apply.bottom }, vw: innerWidth, vh: innerHeight };
      });
      report.ok(g.l >= -1 && g.t >= -1 && g.r <= g.vw + 1 && g.bo <= g.vh + 1,
        `the calendar flips or shifts to stay on screen at ${vp.width}×${vp.height}`,
        `panel ${[g.l, g.t, g.r, g.bo].map(Math.round).join(",")} in ${g.vw}×${g.vh}`);
      report.ok(g.ap.b <= g.vh + 1 && g.ap.l >= -1,
        `…with Apply still clickable at ${vp.width}×${vp.height}`,
        `apply bottom ${Math.round(g.ap.b)} of ${g.vh}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
    await page.setViewportSize(VP);
    await page.waitForTimeout(300);
  }

  /* ── 4. The collapsed rail ────────────────────────────────────────────── */
  await page.click(".dk-rail-toggle");
  await page.waitForTimeout(700);

  const rail = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".dk-railnav .dk-nav, .dk-railfoot .dk-nav")];
    return rows.map((b) => {
      const r = b.getBoundingClientRect();
      const svg = b.querySelector("svg");
      const sr = svg && svg.getBoundingClientRect();
      const lbl = b.querySelector(".lbl");
      const paths = svg ? svg.querySelectorAll("path[d]:not([d=''])").length : 0;
      return {
        name: (lbl ? lbl.textContent : b.title || "").trim(),
        title: b.title,
        hasIcon: !!svg && paths > 0,
        /* Centred and inside the button — the bug put it at -12→6 on a
           button spanning 12→64, i.e. off the left edge entirely. */
        iconInside: !!sr && sr.left >= r.left - 0.5 && sr.right <= r.right + 0.5,
        iconCentred: !!sr && Math.abs((sr.left + sr.right) / 2 - (r.left + r.right) / 2) <= 1.5,
        labelShown: !!lbl && getComputedStyle(lbl).display !== "none",
      };
    });
  });

  report.ok(rail.length >= 10, "the collapsed rail still lists every destination", `${rail.length} rows`);
  const noIcon = rail.filter((r) => !r.hasIcon).map((r) => r.title);
  report.ok(!noIcon.length, "every collapsed rail entry draws an icon", noIcon.join(", "));
  const escaped = rail.filter((r) => !r.iconInside || !r.iconCentred).map((r) => r.title);
  report.ok(!escaped.length, "every icon is centred inside its own button rather than pushed off the edge", escaped.join(", "));
  const labelled = rail.filter((r) => r.labelShown).map((r) => r.title);
  report.ok(!labelled.length, "no truncated labels are left in the collapsed rail", labelled.join(", "));
  const untitled = rail.filter((r) => !r.title).map((r, i) => `row ${i}`);
  report.ok(!untitled.length, "each icon still names itself on hover", untitled.join(", "));

  const railW = await page.locator(".dk-rail").evaluate((e) => e.getBoundingClientRect().width);
  report.ok(railW <= 90, "the collapsed rail really is a rail", `${Math.round(railW)}px`);

  await page.click(".dk-rail-toggle");
  await page.waitForTimeout(500);
  const openLabels = await page.evaluate(() =>
    [...document.querySelectorAll(".dk-railnav .dk-nav .lbl")].filter((l) => getComputedStyle(l).display !== "none").length);
  report.ok(openLabels >= 10, "expanding the rail brings the labels back", `${openLabels} labels`);

  /* ── 5. The dialogs, which had the same fault ─────────────────────────
     .dk-modal and .dk-formbox scrolled as a whole with a `position: sticky`
     head and foot, so a field could come to rest half under the title bar or
     half under the Save row. Both are now frames — head, scrolling middle,
     foot — with the bars outside the scrollport. The item editor is the
     tallest of them and the one that actually overflowed. */
  if (await go(page, "Items")) {
    await page.click(".dk-create");
    await page.waitForTimeout(1600);
    const form = page.locator(".dk-formbox");
    if (await form.count()) {
      const shape = await page.evaluate(() => {
        const g = (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const cs = getComputedStyle(e);
          return { pos: cs.position, scrolls: /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1 };
        };
        return { head: g(".dk-formhead"), body: g(".dk-formbody"), foot: g(".dk-formfoot") };
      });
      report.ok(shape.head?.pos !== "sticky" && shape.foot?.pos !== "sticky",
        "the item editor's title bar and Save row are part of the frame, not pinned over the fields",
        JSON.stringify(shape));
      report.ok(shape.body?.scrolls,
        "…and the fields between them are what scrolls", JSON.stringify(shape.body));

      const dlgCovered = [];
      for (const f of [0, 0.4, 0.8, 1]) {
        await page.evaluate((frac) => {
          const b = document.querySelector(".dk-formbody");
          b.scrollTop = (b.scrollHeight - b.clientHeight) * frac;
        }, f);
        await page.waitForTimeout(180);
        for (const hit of await page.evaluate(coveredControls)) dlgCovered.push(`@${f}: ${hit}`);
      }
      report.ok(!dlgCovered.length,
        "no field in the item editor is ever partly hidden under its title bar or its Save row",
        dlgCovered.slice(0, 4).join(" | "));
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  report.ok(!errs.length, "no page errors while driving the chrome", errs.slice(0, 3).join(" | "));
  await page.close();
}
