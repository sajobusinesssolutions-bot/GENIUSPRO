# Session 5 — per-company backup and restore

Commit `fb89042`. **11 files, +1,326 / −22.** Build, `check-imports`,
`check-layers`, **44** unit tests and `node --check` on every backend file:
clean. The shipped database is byte-identical (`md5 3485fb02…`).

**This is the session that makes session 4 safe to ship.**

---

## What it fixes

Round twelve made whole-file restore refuse on any installation holding more
than one company, and was right to: firm B restoring its own backup deleted
firm A, measured. The refusal never fired, because every installation had one
company — until Companies shipped, at which point the first shop to add a second
business loses its recovery button.

That is now a path that works, not a dead end.

## The finding the whole design rests on

Round twelve declined to build per-firm restore because an import must
*"renumber every primary key that collides with a surviving firm's rows, and
re-point every foreign key that referenced the old numbers"*. True — for
importing a company as a **new** company.

Not true for restoring one **in place**. Primary keys here are `INTEGER PRIMARY
KEY AUTOINCREMENT` on shared tables, so ids are unique across the whole file,
not per company: firm B's item #412 is the only row anywhere with item id 412.
So delete B's rows, reinsert them with their original ids, and every foreign key
that was valid before is valid again. Nothing collides. Nothing needs
re-pointing. The entire class of silent corruption round twelve feared — *"an
invoice line pointing at the wrong item still renders"* — is **structurally
unreachable** on this path.

## The safety mechanism

Round twelve's real lesson was not "renumbering is hard". It was that **the
failure is silent**.

So the export carries control totals — invoice count and the sum of grand
totals, both ledger columns, stock valuation, party and item counts, per-table
row counts — drawn deliberately from documents, the ledger *and* stock, because
a bug losing rows from one would be invisible in the other two. The restore
recomputes them inside the transaction and **rolls back on any mismatch**,
naming which figure was wrong. It also checks the restored ledger still balances
with itself, which the totals alone would miss if both sides were short by the
same amount.

---

## The classification map, and why it came first

`shared/tenant.tables.js` classifies all **69 tables** as firm-scoped,
child-of-a-parent, firm-keyed, or deliberately excluded with the reason written
down. `test/tenant.tables.test.js` walks the live schema and fails the build
when one is unclassified — in **both** directions, since a table renamed without
updating the map would be exported as nothing at all, silently, and the export
would still report success.

I wrote the test before the export code, and it earned its keep on the first
run: **I had guessed eight table names wrong and missed four real ones.** Those
four — `app_updates`, `party_item_rates`, `recurring_runs`, `void_log` — would
have been quietly absent from every company backup.

**What travels:** the company row, its documents, stock, parties, ledger,
settings, roles and permissions, and its invoice numbering (`sequences` is keyed
`INV:firm3` — a restored company that started at INV-000001 again would collide
with its own history and `UNIQUE(firm_id, invoice_no)` would refuse the sale at
the till).

**What does not:** accounts, staff logins, memberships, invitations, sessions —
per your decision. A restore must not resurrect a sacked cashier's login, revert
a password, or re-grant access somebody was removed from. The audit log travels
but is appended, never replaced.

---

## Verified — and the test is about the *other* tenants

Three companies in one file. B given six items, opening stock and three real
sales, then exported, then deliberately damaged (three items renamed and
repriced, one added), then restored.

| | |
|---|---|
| company B exports | ✓ 647 KB, 3 invoices named in the response header |
| the file is a real SQLite database | ✓ |
| …that opens on its own | ✓ 3 invoices inside |
| …holding only company B | ✓ one firm id among its items |
| …and **no account or staff rows** | ✓ people do not travel |
| …**but its roles and permissions do** | ✓ |
| a file that is not a database is refused | ✓ |
| **B's backup is refused for company C** | ✓ *"That backup is of "Shop B"… and this one is "Shop C""* |
| B's backup is accepted for B | ✓ totals: 3 invoices, 6,000 total, ledger 188,550 / 188,550, stock 178,950 |
| the restore succeeds | ✓ |
| **company B is back exactly as it was** | ✓ |
| **company A was not touched** | ✓ 2 items · 6 invoices · debit 3,969,300 — identical |
| **company C was not touched** | ✓ identical |
| the item added after the backup is gone | ✓ |
| the renamed items are back | ✓ |
| a whole-file safety copy was taken first | ✓ `pre-restore-…db`, 639 KB, verified on disk |
| the restore is recorded outside the database | ✓ appended to `restore-history.log` |
| sign-in still works afterwards | ✓ accounts were not rolled back with the company |

