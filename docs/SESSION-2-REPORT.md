# Session 2 — bulk update

Commit `837ef63`. **7 files, +1,198 / −3.** Build, `check-imports`,
`check-layers`, 34 unit tests and `node --check` on every backend file: clean.
The shipped database is byte-identical (`md5 3485fb02…`) — every test ran
against a copy in `/tmp`.

---

## What it is

**Items → ⋯ → Bulk update.** A full screen — per §5 it has lines and a running
count of what will change, so it is a document, not a dialog. Four subtitle
buttons swap the columns over one shared row set and one shared search:

| group | columns |
|---|---|
| **Price list** | Cost · Selling · *the chosen price book* · Margin |
| **Names & descriptions** | Name · Description |
| **Stock & units** | Unit · Second unit · Per unit · Reorder at · On hand |
| **Classification & tax** | Code · Barcode · Category · Tax · Active |

Tick rows and a bulk-actions bar appears: **raise**, **lower** (by % or by
amount, against selling, cost, or the price book), **set margin**, **round to
nearest**, and on the classification group **set category / set tax / activate /
deactivate**. Every one of them writes into the same draft a hand edit writes
into, so they mix freely, they are reviewable, and Cancel undoes all of it.

**Nothing reaches the server until Save.** That is the property that makes
"raise these forty by 5%" safe to offer at all — verified in the browser: after
applying a bulk raise, the server still held the old figure.

---

## On wholesale — a finding that changed the design

You asked for the wholesale price to show "in case wholesale is enabled". There
is an `items.wholesale_price` column, and **nothing in the interface has ever
written or read it.** The single-item edit form does not offer it; `PUT
/items/:id` does not update it. It is a dead column.

The app's actual wholesale mechanism is **price lists** — `price_lists` /
`price_list_items`, with parties pointed at a book. So the wholesale column here
is a *price book* column: pick a book from the dropdown (present only when price
lists are enabled) and its prices become an editable column beside cost and
selling. That is the number a wholesale customer is actually charged.

Worth knowing separately: **`PUT /items/:id` silently ignores seven fields it
accepts on create** — `wholesale_price`, `mrp`, `description`, `hsn_sac`,
`barcode`, `item_code` and `tax_rate_id`. You can set a description when
creating an item and have no way to change it afterwards. Bulk update can now
write all of them, so it is currently the *only* way to edit several of your own
item fields. Fixing the single-item form is a small job and belongs in a later
session.

---

## The endpoint

`PUT /items/bulk` is the one route in this application that can change every
price in the shop in one request, and it is written to that standard rather than
to the standard of the screen that calls it. Five properties:

1. **All or nothing.** One transaction. A batch failing on item 180 of 300
   leaves nothing behind — a half-applied price change is worse than a refused
   one, because the shop does not know which half.
2. **Validated before anything is written.** Ids, prices and names are all
   checked in a first pass and the request is refused naming the offending row.
3. **Only what changed is written.** A field equal to its old value is dropped,
   so the audit log records changes rather than submissions.
4. **One audit row per changed item, with old → new.** Round eleven found `PUT
   /items/:id` could change an item with no audit row at all; doing that 300
   times, on prices, would leave a shop unable to answer "who put the cement
   up".
5. **Firm-scoped in the statement**, and an id that does not resolve refuses the
   batch rather than being skipped — a request that asked to change 300 and
   changed 299 must not report success.

Plus a 5,000-item ceiling: not a limit anyone will meet, but a client looping
without a terminating condition cannot take the database with it.

## Verified against a running server

| check | result |
|---|---|
| 300-item batch applied | ✓ 300/300 in **35ms** |
| resubmitting the same values | ✓ writes nothing — "Nothing had changed" |
| a bad row at 180 of 300 | ✓ refused, naming the row |
| …and nothing at all was written | ✓ **300/300 unchanged** |
| an unknown id | ✓ refuses the batch |
| …and the good row beside it | ✓ not written |
| a name clashing with an existing item | ✓ refused |
| two rows claiming one name | ✓ refused |
| **swapping two items' names** | ✓ allowed |
| an item left without a name | ✓ refused |
| a second unit with a zero conversion rate | ✓ refused |
| an unlisted field (`firm_id`) in the body | ✓ ignored, firm_id unchanged |
| a 5,001-item batch | ✓ refused |
| audit rows | ✓ one per item, `sale_price: 42250 → 7777` |
| a refused batch's audit rows | ✓ none written |
| price book rows through the same batch | ✓ 40 written |
| a price book that is not ours | ✓ refused |

## Concurrency — proved, not assumed

I said in the plan I would prove this rather than assume the round-ten write
mutex covers it. A till sale was fired mid-batch, against a 300-item save:

| | |
|---|---|
| the bulk save | ✓ succeeded, 300 items |
| the concurrent till sale | ✓ succeeded, invoice created |
| invoices written | ✓ exactly **1** |
| the sale's own line | ✓ internally consistent — rate 49,000 × 1 = line total 49,000 |
| the ledger after both | ✓ balances, debits = credits = 4,053,300 |
| books integrity | ✓ **no new failure** |

