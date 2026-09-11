# Session 4 — Manage companies

Commit `0a54bd5`. **15 files, +1,599 / −33.** Build, `check-imports`,
`check-layers`, 34 unit tests and `node --check` on every backend file: clean.
The shipped database is byte-identical (`md5 3485fb02…`).

**46 backend checks and 13 browser checks, zero failures.**

---

## Built against the going-online decisions, not as a local feature

Per the decisions from the onboarding discussion, this is `accounts` /
`memberships` / `invitations` from the start rather than a local-only
`user_firms` we would have had to migrate under real shops later.

| table | what it holds |
|---|---|
| **accounts** | email + password, global, one account across many companies. Carries `plan`, `plan_status`, `company_limit`, `trial_ends_at` from the first migration — read by nothing yet, but adding columns to an identity table after shops depend on it is the expensive version |
| **memberships** | which account may open which company, in what role, and whether they own it |
| **invitations** | the token table for the email invite flow that lands in session 7 |
| **sessions** | so a session can be **ended** |
| **users** | unchanged — counter staff, now with an `account_id` link |

### Two tiers of sign-in

Owners, admins and accountants sign in **by email** and may hold several
businesses. Counter staff keep **username and PIN**, belong to one business, and
are never asked for an email address they do not have.

That is not a simplification. Requiring an email per cashier means the owner
invents `shop1cashier2@gmail.com`, or — commonly — shares one login between two
counters, which is exactly the case round eleven had to fix with per-till
`X-Client-Id` because it corrupts held bills.

---

## The security change that mattered most

`verifyToken` trusted the token completely: signature, expiry, nothing else.
That is fine when the only things a token asserts are permanently true. It stops
being fine the moment a business can be suspended or somebody's access revoked —
**neither would have taken effect until the holder's token expired, up to two
hours later.** "Suspended" does not mean "suspended in a couple of hours".

It now re-reads three things per request, all indexed local lookups: the
company's status, the membership, and whether the session has been ended.

**Measured, on the same token:**

| | |
|---|---|
| a token for Second Shop works | ✓ |
| the owner suspends it | ✓ |
| **the same token, immediately afterwards** | ✓ refused — `403 This business has been suspended. Ask the administrator.` |
| a second account is given access, and reaches the company | ✓ |
| **their access is revoked; the same token, immediately afterwards** | ✓ refused — `403 Your access to this business has been removed` |

The order of the three checks is deliberate and I got it wrong first. Suspending
and revoking both end the holder's sessions, so with the session check first
*every* one of those answered "this session has been ended" — true, and useless:
it sends a shopkeeper to reset a password that was never the problem. Company
and membership are checked first so the reply names the actual reason; a
genuinely ended session still falls through and says so.

---

## A permission nobody could ever have

Found while making the attack tests strict: **`companies.grant` and
`companies.panel` could not be granted to anyone, by any means.**

Role seeding walks `MODULES × ACTIONS` — view, create, edit, delete. Those two
permissions are none of the four, so seeding skipped them, and the roles screen
can only tick what a role has room for. They existed in the catalogue and were
unreachable.

The Admin set is now derived from the catalogue itself, so a permission invented
later is granted automatically instead of being silently unreachable until
somebody notices. Existing installations are topped up on boot — scoped to roles
named Admin and marked `is_system`, so a hand-built "Manager" role deliberately
given less is left exactly as it is.

Without this, the owner of an upgraded shop would have found the Companies
screen refusing them by permission, on their own business.

---

## The migration

Every installation in the field has `users` rows, one `firms` row, and no
accounts. If sign-in started requiring a membership before those existed,
**everybody would be locked out of their own books by an update they did not
ask for.**

Each existing user becomes an account and gets a membership for the firm they
were already using; the first becomes its owner. Emails are obvious placeholders
(`admin@local.invalid`, marked unverified) rather than plausible inventions.
Username + PIN sign-in is untouched, so a shop that upgrades on a Tuesday opens
the till exactly as it did on Monday.

Tested against the shipped database, twice:

```
accounts:    admin@local.invalid (Administrator), sales@local.invalid (Sales Rep)
memberships: account 1 → firm 1, owner;  account 2 → firm 1
users:       2 (untouched)
second run:  accounts 2, memberships 2      ← idempotent
```

---

## Tenant isolation, with three companies

Round nine's method, and the reason for it: **the attacker holds every
permission in its own company** — 46 of them — so nothing can hide behind RBAC
and every refusal has to come from firm scoping.

My first version of this test did not do that. It signed in as the account that
had created *both* companies and checked it could not manage the other one —
which is not an attack, it is one owner managing their own two businesses, and
it is supposed to work. **Had the roles been reversed, that test would have
reported a real vulnerability as a pass.**