The last three rows of the middle block are the point. Round twelve's failure
was **silent and it was about the other tenants** — firm B's item count went
1 → 0 with a 200 OK and nobody told. This test asserts A and C are byte-for-byte
unchanged, read straight off the file rather than through the API.

### And session 4's open item, closed

| | |
|---|---|
| deleting a company works | ✓ *"Shop C deleted. A copy was kept as deleted-Shop-C-….genius.db"* |
| **a copy is forced before deletion** | ✓ 647 KB written before anything is destroyed |
| deleting it again is refused | ✓ |

The delete now takes a per-company export first and **refuses to proceed if the
copy cannot be written**. Session 4 shipped without this and said so: the typed
name was the only thing between a shop and permanent loss. A confirmation stops
the wrong click; it does nothing about the right click made for the wrong
reason, which is the one people ring up about.

---

## Three more things fixed

**The whole-file 409 no longer dead-ends.** It used to say restoring is only
possible on a single-business installation and stop there. It now names the path
that works: Companies → the business → Restore.

**An orphan checker, because the pragma enforces nothing.** Session 3 found the
schema declares **no foreign keys at all** — not one `REFERENCES` clause — so
`PRAGMA foreign_keys = ON`, which `db.js` carefully re-applies after every save,
has never enforced anything. Declaring them would mean a table rebuild per
constraint and would make any existing orphan start hard-failing writes at the
till. So the check lives in the test suite: 18 relationships, and it reports when
it had no database to check rather than passing silently.

**The shipped database is clean** — zero orphans. And I proved the check can
fail before trusting that: planting one orphaned invoice line and one orphaned
stock row made it fail, naming both precisely.

The misleading comment in `db.js` is corrected in place rather than deleted,
because the correction is the useful part.

---

## A test-harness bug worth naming

`tiny-test` was synchronous. An `async` test body returned a promise nobody
awaited, so **the test was recorded as passing the instant it started**, and
anything it went on to assert reported after the summary had printed — or not at
all. My orphan test was the first async one in the suite, and it hid its own
result. The runner now queues async bodies and awaits them in order.

That is the fourth time this project has produced a check that could not fail.
The pattern is consistent enough to be worth stating: **when a new test passes
first time, assume it is broken until you have made it fail on purpose.**

## Two smaller test bugs, same session

- My verification looked for the safety copy in `backend/data/backups/` while
  the server was running on a database in `/tmp` — so it reported a real 639 KB
  file as missing.
- B had no stock, so all three sales were correctly refused by
  `prevent_negative_stock`, leaving every control total at zero. **Zero matches
  zero no matter what the restore does.** The test now stocks B first, so the
  totals are 3 invoices and a 188,550 ledger and the assertions mean something.

---

## Not done

- **Import as a new company.** The renumbering path — "move this shop to a new
  laptop", "clone a company as a template". Deliberately separate, and
  deliberately not on the recovery screen: recovery and migration are different
  jobs, and putting them on one button is what made whole-file restore
  dangerous.
- **Per-company off-site copies.** The proposal called for extending round
  thirteen's off-site service to write `firm-<id>-<date>.db` alongside the
  whole-file copy. The manual export, the forced copy on delete, and the
  whole-file off-site schedule all work; the automatic per-company one does not
  exist yet. This is the largest remaining gap in the feature.
- **Restoring a deleted company.** The forced copy is written, and it is a valid
  per-company export, but nothing in the interface will import it into a fresh
  company — that needs the import-as-new path above. Today it is recoverable by
  somebody with file access, which is better than gone but not good enough.

---

Session 6 next: the all-companies panel — revenue, profit, stock and receivables
across every business, gated to admin and owner.
