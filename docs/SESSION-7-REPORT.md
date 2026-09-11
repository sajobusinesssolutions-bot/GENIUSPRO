# Session 7 — the door: sign-up, verification, invitations, password reset

Commit `ab16337`. **16 files, +2,057 / −11.** Build, `check-imports`,
`check-layers`, **56** unit tests and `node --check` on all 81 backend files:
clean. The shipped database is byte-identical (`md5 3485fb02…`).

**58 API checks and 23 browser checks, zero failures.**

Six sessions built a multi-company application for people who were already in
the database. This is how anybody else gets in.

```
sign up  →  six-digit code  →  first business  →  invite staff
```

---

## The vulnerability this session found in its own code

I wrote the guess-limit test expecting it to pass. It failed, and the reason is
worth more than the feature.

`checkCode` counts a wrong guess by writing `attempts = attempts + 1`. The
verify route ran inside `durable()`, which **rolls the transaction back
whenever the handler refuses** — deliberately, because "a refusal is not a
partial save" is right for every business write in this application. But the
guess counter is written *by* the refusal. So every wrong guess was counted and
then rolled straight back:

```
That code is wrong. 4 tries left.
That code is wrong. 4 tries left.
That code is wrong. 4 tries left.      ← forever
```

**A six-digit code could be walked through all million values.** The guess limit
is the only thing that makes a six-digit secret safe against an attacker, and it
was the one thing being undone. Codes are now checked *before* the transaction
opens; the rest of the handler still runs inside it. The reasoning is written
into the file header so the next person to tidy this does not tidy it back.

It is the **eighth** time in this project that a check passed when it could not
fail, and the second time this session — see "the administrator who was not an
administrator" below. The rule from session five held again: *when a new test
passes first time, assume it is broken until you have made it fail on purpose.*

---

## What was built

**Sign-up.** Email, password, name → a code → the first business. Verified
before the business exists, because an unverified account that already owns a
company is a company nobody can safely delete or reassign.

**A code, not a link.** Fifteen minutes, single-use, five guesses, hashed at
rest, and issuing a new one kills the old one so "resend" cannot be used to hold
five live codes and multiply the guess budget by five. On Android the
verification email frequently opens on a laptop; a code crosses devices and a
deep link does not.

**Invitations.** 32 random bytes, stored only as a SHA-256 digest, single-use,
seven days, withdrawable. They work whether or not the person has an account —
which is the point, since `POST /people` could only ever add somebody who
already had one. Receiving the token at that address *is* proof of address
control, so an invited stranger does not also have to verify by code; an
invitation to an address that already has an account still requires that
account's password, or an intercepted link would let somebody attach an
established account to a company of their choosing.

**Password reset**, and **change password** from inside. A reset ends every
session on the account. Changing the password from inside ends every session
*except the one doing it* — somebody changing their password because a laptop
was stolen wants the laptop signed out; being signed out of the screen they are
typing on teaches them nothing.

**Handing a business over.** The revoke route has told people to "transfer the
business first" since session four and nothing did. A company now has exactly
one owner at all times: nought is a company nobody can rescue, and two is two
people no role can restrain.

**One `sendEmail()`.** Postmark, Resend, SMTP or a console log, chosen by
`EMAIL_PROVIDER`, with every attempt recorded in `email_outbox`. "The code never
arrived" is the commonest onboarding support call and this is what turns it from
a shrug into an answer.

---

## The hardening list, closed

| From the going-online plan | |
|---|---|
| **`loginThrottle` out of process memory** | ✓ in the database — several processes see one set of attempts, and a deploy is no longer an amnesty |
| …and keyed on the email tier too | ✓ the owner tier — the one holding every company — had no per-account limit at all |
| **Password reset, single-use, invalidates sessions** | ✓ |
| **Refresh-token revocation** | ✓ and it was worse than recorded — see below |
| Per-account limits on expensive endpoints | ✗ not done, still open |

### The refresh token walked past every control

Session four added session revocation and `verifyToken` re-reads it on every
request. `POST /auth/refresh` verified the signature and minted a new pair —
**nothing else**. So an ended session, a suspended business and a removed
membership all bit on the access token, and the holder refreshed straight past
every one of them for the next thirty days. The revocation mechanism was
ornamental for anybody who kept a tab open.

Refresh now re-reads the same three things a request does, and carries the
`jti` through so the new token belongs to the same session the old one did.

> *and the refresh token cannot walk past it* — ✓ `This session has been ended. Sign in again.`

---

## The administrator who was not an administrator

The first version of "a non-owner cannot hand the business to themselves" ran
as somebody with no `companies.grant` at all. It passed — with
`Not allowed to grant companies`, from the permission gate, which says nothing
whatever about ownership. **It would have passed with the owner check deleted.**

