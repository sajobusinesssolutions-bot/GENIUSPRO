# Session 4.5 — one SQLite file per company

Commit `b802032`. **17 files, +1,802 / −439.** Build, `check-imports`,
`check-layers`, **65** unit tests and `node --check` on all 86 backend files:
clean. The shipped database is byte-identical (`md5 3485fb02…`).

**58 API checks and 38 split checks pass in BOTH storage modes; 23 browser
checks pass.** Off unless `SPLIT_STORAGE=1` — every installation shipped so far
keeps one file and never enters this code.

This is the piece hosting actually needs. `db.js` keeps a whole database in
wasm memory and exports the entire file on every committed write: right for one
shop, and inverted the moment shops share it — every shop's sale exports every
other shop's data, the 2 GB ceiling becomes shared (45 years for one shop is
about **three months across two hundred**), and one write mutex makes shop A's
sale queue behind shop B's.

---

## The finding: one table decided the whole design

Before writing any of it I built the classifier and ran it over every SQL
literal in the backend. **36 statements straddled the boundary** — naming
tables from both databases, which no single file can answer.

**33 of the 36 were the same shape**: a company's rows joined to `users` to
print who did it. The cashier on a receipt, who held a bill, who voided a line,
who counted the stock, the entire sales-rep half of Reports.

The obvious placement — `users` is identity, so it goes in the central file —
would have meant splitting 33 reports into two queries each and stitching a
name back on in JavaScript. Thirty-three chances to render "Unknown" where a
person's name belongs.

**Moving one table moved all of them at once.** Counter staff live with the
company they work in — which is what the two-tier identity design already said
in session 4: an *account* is global, a *staff login* belongs to one shop. It
also makes `users.username` unique per company rather than per installation,
which is what a hosted product needs: two shops may both employ a James.

| | straddling statements |
|---|---|
| `users` in the central file | **36** |
| `users` in the company's file | **2** |
| after splitting those two (a role name on a people list) | **0** |

The scan is now `test/storage.router.test.js`, so a statement that straddles
the boundary breaks the build. I proved it fails before trusting it: a planted
`accounts JOIN items` was named by file and line, with both sides listed.

---

## What was built

**`database/router.js`** — the classification, derived from session five's
`tenant.tables.js` so a table added next month cannot acquire a home by
accident. A straddling statement throws by name rather than being handed to
whichever file it happened to reach: a LEFT JOIN across the boundary does not
error, it returns the other side blank, and a screen renders that as "Unknown"
rather than as broken.

**`database/db.js` → `makeStore(path)`** — everything that owns a database (the
handle, the dirty flag, the end-of-turn flush, the transaction depth, the write
mutex, the stuck-lock watchdog, the capacity warning) lifted out of module
state into a factory. A company's file therefore inherits the atomic save and
the transaction-aware flush that took thirteen rounds to get right, instead of
a second implementation learning them again. All forty-five callers still
import `{ query, pool }` and are untouched.

**`database/tenancy.js`** — opens, caches and evicts company files.
`AsyncLocalStorage` carries the company for the life of a request, set by
`verifyToken` *after* it has checked the membership and the firm's status — so
the storage layer is never the thing deciding which shop's books open. Idle
files are closed (flushing first); a file in a transaction or holding its lock
is never evicted, and the cap is exceeded rather than a half-rung sale
destroyed.

**`database/split.js`** — the migration, with the verification that matters.

---

## The migration, and the hour it cost

Each output file starts as a **byte copy of the source** — every table, index
and guarded migration exactly as that shop has it — and then the rows that do
not belong are deleted. Not "create an empty database and insert rows into it":
that way the new file's schema comes from whatever `setup.js` builds *today*,
and a shop three migrations behind would silently gain columns its data has not
got. The schema a shop's data was written under is the schema it must be read
under.

Then every company's file is reopened **from disk** and its control totals —
invoice count and value, purchases, parties, items, both ledger columns, stock
valuation — compared against the same figures read from the source. A mismatch
names the figure and fails the run.

That check earned its keep on the first execution:

```
Split failed: My Business: the copy does not match the original —
  invoices 6 → 0, invoice_total 1695200 → 0, parties 2 → 0, items 2 → 0,
  ledger_debit 3969300 → 0, ledger_credit 3969300 → 0, stock_value 2800000 → 0
```

**`new SQL.Database(buf)` does not copy `buf`.** It hands the same memory to
wasm, so writes through the returned handle mutate the caller's buffer. The
first version opened the central copy from the source bytes, emptied every
company table out of it, and then built each company's file from the same bytes
— which by then held a database with no company data in it at all. **Every
company file came out empty and the run reported progress right up to the
totals.** Without them a shop would have been handed a folder of empty
databases that open, list their own name, and contain nothing.

(The app itself was never exposed: `replaceDatabase` and `openBytes` both copy
already. Only the new code did this.)

---

## Verified — 38 checks on real data, in both modes

Three companies built through the API, each sold something different, then
split:

