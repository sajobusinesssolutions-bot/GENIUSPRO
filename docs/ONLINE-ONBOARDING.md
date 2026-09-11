# Going online — identity, onboarding, and the thing that has to be decided first

You asked how to handle email-based onboarding. The onboarding is the easy half
and I have a concrete design for it below. But there is a blocker underneath it
that has to be settled first, because it decides what an "account" even is.

---

## The blocker: sql.js cannot be shared between shops

`database/db.js` runs SQLite in WebAssembly, holds the **entire database in
memory**, and exports the **whole file** to disk on every committed write. One
process, one handle, one global write mutex. Round ten measured what that costs:

| file size | export cost per commit |
|---|---|
| 18 MB | 40 ms |
| 989 MB | ~1 s |

For one shop on one machine this is a good design — round ten put the ceiling at
roughly **45 years of trading at 30 sales a day**, and I believe that number.

Point it at one shared hosted instance and every one of those properties
inverts:

- **Every shop's sale exports every other shop's data.** Shop #200 rings a sale;
  the server writes out the combined file for all 200. Cost scales with the
  *sum* of everyone's data, charged to each individual sale.
- **The 2 GB wasm ceiling becomes a shared ceiling.** 45 years for one shop is
  about **three months** across 200 shops. And it fails as
  `RuntimeError: memory access out of bounds`, which tells nobody anything.
- **One write mutex means shop A's sale blocks shop B's sale.** Round ten made
  that mutex a deliberate property of the storage layer, correctly, for one
  shop. Shared, it is a queue.
- **`loginThrottle` state is in-memory** and its own header says so: move to
  multiple processes and each sees only its share of attempts.
- **A tenant-scoping bug stops being one shop's problem.** Round nine found five
  real cross-firm vulnerabilities in an installation nobody could reach from
  outside. Online, that class of bug is a breach.

So: **do not put many shops in one database file.** Everything below assumes you
won't.

---

## The architecture fork

### A — One SQLite file per company, on your server *(my recommendation)*

A small central **accounts** database holds emails, companies and memberships.
Each company's books stay in their own file, opened on demand and evicted when
idle. `GENIUS_DB_PATH` already parameterises the path, which is most of the way
there.

- Keeps sql.js, keeps the per-shop 45-year ceiling, keeps the write mutex
  meaning what it was designed to mean.
- Keeps `firm_id` scoping as defence in depth — round nine's hardening is not
  wasted, it becomes a second lock rather than the only one.
- **Per-company backup becomes trivial**: the file *is* the backup. This is the
  same conclusion the backup proposal reached from the other direction, which is
  usually a sign a design is right.
- Cost: a tenant connection manager (open, cache, evict, per-tenant write lock),
  and the all-companies panel has to open several files and aggregate — real
  work, but bounded.
- Ceiling: memory. ~30 open shops of 20 MB each is fine; a thousand concurrent
  needs eviction tuning or a move to option C.

### B — Local-first, server as sync relay

Desktop and Android keep their own local database; the server reconciles.
Genuinely the best fit for a shop on Ugandan power and mobile data, and the till
keeps selling when the line is down.

It is also by far the most expensive: offline invoice numbering, conflicting
stock movements, and a ledger that must stay balanced after a merge. Given the
books are double-entry, a naive last-write-wins sync produces a trial balance
that does not balance. **I would not build this first**, but option A does not
foreclose it, and option C partly does.

### C — Postgres, one shared multi-tenant database

The conventional answer, and the one that scales furthest. It is a rewrite of
the storage layer, it costs you the zero-native-dependency property that lets
the same artifact run in Electron and in CI, and it needs a data migration for
every shop already running the desktop build.

**Worth doing eventually. Wrong thing to do at the same time as launching.**

My suggestion: **A now, with the code kept honest about the boundary** — every
query already goes through `query()` / `pool.getConnection()`, so if you keep it
that way, C is a storage-layer swap later rather than an application rewrite.

---

## Identity: two tiers, not one

This is the part I feel most strongly about, and it comes from what a shop
actually looks like rather than from software convention.

**The owner has an email. The cashier does not.** Requiring an email address per
counter staff member means the owner invents `shop1cashier2@gmail.com`, or
worse, shares one login between the counters — which is precisely the case round
eleven had to fix with per-till `X-Client-Id` because it corrupts held bills.

So:

| Tier | Who | Signs in with | Scope |
|---|---|---|---|
| **Account** | Owner, admin, accountant | **Email + password**, verified | Global — one account, many companies |
| **Staff** | Cashier, storekeeper | **Username + PIN**, as today | One company, created by the owner, no email |

The existing `users` table is per-installation with a `UNIQUE` username, which
is right for tier two and wrong for tier one. So:

```
accounts        id, email UNIQUE, password_hash, full_name, status,
                email_verified_at, created_at
companies       (the existing `firms` row, plus owner_account_id)
memberships     account_id, firm_id, role_id, status
                — this is session 4's user_firms, promoted
invitations     token, email, firm_id, role_id, invited_by,
                expires_at, accepted_at
```

**This changes session 4.** `user_firms` should be built as `memberships`
against `accounts` from the start rather than against `users` and retrofitted
later. Retrofitting an identity table after real shops have data on it is one of
the genuinely painful migrations, and we are two sessions away from being able
to avoid it for free.

