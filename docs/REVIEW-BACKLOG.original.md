# Genius POS — review backlog

Findings from a UI/layout review of the running app (v1.42.0), plus the current
state of fixes. Written 13 Aug 2026.

Viewports observed: 1254×596, 1394×662, 1548×736, 1707×811. Dark theme with the
teal accent for the later passes.

---

## A. Fixed in source — verified by measurement

These four were A/B tested against the running app (rule injected, measured
before and after).

| # | Fix | Before | After |
|---|-----|--------|-------|
| A1 | Payment panel action bar pinned (`.dk-confirm` sticky) | `Confirm & print` at y=872, 79px below the visible panel | y=704, visible without scrolling |
| A2 | Report totals row in dark mode (`.tw tfoot td` dark override) | 1.16:1 contrast | 13.48:1 |
| A3 | Report title / description separated (`.dk-rp-item .t/.s` → block) | "X reportToday so far, without closing" | Two lines |
| A4 | Till header contrast (`data-pt` follows app theme) | 3.05:1 (fails AA) | 5.12:1 (passes AA) |

---

## B. Fixed in source — NOT yet verified against a running build

Code is in place and the production build compiles clean. None of this has been
exercised in the browser yet.

| # | Fix | File |
|---|-----|------|
| B1 | **Settings → Print crash.** `useState` was called after an early `return null`, so hook count changed once the fetch resolved → React #310. Hook moved above the guard. | `pages/Settings.jsx:1155` |
| B2 | Slide-over / modal footers pinned, so Save stays reachable (invoice builder) | `styles.css` `.slide-foot`, `.modal-foot` |
| B3 | Items → Movements table wrapped in `.dk-scrollx` so it scrolls rather than clipping | `pages/Items.jsx:560`, `deck.css` |
| B4 | Items stock bar: scale max separated from chip count, so the axis label tracks real stock instead of the 14-chip cap | `pages/Items.jsx:397` |
| B5 | Till labels a negative tax "Withholding tax" (the ledger books it as *Tax Recoverable (WHT credit)*) | `pages/Pos.jsx` |
| B6 | Pluralisation helper; removed `item(s)`, "1 items", "1 categories" | `lib/plural.js` + Items, Pos, Purchases, Setup |
| B7 | Date & currency plumbing: `fmtDate`, `fmtDateTime`, `setDecimals`, `setDateFormat`. `amount_decimals` and `date_format` were configurable but unread. | `lib/tax.js`, `App.jsx`, 7 pages |
| B8 | "Invalid Date" guard on instalment plans | `pages/InstalmentsPanel.jsx` |
| B9 | Active tab no longer 1px short (`.btn-primary` given a transparent border) | `styles.css:83` |
| B10 | Disabled buttons visibly disabled (was 5 places reading as clickable) | `styles.css` |
| B11 | Toast lifted clear of the till's shortcut bar | `deck.css` `--toast-lift` |
| B12 | Hit targets raised to 28px (report favourite stars, row kebabs) | `deck.css` |
| B13 | Settings section buttons given `aria-label` / `aria-current` | `pages/Settings.jsx:112` |
| B14 | "Actions" headers added to the two Instalments tables | `pages/InstalmentsPanel.jsx` |
| B15 | Refund confirm restyled as destructive rather than primary | `pages/Pos.jsx` |

> Every file touched has a `.bak` copy beside it. There is no git repo.

---

## C. Open bugs — not started

### C1. Data / correctness

- **Dashboard chart renders no data series.** The SVG contains only gridlines.
  The axis is hard-coded 07:00–21:00 and the seeded bills are timestamped
  03:00–03:25, so they fall outside the window entirely.
- **Sales page serves stale data on first load.** Showed "Sh 42,900 · 2 invoices ·
  Showing 2 of 2" while Parties simultaneously listed INV-000003…6. Corrected only
  after navigating away and back (to "Sh 1,695,200 · 6 invoices").
- **Books health reports "All clear — every check passed"** while the Balance
  sheet carries Inventory at −1,420,000. The six checks test internal consistency
  (debits = credits, no orphans); none test plausibility.
- **Z report returns zero for a range containing data** — scoped
  `2026-08-01 to 2026-08-06`, reports "No sales on this day" despite six invoices
  dated 2026-08-04 inside that range. Also singular "this day" for a range.
- **Tax & URA cannot match its own VAT rule.** Settings → General holds `VAT`;
  the tax is named `VAT 18`; the match is string equality. The error banner prints
  the answer and still fails, then points at two different Settings pages.
- **Tax & URA defaults to last month** (July) rather than the current period.
- **Search suggestion shows negative loose stock**: `119 BAG − 49 KG in stock`.
- **Dead stock flags brand-new items** — an item created seconds earlier appeared
  under "DEAD STOCK 60D".
- **Best sellers / item detail disagree**: "1273 sold" vs "47 sold this month".
- **Shift open 7 days with nothing flagging it**; "Cash sales so far Sh 729,800"
  against Dashboard "Sales today Sh 0".
- **Backup: "AUTOMATIC DAILY BACKUPS — LAST 7 KEPT" lists 3**, on non-consecutive
  dates.
- **Staff → What they are owed lists one of two staff accounts** (Sales Rep
  missing from the commission table).

### C2. Interaction

- **Till quantity commits only on blur.** Typing a new qty leaves the line
  amount, subtotal and the green Take payment button showing the old figure.
  `Ctrl+P Save & print` is one keystroke away with stale totals on screen.
- **Enter reverts the typed quantity** instead of committing it.
- **Escape does not close the Create Invoice panel.**
- **Refund dialog commits with no preview** — pick an invoice number from a
  dropdown and press Refund, never seeing amount, items, date or customer.
