# Session 6 — the all-businesses panel

Commit `e24bb95`. **7 files, +959.** Build, `check-imports`, `check-layers`, 44
unit tests and `node --check` on every backend file: clean. The shipped database
is byte-identical (`md5 3485fb02…`).

**17 backend checks and 11 browser checks, zero failures.**

---

## What it shows

**Companies → All businesses panel**, gated on `companies.panel`.

Four headline figures — revenue, profit after costs, owed to you, stock at cost
— then six groups: revenue by business, profit by business, receivables by age,
stock by business, where the money went (expenses by category across every
business), and where you stand (cash, owed to you, you owe, net position). Then
a table of every business side by side, with a totals row.

The period control is the one round eight standardised on: Today · Last 7 days ·
This month · Last month · This year.

---

## The charts, and the decision behind almost all of them

**Almost every chart here is the same one: a sorted horizontal bar, one hue,
with the name and the figure written on it.**

That is what the data's job asks for. Revenue by business, stock by business,
expenses by category — each is a magnitude comparison across a handful of named
things, and a sorted single-hue bar is the form that answers it. The ranking
carries the message; hue would only repeat what position already says.

It also settles the palette question honestly. §4 of the design review allows
one accent, one destructive and the three money colours — **nothing else** — and
a categorical palette for "company 1…6" would be exactly the accent creep it
warns about. So **identity is carried by the label on every bar, not by colour**,
which is stronger anyway: it survives greyscale, a photocopier, and a colourblind
reader with no special provision at all.

Two places genuinely need more than one colour, and both already had a
vocabulary:

**Profit is polarity, not identity.** Above zero it reads `amt-received`, below
zero `amt-overdue`, the sign is written out, and the tile carries the words *"at
a loss"*. Colour is never the only signal — the rule this app has already had to
go back and fix once.

**Receivables ageing is sequential**, using the four `--age-*` steps round nine
engineered. I re-measured them rather than trust the comment:

| | light theme | dark theme |
|---|---|---|
| relative luminance, steps 1→4 | 0.505 → 0.317 → 0.258 → 0.158 | 0.650 → 0.454 → 0.340 → 0.261 |
| strictly decreasing | ✓ | ✓ |
| greyscale span | 3.2× | 2.5× |

So the ramp still reads pale-to-dark with the hue removed, as claimed. The
measurement also surfaced the actionable part: **the two palest steps sit at
1.89:1 and 2.86:1 against white — under 3:1** — so every ageing step carries a
visible figure beside it rather than relying on the swatch. That is the relief
that contrast level obliges, not an optional nicety.

No charting library, per §8. The whole thing is positioned `<i>` elements and
CSS.

---

## The endpoint

One statement per measure, grouped by firm, across every business the account
may open. Not N dashboards: six businesses would otherwise mean six sequential
round trips whose figures came from six different instants, so **the total would
not be the total of anything**.

Only businesses the caller has a membership for. Being an administrator of shop A
says nothing about shop B, and a list showing B's turnover to A's manager would
be the cross-tenant leak round nine spent a round closing, dressed as a feature.

## Verified

| | |
|---|---|
| the panel answers | ✓ 13ms |
| covering every business the account may open | ✓ 3 of 3 |
| **the combined revenue is the sum of the businesses** | ✓ 1,745,200 |
| …the same for profit, stock, receivables, invoices, expenses | ✓ all six |
| company B's invoice count matches its own Sales screen | ✓ 5 and 5 |
| …and its revenue matches the sum of those invoices | ✓ 50,000 |
| expenses broken down by category | ✓ Rent 200,000 · Utilities 45,000 |
| an account without `companies.panel` does not hold it | ✓ |
| **…and the server refuses it the panel** | ✓ `403 Not allowed to panel companies` |
| the period changes the figures | ✓ today 50,000 · this year 1,745,200 |

The permission check is the one that matters. Hiding the button is the
convenience; the 403 is the control.

