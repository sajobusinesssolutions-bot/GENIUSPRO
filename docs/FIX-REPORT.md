# Genius POS — section C fix pass

Worked from `REVIEW-BACKLOG.md` section C (open bugs). Sections A and B were left
as found; section D (design/IA judgement calls) was deliberately not touched.

Every source file changed has a `.bak` sibling. Some `.bak` files predate this
pass — they hold the section-B state — so a `.bak` diff may show more than one
session's work. Verified clean: `vite build`, `check-imports`, `check-layers`,
`node --check` on every backend file.

The work was done in two rounds. Round one fixed the backlog items; round two
fixed thirteen defects found by an independent adversarial review of round
one's diffs. Round-two findings are marked **[R2]** where they changed a
round-one fix.

---

## C1 — Data / correctness

| # | Item | Root cause | Fix |
|---|------|-----------|-----|
| 1 | Dashboard chart renders no data series | `for (h = 7; h <= 21)` hard-coded the hourly loop, so bills at 03:00 produced fifteen zero points | Window derived from hours that actually have takings, ±1h padding, min 6h span, falling back to 07:00–21:00 when empty — `dashboard.routes.js:130` |
| 2 | Sales page stale on first load | **Not** the cache header. Two effects race on mount and neither fetch is abortable, so a slow earlier reply overwrites a newer one | Monotonic request ticket + mounted flag on both `loadOv` and `load`; only the newest reply may write state. `Cache-Control: no-store` added on `/api` as well, but that was not the cause — `Invoices.jsx:448,632`, `server.js:26` |
| 3 | Books health "all clear" over Inventory at −1,420,000 | All six checks tested internal consistency; none tested plausibility | Three plausibility checks added (negative inventory, overdrawn asset, negative on-hand), feeding the existing `ok` roll-up; summary names the failing checks. **[R2]** they now read `account_balances.balance` — the same basis as the balance sheet — rather than `journal_entry_lines`, which omits opening balances — `accounting.routes.js:266` |
| 4 | Z report zero over a range containing data | `/day-close` read `date \|\| to` and compared for equality, so 08-01…08-06 asked for "dated exactly 08-06" | Honours `from`..`to`; single day only when `?date=` is given or the two match. Empty copy switches to "No sales in this range" — `reports.routes.js:600`, `Reports.jsx:404` |
| 5 | Tax & URA cannot match its own VAT rule | Setting holds `VAT`, the rule is `VAT 18`, match was string equality | `pickVatName()`: exact normalised match wins; prefix accepted only when nothing matches exactly **and** exactly one candidate matches. **[R2]** the first attempt matched loosely enough to fold `VAT Exempt` into the total while the banner said it was excluded. Banner now fires only on a genuine miss and points at one Settings location — `tax.routes.js:46`, `Tax.jsx:158` |
| 6 | Tax & URA defaults to last month | `periods[1]` | `periods[0]` — `Tax.jsx:39` |
| 7 | Search suggestion shows `119 BAG − 49 KG` | `dualQty` floored the base quantity then multiplied the leftover fraction; the separator was a minus sign | Normalises to loose units, re-splits, rounds. **[R2]** sign now applies to the whole expression (`−(1 BAG + 25 KG)`, not `−1 BAG + 25 KG`, which evaluated to −0.5) and the remainder is rounded, so a non-integer `conversion_rate` no longer yields `0.30000000000000004 BTL` — `tax.js:72` |
| 8 | Dead stock flags brand-new items | "Nothing sold in 60 days" was true of an item created a minute ago | Requires `created_at <= date('now','-60 day')`; the ageing report carries `on_books_days` — `overview.routes.js:55`, `items.routes.js:371` |
| 9 | Best sellers vs item detail disagree | Dashboard summed `quantity` (packs and loose mixed), item screen summed `base_quantity` | Dashboard sums `COALESCE(base_quantity, quantity)`; both labels carry unit and period — `dashboard.routes.js:70`, `Items.jsx:474` |
| 10 | Shift open 7 days, unflagged | Nothing computed shift age; "Cash sales so far" read as "today" | Warning at 24h+; metrics relabelled shift-to-date. The figures were never wrong — they were shift-to-date all along, which is why they diverged from "Sales today" — `Shifts.jsx:58` |
| 11 | "Last 7 kept" lists 3 on non-consecutive dates | Pruning matched any `auto-` prefix while listing returned every `.db`; the gaps themselves are not a bug | Pruning anchored to `auto-YYYY-MM-DD.db`; payload carries `day`, `taken_at`, `automatic`, `gap_before`, `keep`, and the Settings list now shows the covered day and marks gaps as "the app was not opened" — `system.routes.js:16`, `Settings.jsx:834` |
| 12 | Staff → What they are owed drops a staff account | Not a join — `.filter(r => r.sold > 0 \|\| r.rate > 0)` dropped anyone with no sales and no rate | Filter replaced with an active-status filter matching the sibling roster endpoint. **[R2]** the first attempt removed the filter entirely, which parked switched-off ex-employees in the table forever at Sh 0 — `staff.routes.js:187` |

## C2 — Interaction

| # | Item | Fix |
|---|------|-----|
| 1 | Till quantity commits only on blur | `NumCell` gained a `live` mode that pushes each parseable keystroke to `onCommit`, holding back transient `""`, `"."`, `"12."`. **[R2]** the "did I cause this?" guard was a bare boolean that never cleared on a no-op commit — typing `1` over `1` then pressing F6 silently undid the unit flip and sold 1 KG instead of 50. It now stores the exact value pushed — `Pos.jsx:47` |
| 2 | Enter reverts the typed quantity | Enter `preventDefault` + `stopPropagation`s past the till's window-level scanner handlers and commits explicitly — `Pos.jsx:66` |
| 3 | Escape does not close Create Invoice | **[R2]** round one added the handler to the wrong component — there are two named `InvoiceBuilder`, and it landed on the print-template designer. Escape now closes the real Create Invoice panel (`Invoices.jsx:94`) and was removed from the designer, which has no dirty tracking and would silently discard minutes of work |
| 4 | Refund dialog commits with no preview | Summary block (invoice no, date, customer, sale total, item count), live "Refunding N items · Sh X", amount on the button, disabled when nothing is ticked — `Pos.jsx:1097` |
| 5 | Online store fields editable when the store is off | `GATED` map disables and dims the fields with an explanatory line. **[R2]** the section-visibility filter beside it tested `online_store_enabled`, a key that does not exist, so the section was permanently visible — both now use `store_enabled` — `Settings.jsx:60,105` |
| 6 | Import wizard has no Next/Back | Real `← Back` / `Next: Map fields` buttons; disabled with the "Choose a file to continue" hint until a file is parsed; step 2's Back keeps the file — `Utilities.jsx:186` |
| — | *(new, from R2)* Rejected quantity left in the cell | With `prevent_negative_stock` on, `setQty` refused the change but the live draft kept displaying it — the same defect C2.1 set out to remove, moved from the total to the cell. `setQty` now reports success back so the cell snaps to the committed figure — `Pos.jsx:259` |

## C3 — Layout clipping

1. **Sticky header covering Save controls** — `.dk-top` is sticky *inside* `.dk-main`, which was also the scroll container, so anything scrolled up sat underneath it. Rather than nudging an offset, the scrollport moved to `.dk-content`, which takes the header out of the scrollport entirely — overlap is structurally impossible at any header height, with no magic number to keep in sync. Also fixes the sliced first row of the Parties statement. `deck.css:2843`
2. **Unwrapped `.dk-table` instances** — the backlog's "~31 of 50" over-counts: `TableCard` (`deckui.jsx:77`) already renders children inside a scrolling `.dk-tablewrap`, as do several hand-rolled containers. Genuinely clipping: **12**, now **0**.

   | File | tables | already covered | unwrapped before | after |
   |---|---|---|---|---|
   | Invoices.jsx | 5 | 4 | 1 | 0 |
   | Purchases.jsx | 7 | 5 | 2 | 0 |
   | Parties.jsx | 2 | 0 | 2 | 0 |
   | PosAdmin.jsx | 3 | 0 | 3 | 0 |
   | Money.jsx | 4 | 1 | 3 | 0 |
   | InstalmentsPanel.jsx | 5 | 4 | 1 | 0 |
   | StockTake / Recurring / Loyalty | 7 | 7 | 0 | 0 |

   `.dk-scrollx` was also hardened (`min-width: 0` so it scrolls inside flex/grid tracks instead of widening them) and `.dk-card:has(> .dk-table)` added so a bare table degrades to a scrolling card. Rounded-corner clipping is preserved.
3. **Sidebar hides 6 destinations** — `overflow-y: auto` was on the whole rail, so scrolling to Settings pushed the brand off. Brand and the Settings/user footer are now pinned; only the nav list scrolls; density tightens under 760px and 620px viewport height, so at ~600px little or no scrolling is needed. `App.jsx:420`, `deck.css:2897`
4. **12px horizontal jump between Sales tabs** — `scrollbar-gutter: stable` on `.dk-content`, the real scroll container. (The `.main`/`.shell` rules in `styles.css` are dead code — App renders `dk-shell`/`dk-main`.) `deck.css:2846`

## C4 — Copy / affordance

- **"Saved" in the action slot** — button always reads an action ("Save changes" / "Save N changes"), disabled with nothing to save; a separate `role="status"` "✓ Saved" chip appears after a save. Same for the role matrix. `Settings.jsx:147`
- **Backup inverts weight against risk** — download is now secondary; restore reads destructive and keeps its confirmation. `Settings.jsx:705`
- **"Switch off" styled like "Set PIN"** — danger colours, explanatory title, and a confirm dialog before deactivating an account. `Settings.jsx:283`
- **Administrator drawer closes via "→"** — replaced with the `✕` used by every other panel. `PosAdmin.jsx:46`
- **"Sign out" reads as a peer of "Back to dashboard"** — distinct power icon (was the same door-arrow as "End of day"), danger colour, separated by a rule. `PosAdmin.jsx:69`
- **Duplicate primary actions** — page-level "Record payment" hidden when the card-level one is on screen; **[R2]** the guard was on the tab rather than the sub-tab, which removed the action entirely from Expenses and Other income (`Money.jsx:66`). Stock take's empty-state CTA relabelled to match the toolbar (`StockTake.jsx:104`). Report "Print" existed twice — page toolbar and inside `ReportTable`; both called `window.print()` on the whole page, so the table copy is gone (`reportshell.jsx:172`).
- **Sync & audit subtitle promises devices and an audit log that do not exist** — retitled "Data tools" / "Import items, export to Excel, print barcodes and check your data". `App.jsx:203`
- **"Duplicate Handling \*"** — required marker dropped; the two options collapsed into a mapped array with a shared `name`. `Utilities.jsx:167`
- **Hit targets** — sample-CSV link is `inline-flex` at `min-height: 28px`; radios 18×18 in a 28px row, so the whole option row is the target. `Utilities.jsx:168`
- **Last Settings toggle row sliced by the card edge** — the real cause was `.dk-two`'s default `align-items: stretch` forcing both columns to the taller card's height, which `.dk-card { overflow: hidden }` then clipped. `align-items: start` lets each card size to its content; this also removes most of the "mismatched card height" observations. `deck.css:2123`
- **Latest bills INVOICE column wraps** — `white-space: nowrap` on the invoice cell. `Dashboard.jsx:296`