An incidental confirmation on the way: an earlier test left an item priced below
its cost, and the next sale of it was refused by the shop's own "block selling
below cost" setting. That guard still fires on a bulk-edited price.

## In the browser

| check | result |
|---|---|
| the menu entry opens the screen | ✓ |
| all four groups swap columns | ✓ |
| search narrows 320 items to 1 | ✓ |
| the search box takes focus on open | ✓ |
| an edited cell is marked, footer counts it, save button says how many | ✓ |
| typing the old value back clears the edit and quietens Save | ✓ |
| a below-cost margin reads `val-loss`, **not** an `amt-*` money class | ✓ |
| select-all ticks only the rows on screen, not the 320 behind the search | ✓ |
| raise by 10% across 100 ticked rows | ✓ 1,450 → 1,595 |
| **nothing has reached the server yet** | ✓ server still held 1,450 |
| set margin 40% | ✓ cost 800 → selling 1,333.33, margin column reads 40.0% |
| the confirmation names the largest single move | ✓ *"The biggest change is Test item 0100: Sh 1,350.00 → Sh 100.00 (-93%)"* |
| every price on screen equals the price on the server after saving | ✓ 100 rows |
| React / console errors | none |

## Layout

| viewport | toolbar fixed | table scrolls | headings stick | clipped controls |
|---|---|---|---|---|
| 1254×596 | yes | yes | yes | **0** |
| 1280×600 | yes | yes | yes | **0** |
| 1024×640 | yes | yes | yes | **0** |
| 900×700 | yes | yes | yes | **0** |
| 1707×811 | yes | yes | yes | **0** |

`DocShell` gained a `fill` mode for this. The search box is the only way to find
one row among four thousand, and a search box that scrolls away is a screen you
cannot use for the thing it is for. §5 rules out pinning it — a sticky bar
always covers something — so instead nothing around it overflows: the toolbar is
a fixed row of a flex column and the table scrolls inside itself, with its own
headings sticky over its own rows, which is the one sticky the review calls
legitimate. The footer stays on screen with the table scrolled to its end.

---

## Three things I got wrong, and caught

**1. A batch where nothing changed reported "Updated " — the word with nothing
after it.** The "nothing changed" decision ran *before* the price-book rows were
compared against what was stored, so a batch of forty identical prices fell
through to a summary line with no parts in it. It reads as a save that happened.
Moved after the comparison.

**2. Item names were rendering in capitals.** The name cell is
`<th scope="row">` — correct for assistive tech, since it is what labels every
other cell in the row — but `.dk-table th` is styled as a *column* heading: 11px,
uppercase, letter-spaced. "Cement 50kg Bag" was shouting as "CEMENT 50KG BAG".
Per §3 a name is Body, not Caption; the heading treatment is undone and the
semantics kept.

**3. My own final check passed for the wrong reason.** It compared each row's
on-screen price against `server[name]` — where `name` had been uppercased by the
bug above. Every lookup returned `undefined`, every comparison was `NaN`, and
nothing was ever counted as a mismatch. **A check that cannot fail is worse than
no check.** It now asserts each row was *found* as well as matched, and passes
honestly on 100 rows.

A fourth, in the test harness rather than the product: my layout audit first
reported **930 unreachable controls**, because it stopped at the first
`overflow: hidden` ancestor without asking whether a nearer one already
scrolled — so every table row below the fold counted as unreachable. That is the
same false positive round three had to correct. Fixed, and the real number is 0.

---

## Judgement calls

- **Set margin means margin on the selling price**, not markup on cost — the
  same definition the column beside it uses. Two definitions of "margin" one
  click apart is how a shop prices itself into a loss. Items with no cost are
  left alone rather than divided by zero.
- **A zero conversion rate with a second unit is refused.** "50 KG to the bag,
  where a bag is nothing" makes every dual-unit figure a division by zero. The
  single-item form has no such guard — worth knowing.
- **Select-all ticks only the rows the search is showing.** Ticking a box while
  a filter is narrowing the list must not silently select the 4,000 items behind
  it.
- **Cells use `inputMode="decimal"`, not `type="number"`.** A number input
  swallows a stray scroll over the field and silently changes the value — on
  this screen that would change a price which a bulk action is then applied
  from.
- **Rows are memoised.** At four thousand items, re-rendering the whole table on
  every keystroke is the difference between typing and waiting.
- **The confirmation names the largest single move, not just the count.** "34
  items" tells you the size of the batch and nothing about its risk; a 900% jump
  hidden among 34 modest ones is what a mistyped figure looks like.

## Not done

- **Undo after saving.** The audit rows carry old → new for every field, so a
  bad batch is reversible by inspection, but there is no button that does it.
  A "revert this batch" action is a reasonable follow-up and would need the
  batch itself to have an id.
- **`PUT /items/:id` still ignores seven fields**, as above.
- **`ItemsMenu` in `Items.jsx` is dead code** — a whole Zoho-style menu
  component with hover submenus, defined and never rendered. The live ⋯ is the
  simpler `dk-tool` menu. Left alone this session; it is a deletion, not a fix.

---

Ready for session 3 (Settings regrouping) — which starts with the map for you to
approve before I build anything.
