# Settings — the regrouping map

Session 3a. Nothing has been built. This is the map, for you to correct.

I inventoried all **124 settings** and traced every one of them through both the
frontend and the backend before drawing this. Three findings came out of that
tracing, and the first changes what the redesign is actually about.

---

## Finding 1: a fifth of the Settings page does nothing

**25 of the 124 settings are read by nothing at all** — not one line of frontend
or backend code outside the catalogue that defines them. They render as
switches and dropdowns, they save, they persist, and they change nothing.

| page | inert settings |
|---|---|
| **Item defaults** (7) | `enable_items`, `item_wise_discount`, `barcode_scan`, `enable_batches`, `enable_wholesale`, `low_stock_alert`, `default_unit` |
| **Transaction** (6) | `invoice_numbering`, `round_off_mode`, `tax_inclusive_default`, `enable_due_date`, `show_received_amount`, `transaction_discount` |
| **General** (6) | `enable_estimates`, `enable_multi_firm`, `firm_business_type`, `firm_category`, `firm_pincode`, `firm_signature` |
| **Modules** (4) | `biz_you_sell`, `biz_invoicing_method`, `biz_client_type`, `mod_targets` |
| **Party defaults** (2) | `enable_party_groups`, `enable_payment_reminder` |

Some of these matter more than others. **`enable_wholesale` is the switch you
asked about in session 2** — it gates `items.wholesale_price`, which is itself a
dead column nothing writes. **`enable_batches`** promises batch and expiry
tracking; the printing code has `print_show_batch` and `print_show_expiry`, and
line records carry `batch_no`, so the feature half-exists and the switch that
should turn it on is not wired to it. **`tax_inclusive_default`** is the kind of
setting a shop would set once and trust.

A switch that does nothing is worse than a missing one, because the shop
believes it. **This is the single biggest problem on the Settings page**, and no
amount of regrouping addresses it. Question 1 below asks what you want done.

## Finding 2: seven module switches hide nothing

The rail honours 10 of the 17 `mod_*` keys. Of the other seven,
`mod_installments`, `mod_loyalty`, `mod_recurring_sales`,
`mod_recurring_purchases`, `mod_inventory` and `mod_expenses` correctly gate
*sub-tabs* rather than rail entries — fine. **`mod_targets` gates nothing at
all** and is in the inert list above.

## Finding 3: the loyalty gate has a correct key after all

Round eight of the previous pass left this open, saying *"there is no correct
key to point it at without deciding what the setting should be."* `Settings.jsx`
line 107 tests `values.loyalty_enabled`, which is not in the catalogue, so the
Loyalty page is permanently visible.

There **is** a correct key: **`mod_loyalty`** — already in the catalogue,
already the switch on the Modules page, already used by `Invoices.jsx:524` to
gate the loyalty sub-tab. Pointing the page gate at it is a one-line fix that
makes the Modules switch mean what it says. I will do this unless you object.

Two smaller ones alongside it: **Units & categories is a page whose entire
content is a signpost** saying these live on the Items screen, with buttons that
navigate there. And **six item settings exist in two places at once** —
`qty_decimals`, `inventory_valuation`, `allow_duplicate_item_names`,
`enhanced_item_search`, `price_lists_enabled` and `inventory_tracking_default`
are on both Settings → Item defaults and Items → Preferences.

---

## The map

**14 pages → 9**, with three groups moved to the screen they belong to.
Everything that moves keeps a signpost in Settings, so nothing becomes
unfindable.

### Pages that stay, regrouped

