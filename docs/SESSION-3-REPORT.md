# Session 3 — Settings

Commit `a02e797`. **10 files, +1,257 / −324.** Build, `check-imports`,
`check-layers`, 34 unit tests and `node --check` on every backend file: clean.
The shipped database is byte-identical (`md5 3485fb02…`).

---

## The finding that mattered more than the regrouping

**25 of your 124 settings were read by no line of code anywhere in this
application.** Not one, in either the frontend or the backend, outside the
catalogue that defines them. They rendered, they saved, they persisted across
restarts, and they changed nothing.

They are now marked `unbuilt` on the server and rendered nowhere — not on a
page, not in search. **Stored values are untouched**, so wiring one up later is
a one-line change.

| was on | count | keys |
|---|---|---|
| Item defaults | 7 | `enable_items`, `item_wise_discount`, `barcode_scan`, `enable_batches`, `enable_wholesale`, `low_stock_alert`, `default_unit` |
| Transaction | 6 | `invoice_numbering`, `round_off_mode`, `tax_inclusive_default`, `enable_due_date`, `show_received_amount`, `transaction_discount` |
| General | 6 | `enable_estimates`, `enable_multi_firm`, `firm_business_type`, `firm_category`, `firm_pincode`, `firm_signature` |
| Modules | 4 | `biz_you_sell`, `biz_invoicing_method`, `biz_client_type`, `mod_targets` |
| Party defaults | 2 | `enable_party_groups`, `enable_payment_reminder` |

**The shortlist you approved for building later**, cheapest first:
`show_received_amount`, `default_unit`, `low_stock_alert`,
`tax_inclusive_default`. I would add a fifth — **`enable_batches`** — not
because it is cheap but because it is the one that most looks like a shipped
feature: `print_show_batch` and `print_show_expiry` exist, line records carry
`batch_no` and `expiry_date`, and the switch that should turn it on is wired to
nothing.

## And two settings that *are* honoured had no control at all

The opposite failure, found by the same sweep:

- **`print_preview`** — read by `lib/print.js` on **every single print**, deciding
  whether a document is shown before it goes to paper. There was no way to set
  it from anywhere in the app.
- **`print_levy_pct`** — adds a service levy line to receipts. Same.

Both now have a control on Settings → Print. A third, **`print_custom_template`**,
is correctly not a field — it is JSON the Custom Invoice Builder writes — so it
is marked `hidden`: real and honoured, but not something anybody types. That is
a different flag from `unbuilt`, and the distinction is written into the code.

---

## The regrouping

**Fourteen pages → nine.**

| Page | What changed |
|---|---|
| **Business** | Firm identity and money formatting together — currency, decimals, date format, address, email |
| **Modules** | The 17 module switches, with **Online store** folded in as a gated section rather than a page of its own for three settings |
| **Sales & transactions** | The old Transaction page **plus the four `tax_on_*` rules**, which were under General, three pages from the rules they modify |
| **Taxes** | The tax-rule editor **plus** `taxes_enabled`, `vat_rule_name`, `vat_due_day`, `wht_rate`, `efris_enabled`. `vat_rule_name` names a rule in the table directly below it and used to be edited three pages away |
| **Users & roles** | The editor **plus** `login_pin_enabled`, `login_show_staff`, `roster_grace_mins`, `commission_default_pct` |
| **Print** · **Price lists** · **Backup** · **About** | Unchanged, apart from Print's two new controls |

### Moved out of Settings entirely

| Was | Now | Why |
|---|---|---|
| Item defaults (17) | **Items → Preferences** | Six of them already existed there *as well*, so a shop had two places to change one setting and no way to know which it last used |
| Units & categories | **deleted** | Its entire content was a signpost saying these live on Items, with buttons that navigate there |
| Party defaults (4) | **Parties → ⚙ Preferences** | Party *groups* were filed under Units & categories while the page promising "credit limits, groups and statement wording" held only the fields — one subject across two pages, neither of them Parties |
| Loyalty (5) | **Loyalty → Scheme…** | Points-per-shilling configures one screen |

Each leaves a **signpost** in the Settings list — a link, not a page — so
"where did Item defaults go" is answered in one glance.

## The loyalty gate

Round eight left this open: *"there is no correct key to point it at without
deciding what the setting should be."* `Settings.jsx` tested
`values.loyalty_enabled`, which is not in the catalogue, so the test was always
true and the page was permanently visible.

There was a correct key — **`mod_loyalty`** — already in the catalogue, already
the switch on Modules, already used by `Invoices.jsx` to gate the loyalty
sub-tab. The page has since moved to the Loyalty screen, which that same switch
governs, so the wrong key is gone rather than repointed.

---

## The interface