## Round-two housekeeping

- Disabled ghost/secondary buttons turned primary-blue on hover — `.btn:disabled:hover` was unscoped and beat `.btn-ghost:hover` on specificity. Scoped to `.btn-primary`, with a ghost rule added. `styles.css:91`
- `fmtDate` was a day early in any negative UTC offset: `new Date("2026-08-04")` parses as UTC midnight, then `getDate()` reads local. Since this pass routed invoice, instalment, tax-period and refund dates through it, that mattered. Bare `YYYY-MM-DD` is now split with a regex and never passed through `Date`. Verified under `TZ=America/New_York`, `UTC` and `Africa/Kampala`. `tax.js:147`
- `cur()` was bypassed by hardcoded `"Sh "` in `Shifts.jsx` (which imported `cur` and used it in one toast) and 48 sites in `Reports.jsx`. All routed through the currency helper.
- Palette and combo item suggestions printed a raw base quantity; both use `dualQty` now, and `/dashboard/search` returns the unit columns to make that possible. `App.jsx:814`, `ui.jsx:923`, `dashboard.routes.js:247`
- Dead code removed: orphaned `.dk-rail-gap`, a duplicate `.dk-scrollx` block that was entirely overridden, and a byte-identical `deckui.jsx.bak`. `dk-s` (custom scrollbar) moved from `.dk-main` to `.dk-content`, which is what actually scrolls now.

---

## Not fixed — and why

- **Totals shown twice on Stock summary ("QUANTITY 80")** — the band and the table footer both carry the report's totals. That is true of every report, not just this one, and a summary band above a long table plus a column footer at the bottom is a defensible pattern. Changing it is a section-D decision about what the band is for, so it is left alone.
- **"Loyalty" section permanently visible** — same class of bug as the store gate (`loyalty_enabled` is not in the settings catalog either), but there is no correct key to point it at without deciding what the setting should be.
- **Section D** — untouched, as agreed.

---

# Round three — verified against a running build

The app was booted (backend on :3000, Vite on :5173, seeded database) and driven
through Chromium with Playwright. Everything below is a measurement, not a claim.

## Layout: 0 unreachable controls, 16 pages × 7 viewports

The audit walks every `button`, `a`, `input`, `select` and `table` on each page
and reports an element only when it is clipped by an `overflow: hidden` ancestor
**that cannot scroll** — a scrollable ancestor anywhere up the chain counts as
reachable. It also flags controls genuinely covered by the sticky header
(requiring overlap on both axes, so the sidebar is not a false positive).