The figures also cross-check against the app's own history: on the shipped
database the panel reports revenue **1,695,200** and receivables **42,000** —
the same two numbers round six verified on the Sales screen and the UI review
quoted from the dashboard.

### In the browser

| | |
|---|---|
| the panel opens from Companies | ✓ |
| four headline figures, six statistic groups | ✓ |
| **every bar carries its own name** | ✓ 11 labels on 11 bars |
| **no categorical rainbow** | ✓ three hues total across the whole screen: accent, good, danger |
| every ageing step shows its figure | ✓ 4 of 4 |
| the table lists and totals every business | ✓ |
| **greyscale loses nothing** | ✓ age steps named in words; "at a loss" written out |
| changing the period changes what is shown | ✓ |
| React / console errors | none |

| viewport | clipped controls | horizontal overflow |
|---|---|---|
| 1254×596 | **0** | no |
| 1024×640 | **0** | no |
| 1707×811 | **0** | no |

### Timing, measured rather than asserted

The plan said I would time this at scale and report numbers rather than claim it
was fine. On a 38 MB database seeded to **11,014 invoices** across 3 companies:

| period | 5 runs |
|---|---|
| Today | 51–54 ms |
| This month | 50–70 ms |
| This year | 64–72 ms |

Honest caveat: I wanted five companies each carrying volume. `seed-large.js`
only seeds the first firm, and it rewrites `users`, so the extra companies I
created came out empty. **11,014 invoices across 3 companies is the number I
measured**, not 20,000 × 5. The queries are `WHERE firm_id IN (…) GROUP BY
firm_id`, so cost tracks total rows scanned rather than company count, which
makes this a fair proxy — but it is a proxy, and a genuine five-large-company
timing is still untested.

---

## Found by looking at the render

Two things the checks passed but the screenshot did not.

**A zero-value bar drew a sliver.** Every bar was floored at 0.6% width so it
would "be visible" — which meant a business that sold nothing showed the same
small mark as one that sold a little. **A figure invented by the rendering
rather than by the data.** A zero now draws nothing; the row still carries the
name, the note and a greyed "0", which is what says there is nothing there.

**A margin of −450.0% was shown to one decimal.** One decimal is useful at
12.4%; at −450% it is noise, and the extra digit makes an already alarming
figure look like a bug. Rounded to whole numbers beyond ±100%.

Neither would have been caught by any assertion I wrote. That is the seventh
item in this project's running argument for step 7 of the design procedure:
render it and look at it.

---

## Judgement calls

- **"Profit after costs", not "profit".** Profit is a word two people mean two
  different things by. The screen says which one, and the endpoint returns
  `gross_profit` separately.
- **Cost of goods comes from the ledger**, not from item costs. The ledger is
  what the books say, and a profit figure that disagreed with the
  profit-and-loss report would be the more alarming of the two.
- **A suspended business stays in the panel**, dimmed and labelled. Its history
  is part of the total; hiding it would make the combined figure quietly wrong.
- **The table is not a fallback for the charts.** The figures a shopkeeper acts
  on are read off a row. That it also makes every chart accessible without
  special provision is the right way round.
- **The ageing buckets are the ageing report's buckets**, so the panel and the
  report cannot disagree.

## Not done

- **Multi-currency.** Single currency across businesses is the decision on
  record, and the endpoint returns `currency_note: "single"` so the day that
  stops being true, the screen has somewhere to say so rather than quietly
  summing shillings and dollars.
- **Trend over time.** Every figure here is a snapshot for a period. A
  revenue-by-month line across businesses is the obvious next chart and is the
  one form on this screen that would genuinely need a categorical palette — at
  which point the §4 conversation has to be had properly rather than dodged.
- **A five-large-company timing**, as above.

---

That closes the six sessions from the original plan. Remaining, in the order I
would do them: **session 7** (signup, email verification, invitations, password
reset, and the hardening list) — which is what makes the going-online work
usable by anyone who is not already in the database; the **five shortlisted
settings** from session 3; and the **app-wide visual pass**, for which Settings
is now the template.
