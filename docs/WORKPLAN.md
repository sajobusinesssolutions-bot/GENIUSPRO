# Genius POS — work plan for four features

Written after reading `FIX-REPORT.md` (thirteen rounds), `UI-REVIEW.md`, and
surveying the tree. Your answers to the clarifying questions are folded in.
Nothing has been built yet — this is the map, for you to correct before I start.

---

## What the survey found (and why it changes the shape of the work)

**Feature 4 is smaller than it sounds, and feature 4's backup half is bigger.**
The tenant boundary already exists and is already sound:

- `firms` table (`database/setup.billing.js:31`) — the tenant row, with name,
  legal name, TIN, address, logo, invoice prefix, FY start month, `status`
  (`active`), `created_by`.
- `users.active_firm_id` (`database/setup.js:16`) — the active-company pointer
  is already on the user row.
- `shared/middleware/auth.js:34` mints the JWT with `firm_id` from
  `active_firm_id`, and line 49 already refuses a request with no active
  business (`"No active business selected", 403`).
- Round nine hardened `firm_id` scoping across all 60 firm-scoped tables and
  proved it against a live second firm over HTTP.
- `roles.firm_id` exists, so roles are already per-company.

So the multi-company **plumbing** is done. What is missing is: a company CRUD
surface, a per-user company access list, the switcher, the owner role, the
overview panel — and the thing that breaks the moment a second company exists.

**The conflict you accepted, stated plainly.** Round twelve deliberately made
whole-file restore **refuse with 409 when the installation or the backup holds
more than one firm**, and wrote the argument into the header of
`modules/system/system.routes.js`. Today that never fires, because every
installation has one firm. The instant Manage companies ships, every shop that
adds a second company loses its restore button. You chose to build per-firm
export/import so that does not happen — that is session 5, and it is not
optional garnish, it is the thing that keeps this feature from costing people
their books.

**The sticky banner in Settings is already half-gone.** Round eight moved Save
out of a pinned band into `PageDock` at the foot (`Settings.jsx:156`), and the
comment at line 131 records why. What remains at the top of the body is
`.dk-set-head` — a non-sticky card carrying the firm initial, page title and
subtitle. I am reading "the sticky banner be removed entirely" as *that band*,
since it is the only banner left. **Tell me if you meant the dock instead** —
removing the dock means Save goes somewhere else, and "somewhere else" is the
exact bug the shopkeeper photographed.

**Items already has the ⋯ you described** (`Items.jsx:1929`, a Zoho-style menu
with hover submenus for Sort by / Import / Export). Bulk update slots in there
as a new entry, so no new affordance is needed.

**Print already has two independent systems.** `lib/print.js` builds receipts
and invoices in its own `window.open` document; report printing uses the app
stylesheet's `@media print` block. The print dialogue hooks the first.

---

## Decisions on record

| Question | Your call |
|---|---|
| Print prompt scope | Everything that saves a transaction — till, sales documents, purchases and payments |
| Print prompt behaviour | Setting: Always print / Always ask / Never. Default *Always ask*, with a per-save override |
| Bulk update groups | Price list · Names & descriptions · Stock & units · Classification & tax |
| Bulk update apply | Row edits **plus** a bulk-actions bar on selected rows; one Save commits all |
| Company model | One database, many firms, **plus** per-firm backup/restore |
| Panel access | New Owner role + admin; single currency across companies |
| Settings redesign | I propose the regrouping map first, you approve, then I build |
| Delivery | One feature per session, zip + report each time |
| Per-company restore | Id-preserving in place; renumbering import-as-new ships separately (see `BACKUP-PROPOSAL.md`) |
| Export format | A real SQLite file with an `_export_manifest` and control totals |
| Users on restore | Roles and permissions travel; user accounts and passwords do not |
| Audit log on restore | Travels, appended never replaced; the restore itself is logged |
| Zero declared FKs | Orphan-checker test, schema left alone, misleading `db.js` comment corrected |
| Settings banner | The `.dk-set-head` band goes; the `PageDock` Save stays |
| **Hosting** | One SQLite file per company + a central accounts database |
| **Identity** | Two tiers — owners by email, counter staff by username + PIN |
| **Offline** | Read-only offline; selling requires a connection |
| **Billing** | Plan columns from the first migration, nothing built yet |

> **Sessions 4–6 are superseded by the going-online decisions.** See
> `ONLINE-ONBOARDING.md`. Sessions 1–3 are unaffected and go ahead as written.
> The revised arc is 4 (accounts, memberships, invitations, two-tier sign-in and
> the companies UI) → 4.5 (tenant connection manager, per-company files) →
> 5 (per-company backup/restore) → 6 (all-companies panel, now reading several
> files) → 7 (signup, verification, password reset, email delivery, hardening).

---

## The sessions

Six, ordered so each one leaves the app shippable. Sessions 1–2 are
self-contained; 3 depends on nothing but is easier once 1 exists (the print
setting needs a home); 4–6 are the multi-company arc and must run in order.

