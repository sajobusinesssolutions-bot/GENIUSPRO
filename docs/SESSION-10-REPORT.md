# The spacing scale — and what `styles.css` is really doing

Commit `9ecbeae`. **5 files, +1,092 / −928.** Build, `check-imports`,
`check-layers`, **73** unit tests: clean. The shipped database is
byte-identical (`md5 3485fb02…`).

**Every control reachable, no sideways scroll, on 10 pages × 4 viewports.**
Settings (13), onboarding (23) and the API suites still pass; the type audit is
unchanged, which is the point — this pass moved spacing without disturbing
type.

---

## Spacing, measured the same way

**43 distinct pixel values** across the two stylesheets — every whole number
from 1 to 20, and a 2.5. Nobody chose 9 over 8, or 13 over 12; each screen used
what looked right that afternoon.

It is now a 2px grid to 24, then a coarser one, written into `deck.css` beside
the type scale:

```
1                a hairline nudge, not spacing
2 4 6 8 10 12    inside a control, between a label and its field
14 16 18 20      inside a card, between rows of a form
22 24            a card's own padding
28 32 40 48 56   between sections, and page margins
80               the few places a screen is deliberately empty
```

**43 → 19 steps. Nothing moved by more than 2px**, which is exactly why it was
safe: the variance was never carrying meaning. What it costs to keep is a
decision on every future change; what it costs to remove is nothing.

## The density claim I went looking for, and did not find

The review says the app is *"too loose in the places that matter"* and asks for
rows of 40–44px. Measured, the rows run 45 to 68:

| | row height |
|---|---|
| Reports | 45px |
| Dashboard, Parties | 52px |
| Sales | 55px |
| Cash & bank | 65px |
| Items | 68px |

That looks like drift and is not. Every one of those tables uses the same
`13px 24px` cell padding and the same 20.25px line height. **The heights differ
because the content differs** — a party row carries a monogram, an item row
carries a thumbnail, a money row carries a second line. Reports, which is a
grid of numbers and nothing else, is already at the 45px the review asked for.

So I did not shrink them. Tightening padding to make the numbers match would
have taken 4px off a row that needs it because a 26px avatar is in it, and
called the result density. The one real inconsistency — Reports' table using
`12px 20px` where every other table uses `13px 24px` — is the sort of thing
this pass is for, and it is on the scale now.

---

## `styles.css`: the review's first recommendation, tested

> *"Finish killing `styles.css`. Every rule in it is either dead or a landmine."*

I built two tools rather than trusting that.

**`e2e/deadcss.mjs`** walks the running app and asks, per selector, whether
anything anywhere matches it. Two refinements make its answer worth acting on:
a pseudo-state selector is tested by its base (`.btn:hover` never matches a
resting page and is not dead), and a selector is only called dead when the
application's source never mentions its class either — because the walk does
not open every modal.

| | |
|---|---|
| selectors in `styles.css` | **743** |
| live — matched on a walked page | 148 |
| named in the source but not seen (modals, empty states) | 532 |
| **dead on both counts** | **60** |

All 60 are gone: an old payment screen (`.pay-*`), a dead landed-cost editor
(`.landed-*`), superseded skeletons (`.sk-*`), chips and nav items replaced by
their `dk-` equivalents. `dead on both counts` now reports **0**.

## And the part of the recommendation that turns out to be wrong

**`e2e/cssinfluence.mjs`** asks the harder question: if the file were not there,
what would move? It records the geometry of every element on every page, twice —
once as built, once with the stylesheet's import removed and the app rebuilt —
and diffs.

> **2,722 of 2,740 elements move when `styles.css` is not loaded.**

It is not "mostly dead". It is holding the app up: the reset, the box model,
the base rules everything else is written against. Deleting it would not tidy
the codebase, it would flatten every screen.

So the recommendation should be restated, and this is the useful output of the
session: **merge the 148 live selectors into `deck.css` — base layer first —
and delete the remaining 532 once each is confirmed by opening the screen that
uses it.** That is a bounded job now rather than an open-ended one, and both
tools are committed so the next pass can be judged by numbers that move.

The first version of the influence check was wrong in a way worth recording: it
deleted rules from the live CSSOM by matching selector text, and where the same
selector existed in *both* files it deleted deck.css's rule too. It reported the
same "everything moves" answer for the wrong reason. Rebuilding without the
import is unambiguous, and slower, and right.

---

## Not done

- **The merge itself.** 148 selectors to move, 532 to confirm and delete. The
  measurement is the plan; the work is a session of its own.
- **The 532 unconfirmed.** They need a walk that opens modals, empty states and
  error screens. `deadcss.mjs` will report them the moment such a walk exists —
  the tool is not the missing piece, the coverage is.
- **Colour and shadow have no scale**, and the same audit approach would work.
  Type and spacing were the two the review named.

---

Remaining: the `styles.css` merge, on the map above.
