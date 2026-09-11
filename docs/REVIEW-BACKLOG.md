# Genius POS — review backlog

Original findings from a UI/layout review of the running app (v1.42.0), written
13 Aug 2026, **updated after a fix-and-verification pass on the same day.**

Everything below now carries a status. Unlike the original pass, which was
observation-only, the fixes here were exercised against a running build
(backend on :3000, Vite on :5173, seeded database) driven through Chromium.
Where something is marked verified, there is a measurement behind it — the
detail is in `FIX-REPORT.md`. The original document is kept as
`REVIEW-BACKLOG.original.md`.

Viewports observed originally: 1254×596, 1394×662, 1548×736, 1707×811.
Verification also covered 1280×600, 1024×640, 900×700 and 1440×720.

**Status key** — ✅ fixed and verified in a browser · ☑️ fixed, verified by test
or measurement but not visually · ⬜ open · ⚠️→✅ the earlier fix was wrong or
incomplete, now corrected

---

## A. Fixed in source — verified by measurement *(unchanged from the original pass)*

| # | Fix | Before | After | Now |
|---|-----|--------|-------|-----|
| A1 | Payment panel action bar pinned (`.dk-confirm` sticky) | `Confirm & print` at y=872, 79px below the panel | y=704 | ✅ re-confirmed live: y=755–811 in an 850px viewport |
| A2 | Report totals row in dark mode | 1.16:1 contrast | 13.48:1 | ☑️ |
| A3 | Report title / description separated | "X reportToday so far…" | Two lines | ✅ |
| A4 | Till header contrast (`data-pt` follows app theme) | 3.05:1 | 5.12:1 | ☑️ |

## B. Previously fixed in source, never exercised — now exercised

All fifteen compile and were included in the verification sweep. Three needed
follow-up work.