| Viewport | Before round three | After |
|---|---|---|
| 1254×596 *(review's smallest)* | 6 | **0** |
| 1280×600 | 6 | **0** |
| 1394×662 *(observed)* | — | **0** |
| 1548×736 *(observed)* | — | **0** |
| 1707×811 *(observed)* | — | **0** |
| 1024×640 | 2 | **0** |
| 900×700 | 9 | **0** |

No console errors and no React errors on any page.

**The scroll-container change is vindicated, not a regression.** My round-two
worry was wrong, and so was my first audit: it flagged "Run the checks" on
Tax & URA as 236px unreachable and a dozen Settings inputs as clipped. Tracing
the box chain showed each sits inside an inner scroller (`.dk-side` scrolls
461/160; `.dk-content` scrolls 1497/488) and is perfectly reachable. Once the
audit accounted for scrollable ancestors, 11 of 17 pages were already clean.

Three genuine causes were left, all found this round:

- **`.panel` had the same `overflow: hidden` problem as `.dk-card`** but was never
  given the degradation rule. Warranty lost 215px of table rows, Production 9px,
  Shifts 3px of columns. Fixed with a `:has()` rule scoped to panels that
  directly contain a table. `deck.css`
- **`.dk-tablecard` collapsed below its own chrome.** On Accounting at 1280×600
  the card is a `flex: 1 1 0` child given 131px, while its fixed head (84px) and
  footer (67px) need 151px — so the table area collapsed to 0 and Add account /
  Export CSV / Print were clipped 5px past the edge. `min-height: min-content`
  stops the card shrinking past its unshrinkable parts, so the page scrolls
  instead of the card growing its own 20px scrollbar. `deck.css`
- **The same collapse one level up**, at the `.dk-md` and `.dk-dash-bottom`
  content bands (`flex: 1 1 0; min-height: 0`). Below 1024px these shrank to
  nothing and took their cards with them — Parties' filter row and + Add, Items'
  search box, the Dashboard's "All sales ▸". Same `min-content` floor. This is
  what closed 1024×640 and 900×700, which the original review never reached
  (section E listed responsive behaviour as unverified). `deck.css`

## Behaviour verified at runtime

| Check | Result |
|---|---|
| **C2.1** subtotal updates while typing, before any blur | ✓ `Sh 34,440 → Sh 103,320` mid-keystroke |
| **C2.2** Enter commits rather than reverting | ✓ cell holds `3`, totals unchanged by Enter |
| **[R2] the data-loss scenario** — no-op commit then F6 unit flip | ✓ `3 BAG → 150 KG`, cell reads `150`, `Sh 110,700`. This is the bug that would have sold 1 KG instead of 50 |
| **C2.3** Escape closes Create Invoice | ✓ `slide-veil` overlay present after New invoice, gone after Escape |
| **C2.6** import wizard Next/Back | ✓ both exist; Next correctly disabled with no file |
| **[R2] finding 4** disabled ghost button on hover | ✓ stays white, no longer repaints primary |
| **C1.4** Z report range | ✓ `08-01..08-06 → one_day=false`; `?date=` still `one_day=true` |
| **C1.3** books health | ✓ 9 checks, `ok=false`, inventory check fails with "Inventory carries Sh -1420000.00 — stock has gone out that was never taken in" |
| **C1.5** VAT matching | ✓ setting `VAT` resolves to rule `VAT 18` |
| **C1.8** dead stock | ✓ count 0 (was flagging an item created seconds earlier) |
| **C1.11** backup payload | ✓ `day`, `taken_at`, `automatic`, `gap_before`, `keep` all present and rendered |
| **C1.12** staff commissions | ✓ both accounts listed — `Administrator[active]`, `Sales Rep[active]` |
| **C1.1** dashboard chart window | ✓ see below |

**C1.1** could not be reproduced live because nothing has sold today, so the
endpoint correctly returns the documented 07:00–21:00 fallback. The window
derivation was therefore tested directly against the reported scenario:

```
bills at 03:00–03:25   → window 00:00–05:00  covers-all=true   (was 07:00–21:00: excluded)
normal trading 09–17   → window 08:00–18:00  covers-all=true
midnight only          → window 00:00–05:00  covers-all=true
23:00 only             → window 18:00–23:00  covers-all=true
00:00 and 23:00        → window 00:00–23:00  covers-all=true
nothing sold           → window 07:00–21:00  (fallback)
```

## Two corrections to what I told you earlier

- **I overclaimed the sidebar fix.** I said "at ~600px the list needs little or
  no scrolling". It does still scroll — 20 destinations at 34px is 682px in a
  427px slot. What the fix actually delivers is that the brand stays pinned at
  y=14 and the Settings/user footer at y=499 *while* the nav scrolls, so
  reaching Settings no longer pushes the brand and the top four items off
  screen. That was the real complaint; the item count was always going to
  exceed 600px.
- **The sidebar still read "Sync & audit".** Round one renamed the page title
  but not the nav label, so the two disagreed. Both now read "Data tools".

## Also fixed this round

- The till's Amount payable rendered `Sh34,440` with no space while the button
  beside it read `Sh 34,440`. The symbol and figure are separate elements, so
  the space had to be explicit. `Pos.jsx:724`

---

# Round four — report panes and print

Two items I had listed as unverified, closed. Both were things I had changed
without ever looking at the result.

## All 58 report panes opened — 58/58 clean

`Reports.jsx` had 48 currency sites rerouted through `money()` and a Print
button removed, and not one report output had been opened. Every report in all
seven groups was opened and inspected:

| Group | Reports | Result |
|---|---|---|
| Sales | 21 | all clean |
| Purchase | 5 | all clean |
| Money | 6 | all clean |
| Receivables | 7 | all clean |
| Payables | 5 | all clean |
| Stock | 9 | all clean |
| Tax & books | 5 | all clean |
| **Total** | **58** | **0 errors** |

Each pane was checked for React errors, console errors, and for `NaN`,
`undefined`, `[object Object]`, `Invalid Date`, doubled currency symbols and the
`item(s)` plural bug leaking into the output. None appeared anywhere. Reports
with no rows all render a proper empty state ("No refunds in range", "No
supplier dues", "No cash in/out recorded") rather than a blank pane.

**Exactly one Print button on every one of the 58** — confirming the duplicate
removed in round one was the right copy, and that no report lost its Print.

This closes section E's "individual report outputs for 37 reports — the result
panes were not each opened".

## Report printing was broken, and had been all along

Section E guessed print was "likely its own layout system". Half right, and the
half that wasn't was broken:

- **Receipts and invoices** (`lib/print.js`) build their own document via
  `window.open` + `document.write`. Genuinely independent, unaffected by
  anything here.
- **Report printing** uses the app's own stylesheet — and the `@media print`
  block in `styles.css:1809` targets `.sidebar`, `.topbar`, `.shell`, `.main`,
  `.content`. App.jsx renders none of those; it renders `.dk-rail`, `.dk-top`,
  `.dk-shell`, `.dk-main`, `.dk-content`. The print stylesheet has been dead
  since the deck shell landed.

Measured before the fix: printing "Sale summary" produced **one A4 page whose
text was the navigation rail and the report index** — not the report. The single
page is the second half of the problem: the shell is a fixed-height flex column,
so everything past the first screen was silently dropped.

Fixed by writing the same three intentions again in deck class names
(`styles.css`, print media only — no screen impact): hide the chrome, the group
tabs, the report picker column and the report's own toolbar; unwind
`height`/`max-height`/`overflow` down the whole container chain so content flows
across pages; drop card borders and shadows; and repeat table headers on each
page with `display: table-header-group`.

Verified by generating real PDFs:

| | Before | After |
|---|---|---|
| Sale summary | 1 page, contents = report index | 1 page, firm + title + period + totals band + all **6** invoice rows |
| Trial balance | 1 page, contents = report index | 1 page, all **15** accounts with codes, debit and credit columns |

## Also confirmed

- **`:has()` is not a risk.** Electron is not pinned — `electron/main.js` documents it as an ad-hoc `npm i -D electron`, so any version installed today is far past Chromium 105 (Electron 21, Oct 2022) where `:has()` shipped. The rules are safe.

## Regression re-check after these changes

Build, `check-imports`, `check-layers` and `node --check` on every backend file: clean. Layout audit re-run at 1280×600, 1254×596, 1707×811 and 900×700: **0 unreachable controls**. Till live-commit, Enter-commit and the F6 unit-flip data-loss scenario: still passing. All 58 reports re-opened: still clean.

---

# Round five — receipts and keyboard

The last two items on my own unverified list. A real sale was rung up at the
till to produce a genuine receipt; the database was backed up first and restored
byte-identical afterwards (`md5 74dfebad…` before and after), so no test invoice
ships in this zip.

## Thermal receipts — two defects found and fixed

A sale was completed end to end (search → add → Take payment → Exact → Confirm &
print) and the receipt popup captured. It renders correctly: firm, TIN, invoice
number, date, tender type, line with unit maths, subtotal, tax, total, cash,
change, served-by. `window.print()` is called exactly once. **A1 also re-confirmed
in passing** — "Confirm & print" sits at y=755–811 in an 850px viewport, fully
visible without scrolling.

**1. The barcode ran off narrow rolls.** `code128Svg` emitted a fixed `width`
attribute, so the SVG kept its intrinsic pixel width no matter what it was
printed on. Measured: **454px of barcode on a 384px (2in) roll** — the tail of
the invoice number cut off and the code unscannable. Since the SVG already
carries a viewBox, capping it with `max-width: 100%; height: auto` lets it scale
to the paper. One change in `barcode.js` covers every call site.

| Roll | Before | After |
|---|---|---|
| 576px (3in) | fits | fits |
| 384px (2in) | **454px — overflows** | fits |
| 300px (tight) | **412px — overflows** | fits |

It only ever shrinks, so full-size label printing on the Items barcode sheet is
unaffected.

**2. The withholding line had a third name.** B5 relabelled the till's negative
tax as "Withholding tax", but the printed receipt still read
`Less: VAT 18 (18%)` — so the same figure appeared as "Withholding tax" on
screen, "Less: VAT 18" on the customer's copy, and "Tax Recoverable (WHT credit)"
in the ledger. The receipt is the copy the customer keeps, and calling a
withholding deduction "VAT" on it is the version that matters most. B5 fixed the
screen and missed the paper. All three receipt templates now share one
`taxLabel()` helper rendering `Withholding: VAT 18 (18%)` — the user's rule name
is preserved, only the verb states what the deduction actually is. `print.js`

## Keyboard navigation and focus — in good shape

| Check | Result |
|---|---|
| Focus ring on every tab stop (20 stops, Sales page) | ✓ 20/20 |
| Tab stops scrolled into view | ✓ 20/20 |
| `:focus-visible` coverage | ✓ including a catch-all `:where(button, a, input, select, textarea, [tabindex]):focus-visible` |
| F1 focuses the search box | ✓ |
| F2 opens the discount dialog | ✓ |
| F6 changes unit | ✓ `1 qty → 50 qty` |
| ↓/↑ select cart lines | ✓ |
| Del voids the selected line | ✓ opens the void-reason dialog (required by settings), removes the line once a reason is given |
| Enter / Escape | ✓ (verified in round three) |

A caveat on my own method: my first focus check reported a pass on a control
that had **no** ring, because a fully transparent `box-shadow` is not the string
`"none"`. Re-run with a check that rejects transparent colours and zero
geometry, the result held up — the rings are real. Worth noting that the input
ring is `rgba(37, 99, 235, 0.1)` at 3px, which is faint; whether that clears
the 3:1 contrast guidance is a design call rather than a defect, so it is left
alone.

## Regression re-check

Build, `check-imports`, `check-layers` and `node --check` on every backend file: clean. Database restored to its original checksum. `print_paper` returned to `3in`.

---

# Round six — the last C1 claims, and a bug found by checking

Four C1 items had been asserted from API responses but never seen on screen.
Checking them in the UI turned up a defect nobody had noticed.

## The four, seen on screen

| Item | Evidence |
|---|---|
| **C1.2** Sales stale on first load | ✅ First load reads `Sh 1,695,200 · 6 invoices · 6 of 6`, identical after a navigate-away-and-back. The original bug showed `Sh 42,900 · 2 invoices` and only corrected on the round trip. |
| **C1.7** negative loose stock | ✅ Palette and till search both read `80 BAG in stock` — with a unit, no interior minus. (The bug was `119 BAG − 49 KG`.) |
| **C1.9** best sellers vs item detail | ✅ Dashboard: `47 BAG sold this month · 80 BAG left`. Item detail: `47 BAG sold this month`. They agree, and each states its period and unit. The bug was 1273 vs 47. |
| **C1.10** stale shift | ✅ `This shift has been open for 9 days · since 04/08/2026 03:15 AM · 232h ago`, with the figures labelled shift-to-date. |

## The bug that surfaced: settings never applied in the first session

Comparing a warm page against a cold reload showed the same total two ways —
`Sh 1,695,200` and `Sh 1,695,200.00`. `amount_decimals` is `"2"`, so the
reloaded page was right and the fresh one was wrong.

The cause is in B7's plumbing. `App.jsx` fetches `/settings` in an effect with
`[]` deps. That effect first runs while the **sign-in screen** is up, where the
request answers 401 and the `.catch(() => {})` swallows it. App does not remount
on sign-in — it only sets `user` state — so the fetch never happened again, and
`currency_symbol`, `amount_decimals` and `date_format` were **never applied for
the entire session**. The settings only took effect if the user happened to
reload, at which point the stored token made the same request succeed and the
values were read from their localStorage cache.

So B7 shipped the plumbing and it was inert on first run. The effect now depends
on `user`, which also re-reads settings after Switch user — correct, since they
are per firm.

Verified: `localStorage.vy_decimals` is `null` after sign-in before the fix and
`2` after; the fresh-profile session now reads `Sh 1,695,200.00` on first paint,
matching the reload.

## Section F housekeeping

- **Held bill cleared** — the parked "Cash Sale" (Sh 41,000, held 13 Aug 01:53)
  released. `/pos/held` returns `[]`, and it survives a server restart. Invoices
  (6) and stock verified untouched.
- **"Cement 50kg Bag" deliberately kept**, on your instruction and for a
  concrete reason: it is referenced by all six seeded invoices and carries the
  whole Sh 2,800,000 stock value, in a catalogue of two items. Deleting it would
  orphan the sales and empty the books.

The database shipped in this zip was restored byte-identical after the receipt
test (`md5 74dfebad…`), so the only intentional data change is the released held
bill.

## `REVIEW-BACKLOG.md` rewritten

The original backlog is now stale — most of it is closed, and several of its
findings turned out to be wrong or mismeasured. It has been rewritten in place
with a status against every item, including where the original counts were off
(the "~31 of 50" tables were really 12; the 37 unopened reports were 37 of 58)
and where my own earlier fixes were wrong. Your original is preserved as
`REVIEW-BACKLOG.original.md`.

## Final state

Build, `check-imports`, `check-layers`, `node --check` on all backend files: clean.
Layout audit at 1280×600 / 1707×811 / 900×700: **0 unreachable controls**.
Till live-commit, Enter-commit and the F6 data-loss scenario: passing.
All 58 report panes: clean, one Print button each.

## Still unverified — and why

- **Physical thermal hardware.** Rendering is verified at 2in/3in roll widths in a browser; actual ESC/POS output on a real printer is not something this environment can exercise.
- **F11 Customer dialog** — the browser intercepts F11 here, same as in the original review.
- Everything in section D, untouched by agreement.

---

# Round seven — the work is now a git history

The recommendation from round six, acted on. **The project is now a git repo
with two commits**, so everything above is a reviewable diff rather than a
document you have to take on trust:

```
9b89189  Section C fixes, verified against a running build
fb7f0f9  Baseline: v1.42.0 as received, before the review pass
```

The baseline was reconstructed from **the original archive, not the `.bak`
files** — which matters, because three files changed during this pass
(`lib/print.js`, `lib/barcode.js`, `lib/reportshell.jsx`) never had a `.bak`, so
a `.bak`-based reconstruction would have silently hidden the print, barcode and
duplicate-Print-button work. The archive is the only complete record of the
starting point.

`git diff fb7f0f9 9b89189` is exactly this session's work: **35 source files,
+951 / −223**, plus the two documents.

| Area | Files | Largest |
|---|---|---|
| Backend | 9 | `tax.routes.js` +68, `system.routes.js` +44, `accounting.routes.js` +42 |
| Frontend pages | 18 | `Settings.jsx` +128, `Pos.jsx` +86, `Reports.jsx` +87 |
| Shared / CSS | 8 | `deck.css` +153, `styles.css` +50, `tax.js` +57 |

Notes on the repo:

- The project's existing `.gitignore` already excluded `backend/data/` and
  `*.db`, so the seeded database is present in the folder but untracked — its
  own stated intent, respected. `*.bak` has been added to the ignore list.
- The 34 `.bak` files are still on disk as your safety net. They are redundant
  now that the history exists; delete them whenever you are satisfied with it.
- The committed tree was verified to build clean from a fresh `npm install` in
  both `frontend` and `backend`, with `check-imports` and `check-layers` passing
  and `node --check` clean on every backend file.
- `session-changes.patch` is the same diff as a standalone file, if you would
  rather read it than clone.

Had this existed at the start, at least two of the mistakes in this pass — the
Escape handler landing on the wrong `InvoiceBuilder`, and the unscoped
`.btn:disabled:hover` — would have been obvious in review rather than needing an
adversarial pass to find.

---

# Round eight — section D, the design decisions

Commit `445de11`. Twelve items, four owner decisions, ~90 inline colour styles
replaced with a semantic vocabulary.

## What you decided

| Question | Your call |
|---|---|
| KPI strips | Compact to one slim row, standardised everywhere |
| Navigation | Rail + pill tabs, **max two levels**; anything deeper becomes a filter |
| Date filters | The Sales-style preset dropdown everywhere |
| Colour | Green = received, amber = owed to you, red = overdue |

## What that produced

**KPI strips.** `.dk-strip` is shared — 24 usages across six pages, one CSS
block — so this was largely a single-file change. Cell height **138px → 78px**;
`.dk-metrics` 100px → 72px. Line-heights are now explicit so the three lines do
not merge at the smaller size. Sub-lines that used to wrap were shortened, since
they now ellipsise.

**Navigation.** Cash & bank went from three stacked tab rows to one tab row plus
a `.dk-filterbar` segmented control — verified live: one `.dk-tabs`, one
`.dk-filterbar`, and "Record payment" still present on all three sub-tabs (a
previous pass had accidentally removed it from two of them).

**One date control.** Accounting, Money (×3), Staff and Tax dropped their native
date pairs and month selects. So did `TableCard`, which had its own bespoke
two-input control and is what Invoices/Purchases/Challans/Estimates actually
render — leaving it would have meant the standard was not applied on the busiest
pages.

One regression caught during this: Staff's old select listed 12 months and Tax's
15, so any month was one click; the new picker only had "This month" and "Last
month", which made a monthly filing workflow *worse*. A "Pick a month" list was
added, and Tax passes `months={15}` to match exactly what it replaced.

**Colour.** A semantic vocabulary replaced roughly 90 inline `style={{ color:
"var(--good)" }}` declarations:

- Money — `amt-received` · `amt-owed` · `amt-overdue` · `amt-paid` (money that
  has left) · `amt-reversal` (credit notes, returns, discounts) · `amt-zero` ·
  `amt-neutral`
- Stock and performance health — a **separate** `val-good` / `val-watch` /
  `val-loss` / `val-flat` family. This matters: Items and StockTake render
  margin %, shrinkage and count variance in green and red, and painting a
  healthy margin `amt-received` would assert that money was received. The
  prefix keeps the two scales visibly apart.
- Fills — `seg-*`, unscoped so they work on any bar or swatch.

Two things surfaced only because the colour rule forced the question:

- **The receivables ageing bar had 0–30 days in green** — money that has *not*
  been received, rendered as received. It now uses a four-step amber→red ramp on
  new `--age-*` tokens, which also separates the 61–90 and 90+ buckets that were
  merging into one block.
- **The zero-state split bar rendered 100% amber on an empty screen**, because
  `owedPct = 100 - collectedPct` is 100 when nothing has been invoiced. An
  empty screen was reading as "everything outstanding".

## The rest

Recurring, Instalments and Staff's commission tab now hand their tables to
`TableCard`, so they get the segmented filter, in-card search and standard
footer structurally and cannot drift again. Card widths collapsed to
`w-narrow`/`w-mid`/`w-wide` plus a 420px form column. Party groups moved next to
Party defaults. The Discount dialog's three blue buttons became `.dk-choice`
chips, leaving Apply as the only primary action.

## One original finding was wrong

D12 said *"No loading or skeleton states were seen anywhere."* `LoadingRows` is
used across 13 files, 80 references. They exist — the local API just answers too
fast for one to appear.

## Verification

0 unreachable controls across 16 pages × 5 viewports. Till live-commit, Enter,
the F6 data-loss scenario, arrow-key selection and Del-with-reason all still
pass. All 58 report panes clean. Receipt still fits 576/384/300px rolls and
reads `Withholding: VAT 18 (18%)`. Build, `check-imports`, `check-layers` and
`node --check` clean. Database restored to its original checksum, with the
released held bill as the only intentional data change.

---

# Round nine — the untested gaps

Five things I had flagged as never tested. All five were worth chasing.
Commit `e3f0ce7`.

## Tenant isolation — real vulnerabilities, now closed

Every prior pass ran as one admin on one firm, so `firm_id` scoping had never
been exercised. It was not sound. An audit enumerated every SQL statement
against the 60 firm-scoped tables, then attacked a genuine second firm over
HTTP with a user holding all 40 permissions so nothing could hide behind RBAC.

| Attempt as firm B | Before | After |
|---|---|---|
| Empty firm A's Admin role permissions | **200** — firm A's owner left with 0 of 40, locked out | 404 |
| Set the PIN on firm A's owner account | **200** | 404 |
| Delete firm A's item | **200** | 404 |
| Write into firm A's price book | **200** | 404 |
| Put firm A's item on a firm B invoice | **200**, name and cost readable via reports | 400 |

The role-permission one is the worst: a competitor tenant could lock a shop
out of its own books. All fixed at the query rather than with a guard on top,
plus defence-in-depth predicates on 19 unscoped `item_stock` sub-selects and
every child-row statement fetched by parent id.

## Permissions

Coverage was better than expected — 45 of 47 things a cashier should not be
able to do were already refused. Two were not: `/pos/day-close/history`
returned 120 past closes with takings by cashier, and
`/accounting/cash-accounts` handed the bank balance to anyone who opened the
payment dialog. Both gated. Three genuine product decisions (ungated
`day-close`, ungated `/dashboard`, the `Salesman` role lacking
`payments.create`) were reported rather than guessed at.

## Double-posting

A lost response meant a retry posted the sale twice. Now
`UNIQUE(firm_id, client_ref)`: the till mints one UUID per attempt, keeps it
across a reload, and a repeat returns the invoice already written with 200.

```
invoices 10 → 11   (same client_ref posted three times)
  attempt 1: 200 id=11 INV-000011
  attempt 2: 200 id=11 INV-000011
  attempt 3: 200 id=11 INV-000011
```

A different ref still posts a new sale; a client that sends no ref still
works, so nothing existing breaks.

## Failed reads no longer claim the books are empty

Twelve pages answered a dead request with "No invoices yet" and
`STOCK VALUE AT COST Sh 0`. Loading, genuinely-empty and failed are now three
distinct states, routed through one helper so the thirteenth page cannot get
it wrong. A figure that came out of a failed read is suppressed, not shown as
zero — that zero was the dangerous part.

## Colour is no longer the only signal

Making green/amber/red carry owed-vs-overdue was a **WCAG 1.4.1 regression I
introduced**. Overdue now also carries a rule and the word; bar segments carry
hatching and hairlines; the ageing ramp is monotone in luminance so it reads
pale-to-dark with the hue removed. Verified by injecting `grayscale(1)` and
confirming an overdue balance is still distinguishable from a current one.

Every money class was measured, not eyeballed. Nine were below AA; all are now
≥4.5:1 in both themes, including three shared tokens (`--faint`, `--good`,
`--warnc`) whose consumers were checked before moving.

## Scale — measured for the first time

**Speed is not the problem.** At 6,000 invoices and ~110,000 rows the slowest
endpoint is 153ms (books integrity); the dashboard is 64ms, a full sale
summary 91ms.

**Volume is.** `?limit=` was ignored entirely unless `?page=` was also
present, so a caller asking for 50 rows received 500 — and 500 was a silent
truncation. A shop with 6,000 invoices was handed 500 of them with nothing to
say the other 5,500 existed. A quiet truncation reads as "this is all of it",
which is the worst answer a books system can give. The limit is now honoured
and truncation announces itself in `X-Result-Truncated`, leaving the
bare-array body unchanged so no screen breaks.

### The finding I did not fix — **and my diagnosis was wrong**

> The text below is what I originally reported. **It is incorrect.** I have left
> it in place rather than quietly editing it, because the correction is the more
> useful thing to read. See round ten.
>
> *"sql.js holds the entire database in WASM memory, and it dies. Seeding a
> realistic two-year shop failed at roughly 8,000 invoices. For a shop ringing
> 30 sales a day that ceiling is somewhere around one to two years of trading,
> after which the app stops being able to open its own books."*

What actually happened: sql.js 1.14's `Database.exec()` does a `stackAlloc(4)`
for its `pzTail` out-parameter and never restores the stack pointer, so every
call permanently eats 16 bytes of the 5 MB Emscripten stack. `db.js` called it
after every write to read `last_insert_rowid()`. The ceiling was a fixed budget
of ~328,000 *writes*, not a limit on data — it applied to an empty database
exactly as much as a full one.

The real answer is roughly **45 years of trading**, not one. Full diagnosis and
measurements in round ten below.

`backend/seed-large.js` is committed so this is reproducible:
`GENIUS_DB_PATH=/tmp/big.db node seed-large.js --invoices=6000`. It refuses to
touch the shipped database.

## Still not done

- **`e2e/specs/concurrency.spec.mjs` was never written.** Two tills selling the
  same item at the same moment remains untested, and given the debounced
  persist I would not assume it is safe. This is the largest remaining gap.
- **`e2e/specs/scale.spec.mjs`** — scale was measured by hand, not locked into
  the suite, so a regression here would not be caught.

---

# Round ten — concurrency, and a wrong diagnosis corrected

Commit `0b29b6f`. The last two gaps, and a retraction.

## I got the scale ceiling wrong

I reported that this app could not hold more than about 8,000 invoices — one to
two years of a small shop's trading — and framed it as an architecture decision
about sql.js. That was wrong, and the way it was wrong is worth stating.

`sql.js` 1.14's `Database.exec()` allocates four bytes of Emscripten stack for
its `pzTail` out-parameter and **never restores the stack pointer**. Every call
permanently consumes 16 bytes of a 5 MB stack. 5,242,880 / 16 = 327,680 — and
on a brand-new, completely **empty** in-memory database, `db.exec("SELECT 1")`
in a bare loop dies on call **328,905**. `database/db.js` called `exec()` after
every single write, to read `last_insert_rowid()`.

So the limit was a fixed budget of writes per process. It had nothing to do with
how much data was stored.

Bisection:

| what | result |
|---|---|
| 2,000,000 inserts via `db.run` only | survives, RSS 251 MB |
| 1,000,000 inserts via `run` + `prepare/step/free` | survives |
| 1,000,000 inserts via `run` + `db.exec` | **dies at ~300,000** |
| `db.exec("SELECT 1")`, no data at all | **dies at 328,905** |

The evidence that should have stopped me: RSS at the moment of death was 172 MB
against a heap growable to 2 GB, the failing statement was an ordinary `INSERT`
unrelated to the data, and the seed already committed every 500 rows with no
effect. I had "out of bounds" and a big database in front of me and let the
second explain the first.

Fixed by replacing `exec` with `prepare/step/free`. Measured after, end to end
against the real server and real endpoints:

| invoices | rows | file | opens in | worst endpoint |
|---|---|---|---|---|
| 20,000 | 380k | 32 MB | 0.6s | 1.3s |
| 100,000 | 1.9M | 169 MB | 1.9s | 2.2s |
| 300,000 | 5.6M | 486 MB | 12s | 5.7s |
| 500,000 | 9.3M | 989 MB | 20s | 11s |

**In shop terms: about 45 years at 30 sales a day**, not one. A real ceiling
still exists at the 2 GB wasm heap, but it is now a warning from 600 MB with a
message a shopkeeper can act on, and a wasm trap becomes an explanation instead
of a crash.

Ten indexes came out of the same work — found by timing endpoints, not by
reading the schema. Correlated subqueries key on the child column alone
(`WHERE s.party_id = p.id`), so the existing composite `(firm_id, party_id)`
indexes could not serve them and SQLite scanned a whole table per parent row.
`/accounting/integrity` went **220s → 5.7s** and stock summary **42s → 0.4s**
at 300,000 invoices, for 14% more file.

Report bodies are now bounded at 5,000 rows using the `X-Result-Truncated`
convention. No figure changes — each report still queries the whole period and
computes its totals from all of it; only the row listing is cut, and `?limit=`
raises it to 100,000 for a genuine export. A 64 MB sale-summary body becomes
1.06 MB.

## Concurrency — four real defects

Two tills is the normal case for a shop and had never been tested.

| Race | Before | Now |
|---|---|---|
| `persist()` while a transaction is open | **Data lost.** `db.export()` closes and reopens the handle, and closing discards the open transaction: a row inserted inside `BEGIN` vanished from disk *and* memory, and `COMMIT` threw "no transaction is active". Reachable from the 3s save ceiling firing inside `query()` | `persist()` defers while `txnDepth > 0`; commit flushes |
| `PRAGMA foreign_keys` after a save | **Silently 0 forever.** The reopen reset it, so integrity enforcement lasted until the first write to disk, and an orphan child row was then accepted | Re-applied after every export |
| SIGKILL right after the server acks | Sales 10/10 survived. **Held bills 0/10** — a parked bill acked and killed at 0ms was simply gone | 10/10 at zero grace; held bills and voids commit in a transaction |
| Two tills on one held bill | **Both** could resume it and **both** deletes returned "Held bill removed". Table 4's order rung up twice, neither cashier told | Atomic claim; the loser gets 409 |

Oversell was already safe — 30 concurrent sales of 5 against 100 on hand gave 20
accepted, 10 refused, on-hand 0 — but safe *by luck*: no money-moving handler
awaits real I/O between `BEGIN` and `COMMIT`, so Node cannot interleave two
sales. That is one `await fs.readFile` away from being false, so it is now a
property of the storage layer: a write mutex on `pool.getConnection()`, free
when uncontended, with a 30s watchdog rather than a wedge.
`UNIQUE(firm_id, invoice_no)` and `UNIQUE(firm_id, payment_no)` mean a future
`MAX()+1` shortcut is refused by the database rather than discovered in an
audit.

## Still open, honestly

- **Sub-turn durability.** Writes that go through `commit()` — sales, held
  bills, voids — are on disk before the client is told. Settings, item edits and
  party edits still ride the end-of-turn flush and could be lost to a power cut
  in that window. The fix is to wrap them in transactions, module by module.
- **Two browsers signed in as the same user** can both claim one held bill. The
  server cannot tell them apart without a per-session id.
- **`persist()` exports the whole database on every commit** — about a second at
  989 MB. That is now the dominant per-sale cost at extreme size, and an
  incremental save is a durability-architecture change, not a scale bug.

## The pattern worth keeping

Three times this session a confident diagnosis was wrong and only measurement
caught it: the stale-Sales cache header, the rail contrast that looked fine, and
this ceiling. Each time the wrong answer was plausible and the right one was
one experiment away.

---

# Round eleven — durability of ordinary writes

Commit `8487034`. The two items round ten left open.

## A write the user was told had saved could still be lost

`db.js` persists synchronously on `commit()`, so anything inside a transaction
is on disk before the client hears "saved". A bare `query()` write is not — it
rides an end-of-turn flush that runs *after* the response has gone to the
socket. Sales, held bills and voids were transactional. Settings, item edits,
party edits and most of the rest were not.

**105 mutating handlers audited. 29 already safe, 70 wrapped, 6 deliberately
left.** Measured against the pre-change backend, killing the server the instant
the 200 arrived and reading the file straight off disk with sql.js:

| write | on disk at ack, before | after |
|---|---|---|
| item edit | **lost** | present |
| party edit | **lost** | present |
| purchase order + 2 lines | **lost** | present, both lines |
| settings change | raced — sometimes flushed in time | present, deterministically |

Three of four acknowledged writes were provably not on disk at the moment the
client was told they were. The refused order leaves nothing behind, before and
after.

The six left alone: three filesystem operations (update, restore, restore-file)
where a database transaction would be the wrong tool, and two recurring-runner
routes that delegate to the real sale and purchase handlers — those take the
write lock themselves and the lock is not re-entrant, so wrapping them would
deadlock a till against itself.

One addition to the borrowed idiom: a handler that answers itself with a
validation failure now **rolls back**, so `return res.fail(...)` can never leave
a partial write behind.

## Nine atomicity bugs found on the way

Distinct from durability — these were half-writable on an error, and would have
stayed that way:

- `POST /installments` wrote the plan, then could fail on the timetable — a plan
  whose schedule does not add up to the invoice it belongs to.
- **BOM create/update** and **recurring create/update** both delete-then-reinsert
  their lines. A failure mid-loop left a recipe with **no components at all**,
  which then costs and produces the wrong thing on the next run; or a schedule
  that bills an empty invoice every period.
- Purchase orders and stock takes could write a header with no lines.
- `PUT /items/:id` could change an item with no audit row; `DELETE` could remove
  the barcodes and stock and leave the item on the shelf.
- Deleting a price list left parties pointing at it; an accounting account could
  be created without its opening balance, or deleted leaving the balance row
  orphaned; `PUT /users/:id` could change a password without the role change
  beside it.

## Two tills on one login

The held-bill claim was keyed on user id, and deliberately let the same user
re-claim so a retry would not fight itself. A shop that signs both counters into
one account therefore had two cashiers resume the same parked bill and both
delete it — one table's order rung up twice, neither cashier told.

The claim now identifies the **till**, not the login. The browser mints an
`X-Client-Id` per tab and sends it on every request. `sessionStorage`, not
`localStorage`, and that distinction is the whole fix: `localStorage` is shared
between tabs of one origin, which is exactly the case being told apart. An
absent header keeps the previous behaviour, so an older client is not locked out
of its own bills.

## Also

A dead second `DELETE /stock-takes/:id` removed. Express matched the earlier
registration so it had never run, but it read as authoritative while being the
older version — two bare `query()` calls outside a transaction, where a failure
between them would have orphaned every line of the count while the client was
told "Count discarded". Two handlers for one route is itself the bug, so it went
rather than being repaired.

## What is left

- **`persist()` exports the whole database on every commit** — about a second at
  989 MB, negligible at realistic sizes (40ms at 18 MB). Now the dominant
  per-sale cost at extreme scale. An incremental or WAL-style save is a
  durability-architecture change, not a bug fix, and should be a deliberate
  decision rather than something slipped in.
- **`POST /system/update`** writes its audit row with a bare `query()`. It is a
  filesystem operation that ends by demanding a restart, and the exit handler
  flushes; wrapping the unzip in a transaction is worse than the risk.
- **Physical thermal hardware** and **Electron packaging** remain the two things
  this environment cannot exercise at all.

Tests: 34 unit + 253 browser assertions across eight specs.

---

# Round twelve — backup and restore

Commit `d8bb389`. This is the feature where a bug destroys data rather than
misreporting it, and it had never been tested.

| Problem | Proved before | Now |
|---|---|---|
| **Restore destroyed other tenants** | Two firms in one file. Firm B created an item; firm A restored a backup taken seconds earlier. **Firm B's item count went 1 → 0**, silently, 200 OK | Whole-file restore refused (409) when the installation or the backup holds more than one firm. Preview says `restorable:false` with the reason, so the UI never offers a button that will be refused |
| **Restore raced every in-flight write** | Rewrote the file and reloaded with no lock and no `txnDepth` check — a sale committing at that moment either landed in a database that no longer existed or overwrote the restored file with the old one | Holds the write mutex throughout; `replaceDatabase()` cancels the pending flush, clears `dirty`, closes the old handle, re-applies pragmas |
| **No compatibility check** | An 8 KB SQLite file whose only table was `not_genius` previewed as "0 invoices, 0 parties" and **was accepted**. A corrupted Sajo file gave a raw 500 "database disk image is malformed" | Four staged checks before anything is touched: header, 14 identity tables, newer-schema detection, live-vs-backup column diff. Older backups are migrated forward, verified, and auto-rolled-back if still unusable |
| **The safety copy was clobbered** | One `genius.db.pre-restore`, overwritten each time — restore twice and the original was gone, with nothing in the UI to recover it | Timestamped, collision-suffixed, read-verified, last 10 kept, listed in the UI as restorable |
| **Base64 in a JSON body** | A 45 MB payload returned 413, rendered in production as *"Something went wrong. Reference: k3f9a2"* | Raw binary body; the Backup screen uploads the `File` directly. `server.js` turns a 413 into an explanation naming the limit and what to do |

## The multi-tenant decision

Refusal was chosen over firm-scoped row import, and the argument is written into
the header of `system.routes.js` so it can be overruled on its merits.

A firm-scoped import must delete and re-insert across 60 tables in dependency
order, renumber every primary key that collides with a surviving firm's rows,
and re-point every foreign key that referenced the old numbers — including the
ones this schema does not declare. Each is a chance to leave one shop's books
pointing at another shop's rows, and the failure is **silent**: an invoice line
pointing at the wrong item still renders. Putting that much machinery inside the
button people press when everything has already gone wrong makes restore a worse
last line of defence, not a better one.

Real shops run one firm, and that case is now airtight. If per-firm restore is a
shipping requirement it should be built as a per-firm export/import with its own
tests, not bolted onto the recovery path.

## Found without being asked

- **No record of a restore existed anywhere** — not who, when, or from what. Now
  written to `audit_logs` *and* appended to `data/restore-history.log`. The file
  matters: a row written into the restored database is destroyed by the *next*
  restore.
- **`autoBackup()` could copy a stale file.** `persist()` declines to export
  while a transaction is open, so the daily copy could silently be missing every
  write made since that transaction began — a backup a day older than it claimed
  to be, with nothing said. It now takes the write lock, then opens the copy and
  reads it back; an unreadable copy is deleted and logged loudly rather than left
  in the list looking like something to fall back on.
- **Downloads were never verified.** `/backup` now proves the snapshot opens and
  reads before sending it.

## Suggested, not done

- **Backups still all sit on the same disk as the live data.** The screen says so
  plainly, and `/backup` gives a one-click copy off the machine, but nothing
  pushes one automatically. A scheduled copy to a USB drive or a network path is
  the single biggest remaining improvement to this feature, and it is a feature
  rather than a hardening fix.
- **No "your last downloaded backup was 40 days ago" nudge.** The server cannot
  know — the download is a stream with no record. It would need a downloads log.
- **Verification degrades above 256 MB** to header-and-length, because a full
  open doubles the file in the wasm heap and would itself be the thing that kills
  a large shop's backup. Verifying in a child process would be strictly better.
- **A restore cannot be undone from the UI beyond the ten kept safety copies.**
  That is probably enough, but it is a limit worth knowing.

Tests: 34 unit + 309 browser assertions across eleven specs.

---

# Round thirteen — a copy that is not on this machine

The last round ended with a suggestion rather than a fix: *every backup this app
made sat on the same disk as the live database.* `backups/auto-2026-08-18.db`
beside `data/genius.db`. A dead drive, a stolen laptop, a ransomware run or a
spilt drink took the books and all seven copies of them in the same second. The
screen was honest about it and offered a download, but a download is a thing
somebody has to remember, and the point of a backup is that it does not depend
on anyone remembering.

So: **one folder, configured once, that the app copies to by itself.** From
Node's point of view a USB stick and a folder on another machine on the shop LAN
are the same thing — a directory path — so there is no cloud account, no
credentials and no new dependency. Four settings (`offsite_enabled`,
`offsite_path`, `offsite_keep`, `offsite_warn_days`), three routes, one card on
Settings → Backup.

What the work actually consists of is not the copy. It is a set of decisions
about a destination that is usually **not there**.

## The cadence is 15 minutes, deliberately not 24 hours

The local backup runs at boot and every 24 hours. That is right for a
destination that is always present. **A USB stick is present for the ten minutes
somebody has it in the machine**, and a daily timer misses those ten minutes for
weeks on end.

So a copy is *attempted* every 15 minutes and at boot, and *taken* at most once
per calendar day per destination. An attempt that finds nothing plugged in costs
one `fs.access` and stops. Plug the stick in over lunch and the day's copy is on
it before it comes out again. The same rule answers "the shop was closed for a
week": the destination is checked within seconds of the next boot, not 24 hours
later.

## "Not there" and "not there for weeks" are different sentences

The stick is unplugged most of the time. Treating that as a failure writes 96
errors a day and teaches everybody to ignore the log. It is a silent skip, and
it does not touch the local backup.

The one case where absence *is* an error: **a destination nothing has ever
landed on.** A path that has never once worked is a typo — a wrong drive letter,
a share name misspelt — and saying "not connected at the moment" about it would
hide that mistake forever. Once a copy has landed at that exact path, the same
`ENOENT` means the stick is out. The rule is a single question: has anything
ever been written here?

Separately, and regardless of reason, the **age of the last successful copy**
drives how loud the screen is: fine, uneasy after `offsite_warn_days` (7 by
default), alarmed after 21. Eighteen days of "not plugged in" is eighteen days
with no insurance.

## The copy itself

- **The write lock is never held across the USB write.** The copy source is
  today's local `auto-*.db`, which was already taken under the lock and already
  read-back-verified. A slow stick therefore cannot block a sale.
- **Written to a temp name, opened and read back *where it landed*, then
  renamed.** An unreadable file on a stick is worse than no file, because it
  looks like insurance.
- **Free space is checked and old copies pruned before writing**, so a nearly
  full 4 GB stick prunes rather than half-writes.
- **A path inside the app's own data directory is refused.** That is not
  off-site.
- **State lives in `data/offsite-state.json`, outside the database on purpose** —
  same reasoning as `restore-history.log`. "Is anything of mine anywhere else?"
  is asked most urgently when the database is the thing that has gone wrong.

## Nine failure modes, nine sentences

Each gets something a shopkeeper can act on rather than an errno. A full drive
names the numbers. `EROFS` mentions the little lock switch on the side of the
stick. `EACCES` on a share explains that the other computer has to allow
writing and not just reading.

## Found while doing it

`backup.service.js` contained a **literal NUL byte** in the SQLite magic string
instead of the `\0` escape. Functionally identical and quietly corrosive: one
NUL makes the whole file "binary" to grep, so `grep -rn` across the backend
silently skipped the entire module. Several passes in this report relied on
exactly that kind of sweep to prove a call site dead — and a file that cannot be
searched is one those sweeps lie about. `file` now reports it as JavaScript
source.

## Limits worth knowing

- Real USB removal *mid-write* is not simulated in tests; the temp-and-rename
  means the worst case is a leftover `.genius-offsite-tmp-*` file, which is pruned.
- Windows UNC paths and drive-letter semantics are handled as plain paths and
  have not been tested on Windows.
- `fs.statfsSync` on some network shares reports the *server's* free space, or
  fails; a failure is treated as "space unknown, proceed".
- FAT32 cannot hold a file over 4 GB. A database that large would fail the copy
  with the disk-full message, which is misleading.
- **Two machines writing backups to one share** will each prune the other's
  copies, because pruning is by prefix and count. One destination per machine,
  or one subfolder each.

Tests: 34 unit + **347 browser assertions across twelve specs**.
`e2e/specs/offsite.spec.mjs` (38) uses temp directories and simulates the stick
being pulled by renaming the destination. Full, read-only, permission-denied and
EIO cannot be produced by a filesystem in CI, so those run the shipped
`copyOffsite()` in a child process with `fs.statfsSync` or `fs.copyFileSync`
replaced — real code, stand-in disk.

---

# Round fourteen — the screens you photographed

Eleven photographs of the app running on a laptop, and a list. Everything below
came from those. Each one is written up as what it actually was, not what it
looked like.

## Settings: the Modules header tore loose on scroll

`.dk-set` and `.dk-set-body` are both `flex: 1 1 0` with `min-height: 0`, so
their boxes stop at the height of the content viewport while their content is
half again as tall — measured at 1536x730, a **554px box holding 1124px** of
switches. The switches spill out and stay readable, so nothing looks wrong
until you scroll. A sticky element cannot leave its containing block, so past
scrollTop 554 the card header was dragged up with the bottom of that box:
measured **top 54px while the content viewport starts at 112px**, which is
behind the app header with the Save button sliced off. Exactly the photograph.

Both are now floored at `min-content`, the same floor the dashboard already
used. The page also gained a real sticky header, and the three sticky layers —
app bar, page header, card header — are on declared z-index tokens instead of
numbers chosen one at a time.

One thing found while looking: a stuck element rests at the top of the
scrollport's *content* box, so the 24px top padding left a band through which
rows scrolled *above* the pinned header. Closed with a background shadow.

## Reports: the date popover was clipped, not stacked

`.drp-panel` is absolutely positioned inside a card with `overflow: hidden` for
its rounded corners, sharpened to `overflow: auto hidden` by the wide-table
rule. Measured: the panel wanted **[290,353]-[782,811]**, the card allows
**[620,196]-[1494,690]** — the month header and three weekday columns off the
left, Cancel and Apply off the bottom. No z-index can fix clipping.

It is now fixed-positioned and anchored to its trigger. Worth recording:
**flipping is not enough.** A 449px panel at a trigger 306px down a 730px
window has 377px below and 299px above, so both flips overflow and the browser
keeps the first — forcing the flip gave `top: -150`. The fallback chain
therefore ends by shifting the panel against the window edge with its right
edge still on the trigger. Verified at three window sizes.

## The collapsed rail showed no icons

Every rail entry already had a glyph. The rule hiding the label existed **only
inside a `max-width: 1180px` media query**, so above that width the label
stayed, and with `overflow: hidden` and the icon first in a centred row the
icon was pushed out of its own button — Dashboard's svg measured **left -12 to
right 6 on a button spanning 12 to 64**. The label is now hidden under
`.rail-shut` at every width, and every icon sits centred within 1.5px.

## The till opened with somebody else's bill in it

Not a held bill, not a resumed shift, not a demo seed. A state initialiser
rehydrated `localStorage["vy_pos_cart"]`, and the restore was deliberate — a
power cut should not lose the bill. The reason it is dangerous is that
**localStorage belongs to the browser, not to the person signed into it.**
`clearSession()` removed the token but not the cart, so a bill outlived the
cashier, the shift and the customer.

Reproduced end to end before touching anything: admin rings up a line, the
session is cleared, `sales` signs in, opens the Till, and it reads `1 item -
1 qty`, `AMOUNT PAYABLE Sh 34,440.00`, with a green Take payment button. A
cashier who trusts that screen charges a stranger for a stranger's goods.

The till now always mounts empty. The saved bill is offered as a question —
who left it, when, every line, the total — with **Discard** and **Resume** and
no way to dismiss without answering, because a dismissal that left the bill on
disk would hand the trap to the next person. A bill from another user or
another day gets a warning band and Discard takes the focus. Discard clears the
idempotency key too, or the next unrelated sale looks to the server like a
retry of the discarded one. `clearSession()` now clears both keys as well.

## End of day ran off its own dialog

`.dk-denoms` used `grid-template-columns: repeat(4, 1fr)` over bare inputs.
`1fr` cannot resolve below a track's min-content, and a bare input's intrinsic
width is about 227px, so the grid came out **938px wide inside a 598px dialog**
with `overflow-x: hidden`. The last four note values were drawn off the right
edge, uncountable, at the one moment somebody is counting a drawer. Tracks are
now 129px at every tested size, horizontal overflow 0, and each label sits in
the same bordered box as its input so the two cannot separate.

## Sold by, on the cart

`sale_invoices.sales_rep_id` existed, the API accepted it, and three reports
already grouped by it. The only picker was on the payment screen behind
`require_sales_rep`, which most shops leave off — so every sale was credited to
whoever was signed in, and commission worked out from that is wrong for
everybody. There is now a **Sold by** row on the cart, F4, defaulting to the
signed-in user, with an explicit option for an admin who is not in the rep list
and would previously have gone up unattributed. No migration was needed.

## Documents get the whole screen

Record Purchase was a modal forced to `height: 100vh` inside a backdrop with
`padding: 40px 24px`, so the dialog was **80px taller than the slot it was
being centred in** and the bottom 40px — the Total row and the Save button —
was drawn below the window. Nothing could scroll to it, because the overflow
belonged to the backdrop rather than the dialog.

`lib/docshell.jsx` never centres and never inherits a height: fixed `inset: 0`,
a three-row grid, and **only the middle row scrolls**, so the total lives in a
sibling of the scrollport. That is the difference between "on screen once you
scroll" and "on screen". On a thirteen-line purchase the Save button measures
714-756 of 768.

Seven documents now share it — purchase, purchase order, debit note, estimate,
credit note, delivery challan, expenses — along with one item table replacing
five. The estimate, credit note and challan had bare `<select>`s listing every
item in insertion order; they get the searchable combo, the bulk picker and the
unit flip like everything else.

Found while converting:

- **New debit note opened a blank screen.** It carried a copy-pasted
  extra-costs block referencing state that exists only in the purchase form,
  and threw on render.
- **No debit note in this app was ever filed against a bill.** `bill_id` was
  never sent. It is now, with line prefill from the original purchase.
- **There was no purchase order editor at all** — orders could only appear from
  the reorder suggestions.
- **Purchases had no due date**, so every credit bill read as overdue the day
  it was keyed. **Expenses were all stamped today** whatever date was meant.

Driver and return-by on a challan have no columns, so they are composed into
the notes that print on the paper the driver carries. Real columns need a
migration and are reported rather than invented.

## Every report printed blank in dark mode

The report was "some report prints come out blank". All **58** did, in dark
mode. None did in light, which is why it looked intermittent.

Nothing was hidden and nothing threw. The page went to the printer still
carrying the dark theme's text colour, `#E7EAF0`, measured at **1.18:1 against
white paper**. The browser drops the dark background when printing but keeps
the text colour, so the paper stayed white and the figures came out as ghost
grey — while the table rules, drawn dark for a dark screen, printed perfectly.
That is precisely the photographed Cash flow page: DATE, DESCRIPTION, ACCOUNT,
IN, OUT, RUNNING, ruled and empty, with the occasional value showing through
wherever it happened to be painted in a semantic red or green.

The audit is worth describing, because one half of it would have passed all 58.
Each report was printed through Chromium's real print pipeline and the bytes
read back as text and as rasterised pages; and separately the print stylesheet
was applied to the live DOM so the contrast of every text element against white
could be computed. **A blank print is a valid PDF full of characters** — text
extraction alone proves nothing. Before: 58 of 58 faint, worst 1.18:1. After: 0
of 58. The darkest glyph pixel on the rendered Cash flow page went from
`(165,167,170)` to `(79,79,79)`.

Two reports were also blank for a plainer reason — they queried tables nothing
writes to:

- **Quote Details** read `sale_invoices` for `doc_type IN ('estimate',
  'sale_order')`. Estimates live in their own table and the sales route
  hardcodes `'invoice'`, so it matched nothing, ever.
- **Drawer cash entries** never read `cash_movements` — the table the till's
  Cash in and Cash out buttons fill, and the only place the reason is kept.

Headline figures no longer animate into a print. A print started mid-climb put
whatever frame it was on onto the paper: a day's takings stated as some number
on the way to the real one, which does not look like an artefact, it looks like
a figure.

One thing not resolved: six long reports intermittently produced a print
document that stopped after the first page of rows while the header kept
repeating. It does not reproduce outside the test harness — the same page
printed forty times in a row was complete every time — so it is most likely a
race in the capture rather than in the app. The guard prints up to three times
and fails only if rows are missing every time. If a shop reports long reports
losing their tail, this is the first place to look.

## Cash and bank, as tiles

It was a table with a tab per account, which grew a tab every time somebody
opened a till float and pushed "Payments and expenses" off a 1366px row. It is
now the layout from the reference screenshot: a section header with the total,
and a wrapping grid of tiles — balance, what the account opened at, where it
closed today, and whether money went in or out, in words as well as colour.

There is no daily snapshot table, so the opening figure is reconstructed by
unwinding today's journal lines. The **stored** balance is used as the close and
the **derived** figure as the opening, deliberately that way round, so the big
number on the tile always agrees with the rest of the app and any error in the
reconstruction lands on the number carrying less weight.

Cash versus bank was a guess from the account name, because
`chart_of_accounts` had one flag and no way to say which. There is now a `kind`
column, offered in the account editor. It is **not backfilled**: writing the
guess into the data would freeze the name rule's mistakes, and "Cash at
Stanbic" is not a till.

## What a payment settles

The form said "Money is applied to this party's oldest open invoices first" and
then showed a single figure — "Settles Sh 0.00 of invoices" — which is not even
the amount received once tax is withheld.

It now shows the plan: every open invoice this payment will touch, in the order
the server will touch them, what each takes, whether it clears or is left part
paid, and what remains as an advance. The preview walks **the same SELECT the
allocator runs**, so it cannot promise something the save will not do. The old
single bottom line collapsed five different numbers into one; received, tax
withheld, bank charges, what clears invoices, what stays as an advance and what
actually lands in the account are each now named.

Two things worth knowing. The allocator sorts by **id**, not by date; the
preview mirrors that exactly rather than quietly correcting it, because a
preview that sorts differently from the save is worse than no preview — but a
back-dated invoice entered late is not the oldest by id while the screen says
"oldest first". And the preview is a snapshot: if another till takes a payment
from the same customer in between, the server allocates against the newer
balances and the screen's promise is stale. The server is authoritative and the
toast reports the real figures.

## The ⋮ menu that was never styled

A shopkeeper photographed the Items screen with a row menu open. What came out
of the ⋮ was not a menu. It was six or seven **loose beige rectangles**,
staircased down and across the screen, each with a bevelled edge, none of them
touching the app's colours: "Edit item", "Repack into smaller unit", "Stock
ledger", "Print barcode label", "Mark inactive", "Delete item". The Sales list
did the same thing with View / Edit / Print / Send on WhatsApp / Duplicate /
Void this sale. It did not look badly styled. It looked broken.

## What it actually was

Not a missing stylesheet, not a renamed class, not the dead `styles.css` layer.
Measured in Chromium, with the menu open on Items:

```
panel  .dk-rowmenu   224×140  background rgb(255,255,255)  border 1px   ← styled
child  BUTTON        68×21    background rgb(239,239,239)  border 2px outset
                              appearance: auto   display: inline-block   ← not styled
```

`deck.css` had a rule for `.dk-rowmenu` — surface, border, radius, shadow,
padding — and **no rule at all for the buttons inside it**, in that file or in
`styles.css`. So every option fell back to the browser's default button:
ButtonFace beige, a 2px outset bevel, and `display: inline-block`. Inline-block
boxes flow like words. "Edit item" (68px) and "Adjust stock" (88px) fitted on
one line together, "Repack into smaller unit" (158px) took the next by itself,
and each following option started wherever the last one ended. That is the
staircase, exactly: not one element per box by design, but one line-box per
wrap. The `<div className="rule" />` separators measured 0px tall for the same
reason.

The staircase was the visible half. The other half: `.dk-rowmenu` was
`position: absolute` inside the table cell, so the last rows of a long list
opened their menu into the card's `overflow: hidden` — the clipping trap
written up at C4.4 for the Reports date popover in the previous round.

It has been like this since the baseline commit; `git log -S "dk-rowmenu
button"` finds nothing, because that rule was never written.

## Every row menu, counted

Found by grep rather than memory: **19 row menus in 12 files**.

Six were the broken `.dk-rowmenu`: Items → the product/service list, Items →
Categories, Sales → Invoices, Sales → Estimates & orders, Purchases → Bills,
Purchases → Purchase orders. Thirteen were already on `RowDots` in
`styles.css`, which was portalled and themed and therefore looked fine: Items'
stock-ledger movements, Staff, Warranty (×2), Money (×3), Offers, Manufacturing,
Recurring, Instalments (×2), Settings → update history. Two menus that are *not*
row menus and were left alone: the Items toolbar ⋯ (Zoho-style, with submenus)
and the till's unit-flip chip.

Two implementations of one control is how one of them ends up unstyled. There is
now one: `src/lib/rowmenu.jsx` with `.dkm-*` in deck.css. `.rd-*` and
`.dk-rowmenu` are deleted.

## What the shared menu does

- **One panel, options as rows.** `all: unset` on the row rather than a pile of
  individual resets, so no future UA default can come back through.
- **`position: fixed`, portalled to `<body>`.** No ancestor's overflow can clip
  it. Placement is measured in JavaScript — the panel's real height, not the
  `rows × 40 + 12` guess the old `RowDots` used, which is wrong the moment an
  option wraps. Below the trigger if it fits; flipped above if not; pinned to
  the roomier edge with internal scrolling if neither side fits; and shifted —
  not flipped — back inside the window horizontally, because a menu whose
  trigger is at the right edge of a table has no room on either side of it.
  The date popover solved the same problem with CSS anchor positioning and
  therefore does not flip in Firefox; this one is placed in script and behaves
  the same everywhere.
- **Closes** on Escape, on an outside mousedown, on scroll and on resize.
  Scroll closes rather than re-places: a fixed panel left behind by a scrolling
  table points at a different row than the one it will act on.
- **Keyboard**: arrows with wrap-around, Home/End, Enter/Space, Tab closes,
  Escape closes and returns focus to the ⋮ button it came from. `role="menu"` /
  `role="menuitem"`, `aria-haspopup`, `aria-expanded`, and an `aria-label`
  naming the row ("Actions for INV-000006") instead of twelve buttons all
  called "Actions".
- **Destructive options carry the word "destructive"** next to the label, not
  only the red. WCAG 1.4.1 — a colour is not a message to somebody who cannot
  see that colour.
- Measured contrast in the panel: option text **17.9:1** light / **14.7:1**
  dark, destructive text **5.06:1** / **6.14:1**, the destructive flag
  **5.10:1** / **5.07:1**.

Nothing was dropped. Every option, including the ones behind a permission check
or a document's state, is in the new list, and the spec compares each menu's
options item by item against the list the old markup produced.

## Three smaller things, finished

- **One expense form.** `ExpenseForm` (the full-screen editor on Purchases) is
  exported, and Cash & bank uses it. Its own four-field dialog is deleted. That
  dialog had no date — so last week's rent landed in this week's figures — no
  supplier, no tax and no account the money came out of. There was one call
  site, not two.
- **Wallet and bank glyphs** are in `lib/icons.jsx` at the same 24×24 geometry
  as the rest (the exact paths Money.jsx was drawing inline, so nothing on
  screen moves), and `AcctIcon` is now two lines.
- **`chart_of_accounts.kind`** ('cash' / 'bank'), added through the guarded
  ALTER list, offered in the account editor when "this is a cash / bank
  account" is ticked, and preferred by `kindOf()` in money.routes.js.
  **Deliberately not backfilled.** The column arrives NULL and the old name
  regex still decides for those rows, so every account in an existing database
  groups exactly as it did the day before the upgrade. Backfilling from that
  same regex would have frozen its mistakes — "Cash at Stanbic" filed in the
  till drawer — into stored data where nothing would question them again.
  Unticking "holds money" clears the kind with it.

## Tested

`e2e/specs/rowmenus.spec.mjs` — **235 assertions**. Every menu reachable in the
seeded database (10 of 11; Purchases ships empty, so the spec rings up a bill
and an order through the real routes first) opened in a real browser in **both
themes at 1366×768 and 1920×1080**: option list identical item by item, one
panel with rows in it and no `appearance: auto` anywhere, the whole box measured
inside the viewport, all four corners hit-testing to the panel itself. Plus the
last row of a long table (trigger at y=740 of 768; panel placed 462–734, flipped
above), a trigger at the right edge of a 900px window, the keyboard walk,
Escape, outside click, scroll, focus return, and an action actually running.

`cashbank.spec.mjs` gains the migration test: the suite already runs against a
**copy of the shipped `backend/data/genius.db`**, so `kind` is added to a book
with real accounts in it. Asserted: the column arrives NULL on every existing
account, every one of them groups as it did before, and two new accounts saved
with a stored kind — "Stanbic current account" as bank, "Front counter" as cash
— group by what was stored rather than by their names.

## Limits worth knowing

- Firefox and Safari are not in the harness. The placement is plain
  `getBoundingClientRect` arithmetic with no anchor positioning, so it should
  behave identically, but "should" is the honest word.
- Warranty, Offers and Manufacturing are switched off by module flags in this
  database, and Settings → update history is empty, so four of the nineteen
  menus were converted and built but never opened in a browser. They take the
  same props through the same component as the ten that were.
- The menu does not re-place itself on scroll, it closes. On a trackpad that
  can feel abrupt.
- Nested / submenu row actions are not supported. Nothing needs them; the Items
  toolbar ⋯ that does have submenus is a different control and was left alone.

# Round fifteen — the sticky header was the wrong idea, not a broken one

## Settings: the pinned header hid the control you were reading

Round fourteen pinned the Modules head card so Save was always in reach, and
asserted that it stayed inside the content viewport. It did. It also sat on top
of the switches scrolling underneath it, which is what the next photograph
showed: the "Services & Products" select with its top half sliced off by an
opaque band. The geometry assertion passed on a screen anyone could see was
wrong, because it asked where the header was and never what was under it.

Reproduced first, at 1366x768: at scrollTop 133 the select's own top edge
hit-tests to `.dk-card.pad.dk-stickhead`. Across the thirteen Settings
sections, two themes, two window sizes and four scroll positions each, **132
controls** were partly covered.

A sticky bar does not merely overlap — it overlaps *unrecoverably*, since it
travels with the scroll. That is the difference between this and content
passing under the app bar, which one flick of the wheel undoes. So the header
is an ordinary card again and Discard/Save moved to `.dk-dock`, a bar rendered
as a **sibling of `.dk-content`** rather than a child. Being outside the
scrollport it shortens the scroll area instead of covering it, and it only
exists while there is unsaved work.

Rejected: a plain header with no dock (fixes the covering, sends you back up a
1100px page to save); sticky header plus `scroll-padding-top` (that only
governs where *programmatic* scrolling rests — a wheel still parks a control
under the band, which is how the user got there).

## The dialogs had the same fault

`.dk-modal` and `.dk-formbox` scrolled as a whole with `position: sticky` head
and foot, so in the item editor "Opening stock" came to rest half under the
Save row. Both are now frames — head, scrolling middle, foot — with the bars
outside the scrollport. Nothing else in the app pins a bar over scrolling
content; a sweep of every rail destination at three scroll positions found no
other case.

## The test is the real fix

`chrome.spec.mjs` gained `coveredControls()`: for every focusable control it
hit-tests the control's own top and bottom edges with `elementFromPoint` and
fails if the answer belongs to a sticky or fixed subtree. Two exclusions, both
deliberate — a point outside the control's own scroll container is skipped
(clipping is recoverable, pinning is not), and while a dialog is open only its
own controls count.

It reports **132 covered controls on the pre-change build and 0 after**, over
208 section/theme/window/scroll combinations.

# Round sixteen — money that says what it settles and where it landed

Four requests, one fault underneath all of them: a payment could be recorded
without saying **what it paid** or **where it went**, so both answers were
guessed on the shopkeeper's behalf, and both guesses were often wrong.

## The allocator was three copies of a rule about money

`GET /payments/open`, `POST /payments` and `POST /payments/:id/confirm` each
carried their own `balance_due > 0 ORDER BY id` loop, with a comment in one of
them asking whoever changed it to remember the other two. That is not a coding
style, it is three chances for the screen to promise one thing and the books to
record another. They are now one module, `backend/modules/payments/allocate.js`.

**Oldest first now means oldest by date.** `ORDER BY id` and "oldest" are the
same thing only when documents are keyed in the order they were written, and
the case that breaks it is ordinary: a delivery note found in a drawer and
entered today has the *highest* id and the *earliest* date. Sorting is now
`document date, then id` — id kept as the tiebreak so two documents dated the
same day still have one settled order. Because the preview and the save call
the same function, they cannot drift; the spec proves the ordering by creating
the back-dated invoice **second**, so its id is higher, and asserting it comes
back first.

## Choosing the invoices, and the guards on doing so

`POST /payments` now accepts `allocations: [{ doc_id, amount }]`. Automatic
stays the default and is what an untouched form posts — the client sends no
allocations at all, so there is exactly one implementation of oldest-first.

Everything about the explicit path is a **refusal, never a correction**. Silently
trimming an over-application, or quietly merging a doubled line, would post a
payment that does not match the screen the operator pressed Save on, and they
would have no reason to check. Refused, with the reason: an amount larger than
the invoice's balance; the same invoice listed twice; allocations summing past
what the payment settles; a document that is not that party's open business.
Under-allocating **is** allowed — a customer may pay for one invoice and leave
the rest on account — and the remainder is named as an advance rather than
spilled onto invoices nobody chose. A balance that moved between preview and
save (another till took money from the same customer) is re-checked inside the
transaction and refused as a 409 with the new figure, not as an anonymised 500.

On the form: an **Automatic / Choose invoices myself** pair, the override stated
in words inside the panel and again in the footer, a per-invoice amount box with
a "Pay all" shortcut, and the same refusals applied before the round trip.

## Receive payment, from the invoice's own row menu

Sales → ⋮ now offers **Receive payment**, opening the payment editor with the
customer filled in, the amount defaulted to *that* invoice's balance, and the
allocation switched to manual on that invoice alone.

It is **shown disabled with the reason**, not hidden, on a paid invoice
("Paid in full — nothing outstanding"), a voided one, and a walk-in cash sale
with no customer account. A menu whose options appear and disappear from row to
row cannot be learnt: the cashier who used it a moment ago looks for it here and
concludes the app is broken. The reason is also the answer they need.

## Every screen that takes money, audited

Nine, and the list is the deliverable — three of them already had a picker, so
"fix the ones I remember" would have missed the rest.

| Screen | Before | Now |
|---|---|---|
| Till → Take payment | **no picker at all** — every card and MoMo sale posted to Cash in Hand | picker; drawer for cash, follows the mode otherwise |
| Invoice builder → payment | picker, defaulting to code 1001 | shared picker, defaults to last used |
| Payment record form (Cash & bank / Parties / Instalments) | picker | shared picker, defaults to last used |
| Purchase bill → Paid from | picker, hidden unless 2+ accounts | shared picker, always shown when money moves |
| Expense (Purchases and Cash & bank — one form) | picker, hidden unless 2+ accounts | shared picker, always shown |
| Credit note → cash refund | picker, hidden unless 2+ accounts | shared picker, always shown |
| Other income | **no picker** — bank interest was posted to the till | picker |
| Cash & bank tile → Record payment here | presets the tile's account | unchanged, asserted |
| Till → Cash in / Cash out | drawer by definition, no journal | left alone, deliberately |

Hiding the picker below two accounts was wrong twice over: a shop grows a second
account and the field appears from nowhere, and *seeing* "paid from the drawer"
before saving is how a bank transfer stops being posted to the till.

One component, `lib/moneyaccounts.jsx`, so five screens cannot drift into five
slightly different dropdowns — which is exactly how the till came to have none.
It also remembers the last account used **per machine, not per user**: that is a
property of the counter the terminal sits on ("this till banks to MoMo"), and a
relief cashier should inherit it rather than start from the drawer.

## Mobile money is its own thing

`kind` gains `'mobile'` alongside `'cash'` and `'bank'`, offered in the account
editor and given its own section on Cash & bank (hidden until a shop has one).
No migration: the column already existed, only the vocabulary is wider.

It is a **stored answer only, never guessed from a name**. A rule matching
"MoMo" or "MTN" would have moved every account already called "MTN float" out of
the group it has been in since the book was opened, and a grouping that changes
by itself on upgrade is how somebody concludes an account has gone missing. The
migration test still asserts every existing account groups exactly as before.

## The document shell did not line up

The photograph: the body was a centred 1180px sheet while the header and the
footer were full-width flex rows with their own padding. At 1920 the close
button sat at x=8 and the first field at x=400 — nothing over anything. All
three rows now sit in one `.doc-fs-col`: one width, one pair of margins.

Measured, not eyeballed, on all seven editors at 1366x768 and 1920x1080: header,
body and footer share a left edge and a right edge to within 1px (400/1520 at
1920), the close button sits on the body's own edge, and the grand total stays
inside the column.

## Printed tables were laid out as phone cards

The reports still printed wrong, and my hypothesis about why was wrong too. I
assumed the print stylesheet I added last round had set `display: block` on
table cells. It had not. The cause predates all of this work: `styles.css` turns
`.tw` tables into one bordered card per row below 780px, hiding the headings and
stacking each cell right-aligned against its label — the correct behaviour for a
counter tablet.

**Paper is narrower than a laptop.** An A4 sheet is 794 CSS px and Chrome's
dialog takes 0.4in off each side, leaving **717px** — squarely inside that
breakpoint. Every printed table in this app has been laid out as phone cards for
as long as the rule has existed. Last round's fix did not break it, it *revealed*
it: while the text printed white-on-white the boxes were invisible, and putting
black ink on the page made the wrecked layout visible for the first time.

Worth recording why the previous verification passed on broken output, because
that is the more useful lesson. Playwright's `page.pdf()` defaults to **zero
margins**, so the captured PDF was laid out at 794px — fourteen pixels the safe
side of the breakpoint — and the computed-style pass ran at the 1440px test
viewport, where no mobile rule applies at all. Even at the right width, neither
check could have seen it: text extraction finds every character, because they
are all still there, and the contrast check finds them all black. **Neither
measures the grid.**

The suite now prints at the dialog's own margins and measures the grid: cells
are `table-cell`, a row's cells share one top, a column holds one x-origin down
the rows and sits under its own heading, and no figure wraps. Proved to fail on
the unfixed build — 38 of 38 tables — and to pass after. Fourteen printed pages
were also rasterised and looked at, which is what would have caught this in the
first place and what no assertion did.

## A dashboard that answers the questions you open the app with

It showed turnover and little else. The questions a shopkeeper actually has at
seven in the morning are whether the money is arriving, whether yesterday was
normal for a Wednesday, who owes and how late, where the cash physically is,
whether today's trade earned anything after the goods, and what needs doing
before customers arrive.

A collection gauge — invoiced money actually collected — beside four stat blocks
with fourteen-day trend strips: takings today against yesterday *and against the
same weekday last week*, owed to me split into within-30-days and overdue, money
held across every cash, bank and mobile account, and earned today with the
margin. Then a watch row that shows only the cards with something to say.

**Margin is measured against the sub-total, not the grand total.** The grand
total carries VAT the shop is only holding for URA; using it would price tax
into profit and would put a different margin here from the profit report.

Still one request per load. Ten more queries cost single-digit milliseconds on
the shipped books, 14–39ms worst of three.

Two faults the screenshots caught that the assertions had passed: the bar stubs
for a day with no trade were drawn at **1.26:1**, so a quiet day read as missing
data rather than as zero; and a card headed "Stock at risk" led with the total
value of all stock, which is a lie. Every figure is asserted against an
independent report rather than the endpoint that drew it, and the empty state
runs against its own copy of the database, because by the time that spec runs
the shared one has been traded through.

Known difference: `/reports/bill-profit` does not exclude voided invoices and
the dashboard does, so on a day with voids the two disagree. The report is the
one that is wrong; it was left alone as a separate fix.

## Tested

`e2e/specs/payalloc.spec.mjs` — **139 assertions**, and every one about money
goes to the API and the ledger rather than the screen, because the last two
rounds each shipped a fix whose test passed while the user could see it was
wrong. After each save: the invoice named moved by exactly that amount; the
invoices *not* named did not move at all; the journal entry debits the account
that was picked (`1031 dr164000 | 1010 cr164000`, not Cash in Hand); and that
account's stored balance moved by exactly the same figure. The four refusals are
posted through the real route and the books read back afterwards to show that
nothing moved and no payment row was left behind. No figure in the spec is
hard-coded — the shop's tax rules decide what a 200,000 line invoices for, so
the balances are read out of the books first.

Full suite: **1018 assertions across nineteen specs**, zero failures.

## Limits worth knowing

- The till's payment panel scrolls and its Confirm bar is sticky by design; one
  more field makes the keypad a little more likely to need a scroll on a 768px
  screen. Reachable, but it is one field closer to not being.
- A draft payment cannot carry an explicit allocation. Confirming one still
  allocates oldest-first, which is correct — the party's open documents will
  have moved on since it was parked — but it means "park this against invoice
  214" is not expressible.
- Nothing reverses `payment_allocations` when a payment is deleted; that was
  true before this round and is unchanged.
- Existing payments recorded before this round have no allocation choice
  recorded because there was none to make. Their rows are oldest-by-id.