| | |
|---|---|
| the central file keeps the accounts, memberships and every company's name | ✓ |
| **…and none of the books** | ✓ 0 invoices, 0 items, 0 parties |
| each company's file holds only its own items | ✓ one firm id, and it is theirs |
| …only its own invoices | ✓ |
| …its own roles and its own invoice numbering | ✓ |
| **…and nobody's account or session** | ✓ |
| **every invoice landed in exactly one company's file** | ✓ 3 split, 3 in the original |
| …and there was something to land | ✓ *(the check that stops zero matching zero)* |

That last line is there because the first run passed everything while all three
sales had been refused for a missing sales rep — "0 invoices in the file"
matching "0 invoices expected". Session five hit the identical trap; the fix is
the same and it is now written into the test.

### The application, running on the split

Not a promise — measured. Server booted with `SPLIT_STORAGE=1` against the
migrated files:

```
Storage: one file per company (up to 24 open, idle 10 min).
DB ready, schema ensured — central + 4 companies.
```

| | |
|---|---|
| sign in by email | ✓ |
| items, parties, companies, reports | ✓ all answering from the right file |
| **switching company changes which file answers** | ✓ Alpha → `Widget 1`, Beta → `Widget 2` |
| creating a company (file, schema, provisioning) | ✓ |
| invitations, acceptance, ownership transfer, password reset | ✓ |
| **the whole session-7 suite** | ✓ **58 of 58** |
| …and the same suite in single-file mode | ✓ **58 of 58** |

---

## What the guard found, one refusal at a time

Every one of these was a real defect the boundary made visible, and each is now
fixed rather than noted:

1. **Boot migrated one schema.** With N+1 files there are N+1 schemas, and a
   company left one migration behind does not announce itself — it refuses a
   column at the till weeks later. `setupAll` migrates the central file and
   then every company, naming which one if it fails.
2. **`withFirm` dropped the pin.** Schema work pins a store; `withFirm` built a
   fresh context and lost it, so a new company's `CREATE TABLE`s went wherever
   the router thought each belonged. The file came out empty and the first
   insert said "no such table: roles".
3. **`CREATE TABLE IF NOT EXISTS items` classified as belonging nowhere** — the
   pattern read "IF" as the table name.
4. **An account can only have one `users` row per file.** With one file that row
   moved between companies as the owner switched; with a file per company an
   owner of three shops has to exist in three of them. Created on first entry
   now, which is also what lets an invited owner open a company at all.
5. **A retry after a half-provisioned company could not repair it** — it added a
   second Admin role, read back the first, and collided on `role_permissions`.
   The ordering deliberately leaves a company that exists and is unfurnished;
   that is only useful if furnishing it again is safe.
6. **The company-management routes opened their transaction on the wrong
   database** — they are *about* a company but write `firms`, `memberships` and
   `invitations`, which are central.
7. **Whole-file automatic backups would have been a lie.** With storage split
   there is no whole file: a copy of the central one restores an installation
   with every shop's books missing, while looking in the list exactly like a
   backup. They are switched off in that mode with a message saying what to use
   instead, rather than left running and reassuring.

## The thing that cannot be solved, and is therefore declared

**A transaction cannot span two SQLite files.** There is no distributed commit
to borrow and inventing one on two wasm handles would be a lie. So a write to
the other database from inside an open transaction **throws by name**, and the
operations that genuinely touch both order their writes so a crash between them
leaves something repairable:

- creating a company: the `firms` row commits first, then the file is built —
  a crash leaves a company that exists and cannot be opened, which is visible
  and fixable, rather than a fully-provisioned file nothing knows about;
- the first company, invitation acceptance: the account and the membership
  commit centrally; the staff row and the audit entry are written into the
  company afterwards — the worst a crash costs is a staff row that the next
  sign-in creates anyway;
- the audit entry for a company-management change is written after the commit.
  An audit row for a change that did not happen would be worse than a missing
  row for one that did.

## Not done

- **Staff sign-in on a hosted installation.** `login` and `login-pin` look a
  username up before any company is known, and counter staff now live inside a
  company. It works on a single-shop installation (there is one company to
  ask); hosting many shops needs the shop named first — a subdomain or a shop
  code on the sign-in screen. This is the one piece of the split that is
  designed but not built.
- **Scheduled per-company backups.** The manual per-company export (session
  five) is what a shop has today, and whole-file scheduling is now off in split
  mode rather than pretending.
- **VACUUM does not shrink a file through sql.js**, so the split files are the
  size of the original until the free pages are reused. Cosmetic, and named so
  the next person does not chase it.
- **Timing at scale.** Correctness first: the manager's open/evict costs are
  untested under a hundred concurrent shops, and the number in the report
  should be measured rather than assumed.

---

Remaining, in the order I would do them: **staff sign-in for hosting** (the
open piece above); the **five shortlisted settings** from session 3; and the
**app-wide visual pass**, for which Settings is still the template.