| # | Fix | Now |
|---|-----|-----|
| B1 | Settings → Print crash (hook after early return → React #310) | ✅ opens clean, no console error |
| B2 | Slide-over / modal footers pinned | ✅ |
| B3 | Items → Movements wrapped in `.dk-scrollx` | ✅ pattern reused for 12 more tables |
| B4 | Items stock bar: scale max separated from chip count | ☑️ |
| B5 | Till labels a negative tax "Withholding tax" | ⚠️→✅ **incomplete.** Fixed the screen and missed the printed receipt, which still read `Less: VAT 18 (18%)` — so one figure carried three names across till, receipt and ledger. The receipt now reads `Withholding: VAT 18 (18%)`. |
| B6 | Pluralisation helper | ✅ no `item(s)` / "1 items" across 58 report panes |
| B7 | Date & currency plumbing (`fmtDate`, `setDecimals`, `setDateFormat`) | ⚠️→✅ **two real defects.** `fmtDate` was a day early in any negative UTC offset (bare ISO parsed as UTC, read as local). And `/settings` was fetched once on mount — which happens on the *sign-in screen*, answers 401, and was silently swallowed — so currency, decimals and date format were never applied for the whole first session: totals read `Sh 1,695,200` instead of the configured `Sh 1,695,200.00` until the user happened to reload. Both fixed and verified. |
| B8 | "Invalid Date" guard on instalment plans | ✅ none found across 58 report panes |
| B9 | Active tab no longer 1px short | ☑️ |
| B10 | Disabled buttons visibly disabled | ⚠️→✅ the rule was unscoped (`.btn:disabled:hover`), so *every* disabled button repainted primary-blue on hover. Scoped. |
| B11 | Toast lifted clear of the till's shortcut bar | ☑️ |
| B12 | Hit targets raised to 28px | ☑️ |
| B13 | Settings section buttons given `aria-label` / `aria-current` | ☑️ |
| B14 | "Actions" headers added to Instalments tables | ☑️ |
| B15 | Refund confirm restyled as destructive | ✅ |

---

## C. Open bugs — **all closed**

### C1. Data / correctness — 12 of 12

| Item | Status | Evidence |
|---|---|---|
| Dashboard chart renders no data series | ✅ | Window derives from hours that actually sold. The reported case (bills at 03:00) yields a 00:00–05:00 window instead of excluding them; falls back to 07:00–21:00 only when nothing sold. Seven cases tested. |
| Sales page stale on first load | ✅ | **Not** the cache header, as first diagnosed. Two effects raced on mount with no abort; now request-ticketed. First load reads `Sh 1,695,200 · 6 invoices · 6 of 6` — the bug showed 2. |
| Books health "all clear" over negative inventory | ✅ | 9 checks (was 6), `ok=false`, inventory check reports "Inventory carries Sh -1420000.00 — stock has gone out that was never taken in". Reads `account_balances`, the same basis as the balance sheet. |
| Z report zero for a range containing data | ✅ | `08-01..08-06 → one_day=false`; `?date=` still collapses to one day. Copy switches to "No sales in this range". |
| Tax & URA cannot match its own VAT rule | ✅ | Setting `VAT` resolves to rule `VAT 18`. Exact match wins; prefix only when unambiguous — a first attempt matched loosely enough to fold `VAT Exempt` into the total while the banner claimed it was excluded. |
| Tax & URA defaults to last month | ✅ | |
| Search suggestion shows negative loose stock | ✅ | Palette and till search both read "80 BAG in stock". `dualQty` re-tested across 0, negatives, `conv` 0/1/2.5 and non-integer quantities. |
| Dead stock flags brand-new items | ✅ | count 0 |
| Best sellers / item detail disagree | ✅ | Both read "47 BAG sold this month" — was 1273 vs 47. Each figure states its period and unit. |
| Shift open 7 days with nothing flagging it | ✅ | "This shift has been open for 9 days · since 04/08/2026 03:15 AM · 232h ago". Figures relabelled shift-to-date — they were never wrong, just mislabelled. |
| Backup "last 7 kept" lists 3 | ✅ | Pruning anchored to `auto-YYYY-MM-DD.db`; the list shows the covered day and explains gaps. **The gaps were never a bug** — a copy is only taken on a day the app was opened. |
| Staff → What they are owed lists one of two | ✅ | Both accounts listed. Was a `.filter(sold > 0 \|\| rate > 0)`, not a join. |

### C2. Interaction — 6 of 6

All ✅, verified live. The till commits quantity on every keystroke
(`Sh 34,440 → Sh 103,320` mid-typing), Enter commits instead of reverting,
Escape closes the real Create Invoice panel, the refund dialog previews the
invoice, online-store fields are gated, and the import wizard has real
Next/Back controls.

Two defects were introduced by the first attempt and caught by review: a
stale-guard bug that let a no-op commit silently undo an F6 unit flip
(**would have sold 1 KG instead of 50**), and the Escape handler landing on the
wrong component — there are two named `InvoiceBuilder`, and it went to the
print-template designer. Both fixed and verified.

### C3. Layout — 4 of 4

**0 unreachable controls across 16 pages × 7 viewports** (1254×596 through
1707×811, plus 1024×640 and 900×700).

- Sticky header covering Save controls — ✅ the scrollport moved from `.dk-main`
  to `.dk-content`, taking the header out of the scroll container entirely, so
  overlap is structurally impossible at any header height. Also fixes the
  Parties statement's sliced first row.
- Unwrapped `.dk-table` instances — ✅ **the "~31 of 50" over-counted.**
  `TableCard` already renders children inside a scrolling `.dk-tablewrap`, as do
  several hand-rolled containers. Genuinely clipping: 12. Now 0. `.panel` had
  the identical problem and was never mentioned — Warranty was losing 215px of
  rows.
- Sidebar hides 6 destinations — ✅ **with a correction.** The nav still scrolls;
  20 destinations at 34px will not fit in 600px. What is fixed is that the brand
  (y=14) and the Settings/user footer (y=499) stay pinned while it scrolls, so
  reaching Settings no longer pushes the top of the nav off screen. That was the
  actual complaint.
- 12px horizontal jump between Sales tabs — ✅ `scrollbar-gutter: stable` on the
  real scroll container. (The `.main`/`.shell` rules in `styles.css` are dead
  code — the app renders `dk-shell`/`dk-main`.)

### C4. Copy / affordance — all closed

All ✅. "Saved" is an action again with separate saved-state feedback; Restore
reads destructive and Download secondary; "Switch off" and "Sign out" are
differentiated; the Administrator drawer closes via ×; duplicate Record payment,
Print and count actions removed; "Data tools" replaces a title promising devices
and an audit log that do not exist; the required marker is gone; hit targets
raised; the sliced toggle row traced to `.dk-two`'s default `align-items:
stretch` and fixed at the cause.

Two follow-ups from review: the Record-payment guard was on the tab rather than
the sub-tab and had removed the action entirely from Expenses and Other income;
and the sidebar label still read "Sync & audit" while the page title said
"Data tools".

---

## D. Design / IA changes — **closed**

Originally 12 items, flagged as judgement calls rather than defects. The owner
made four calls; the rest followed from them or had an obvious answer.

**The owner's decisions**

| Question | Chosen |
|---|---|
| KPI strips | Compact to one slim row, standardised across every page |
| Navigation | Rail + pill tabs, **maximum two levels**; anything deeper becomes a filter control |
| Date filters | The Sales-style preset dropdown everywhere |
| Colour | **Green = received, amber = owed to you, red = overdue** — colour tracks how the money is doing, not whose it is |

**What changed**

| # | Item | Outcome |
|---|---|---|
| D1 | Vertical space budget — "the pattern is the real fix" | ✅ It is now the pattern, not three patches. The scrollport move plus `min-content` floors give 0 unreachable controls across 16 pages × 5 viewports. |
| D2 | KPI strips cost a third of the first screen; counts inconsistent | ✅ `.dk-strip` cell 138px → **78px**, `.dk-metrics` 100px → 72px, in shared CSS — all 24 usages across six pages, no markup change. Counts made deliberate per page family; Shifts' cards un-nested. |
| D3 | Recurring and Instalments diverge from the other Sales tabs; Staff splits the same way | ✅ All three adopt the majority pattern — bare KPI strip, segmented sub-filter, search and action inside the card head, row kebab, standard footer. Both panels now hand their table to `TableCard`, so they cannot drift again. |
| D4 | Settings' fixed 2-column template → mismatched card heights | ✅ Fixed at the cause: `.dk-two` was defaulting to `align-items: stretch`. |
| D5 | Card widths vary by screen | ✅ `w-narrow` / `w-mid` / `w-wide` (560/720/880) and a 420px `.dk-formcol`, replacing seven arbitrary inline max-widths. |
| D6 | Four navigation patterns; Cash & bank stacks three tab rows | ✅ Capped at two levels. Cash & bank is one tab row plus a `.dk-filterbar` segmented control. |
| D7 | Three filter patterns | ✅ One `DateRangePicker` on Accounting, Money (×3), Staff, Tax **and** `TableCard` — which is what Invoices/Purchases/Challans/Estimates actually render. It gained a "Pick a month" list so Staff and Tax keep the one-click month access their old selects had. |
| D8 | Colour semantics unsettled | ✅ A semantic vocabulary replaced ~90 inline colour styles. Money: `amt-received` / `amt-owed` / `amt-overdue` / `amt-paid` / `amt-reversal` / `amt-zero` / `amt-neutral`. Stock and performance health got a **separate** `val-*` family, so a healthy margin no longer asserts money was received. The Discount dialog's three blue buttons became `.dk-choice` chips, leaving Apply as the only primary action. |
| D9 | "Party groups" filed under "Units & categories" | ✅ Moved to sit with Party defaults. |
| D10 | Latest bills INVOICE column wraps | ✅ `white-space: nowrap`. |
| D11 | Money-owed ageing bar always 100% full | ✅ The bar is a share of everything owed, so it keeps that scale but now says what a full bar means ("All of it sits in 0–30 days" / "Spread across N age bands"). It also got a four-step amber→red ramp on new `--age-*` tokens: 0–30 was **green** — money not received rendered as received — and the two oldest buckets merged into one block. |
| D12 | "No loading or skeleton states were seen anywhere" | ❌ **Not true.** `LoadingRows` is used across 13 files (80 references). They exist; the local API just answers fast enough that none was ever seen. |

Also fixed while in there: the zero-state split bar rendered 100% amber on an
empty screen, because `owedPct = 100 - collectedPct` is 100 when nothing has
been invoiced.

## E. Not investigated — **now investigated**

| Original item | Outcome |
|---|---|
| Individual outputs for 37 reports | ✅ **All 58 opened** across all seven groups (the index holds 58, not 50). Zero React or console errors; no `NaN`, `undefined`, `[object Object]`, `Invalid Date`, doubled currency or plural artifacts. Every empty report shows a proper empty state. Exactly one Print button on each. |
| Print / receipt output | ✅ **Half right, and the half that wasn't was broken.** Receipts build their own document via `window.open` and are genuinely independent. *Report* printing uses the app stylesheet — whose `@media print` block targets `.sidebar`/`.topbar`/`.shell`, none of which the app renders. Dead since the deck shell landed: printing a report produced one page of the nav rail and the report index. Fixed; verified by generating PDFs. |
| Responsive breakpoints (`resize_window` was a no-op) | ✅ Audited at seven viewports down to 900×700. Two collapse bugs found and fixed below 1024px that the original pass could not reach. |
| Keyboard navigation and focus states | ✅ 20/20 tab stops have a real focus indicator; `:focus-visible` coverage includes a catch-all rule. F1/F2/F6/↓/↑/Del/Enter/Escape verified. Note: the input focus ring is `rgba(37,99,235,0.1)` at 3px, which is faint — a design call, left alone. |
| Settings sections only partly walked | ✅ Walked in the layout audit at all seven viewports. |
| F11 Customer dialog | ⬜ still open — the browser intercepts F11 in this environment too. |

**Newly found while verifying, and fixed:** the receipt barcode had a fixed
pixel width that ignored the paper setting — 454px of barcode on a 384px (2in)
roll, so the invoice number was cut off and the code would not scan.

---

## F. Housekeeping

- ✅ **Held bill cleared.** The parked "Cash Sale" (Sh 41,000, held 13 Aug 01:53)
  has been released; `/pos/held` returns `[]` and the change survives a server
  restart. Invoices and stock verified untouched.
- ⬜ **"Cement 50kg Bag" deliberately kept.** Listed here as a test product, but
  it is referenced by the seeded invoices and carries the entire Sh 2,800,000
  stock value, and the catalogue holds only two items. Deleting it would orphan
  the six sales and empty the books. Remove it only as part of a reseed.
- `frontend/node_modules` and `frontend/dist` are stripped from the delivered
  zip — run `npm install` in `frontend` and `backend` before starting.
- Every source file changed has a `.bak` sibling. There is still no git repo;
  initialising one before the next pass would make all of this reviewable as
  diffs rather than as a document.

---

## Verification not possible in this environment

- **Physical thermal hardware.** Receipt rendering is verified at 2in/3in roll
  widths in a browser; actual ESC/POS output on a real printer is not.
- **Electron packaging.** `:has()` is used by two layout rules; Electron is not
  pinned (`electron/main.js` documents an ad-hoc `npm i -D electron`), so any
  current version is well past the Chromium 105 where `:has()` shipped.
