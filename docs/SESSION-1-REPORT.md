# Session 1 — the print dialogue

Commit `dd77ff7`, on top of a `fda8a22` baseline of the zip as received.
**19 files, +739 / −27.** Build, `check-imports`, `check-layers`, 34 unit tests
and `node --check` on every backend file: clean. The shipped database is
byte-identical (`md5 3485fb02…` before and after) — every test ran against a
copy in `/tmp`.

---

## What you asked for, and what it turned out to require

> *"when any transaction is saved a dialogue for print yes or no"*

The dialogue itself is about eighty lines. The reason this session is larger
than that is what I found when I went to wire it up:

**Six of the app's own documents could be created but never printed.** Purchase
bills, purchase orders, credit notes, debit notes, delivery challans and
quotations had no single-document endpoint on the server *and* no template in
the browser. What their screens offered as "Print" was `window.print()` on the
whole page — which round four of the previous pass measured as producing one A4
sheet whose text is the navigation rail and the report index.

**Money movements had no printable form at all.** Payments in and out, expenses,
other income, drawer cash in/out and manual journals produced no paper of any
kind. A customer paying down a debt at the counter had nothing to take away.

So "ask whether to print" could not be answered honestly for eleven of the
fourteen save paths until there was something to print. That work is the bulk of
the diff.

---

## The setting

`print_after_save` — **Ask** (default) · **Print straight away** · **Never**.
Lives on Settings → Print under a new "Printing" heading, beside copies and the
drawer toggle.

The dialogue also writes it: ticking *"Remember my answer and stop asking"* and
pressing **Print** sets `always`; ticking it and pressing **Don't print** sets
`never`. Stated that way round on purpose — the same tick means two different
things depending on the button pressed next, and a shopkeeper should be able to
read that off the screen rather than infer it. Once ticked, a line appears
saying where to change it back, so switching the prompt off by accident has one
findable way out.

The till's **Confirm & print** is deliberately untouched. It is an instruction,
not a question, and routing it through a dialogue would ask somebody to confirm
the thing they just clicked. **Save, no print** is the button that used to end a
sale with no paper and no offer of any — that is the one now wired.

## Where it fires

Fourteen paths, all after the server's 200 and never before it:

| | |
|---|---|
| **Till** | sale (`Save, no print`), refund |
| **Sales** | invoice, quotation / proforma, estimate → invoice conversion, credit note, delivery challan |
| **Purchases** | purchase bill, purchase order, suggested-order shortcut, debit note |
| **Money** | payment in / out, other income, expense, drawer cash in / out, manual journal |

Three rules are written into `lib/printprompt.jsx` and hold at every one of them:

1. **After the save, never before.** The prompt is a question about a document
   that exists.
2. **A failed print must not make a saved record look unsaved.** Printing is
   wrapped; a blocked popup or an unreachable printer surfaces as its own
   message and the save's toast stands.
3. **An explicit print instruction is not a question.**

## The new documents

`printInvoice` gained a `docTitle` argument, so the templates that exist can
name what they are printing. Measured on the A4 template:

| document | heading printed |
|---|---|
| invoice (no override) | `INVOICE` |
| credit note | `CREDIT NOTE` |
| debit note | `DEBIT NOTE` |
| purchase bill | `PURCHASE BILL` |
| delivery challan | `DELIVERY CHALLAN` |
| quotation | `QUOTATION` |
| purchase order | `PURCHASE ORDER` |

This is not cosmetic. **A credit note printed under the heading "INVOICE" is a
document that says a customer owes money when in fact they are owed it**, and it
is the kind of error found in an audit rather than at the counter. Two
consequences of taking that seriously:

- The *classic* theme titles its documents in mixed case, so an override there
  renders `Credit note`, not `CREDIT NOTE` — verified.
- A named document **bypasses the Custom Invoice Builder** entirely. That
  template's title is free text the shopkeeper typed for their invoices;
  printing a credit note through it would put "MY SHOP INVOICE" on the wrong
  document. Verified as bypassed.

Two documents deliberately print no prices: a **delivery challan** carries no
rates or totals (a goods-out note is not a demand for money, and one that looks
like an invoice gets paid twice), and a **purchase order** shows no balance due,
because nothing has been received and no bill has arrived.

`printVoucher` is new — a single-amount document with a payer or payee, a key/
value block, a note and two signature lines. It is not an invoice with the rows
hidden: its job is to be evidence that money changed hands. It reuses the firm
letterhead toggles and `print_copies`, since two copies is the normal ask for a
voucher. Blank rows are suppressed rather than printed empty.

## Three defects found by running it

Each of these was found by measurement, not by reading — which is the pattern
the previous thirteen rounds kept landing on.

**1. The new endpoints queried a column that does not exist.** `parties` has
`billing_address`, not `address`. All three new return-document endpoints failed
with `no such column: p.address` the first time they were called. Fixed.