### Session 1 — Print dialogue

*Depends on: nothing. Touches: `lib/print.js`, a new `lib/printprompt.jsx`, ~14
save handlers, `Settings.jsx` print page, settings catalogue.*

1. New setting `print_after_save` in the settings catalogue: `always` / `ask` /
   `never`, default `ask`. Lives on Settings → Print, which already exists.
2. One shared `askToPrint(doc)` helper in `lib/`. Reads the setting; on `ask`
   it opens a small decision dialog (per §5 of the UI review: *dialog for a
   decision*), yes/no, with the document named — "Print receipt for INV-000012?"
   — and a "don't ask again" path that writes the setting.
3. Wire it into every transactional save: till sale, invoice, estimate, challan,
   credit note, purchase, purchase order, payment in, payment out, expense,
   other income, refund, instalment payment, stock take commit. Each names its
   own document and routes to the right template — thermal receipt for the till,
   A4 for sales documents, voucher for money movements.
4. The till's existing "Confirm & print" keeps working unchanged and does **not**
   double-prompt — it is an explicit print instruction already.
5. Verification: every one of the fourteen paths driven in a browser; prompt
   appears once, prints the right template, and `never` suppresses it silently
   while `always` skips the dialog. Receipt roll widths (576/384/300px) re-checked
   since round five's barcode fix is in this code path.

**Risk:** a save that is told "print" and then fails to print must not report
success for the print. The prompt fires *after* the 200, never before.

### Session 2 — Bulk update

*Depends on: nothing. Touches: `Items.jsx`, a new `pages/BulkUpdate.jsx`, new
backend route `PUT /items/bulk`.*

1. New entry in the existing Items ⋯ menu: **Bulk update**. Opens full screen —
   per §5, it has lines and a total, so it is a document, not a dialog.
2. Four subtitle buttons: **Price list · Names & descriptions · Stock & units ·
   Classification & tax**. Each swaps the column set; the row set and search bar
   are shared.
3. Sticky search bar at top (the one legitimate sticky exception in §5 is a
   table's own heading over its own rows — the search bar sits *above* the
   scrollport, not over it). Filters by name, barcode, category, brand.
4. Price list columns: name (read-only), purchase price, selling price
   (editable), **wholesale price shown and editable only when price lists are
   enabled** — reusing the same `price_lists_enabled` gate Settings already uses,
   so an installation without wholesale never sees a dead column. Margin %
   rendered live per row in the `val-good`/`val-watch`/`val-loss` family — *not*
   the `amt-*` money family; round eight's note about not asserting "received"
   applies here exactly.
5. Bulk-actions bar: select rows via checkbox → raise/lower by amount or
   percent, set margin to X%, round to nearest, set category/brand/tax rule,
   activate/deactivate. Preview of what will change before it commits.
6. One `Save N changes` button at the foot, in a `PageDock` — same component
   Settings uses, so it cannot cover the rows it is saving.
7. Backend `PUT /items/bulk` writes **inside one transaction** and writes an
   audit row per changed item. Round eleven found `PUT /items/:id` could change
   an item with no audit row; the bulk path will not repeat that. Partial
   failure rolls the whole batch back — a half-applied price change across 300
   items is worse than a refused one.
8. Verification: 300-item batch applied and rolled back; concurrent till sale
   during a bulk save (the write mutex from round ten should serialise it, and I
   will prove it rather than assume it); tabular numerals and right-aligned money
   per §3.

**Risk:** this is the first screen in the app that can change every price in the
shop in one click. It gets a confirmation naming the count and the largest
single change, and the audit rows make it reversible by inspection.

### Session 3 — Settings redesign

*Depends on: 1 (the new print setting needs its final home). Touches:
`Settings.jsx`, `deck.css`, and the pages settings move **into**.*

Deliverable is **two** things, and I stop after the first for your approval:

**3a. The regrouping map.** Every setting in the catalogue, listed, with its
current page and proposed page. My starting position, for you to overrule:

- Settings that configure *one screen's behaviour* move next to that screen —
  till behaviour to a Till settings drawer reachable from the POS, item defaults
  reachable from Items, party defaults from Parties — with the Settings page
  keeping a link to each, so nothing becomes unfindable.
- Fourteen top-level pages is the same problem §7 flags for the eighteen-entry
  rail. Target is eight or nine, with related pages merged rather than nested
  (the two-level rule from round eight).
- Likely merges: Units & categories into Item defaults; Loyalty and Online store
  into Modules as gated sub-sections; Taxes and Price lists stay standalone
  because they are list editors, not field pages.

**3b. The build.** The banner card removed, the nesting reduced to §2's two
honest levels (page section, and rows within it), the typography collapsed to
§3's four-step ramp on this page, and the leftover `styles.css` rules touching
Settings folded into `deck.css` per §1.

