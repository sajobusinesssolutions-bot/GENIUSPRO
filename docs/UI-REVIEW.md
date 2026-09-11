# Genius POS — a design review

Written after two rounds of working inside the code, driving every screen in a
browser, and reading eleven photographs of it running on a real laptop in a real
shop. This is a candid review, not a compliment sandwich. Where I am guessing, I
say so.

---

## The short version

The app is **substantially more capable than it looks**. There are 58 reports, a
double-entry ledger under the till, multi-firm support, EFRIS, dual units,
repacking, instalments, warranty, loyalty. Very little of that capability is
visible in the interface, and quite a lot of it is undermined by the interface.

The problems are not taste problems. Almost every fault found in the last two
rounds was a **correctness** fault wearing a visual disguise:

- Reports printed blank — the theme's text colour went to white paper.
- Printed tables collapsed into stacked cards — a phone breakpoint catching A4.
- The row menus were unstyled — no rule for them had ever been written.
- Record Purchase hid its own Total — a modal 80px taller than its slot.
- The till opened with a stranger's bill in it — cart state in `localStorage`.
- The drawer count drew four note values off the right edge of its dialog.

That is the pattern worth internalising: **in this app, "it looks wrong" has so
far always meant "it is wrong."** Treat visual complaints as bug reports.

---

## 1. The single biggest problem: there is no design system, there are three

Three visual layers coexist:

- `styles.css` — the original layer, partly dead, still authoritative in places
  (it is what wrecked the printed tables).
- `deck.css` — the live layer, ~3,000 lines, organised in lettered sections.
- Per-page inline styles and one-off class names.

The symptom is divergence. Before this round there were **nineteen row menus in
twelve files across two implementations**, and five separate item tables. A
component built twice will be fixed once.

**Recommendation, in order of value:**

1. **Finish killing `styles.css`.** Every rule in it is either dead or a
   landmine. Move what is live into `deck.css`, delete the rest. Budget a day;
   it will repay itself the first time you avoid a print bug.
2. **Write down the tokens.** There are already good ones — `--bg`, `--surface`,
   `--line`, `--ink`, `--faint`, `--accent`, plus the semantic money colours. They
   are used inconsistently, and raw hexes still appear in page files. One page of
   documentation and a lint rule banning hex literals outside the token file.
3. **Adopt a rule: no new class name in a page file.** If a page needs a visual,
   it goes in `lib/` as a component. `docshell.jsx`, `rowmenu.jsx` and
   `moneyaccounts.jsx` are the model — one implementation, used everywhere.

---

## 2. Density is fighting the work

The reference screenshots you sent are all *dense*: small type, tight rows, many
numbers visible at once. Your instinct is right, and the app is currently too
loose in the places that matter and too tight in the places that don't.

- **A till and a books screen are professional tools**, used all day by someone
  who knows them. They should look closer to a spreadsheet than to a marketing
  site. Rows of 40–44px, 13px type, generous *horizontal* rhythm and tight
  vertical rhythm.
- **The KPI strip** was 138px tall for four numbers; it is 78 now. That is the
  right direction. Numbers earn their space by being read; padding does not.
- **Cards inside cards inside cards.** Settings is the worst offender: a card
  containing a card containing a row that is itself boxed. Each nesting level
  costs 32–48px of horizontal space and adds a border the eye must parse. Two
  levels is the honest maximum: a page section, and rows within it.

**Recommendation:** define exactly three container treatments — *page section*,
*row*, and *inset* (for a genuinely subordinate thing, like a total block) — and
delete every other box treatment.

---

## 3. Typography is doing too many jobs

Counted on the Settings and Reports screens: eleven distinct type
label/size/weight combinations, several differing by one pixel or fifty weight
units. That is not a hierarchy, it is noise. The eye can hold about four.

**Recommendation — a four-step ramp, and nothing else:**

| Role | Use |
|---|---|
| **Figure** | 22–28px, 700, tabular numerals, tight tracking — money and counts |
| **Title** | 15–16px, 650 — section and card headings |
| **Body** | 13–14px, 500 — everything you read |
| **Caption** | 11.5px, 650, uppercase, `--faint` — labels above fields, table headings |

And one rule that matters more than the ramp: **every money figure uses tabular
numerals and is right-aligned.** Columns of money that do not align at the
decimal point cannot be scanned, and scanning them is the entire job.

---

## 4. The colour is nearly right — protect it

`green = received, amber = owed to you, red = overdue` is a genuinely good
decision, better than most commercial products manage. Two things threaten it:

