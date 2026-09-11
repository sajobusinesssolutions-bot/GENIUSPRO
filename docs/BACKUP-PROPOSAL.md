# Per-company backup and restore — what I suggest

Grounded in the schema as it actually is, not as the round-twelve header
assumed. I enumerated all 65 tables before writing this.

---

## The finding that changes the design

Round twelve refused to build per-firm restore, and its stated reason was that
an import must *"renumber every primary key that collides with a surviving
firm's rows, and re-point every foreign key that referenced the old numbers —
including the ones this schema does not declare."*

That reasoning is sound **for importing a company as a new company**. It does
not apply to the operation people actually need.

**Restoring a company in place needs no renumbering at all.** Primary keys in
this schema are `INTEGER PRIMARY KEY AUTOINCREMENT` on shared tables, so IDs are
unique across the *whole file*, not per firm. Firm B's item #412 is the only row
anywhere with item id 412. So:

> delete firm B's rows → reinsert firm B's rows **with their original ids** →
> every foreign key that was valid before is valid again.

Nothing collides, because the ids being reinserted are ids no other firm ever
held. Nothing needs repointing, because nothing moved. The entire class of
silent corruption round twelve was afraid of — *"an invoice line pointing at the
wrong item still renders"* — is structurally unreachable on this path.

The map is also smaller than feared. Of 65 tables:

| Class | Count | How export finds them |
|---|---|---|
| Firm-scoped (`firm_id` column) | **56** | `WHERE firm_id = ?` |
| Child-only, reached via a parent | **7** | via parent id — and only 5 are real per-firm children: `bom_components`, `production_consumed`, `installment_lines`, `recurring_lines`, plus `audit_logs` |
| Global | **2** | `firms` (the one row), `sequences` |

`users`, `role_permissions` and `audit_logs` are the cross-cutting ones and need
a deliberate decision (below), not a mechanical rule.

**And a second finding, which you should know regardless of this feature:**
there are **zero declared foreign keys in the entire schema** — no `REFERENCES`
clause anywhere in the three setup files. `db.js:36` re-applies
`PRAGMA foreign_keys = ON` after every export, and round ten reported that as
closing a hole where *"an orphan child row was then accepted"*. That pragma is
currently enforcing nothing at all. It is harmless, but it is not the safety net
the comment believes it is.

---

## What I suggest, in one line

**Two operations, not one, shipped in order of how much they protect you.**

### 1. Restore this company (id-preserving) — the safety feature

The button a shop presses when something has gone wrong. Ships first.

- **Export format: a real SQLite file**, not JSON. Full schema, plus only that
  firm's rows, plus one `_export_manifest` table. This is the recommendation I
  feel most strongly about, for a reason that is easy to miss: *a per-company
  export of a single-company installation is byte-for-byte a valid whole-file
  backup.* One artifact serves both paths. It also means round twelve's four
  staged checks (header, 14 identity tables, newer-schema detection, live-vs-
  backup column diff) and `backup.service.js`'s open-and-read verification work
  on it **unchanged** — no second verification stack to keep honest.
- **Import path:** hold the write mutex (round ten), one transaction (round
  eleven), delete the firm's rows across the 56+5 tables in reverse dependency
  order, insert verbatim, commit. Take a **whole-file** pre-restore safety copy
  first — a per-company restore still mutates the shared file, so the existing
  timestamped 10-deep safety copies stay exactly as they are.
- **Never lower `sqlite_sequence`.** Reinserted ids are always ≤ the current
  high-water mark, so leaving the sequence alone is both correct and the safe
  default. Lowering it would reissue an id the restore just wrote.

### 2. Import as a new company (renumbering) — the portability feature

"Move this shop to the new laptop", "clone a company as a template". Genuinely
needs the renumbering machinery round twelve described. Ships **after** #1,
behind its own confirmation, and — my suggestion — never on the recovery screen.
Recovery and migration are different jobs and putting them on one button is what
made whole-file restore dangerous in the first place.

---

## The control totals, which are the actual safety mechanism

Round twelve's real lesson was not "renumbering is hard". It was **"the failure
is silent"**. So the manifest carries figures that are recomputed after import
and compared before the transaction commits:

- row count per table
- invoice count, and the **sum of invoice grand totals**
- ledger debit sum and credit sum (which must also equal each other)
- stock on-hand valuation at cost
- schema fingerprint and app version at export time

A mismatch on any of these rolls back and names which one. This turns a silent
class of bug into a loud one, and it costs one query per figure.

## The classification test, which is what keeps it correct in a year

The single most important durability property here is not in the import code.
It is a test that **enumerates every table in the schema and fails if one is not
classified** as firm-scoped, child-of-a-parent, global, or deliberately excluded.

Without it, the next feature adds table 66, export silently omits it, and a shop
restores a company that quietly lost its warranty claims. With it, adding a
table you forgot to classify breaks the build. I would write this before the
export code, not after.

---

## Three decisions I would like you to make

**1. Do users travel with the company?** A company's export can carry its
`roles` and `role_permissions` (both already firm-scoped) but `users` is global
with an `active_firm_id`. My suggestion: **roles and permissions travel, user
accounts do not.** Restoring a company should not resurrect a sacked cashier's
login or change anybody's password. The importing installation maps access via
the `user_firms` table from session 4.

**2. Does the audit log travel?** My suggestion: **yes, but appended, never
replaced.** An audit log that can be rolled back by a restore is not an audit
log. Same argument as round twelve's `data/restore-history.log`, which was put
outside the database precisely because a row written into a restored database is
destroyed by the next restore.

**3. Keep the whole-file 409 refusal?** My suggestion: **yes, unchanged.** Its
argument is still correct, and once #1 exists the refusal stops being a dead end
— the message becomes "this file holds 3 companies; restore one of them
individually" with a link. The `GENIUS_ALLOW_WHOLE_FILE_RESTORE=1` operator escape
stays for whoever genuinely wants it.

---

## Scheduling and retention

Reuse round thirteen's off-site service rather than building a second scheduler.
Per-company copies land in the same destination as `firm-<id>-<YYYY-MM-DD>.db`,
under the same rules that were already thought through there: attempted every 15
minutes, taken at most once per day per destination, silent skip when the
destination is absent, loud error only when nothing has *ever* landed at that
path. `offsite_keep` applies per company rather than globally, so a five-company
shop does not evict its own history five times faster.

One addition: **a forced per-company export immediately before deleting a
company** (session 4 needs this anyway), written to both the local backup folder
and the off-site destination if one is configured. Deleting a business should be
recoverable for at least as long as an ordinary day's mistake is.

---

## What this changes in the plan

Session 5 gets slightly cheaper and considerably safer than I first wrote it —
the id-preserving path removes the renumbering work from the critical feature
and defers it to the optional one. I would also move the classification test and
the FK finding earlier, into session 4, since session 4 is what makes a second
company possible in the first place.