---

## The onboarding flow

```
1  Sign up          email + password + full name
2  Verify           6-digit code, 15 min expiry  (not a link — the Android
                    app can't reliably catch a deep link, and a code works
                    when the email opens on a different device)
3  Create company   name, currency, TIN, FY start, invoice prefix
                    → seeds chart of accounts, tax rules, default roles
                    → creates the owner membership
4  Invite staff     by email (tier one) or by username + PIN (tier two)
5  Done             lands on the till
```

Notes on the parts that are easy to get wrong:

- **Verify before the company is created, not after.** An unverified account
  that already owns a company is a company you cannot safely delete or
  reassign.
- **A code, not a link.** On Android the email frequently opens on a laptop.
  Codes cross devices; links do not.
- **Signup must not reveal whether an email exists.** "We've sent a code to that
  address" either way, or you have an account-enumeration oracle on a system
  holding shops' books.
- **The company, not the account, is the billable thing.** An accountant with
  five clients has one account and five memberships; charging per account gets
  that backwards.
- **Invitations expire and are single-use**, and accepting one is the only way
  to gain a membership. There is no "request access".
- **Never let the last owner leave a company.** Transfer first, then leave.

---

## Email delivery

You need a transactional provider — verification codes, invitations, password
resets, and eventually the "your last backup was 40 days ago" nudge round twelve
wanted. Postmark or Resend for deliverability and simplicity; SES if cost at
volume matters more than setup time. Whichever, it goes behind one
`sendEmail()` module so it is swappable and so it can be a no-op in tests.

Two things that decide whether the codes actually arrive: **SPF, DKIM and DMARC
on your sending domain**, and **never sending from a Gmail address**. A
verification code in spam looks to the shopkeeper like a broken product.

---

## What hardens the moment this is public

Ranked by what I would do first:

1. **The round-nine tenant-isolation suite becomes the most important test in
   the repo**, and it should run in CI on every commit. Under option A it gains
   a second question: can a token for company X ever cause company Y's file to
   be opened?
2. **`loginThrottle` moves out of process memory** — its own comment predicted
   this. Per-IP, per-email, and a per-account lockout with an unlock email.
3. **Password reset** — single-use, 30-minute, invalidates sessions on use.
4. **Refresh-token revocation.** `auth.js` mints a refresh token with no server
   record, so today nothing can revoke a session. Suspending a company or
   removing a member has to take effect on the next request, not at next
   sign-in. That is already a stated requirement in session 4.
5. **Per-account rate limits on the expensive endpoints** — reports and the
   all-companies panel are the cheapest denial-of-service in the app.
6. **Audit what an owner can see.** An owner joining a company they were invited
   to gets its books. Make sure "invited as a cashier" cannot read the ledger,
   and prove it rather than assume it.

## Android

The API is already REST and already token-based, so a native or React Native
client is mostly UI. Three things to decide early because they are expensive
later: whether the app must sell while offline (that is option B, and it is a
different product), how the barcode scanner works (camera vs a paired hardware
scanner), and whether receipts print to a Bluetooth thermal printer — which is
a different code path from `lib/print.js`'s `window.open`, and is the single
most likely thing to be discovered late.

---

## Decided

| Question | Your call |
|---|---|
| Storage | **A** — one SQLite file per company, central accounts database |
| Identity | Two tiers — owners/admins by email, counter staff by username + PIN |
| Offline | **Read-only offline.** Catalogue, prices, stock and reports cached and viewable; anything that writes money requires the line |
| Billing | Schema carries plan/status/limits from the start; no billing built yet |

**On read-only offline — the one thing that makes it dangerous.** A cached stock
figure shown without qualification is a lie the moment the line drops: the shop
reads "80 BAG in stock" from an hour ago and promises it to a customer. Every
cached surface has to say when it was last true, and the till must refuse to
open rather than appear to work. This is the same principle as round nine's
finding that a failed read must not render as `Sh 0` — a stale figure and a
suppressed one are different, and only one of them is honest. Cheap to do
correctly if it is designed in from the first screen; nearly impossible to
retrofit across 26 pages.

**On billing.** `accounts` and `companies` carry `plan`, `plan_status`,
`company_limit` and `trial_ends_at` from the first migration, nothing reads them
yet, and no payment provider is chosen. Adding columns to an identity table
after real shops depend on it is the expensive version of this.

## Suggested revision to the plan

Sessions 1–3 (print, bulk update, settings) are unaffected — go ahead as
planned. Sessions 4–6 change:

- **Session 4** builds `accounts` / `memberships` / `invitations` rather than a
  local-only `user_firms`, and the two-tier sign-in. Same UI, identity model
  that survives going online.
- **New session 4.5**: the tenant connection manager and per-company files.
- **Session 5** (per-company backup) gets *simpler* under option A — the file is
  the export — but the id-preserving restore work stays, because that is what a
  shop needs when it wants yesterday back rather than a new machine.
- **Session 6** (all-companies panel) reads several files instead of one query.
  Same widgets, different plumbing.
- **New session 7**: signup, verification, invitations, password reset, email
  delivery, and the hardening list.