Rewritten with a genuinely separate account owning only company B:

| attempt as company B | result |
|---|---|
| read firm A's item | ✓ `404 Item not found` |
| edit firm A's item | ✓ `404` |
| delete firm A's item | ✓ `404` |
| **bulk-edit** firm A's item (session 2's endpoint) | ✓ `404 1 of the 1 items in this batch could not be found` |
| put firm A's item on B's own invoice | ✓ `400 One of these lines refers to an item that isn't in this business` |
| rename firm A | ✓ `404 Business not found` |
| list who can open firm A | ✓ `404` |
| suspend firm A | ✓ `404` |
| delete firm A, with the right name typed | ✓ `404` |
| switch into firm A | ✓ `404` |
| grant itself access to firm A | ✓ `404` |
| **empty firm A's Admin role** — round nine's worst finding | ✓ `404 Not found` |

Every refusal is **404, not 403**, so the reply does not confirm which other
businesses exist on the installation.

## The rest, verified

| | |
|---|---|
| username + password sign-in still works after the migration | ✓ |
| email sign-in works for an adopted account | ✓ |
| an unknown email is refused **identically** to a wrong password | ✓ — no account-enumeration oracle |
| a created company has its own chart of accounts | ✓ 15 |
| …its own units, and a walk-in customer so it can ring its first sale | ✓ |
| …and none of anybody else's stock | ✓ 0 items |
| a duplicate company name is refused, case-insensitively | ✓ |
| delete: a mistyped name refuses | ✓ |
| delete: the exact name works, and it leaves the list | ✓ |
| suspending the only company you can open is refused | ✓ |

### In the browser

| | |
|---|---|
| the sign-in screen offers both tiers | ✓ Owner — email · Username |
| signing in by email from the screen | ✓ |
| Companies is in the sidebar | ✓ |
| the list, names in sentence case, status as a **word** | ✓ |
| the open business is marked on its row | ✓ |
| creating a business from the screen | ✓ |
| **switching actually changes the open business** | ✓ |
| the business just opened has none of the other's stock | ✓ |
| the owner cannot be removed from the people list | ✓ |
| React / console errors | none |

---

## Three things I got wrong and caught

**1. Switching didn't switch.** The screen called `/companies/switch`, which
updated the server, and then reloaded — with the *old* token, still naming the
old company. The server had switched and the client had not, which is worse than
not switching, because the screen says one business while the data is another's.
My own comment claimed it "re-issues the session"; it didn't. The endpoint now
returns a whole new session built by the same `sessionFor` the three sign-in
paths use, so a switched session and a fresh one cannot drift.

**2. The rail entry was invisible.** `NAV` governs permissions and module
switches; `RAIL` governs what is on screen. I added the entry to one and not the
other, so Companies was reachable and unlistable.

**3. A new company dropped its owner into the first-run wizard**, asking them to
type again the name, TIN, address and prefix they had entered thirty seconds
earlier — on a screen with no way back. A company created from the Companies
form is marked set-up-done; one created by `seed.js` is untouched.

---

## Decisions worth knowing

- **A suspended business is listed and marked, not hidden.** One that vanished
  would read as deleted.
- **The owner is not a role.** `is_owner` is on the membership, read from the
  database each request. A role is a set of permissions an admin edits, and an
  owner who could be edited out of their own books is a support call with no
  resolution short of the database.
- **Deleting requires the name typed back in full.** Every other guard can be
  clicked through. It also refuses the last company on the installation and the
  caller's only company.
- **Deleting deactivates staff rather than removing them**, because their id is
  on audit rows and a dangling user id reads as "unknown" forever.
- **Switching does a hard reload.** Every screen holds data for the company it
  was opened with; re-fetching some while others keep the old company is how one
  shop's stock ends up on another's screen.

## Not done — and the one that matters

- **Deleting a company still has no forced export.** The plan called for one,
  and it depends on session 5's per-company export, which does not exist yet.
  **Until session 5 ships, a deleted company is gone.** The typed-name
  confirmation is the only thing standing between a shop and that, which is
  thinner than I would like.
- **Whole-file restore now refuses on any installation with two companies** —
  the round-twelve behaviour, now reachable for the first time. This is exactly
  the landmine flagged in the original plan, and session 5 is what defuses it.
  **I would not ship session 4 to a real shop without session 5.**
- **Invitations are a table, not a flow.** Access is granted directly to an
  account that already exists. The email invite lands in session 7.
- **No signup.** Accounts are created by the migration; there is no way to make
  a new one yet. Also session 7.

---

Session 5 next: per-company backup and restore — the id-preserving path, which
is what stops this feature from costing somebody their books.