**Open question for you inside this session:** does the dock stay? I think yes —
it is the fix for a bug you photographed — but "remove the sticky banner
entirely" could be read as including it.

### Session 4 — Manage companies

*Depends on: nothing technical, but ships after 3 so the settings it adds land
in the new structure. Touches: sidebar, new `pages/Companies.jsx`, new backend
`modules/companies`, permission catalogue, auth middleware.*

1. New `user_firms` table — which users may see which companies. Absence of a
   row means no access; the existing `active_firm_id` becomes "the one currently
   selected, and it must be one they have a row for".
2. New **Owner** role alongside admin, and new permissions in the existing
   catalogue: `companies.view`, `companies.create`, `companies.edit`,
   `companies.suspend`, `companies.delete`, `companies.panel`, `companies.grant`.
   Admin grants these like any other permission.
3. Sidebar entry **Companies**, visible only with `companies.view`.
4. The screen: list of companies with status, a company switcher that sets
   `active_firm_id` and re-issues the token, create-a-company flow (name, legal
   name, TIN, address, currency, invoice prefix, FY start — seeded with its own
   chart of accounts, tax rules and roles exactly as first-run setup does),
   edit, **suspend** (blocks sign-in and hides it from the switcher without
   touching a row of data), and delete.
5. Delete is the dangerous one. It gets: a typed confirmation of the company
   name, a forced backup of that company's data first (session 5's export, which
   is why 5 follows immediately), and a refusal if it is the last company or the
   caller's only company.
6. Access management: per user, tick which companies they may enter; per
   company, see who has access. Admin-only.
7. Verification: the round-nine tenant-isolation attack suite re-run with three
   companies instead of two, including the attacks that were vulnerable before —
   a suspended company must be unreachable by token replay, and a user whose
   access is revoked mid-session must be refused on the next request, not at
   next sign-in.

**Risk, and the thing I will not guess at:** every existing installation has
exactly one firm and no `user_firms` rows. The migration must grant every
existing user access to that firm, or everyone is locked out on upgrade. I will
write it, test it against the shipped database, and say so in the report.

### Session 5 — Per-firm backup and restore

*Depends on: 4. Touches: `modules/system`, Settings → Backup.*

The thing that stops session 4 from breaking recovery. Round twelve's refusal
stays for whole-file restore — its argument is sound — and this adds the
per-company path it recommended building properly:

1. `GET /system/export/:firmId` — every row of one company across the 60
   firm-scoped tables, dependency-ordered, as a versioned file.
2. `POST /system/import` — into a **new** company id, renumbering primary keys
   and re-pointing foreign keys, inside one transaction, with a verification
   pass that re-reads the imported company and checks invoice/line/ledger
   totals against the export's own recorded totals before committing. A
   mismatch rolls back and says so.
3. The off-site copy (round thirteen) extended to take per-company exports too.
4. Whole-file restore's 409 message updated to point at this path instead of
   being a dead end.
5. Verification: export company B from a three-company file, import it back as
   company D, prove D's trial balance, stock valuation and invoice count match
   B's exactly, and prove A and C are untouched — the failure round twelve
   caught was silent, so this test is about *other* tenants, not the imported one.

### Session 6 — All-companies panel

*Depends on: 4, 5. Touches: `pages/Companies.jsx`, new backend aggregate routes.*

1. Button inside Manage companies: **All companies panel**. Gated to admin and
   Owner via `companies.panel`, refused server-side, not just hidden.
2. Widgets, single currency, per §2's density and §3's figure ramp:
   - Revenue and profit — per company and combined, with the period picker that
     round eight standardised on.
   - Sales statistics — invoices, average bill, best company, trend.
   - Stock statistics — value at cost, on-hand, dead stock, low stock, per company.
   - Expense statistics — by category, per company.
   - Financial statistics — receivables (with the ageing ramp, not green),
     payables, cash and bank, drawn from the ledger the review notes is invisible.
3. Hand-drawn SVG, per §8 — no charting library.
4. Aggregates computed in SQL across companies in one pass, not N round trips.
   Round ten's index work is the precedent: I will time it at 20,000 invoices per
   company × 5 companies and report the numbers rather than assert it is fine.
5. Truncation follows the `X-Result-Truncated` convention already established.

---

## What I will not do without asking

- ~~Remove the Settings dock~~ — decided: the dock stays, the band goes.
- Touch the till's rhythm — §8 says don't redesign it, and I agree.
- Add a charting library.
- Change the whole-file restore refusal. It is load-bearing.

## Standing verification, every session

Same bar as the previous thirteen rounds, since that is what the codebase is
used to: `vite build`, `check-imports`, `check-layers`, `node --check` on every
backend file, the layout audit at 1280×600 / 1707×811 / 900×700 for zero
unreachable controls, the till live-commit and F6 data-loss scenarios, and the
database restored to its checksum. Each session ends as a git commit on top of
`d8bb389`, a zip, and a report in the style of `FIX-REPORT.md`.
