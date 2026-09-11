# Staff sign-in for hosting — the shop code

Commit `81ab54e`. **9 files, +589 / −47.** Build, `check-imports`,
`check-layers`, **65** unit tests and `node --check` on all 87 backend files:
clean. The shipped database is byte-identical (`md5 3485fb02…`).

**29 API checks and 11 browser checks, in both storage modes, zero failures.**
The session-7 suite still passes 58/58 in both.

This closes the one piece session 4.5 left designed and not built.

---

## The problem, stated plainly

Session 4.5 moved counter staff into their company's own database — the right
call, and the thing that took 36 straddling statements down to 2. It left a
hole it named: **`login` and `login-pin` look a username up before any company
is known.** On a desktop installation that question answers itself; there is
one company. On a server holding many shops it does not, and two shops may each
employ a James.

So the shop is named first, by a short code the owner can write on the counter.

## What a shop code is, and is not

`kampala-hardware`. Derived from the business name, because a code somebody has
to memorise is a code that gets written on a sticky note — and a collision gets
`-2` rather than a random string, for the same reason. Unique across the
installation, case-insensitively: a code differing by one capital letter would
send one shop's cashier at another shop's till.

**It is the name of the door, not the key.** Knowing it gets somebody as far as
a username and password prompt, exactly as knowing a company's web address
does. That is why the sign-in screen may say "we could not find that shop code"
while the route that accepts a password says only ever `Wrong username or
password` — one is throttled and returns nothing but a display name, the other
would otherwise be a way to enumerate every business on the server, one guess
at a time.

**Four ways to say which shop**, in the order they are believed:

1. what the sign-in screen sent (`shop` in the body or query)
2. the `X-Shop-Code` header — an Android build sets it once
3. the subdomain — `kampala-hardware.example.com`
4. **the only company there is**

Four is what keeps every desktop installation exactly as it was. Nobody is
asked for a code that could only have one answer.

---

## Verified — 29 checks, run against both storage modes

Two shops, each with a cashier, built through the API:

| | one file | file per company |
|---|---|---|
| each shop gets its own code | ✓ | ✓ |
| **two shops each employ a "james"** | refused — `username` is unique across a single file | **✓ same username, different files** |
| naming a shop signs the right person in | ✓ `James at shop 1` | ✓ |
| the other code signs the *other* one in | ✓ | ✓ `James at shop 2` |
| no shop named at all | ✓ *"Which shop? Enter the shop code as well."* | ✓ |
| …and the screen is told to ask for one | ✓ `needs_shop` | ✓ |
| **an unknown code answers exactly like a wrong password** | ✓ | ✓ |
| …the same sentence, byte for byte | ✓ | ✓ |
| a mistyped code on the sign-in screen says so plainly | ✓ | ✓ |
| the `X-Shop-Code` header works | ✓ | ✓ |
| the owner can change a code · two shops cannot share one · it must be typable | ✓ | ✓ |

The single-file row is the honest half: `users.username` is UNIQUE across the
whole file, so one installation still cannot have two people called james. That
constraint is real, it is not removed by this work, and it dissolves on its own
when storage is split because the two rows are then in two files. The test says
which world it is in rather than skipping the case.

### The isolation check, and why the first version of it was worthless

> **an administrator still cannot reach the other shop** — ✓ `404 Business not found`

The first version ran as the Salesman, who is refused `companies.view` by
permission. It passed — and it would have passed with every shop boundary
removed, because the refusal came from the permission gate and said nothing
about shops. It now runs as **an administrator of shop 1 holding every
companies permission there is**, proved by having them send an invitation
first. They see one company in the list and are refused the other: not by
permission, but because a staff login has no account and therefore no
membership anywhere else.

That is the ninth time this project has produced a check that could not fail.

---

## Found by looking at the render

**The shop step was a dead end for an owner.** The screen said "an owner signs
in with an email address instead" — and offered nowhere to type one. The one
person who could look up a forgotten shop code was the one person the screen
would not let in. There is now a way through in both directions ("I'm the
owner — sign in with my email instead" / "I work at the counter — enter a shop
code"), and both are checked in the browser.

**The code is remembered once it is known to work.** A cashier types it on
their first morning and never again; a code the server did not recognise is not
stored, or tomorrow would greet them with the same dead end.

---

## Two defects the work turned up

**Creating a second business was broken under split storage.** `POST
/companies` read the new company's Admin role back with `SELECT id FROM roles
WHERE firm_id = ?` — and `roles` belongs to a company, so it went looking in
the database of the company the owner was *standing in* rather than the one
just created, and found nothing. The role now comes back from provisioning
rather than being read back. Single-file installations never saw it because
both companies were in the same file.

**A new company had no shop code** until the next boot's backfill, so its
counter staff could not sign in on a multi-shop installation — and only the
first cashier to try would have found out. Assigned at creation now.

## Not done

- **Per-shop rate limiting.** The sign-in throttle is per IP and per identity;
  a hosted service should also cap attempts per shop code.
- **Wiring the subdomain in the client.** The server accepts it; the sign-in
  screen still sends the code it was given. A deployment serving
  `shop.example.com` should skip the shop step entirely, and that is a
  five-line change once there is a deployment to test it against.
- **A shop code on printed material.** It belongs on the receipt footer or the
  staff card, and nothing puts it there yet.

---

Remaining, in the order I would do them: the **five shortlisted settings** from
session 3, and the **app-wide visual pass**, for which Settings is the template.