The check now makes the person an administrator first, proves they really hold
`companies.grant` by having them send an invitation, and only then asserts the
refusal:

> *an administrator really does hold companies.grant* — ✓ invitation sent
> *an administrator still cannot hand the business to themselves* — ✓ `Only the owner can hand over a business`
> *refused for ownership, not for permission* — ✓
> *nor invite a second owner* — ✓ `Only the owner can invite another owner`

---

## Verified — 58 checks against a running server

The codes are read out of the server's own log, which with
`EMAIL_PROVIDER=console` *is* the delivery mechanism. Nothing in the test can
see a code any other way, which is what makes the claims about hashing and
single use mean something.

| | |
|---|---|
| sign-up is accepted, weak passwords and bad addresses refused | ✓ |
| **the answer never says whether the address is known** | ✓ same sentence, byte for byte |
| **sign-up cannot be used as a password reset** | ✓ the taken address's password is unchanged |
| a wrong code says how many tries are left | ✓ |
| the same code cannot be used twice | ✓ |
| **five wrong guesses burn the code** | ✓ and the real code then fails |
| verification hands back no session, because there is no business yet | ✓ ticket only |
| **the ticket cannot be replayed to mint a second business** | ✓ 409 |
| a brand-new account lands with a provisioned company | ✓ owner, one business, `/api/items` answers |
| an invitation creates the account and the membership together | ✓ |
| …is single-use | ✓ · …can be withdrawn | ✓ |
| …and the invited person sees exactly one business | ✓ |
| forgotten password: identical answer, known address or not | ✓ |
| **the reset ends every session** | ✓ · **and the refresh token too** | ✓ |
| change-password requires the current one | ✓ · keeps its own session | ✓ |
| **nine attempts on one address are throttled** | ✓ 429 on attempt 9 |
| …and a different account is unaffected | ✓ |
| ownership transfer: owner only, both parties signed out | ✓ |

### In the browser

| | |
|---|---|
| the sign-in screen offers sign-up and password recovery | ✓ owner tier only |
| the three-step sign-up runs end to end | ✓ |
| **a pasted six-digit code fills all six boxes** | ✓ |
| **a stranger reaches the inside of the app** | ✓ |
| the invitation link opens a join screen naming the business | ✓ |
| the access modal lists waiting invitations and offers withdrawal | ✓ |
| React / console / request errors | none |

| viewport | clipped controls | horizontal overflow |
|---|---|---|
| 1254×596 | **0** | no |
| 1024×640 | **0** | no |
| 1707×811 | **0** | no |

---

## Found by looking at the render

Three things no assertion caught. This is the eighth session in a row that step
has earned its place.

**The sign-up screen had no button.** The primary action was rendered only once
every field was valid, so a stranger's first screen showed three empty boxes and
one link reading "I already have an account" — nothing saying what happens next.
A disabled button teaches; a missing one confuses. Every panel now renders its
action and disables it.

**The screen contradicted itself in one glance.** A green toast reading
*"Invitation sent to brian@…"* sat directly above a panel reading *"nothing was
sent."* Both were "true": the server reported `sent` because the console
provider had printed it. "Sent" now means a mail provider accepted it.

**Invitation links pointed at `localhost:5173`.** The default `APP_URL`, on an
installation that had not set one — a link that works on the machine that sent
it and nowhere else, which is the worst kind of broken because the sender sees
it work. The link is now built from the address the request actually arrived on
unless `APP_URL` says otherwise.

---

## One thing fixed in passing, and why the rail counts were empty

The badge counts on the rail loaded on `[page]` only, and signing in lands on
the page already selected — so the effect did not re-run and the counts stayed
empty until the first navigation. It now depends on `user` as well, and does not
fire before somebody has signed in.

---

## Not done

- **Per-account rate limits on the expensive endpoints.** Reports and the
  all-businesses panel remain the cheapest denial of service in the app. The
  throttle infrastructure to do it now exists.
- **A real mail provider.** `EMAIL_PROVIDER` defaults to `console`. Choosing
  Postmark, Resend or SES is a decision with a cost attached, and it needs SPF,
  DKIM and DMARC on a sending domain before the first code goes out.
- **The tenant connection manager** (one SQLite file per company) — session 4.5
  in the going-online plan, and still the largest piece between here and hosting
  more than one shop.
- **The pre-existing e2e suite is not green**, and was not before this session
  either: three specs time out clicking the rail. I verified this by stashing
  every change and running `cashbank` at session six's commit — **6 failed, 100
  passed**, the same failures. Not caused by this work, and not fixed by it.

---

Remaining, in the order I would do them: the **per-company files** (session
4.5), which is what hosting actually needs; the **five shortlisted settings**
from session 3; and the **app-wide visual pass**, for which Settings is still
the template.