- **Accent creep.** The indigo rail is right. But indigo, teal and now a rust
  tone all appear as "primary" in different places, which teaches the eye that
  filled buttons are decorative rather than meaningful. One accent for "the
  action you probably want", one for "destructive", and the three money colours.
  Nothing else.
- **Colour as sole signal.** Mostly handled now — the row menus say the word
  "destructive", the dashboard writes "in today" / "out today" — but keep
  enforcing it. Roughly one man in twelve cannot separate your green from your
  red, and he is disproportionately likely to be the one behind the counter.

---

## 5. Interaction patterns to settle, once

Right now the same intention is expressed several ways, which is what makes an
app feel amateur even when every screen is individually fine.

**Where does a form open?** Now settled at: *full screen for a document* (has
lines and a total), *dialog for a decision* (confirm, count the drawer, pick a
reason), *inline for a single field*. Hold that line. The Record Purchase bug
happened because a document was put in a dialog.

**Where do actions live?** Settle on: primary action bottom-right of the thing
it acts on; destructive actions never adjacent to it; row actions in the `⋯`
menu and nowhere else. The Settings header taught this the hard way — Save
pinned in a floating band covered the very controls it was there to save.

**Nothing sticky over content that scrolls.** A sticky bar always overlaps
something. If a control must stay reachable, put it in a dock that *shortens*
the scroll area, as the Settings dock now does. The one legitimate exception is
a table's own column headings over its own rows.

**Empty states are part of the design, not an oversight.** A new shop opens this
app with no products, no customers and no sales, and every screen it sees is
empty. That first hour decides whether they keep using it. Each empty state
should say what the screen is for and offer the one action that fills it.

---

## 6. What the interface hides that it should show

This is where I would spend design effort next, ahead of any polish.

- **The till is the product.** It is one of 18 rail entries, at the same weight
  as Warranty. In a shop, 95% of interaction is: scan, take money, print. The
  till deserves a permanent, unmissable position and a keyboard-first design —
  which it half has (F-keys, barcode burst capture) but does not advertise.
- **Receivables are the business risk.** Small shops die of uncollected credit,
  not of low sales. "Sh 42,000 owed" should be impossible to miss and one click
  from *who* owes it and *how to chase them*.
- **The books are invisible.** There is a full double-entry ledger under this
  app and no shopkeeper would know. They will never ask for a trial balance —
  but "does the cash in the drawer match what the books say" is exactly what
  they worry about, and that question is answerable.
- **Multi-till reality.** Two tills on one login, one drawer, one held-bill
  queue. The model supports it; the interface barely acknowledges it.

---

## 7. Concrete quick wins, ranked by value per hour

1. **Delete `styles.css`.** Highest value, lowest creativity required.
2. **One table component.** Sticky heading row, tabular numerals, right-aligned
   money, one row height, one empty state, one loading state. Roll it across
   every list.
3. **A shortcut legend that is always visible at the till.** It exists; make it
   permanent rather than behind a key.
4. **Loading and error states on every async surface.** A screen that shows
   stale figures while fetching is how "the Sales screen said two invoices when
   the books held six" happened.
5. **Reduce the rail to two levels and eight top entries**, with the rest behind
   "More". Eighteen flat entries is a menu nobody reads; they learn three and
   navigate by search.
6. **Number formatting audit.** One helper, used everywhere: thousands
   separators, two decimals for money, no decimals for counts, "Sh" consistently
   placed.

---

## 8. Things I would not do

- **Don't add a charting library.** The hand-drawn SVG is small, fast and
  themable. A dependency would cost 80–200kB to draw bars you already draw.
- **Don't chase a "modern" aesthetic** — big radii, heavy shadows, generous
  whitespace. It is directly opposed to what a counter tool needs. The reference
  screenshots you chose are dense and quiet; trust that instinct.
- **Don't redesign the till.** It is the most-used and least-broken screen. Add
  the sales-rep and account pickers (done), leave the rhythm alone.

---

## 9. What I am unsure about

- I have never watched anyone use this in a shop. Everything above about
  *workflow* is inference from the code and your photographs; everything about
  *rendering* is measured.
- I do not know your customers' hardware. I have assumed 1366×768 laptops and
  the occasional counter tablet, because that is what the breakpoints imply and
  what your photographs show. If touch screens are common, the tap targets need
  a separate pass — several are below 44px.
- I do not know whether shops run one firm or several. The code supports many;
  the interface assumes one; the restore path refuses more than one. Worth
  deciding deliberately rather than by accretion.