| # | Page | Holds | Change |
|---|---|---|---|
| 1 | **Business** | Name, legal name, TIN, address, phone, email, currency symbol, decimal places, date format | General's firm identity and money formatting, together. The firm block is currently split between the firm record and six `firm_*` settings. |
| 2 | **Modules** | The 17 `mod_*` switches, **plus Online store** as a gated section | Store is three settings and one master switch; it does not earn a top-level page. Folded in under its own gate, the same way Loyalty's fields will be. |
| 3 | **Sales & transactions** | `invoice_prefix`, rounding, `prevent_negative_stock`, `prevent_below_cost`, `force_customer_on_credit`, `require_void_reason`, `require_sales_rep`, `block_sales_without_shift`, `cash_round_to`, **plus the four `tax_on_*` rules** | Renamed from "Transaction". The `tax_on_pos` / `tax_on_cash` / `tax_on_credit` switches are transaction rules that currently sit under General, three pages away from the rules they modify. |
| 4 | **Taxes** | The tax-rule editor (unchanged), plus `taxes_enabled`, `vat_rule_name`, `vat_due_day`, `wht_rate`, `efris_enabled` | Five URA settings currently under General move next to the rules they name. `vat_rule_name` in particular *points at a rule on this page* and is edited on a different one. |
| 5 | **Users & roles** | The user and role editor, plus `login_pin_enabled`, `login_show_staff`, `roster_grace_mins`, `commission_default_pct` | Four settings about who signs in and how they are paid, currently under General. |
| 6 | **Print** | All 32 print settings, unchanged | Already its own well-built screen. |
| 7 | **Price lists** | Unchanged, still gated on `price_lists_enabled` | A list editor, not a field page. Stays. |
| 8 | **Backup** | Unchanged, plus the four `offsite_*` | Already correct. |
| 9 | **About & updates** | Unchanged | |

### Pages that move out of Settings

| Page | Goes to | Why |
|---|---|---|
| **Item defaults** (17 settings) | **Items → Preferences**, which already holds 6 of them | Two places to change one setting is how they drift apart. The Items screen is where somebody thinking about items already is. |
| **Units & categories** | **deleted** | Its entire content is a signpost to Items. A page that exists to say "not here" is a rail entry nobody should have to read. |
| **Party defaults** (4 settings) | **Parties → a settings drawer** | Same argument as items. Two of the four are inert and would go under question 1 anyway. |
| **Loyalty** (5 settings) | **The Loyalty panel**, gated on `mod_loyalty` | Points-per-shilling is configuration of a screen, and it belongs on that screen. |
| **Online store** (3 settings) | **Modules**, as a gated section | Too small for a page. |

---

## The UI changes

Beyond the banner you have already approved for removal:

1. **Two container levels, not four.** §2 of the review names Settings as the
   worst offender — "a card containing a card containing a row that is itself
   boxed". Every field page becomes: page section, and rows within it. Nothing
   else.
2. **The four-step type ramp** (§3). Settings currently carries several of the
   eleven distinct type treatments the review counted. Figure / Title / Body /
   Caption, and nothing else.
3. **Every setting gets a "what this does" line.** Roughly half already have a
   `note`; the rest have only a label. A switch called "Round off invoice total"
   with no explanation is a switch nobody dares touch.
4. **The left rail on Settings becomes 9 entries** rather than 14, and each
   carries its subtitle at Caption weight rather than the current mixed sizes.
5. **Search across settings.** With 124 of them behind 9 pages, the fastest way
   to reach one is to type its name. This is one input and a flat filter over
   the catalogue — cheap, and it makes the regrouping much less load-bearing,
   since nobody has to guess which page a setting is on.

---

## What I need from you

**1. The 25 inert settings — what should happen to them?**
   - **(a) Remove them from the interface**, and list them in the report as
     features that are not built. Most honest, and the page stops lying.
     Nothing is deleted from the database, so implementing one later is easy.
   - **(b) Implement them.** Several are small (`default_unit`,
     `low_stock_alert`, `show_received_amount`); several are not
     (`enable_batches` is a feature, `invoice_numbering` touches sequences).
     This would be its own session, or several.
   - **(c) Leave them and mark them** "not yet in use" in the interface.
   - My suggestion: **(a) now, with a named shortlist for (b) later** — I would
     put `tax_inclusive_default`, `default_unit`, `low_stock_alert` and
     `show_received_amount` on that shortlist as genuinely cheap and genuinely
     wanted.

**2. Moving Item defaults into Items → Preferences, Party defaults into
   Parties, Loyalty into the Loyalty panel.** This is the biggest behavioural
   change in the map: a shopkeeper who knows Settings → Item defaults will find
   a signpost instead. Yes, or keep them in Settings?

**3. Deleting the Units & categories page** — it is a signpost with buttons.
   Yes, or keep the signpost?

**4. Settings search** — worth building, or scope creep?

Once you answer, I build it and ship session 3 the usual way.