**2. `/estimates/:id` printed a blank document number and a blank date.** It
returns `doc_no` and `doc_date`; the templates read `invoice_no` and
`invoice_date`. A printed quotation would have carried no reference at all —
which is precisely the field a customer quotes back at you. Aliases added there
and on purchases and purchase orders.

**3. The thermal voucher overflowed a narrow roll by 1px** — and by 14px on a
true 3in roll. `width: 76mm` plus 7px of padding each side is 76mm + 14px of
paper, and a thermal roll has no 14px to give. This is the same defect round
five found in the barcode: an intrinsic width that ignores the paper it is
printed on. `box-sizing: border-box` fixes it.

| roll | before | after |
|---|---|---|
| 4in (576px) | fits | fits |
| 3in (448px) | fits | fits |
| 2in (384px) | fits | fits |
| tight (300px) | **301px — 1px over** | 287px, fits |

**And one I caused and caught in the same minute:** the comment I wrote
explaining fix 3 used backticks around `width: 76mm`, inside a JavaScript
template literal. A backtick ends the string. The module stopped parsing
entirely and the page went blank. The comment now says so, in the comment.

## Verified in a running build

All against a real server and a real browser, not asserted.

| check | result |
|---|---|
| `print_after_save` present in the catalogue, default `ask` | ✓ |
| the control renders on Settings → Print, labelled | ✓ |
| **ask** → dialogue, **Print** → prints | ✓ `INV-000011`, popup opened |
| **ask** → dialogue, **Don't print** → nothing prints | ✓ |
| **never** → no dialogue, nothing prints | ✓ |
| **always** → no dialogue, prints | ✓ |
| dialogue names the document and party | ✓ `"Print receipt INV-000011?" · "Cash Sale · Sh 34,440.00"` |
| remember + Don't print → setting becomes `never` | ✓ |
| the next sale then asks nothing | ✓ |
| Escape declines, and does not leak to the page beneath | ✓ dialogue closed, nothing printed |
| Enter accepts | ✓ printed |
| all six new document endpoints return a printable shape | ✓ number, date, party and lines on each |
| voucher at 4in / 3in / 2in / 300px | ✓ fits all four |
| voucher, 2 copies, page break between | ✓ |
| dialogue fits at 1254×596, 1280×600, 1024×640, 900×700, 1707×811 | ✓ every control reachable, remember row 38px |
| React / console errors anywhere in the above | none |

**On the keyboard.** The dialogue takes Escape and Enter in the capture phase
and stops them completely. The till binds window-level handlers for its barcode
burst reader and F-keys, and Create Invoice closes on Escape (C2.3) — without
this, one Escape would both decline the print and close the panel underneath.

## What I measured about layout, and what I did not

I ran a clipped-control audit across viewports and got **6 flagged, at
1280×600 and 1707×811**. Before reporting that as anything, I built the
**baseline** commit and ran the identical audit: **also 6, same distribution**.
So they are pre-existing or false positives of my detector, and unchanged by
this work.

I should be straight about a limit: that sweep only walked two pages per
viewport, because the till has no navigation rail and my walker died there. Once
I saw it was a like-for-like comparison rather than a coverage claim, I did not
spend more on it — this session adds no new page layout. Its only new visuals
are the dialogue (measured at five viewports, above) and one Settings field. A
full rail sweep belongs in the next session, where there will be new pages worth
sweeping.

## Judgement calls

- **Payment drafts get no prompt.** A draft has posted nothing and allocated
  nothing; offering paper for it would hand a customer evidence of a payment
  that has not been made.
- **Instalment plans get no prompt.** A plan is a schedule, not a transaction;
  the instalment *payments* go through the payment path, which is wired. A
  printable signed schedule is a reasonable thing to want and is not built.
- **The invoice dialogue names the party and the line count, not a total.** A
  total computed in the browser is the client's arithmetic before the server's
  tax rules, rounding and offers have run, so it could disagree with the figure
  on the paper being authorised. A confirmation that contradicts its own
  document is worse than one with no figure.
- **Stock takes, shift closes and day closes are not wired.** The first is a
  count rather than a money movement; the other two already produce Z reports
  with their own print.

## Two things worth knowing

- **`purchase_order_lines` was fetched by parent id with no `firm_id`.** Exactly
  the pattern round nine's audit flagged. The parent was scoped, so it was not a
  live hole, but the predicate is now there as defence in depth.
- **The receipt now offered on a refund is the first paper a shop has ever had
  for cash going back across the counter.** That was the single largest gap the
  wiring exposed.

## Still not exercised

- **Physical thermal hardware.** Rendering is verified at four roll widths in a
  browser; real ESC/POS output is not something this environment can drive.
- **The Electron print bridge** (`window.geniusPrint`) — the silent, named-printer
  path. The browser fallback is what was tested.

---

Ready for session 2 (bulk update) when you are.