- **Online store fields stay editable when the store toggle is off.**
- **3-step import wizard has no Next/Back controls** — only static grey text
  "Choose a file to continue" where a button belongs.

### C3. Layout still clipping / unreachable

- **Sticky page header covers the Save controls.** On Settings → Transaction the
  header bottom is y=112 while Discard/Saved span y=85–123 — **27px of a 38px
  control hidden (71%)**. Same cause slices the first row of the Parties
  statement.
- **~31 of 50 `.dk-table` instances still sit directly inside `.dk-card`**
  (`overflow: hidden`) with no scroll wrapper. Only Items → Movements is fixed.
  Worst: Invoices.jsx (5 tables, 0 wrappers), PosAdmin.jsx (3, 0),
  Parties.jsx (2, 0), Purchases.jsx (7, 1).
- **Sidebar hides 6 destinations** (Staff, Shifts, Tax & URA, Sync & audit,
  Settings, Switch user) — 367px of nav below the fold at laptop height, and
  scrolling to them pushes the brand and top four items out of view.
- **Content jumps 12px horizontally between Sales tabs** as the scrollbar
  appears/disappears. `scrollbar-gutter: stable` fixes it.

### C4. Copy / affordance

- **Settings' primary button reads "Saved"** — a status occupying the action slot.
- **Backup inverts weight against risk**: "Download backup now" (harmless) is the
  teal primary; "Restore" (replaces everything) is a plain outline.
- **"Switch off"** (deactivates an account) styled identically to "Set PIN"
  beside it. Same for **"Sign out"** sitting under "Back to dashboard" in the
  Administrator drawer with the same icon.
- **Administrator drawer closes via "→"**, which reads as "next". Every other
  panel uses ×.
- **Duplicate primary actions**: two "Record payment" buttons on Cash & bank →
  Payments (~140px apart); two "Print" buttons on Stock summary; "New count" and
  "Start a count" on Stock take. "QUANTITY 80" shown twice on Stock summary.
- **Sync & audit's subtitle promises what the page lacks** — "Devices, who did
  what, and how you get your data back" over tabs for Import / Export / Barcode
  generator / Verify. No devices, no audit log. Barcode generator is an Items
  feature filed here.
- **"Duplicate Handling \*"** marked required but already defaulted.
- Radio buttons 16×16; "sample CSV file" link 93×15.
- **Last Settings toggle row sliced** by the card edge ("Show staff names on the
  sign-in screen").

---

## D. Design / IA changes — not started

Judgement calls rather than defects. Each is a deliberate decision, not a fix.

- **Vertical space budget.** Every screen assumes ~900px height. Nothing is
  sticky by default and primary actions sit at the natural bottom of a long
  column. B1/B2/A1 patched three instances; the pattern is the real fix.
- **KPI strips cost a third of the first screen** on every page to show mostly
  zeros, pushing working content below the fold. Counts are inconsistent — 3
  cards on Sales/Purchases/Parties/Items, 4 on Accounting/Staff/Tax/Shifts, and
  Shifts nests them inside a card.
- **Recurring and Instalments diverge from the other four Sales tabs** — banner
  pills instead of the KPI strip, plain-text sub-filters instead of the segmented
  control, search/action hoisted out of the card, inline buttons instead of a
  kebab, different footer string. Staff's two tabs split the same way.
- **Settings uses a fixed 2-column Details/Behaviour template regardless of
  content** — Loyalty's Behaviour panel holds one toggle in a 450×310 card.
  This is the source of most "mismatched card height" observations.
- **Card widths vary by screen**: Sync & audit Import 710px vs Verify 530px;
  About & updates 625px left-pinned; Shifts' form 280px in a 1150px card.
- **Four navigation patterns**: sidebar rail → pill tabs → segmented sub-filters
  → Settings' chevron list. Cash & bank stacks three tab rows before content.
- **Three filter patterns**: "All dates" dropdown (Sales) vs raw native
  `dd/mm/yyyy` pickers (Cash & bank, Accounting) vs a month selector (Staff).
- **Colour semantics unsettled** — green for money owed *to* you; amber progress
  track on a zero state reading as "everything overdue"; the same blue for
  "selected" and "submit" (Discount dialog stacks three blue buttons and the
  actual submit is the smallest).
- **"Party groups" filed under "Units & categories"** while a separate "Party
  defaults" section exists two rows below.
- **Latest bills INVOICE column wraps** `INV-` / `000002` onto two lines,
  doubling row height, while TIME and TENDER sit oversized.
- **Money-owed ageing bar is always 100% full** when one bucket holds everything
  — conveys nothing.
- **No loading or skeleton states** were seen anywhere; panes render empty then
  populate.

---

## E. Not investigated

- Individual report **outputs** for 37 reports (Purchase, Money, Receivables,
  Payables, Tax & books). The shared list-component bug is confirmed across
  categories; the result panes were not each opened.
- **Print / receipt output** — likely its own layout system.
- **Responsive breakpoints.** `resize_window` was a no-op for the whole session,
  so everything was observed at whatever width the window happened to be. Narrow
  and tablet behaviour is unverified. Note the payment screen already failed at
  736px height; shorter viewports will be worse.
- **Keyboard navigation and focus states.**
- Settings sections only partly walked: Price lists, Item defaults, Units &
  categories, Party defaults, Transaction.
- **F11 Customer dialog** on the till (the browser intercepts F11).

---

## F. Housekeeping

- A **held bill** ("massage", Sh 41,000) is parked on the till from testing.
- A test product **"Cement 50kg Bag"** (1 BAG = 50 KG) was created to exercise
  the dual-unit paths.
- `frontend/node_modules` was installed mid-review; if anything behaves oddly,
  delete it and reinstall clean.
