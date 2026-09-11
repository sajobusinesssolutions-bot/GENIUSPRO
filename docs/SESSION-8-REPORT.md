# The five settings that did nothing

Commit `c69a592`. **15 files, +497 / −41.** Build, `check-imports`,
`check-layers`, **73** unit tests and `node --check` on all 89 backend files:
clean. The shipped database is byte-identical (`md5 3485fb02…`).

**16 API checks and 13 browser checks, zero failures.** The session-7 (58) and
shop-code (29) suites still pass.

Session 3 found **25 switches on the Settings page that no code anywhere read**
and called it the single biggest problem with that screen: *a switch that does
nothing is worse than a missing one, because the shop believes it.* Five were
shortlisted. All five now do what they say. **25 → 20.**

---

## What each one turned out to be

**`default_unit`** — a shop selling by the bag retyped BAG on every new item
while a setting saying exactly that sat there doing nothing. A new item now
starts in the shop's own unit.

**`show_received_amount`** — off takes the *amount received* and *balance due*
boxes off the sale form. What is left is where the money went, and every sale
settles in full — which is what a shop that turned it off is saying about how
it trades. A figure typed before the switch was flipped is deliberately
ignored rather than quietly kept.

**`low_stock_alert`** — honoured **where the figure is produced**, not on each
screen that shows it. The dashboard tile, its alert list and the Items panel
all read one array, so a shop that switches the alerts off goes quiet
everywhere at once rather than in three places out of four. The stock itself is
untouched; only the alarm.

**`enable_batches`** — and this one was the surprise. **The batch machinery was
already complete**: purchases store a batch and an expiry, `item_stock` holds a
row per batch, stock is consumed **earliest-expiry-first**, and the receipt can
print both. What never existed was the switch — the two columns were on for
everybody, including shops selling nothing with a shelf life.

So its default is now **`1`, not `0`**. The catalogue said off while the app
had always been on; honouring the declared default would have taken a column
away from every shop on upgrade, which is a worse fault than the one being
fixed.

---

## The fifth one needed the label changed before it could be built

**`tax_inclusive_default` — "Prices include tax by default"** — cannot mean
that in this application, and building it as labelled would have been a lie.

This app's taxes are firm-level rules applied in order, and the Uganda default
chain **deducts**: withholding tax and VAT are taken *out* of the price the
customer pays. An entered price already is the gross. There is nothing to
include.

"Include" only means something for a rule that **adds** — which the Taxes
screen allows and some shops use. So the setting is now honoured there, and
only there, and the label says which: **"Prices already include add-on tax
(VAT)"**.

| a line entered at 11,800, one 18% add-on rule | sub-total | tax | customer pays |
|---|---|---|---|
| exclusive (unchanged, and still the default) | 11,800 | 2,124 | **13,924** |
| inclusive | 10,000 | 1,800 | **11,800** |

The point of the setting, in one line: **the customer pays what the shelf
said**, and the tax line says how much of it was tax. Shops price in round
numbers; this lets them.

Four properties are asserted, and all four fail if the feature is switched off
(I checked, by switching it off):

- a **deduct** chain is bit-for-bit unchanged — silently rescaling one would
  change every existing shop's takings on upgrade;
- a shop with no tax rules is unaffected;
- in a mixed chain only the added part comes back out (11,800 → 10,000 base,
  1,800 VAT, then 6% withheld = 11,092);
- **every line is scaled, not just the total**, so a line-level report still
  adds up to the invoice it came from. Scaling the total alone would make the
  two disagree with nothing to say so.

The server reads the setting itself rather than trusting the request: what a
price *means* is the shop's standing decision, not something a client asserts
per sale. The client mirrors the same arithmetic so the figure does not jump
when the sale is saved.

---

## Verified

| through the API | |
|---|---|
| an item below its reorder level is reported by Items and the dashboard | ✓ 2 running out |
| **with alerts off, both go quiet** | ✓ 0 and 0 |
| …and the stock itself is unchanged | ✓ only the alarm is off |
| exclusive pricing: 11,800 → 13,924 | ✓ |
| **inclusive pricing: 11,800 → 11,800** | ✓ |
| …sub-total 10,000, and the saved line agrees | ✓ |
| a purchase names a batch and an expiry | ✓ |
| **…and the stock lands in that batch** | ✓ 5 in LOT-9 |

| in the browser | |
|---|---|
| **a new item starts in the shop's own unit** | ✓ BAG |
| received and balance are asked for when the setting is on | ✓ |
| **…and both are gone when it is off**, with the payment section intact | ✓ |
| batch and expiry appear on a bill line when tracking is on | ✓ |
| **…and the two columns are gone when it is off** | ✓ |
| React errors | none |

---

## The check that could not fail — again

"With it off, both boxes are gone" passed on the first run **because the sale
form had never opened**: the button I clicked did not exist under that name, so
the assertion was "a field is absent from a screen that is absent". The form is
now proved open before anything about its fields is asserted.

That is the tenth time in this project. The pattern holds: *when a new test
passes first time, assume it is broken until you have made it fail on purpose.*

## One more dead thing found on the way

**`items.price_inclusive`** — a per-item column, written on every item create,
read by no code anywhere. It is the same family as `wholesale_price` from
session 2. I did not build a second inclusive-pricing mechanism to justify it;
the firm-level setting is the one that now works, and a per-item override is a
decision to take deliberately rather than to infer from a column somebody added
once.

## Not done

- **The remaining 20 inert settings.** Named in `SETTINGS-MAP.md`, still inert,
  still hidden from the Settings page rather than pretending.
- **A per-item inclusive price** (`items.price_inclusive`), above.
- **`enable_wholesale`**, which gates `items.wholesale_price` — itself a dead
  column. Session 2 established that price lists are the real wholesale
  mechanism; the honest fix is probably to remove both rather than wire them.

---

Remaining: the **app-wide visual pass**, for which Settings is the template —
priority order Money, Reports, Purchases.