**The banner is gone.** The card carrying the firm initial, the page title and
its subtitle restated the entry already highlighted in the list beside it, cost
a card of height on every page, and was the third container in the stack §2 of
the review named as the worst in the app. The page title is now a heading.

**The Save dock stays**, as you decided — it is the fix for the overlap a
shopkeeper photographed.

**Two container levels, not four.** A page section, and rows within it. Rows are
separated by a hairline rather than boxed.

**The four-step type ramp** (§3): Title at 15px/650 for section headings — it
was three different sizes across the pages this replaces — Body at 13.5px/500,
Caption at 11.5px for explanations.

**Every setting says what it does.** Roughly half carried a `note`; the rest had
only a label. 40 explanations were written for the ones that were bare. "Round
off invoice total", with nothing under it, is a switch nobody dares touch.

**An unsaved row marks itself with a rule on the left** — which survives
greyscale, as §4 requires and round nine had to go back and fix once already.

**One implementation, four screens.** `SettingRow`, `SettingSection`,
`settingsIn` and `MasterList` moved into `lib/settingsui.jsx`. §1 of the review
is explicit: no new class name in a page file, one implementation in `lib/`,
used everywhere — `docshell.jsx` and `rowmenu.jsx` are the model. A setting now
reads and behaves identically on Settings, Items, Parties and Loyalty; without
that, moving them would have made the same switch look like two controls.

**Settings search.** One input over all 124, matching label, explanation **and
key** — the key because the people who search hardest are the ones who read it
in a support message. Each result is *the real control*, editable where it was
found, with the page it belongs to named beside it. Finding a setting and
changing it are one action rather than two.

---

## Verified in a running build

| check | result |
|---|---|
| nine pages | ✓ Business · Modules · Sales & transactions · Taxes · Users & roles · Print · Price lists · Backup · About |
| the banner card is gone | ✓ |
| the page title is a heading, not a card | ✓ |
| the Save dock still exists | ✓ |
| Items → Preferences shows the item settings | ✓ 10 rows |
| Parties → Preferences shows the party settings | ✓ 2 rows |
| …and party groups came with them | ✓ |
| Loyalty → Scheme shows the loyalty settings | ✓ 5 rows |
| **every live setting is reachable from some screen** | ✓ 62/62 of the catalogue-rendered ones |
| **no inert setting is rendered anywhere** | ✓ all 25 kept out |
| search by label | ✓ |
| search by key | ✓ `prevent_below_cost` → 1 result |
| search names the page each result is on | ✓ |
| a search with no matches says so | ✓ |
| an inert setting is not findable | ✓ |
| a result is editable in place, and saving persists | ✓ `1 → 0` on the server |
| the three signposts are present and navigate | ✓ |
| a setting saved from Items → Preferences persists | ✓ `qty_decimals 2 → 0` |
| React / console errors | none |

### Layout

| viewport | pages walked | clipped controls | dock on screen |
|---|---|---|---|
| 1254×596 | 9 | **0** | yes |
| 1024×640 | 9 | **0** | yes |
| 1707×811 | 9 | **0** | yes |

Print and Backup are hand-built screens rather than catalogue rows, so the
runtime sweep cannot see their controls by class. Both were checked at the
source level instead — that is how the two missing print controls were found —
and the four `offsite_*` keys are edited through the Backup screen's own
`/system/offsite` form, which writes them by name (`offsite.service.js:569`).

---

## Three test bugs I caught

Worth recording, because two of them would have produced false confidence:

1. **The audit reported 41 unreachable settings.** They were the Print page's,
   which uses its own layout rather than catalogue rows, so nothing could see
   them by class. Chasing that is what turned up the two genuinely missing
   controls — so the false failure was worth having.
2. **"A setting saved from Items → Preferences persists" changed the wrong
   control.** It picked the first `<select>` on the screen — `reorder_lookback_days`
   — and then asserted `qty_decimals` had moved. It had not. Targeted by id now.
3. **"The dock is reachable" reported `none` at every viewport.** It clicked the
   first switch on the Business page, which has no switches at all — only
   selects — so nothing became dirty and the dock correctly never appeared. The
   check now lands on Modules first.

---

## What is left in this area

- **The five shortlisted settings**, above. Each is its own small piece of work.
- **The app-wide visual pass** you asked for as a later track. Settings is now
  the template: two container levels, the four-step ramp, an explanation on
  every control, and one implementation in `lib/`. The pages that would benefit
  most, in order: **Money** (three tab rows deep in places), **Reports**,
  **Purchases**.
- **`ItemsMenu` in `Items.jsx` is still dead code** — carried over from session
  2's report. A whole Zoho-style menu component, defined and never rendered.

---

Session 4 next: Manage companies — accounts, memberships, invitations and
two-tier sign-in, built against the going-online decisions rather than as a
local-only feature.
