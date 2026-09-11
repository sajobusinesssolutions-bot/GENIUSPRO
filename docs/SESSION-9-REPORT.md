# The app-wide visual pass — one type scale

Commit `e2af6e4`. **34 files, +934 / −612.** Build, `check-imports`,
`check-layers`, **73** unit tests and `node --check` on every backend file:
clean. The shipped database is byte-identical (`md5 3485fb02…`).

**Every control reachable, no sideways scroll, on 10 pages × 4 viewports.**
The settings (16), onboarding (58) and browser (13 + 23) suites still pass.

---

## The pass is measurable, so it was measured

The design review's third section says the quiet part plainly:

> Counted on the Settings and Reports screens: eleven distinct type
> label/size/weight combinations, several differing by one pixel or fifty
> weight units. **That is not a hierarchy, it is noise.** The eye can hold
> about four.

So the first thing built was not a stylesheet change — it was
`e2e/visual.audit.mjs`, which counts, in a live browser, per page: container
nesting depth, distinct type combinations, money figures that are not tabular
or not right-aligned, and how many different "filled button" colours the eye is
being taught. A visual pass judged by whether the screenshot feels tidier is a
pass nobody can check.

| page | type combinations before | after |
|---|---|---|
| Dashboard | 20 | **13** |
| Sales | 15 | **8** |
| Purchases | 14 | **8** |
| Items | 21 | **11** |
| Parties | 20 | **10** |
| Cash & bank | 18 | **9** |
| Reports | 14 | **9** |
| Settings | 13 | **9** |

And in the stylesheets themselves:

| | before | after |
|---|---|---|
| distinct font sizes | **25** | **9** below the display tier |
| distinct font weights | **9** | **5** |

The other three measures were already clean and stayed clean: nesting never
exceeded two levels, **zero** money figures were mis-set, and exactly **two**
filled-button colours — the accent and the destructive — on every page.

---

## What 25 sizes looked like

12 and 12.5 and 13 and 13.5 all in play. 11 beside 11.5. 14, 14.5, 15, 15.5.
600 beside 650 beside 700 beside 730 beside 780 beside 800 beside 900. None of
it was a decision. It was accretion — every screen added the size it wanted,
and the differences were mostly half a pixel.

The scale is now written into the top of `deck.css`, and it pairs **one weight
with each size**, which was the missing half:

```
11.5 / 700 caps   caption    labels above fields, table headings
11.5 / 500        hint       the quiet second line under a figure
12.5 / 650        label      a chip, a pill, a small named thing
12.5 / 500        secondary  sub-headings, counts, notes
13.5 / 400        body       everything you read
13.5 / 650        title      card headings, tabs, buttons, rail labels
16   / 700        amount     money inside a row or a total block
19   / 750        figure     the number a tile exists to show — and the page
                             title, which is the same size and the same job
```

Plus `10.5` for a badge, `15` for the few headings that head a whole panel
rather than a card, and a **display tier** — 28 to 50px — used by exactly three
surfaces read across a room rather than at a desk: the till's running total,
the dashboard headline, and the sign-in page. Those are deliberately off the
scale. A 44px total on a counter screen is a different job from a 19px figure
on a tile.

**14px is gone.** It was 13.5 with a rounding error.

---

## Three combinations nobody had ever chosen

The most useful finding came from asking *where* each combination came from —
`e2e/typesource.mjs` walks the live stylesheets and names the rule that won.

Several combinations were not authored at all. **`<b>` and `<strong>` inherit
`bolder` in the UA stylesheet, which resolves relative to the parent** — so the
same `<b>` came out 700 inside a 400 container and **900** inside a 650 one.
Three of the combinations this pass removed were that, and no amount of reading
the CSS would have found them, because the weight is not in the CSS.

```css
b, strong { font-weight: 650; }
```

650 rather than 700: emphasis inside body text is the title weight. The few
places where money genuinely needs to be heavier now say so explicitly, which
is the second half of the same fix — `.dk-duerow b` and `.dk-flow .top b` had
no weight of their own and were relying on that same accident.

---

## What changed on screen, and what did not

Almost nothing, which is the point. Side by side, the Cash & bank screen before
and after this pass differs in two visible ways: the uppercase strip captions
went from 10.5px to 11.5px — they had been one step smaller than every other
uppercase label in the app for no reason anybody could name — and the card
heading went from 14/700 to 13.5/650, the same step as the tab beside it.

Eighteen type combinations became nine and the screen barely moved. That is
what the review meant: the noise was never carrying information.

The changes that are visible are corrections:

- **strip captions** now match every other caption (10.5 → 11.5)
- **`.dk-strip .v`** now matches `.big` beside it (700 → 750) — they are the
  same thing at the same size
- **the page title** joins the figure step, because it is the largest text on
  the page and the same job
- **avatars** (monograms in circles) join the label and figure steps rather
  than holding two sizes of their own

## The guardrail

`e2e/layout.check.mjs` walks 10 pages at 1254×596, 1024×640, 1440×900 and
1707×811 and asserts every control is reachable and nothing scrolls sideways.
Half a pixel of font-size, multiplied through a flex row, is exactly how a Save
button ends up under the fold — so the check ran after every batch, and it is
green.

It carries the detector's own history in a comment: an earlier version stopped
at the first `overflow: hidden` ancestor without asking whether a nearer one
already scrolled, and reported **930** phantom failures. A check that cries
wolf is a check that gets muted.

---

## Not done

- **Dashboard is still at 13.** It has three genuine display figures (34px
  gauge, 24px stat, 22px watch) plus the ageing grid, and the last few
  combinations there are real hierarchy rather than noise. It could reach ~10
  by merging the gauge and the stat, which is a design decision about that
  screen rather than a scale decision.
- **`styles.css` is still alive.** The review's first recommendation was to
  finish killing it; this pass snapped its type to the same scale but did not
  remove it. It is now 5 sizes and 5 weights rather than a second opinion, but
  it is still a second file.
- **Spacing has no scale.** Type was the loudest half of §2 and §3; the
  padding and gap values are still ad hoc, and the same audit approach would
  work on them.
- **The four-step ideal.** The review asks for four; the app is at eight below
  the display tier. I think eight is honest for a books application — caption,
  hint, label, secondary, body, title, amount, figure are eight different jobs
  — but it is more than was asked for, and I am recording the gap rather than
  claiming the target.

---

Remaining: **spacing**, on the same measured basis; and the last of
`styles.css`.
