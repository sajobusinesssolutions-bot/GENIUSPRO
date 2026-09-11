# End-to-end tests

`backend/test` covers the maths — tax, costing, units — with 34 unit tests
(`npm test`). This directory covers the half that only fails in a browser.

```bash
npm run build          # the suite serves frontend/dist, so it must exist
npm run test:e2e       # all specs
npm run test:e2e -- till   # only specs matching "till"
```

Exit code is non-zero if anything fails, so it drops straight into CI.

## How it runs

The backend already serves `frontend/dist` when that directory exists
(`backend/server.js:84`), so the suite boots **one** process on port 3199 and
drives the production bundle. No Vite, no proxy, and what is exercised is what
ships.

The database is copied to a temp file and handed to the server through
`GENIUS_DB_PATH` (`backend/database/db.js:20`). Specs ring up real sales and
void real lines; `backend/data/genius.db` is never written to, and the copy is
deleted when the run ends.

## The specs, and why each exists

Every assertion in here is a bug that shipped at least once. That is the bar
for adding one — not "this code path exists" but "this went wrong, and would
go wrong again silently".

| Spec | Guards against |
|---|---|
| `layout.spec.mjs` | Controls you cannot reach. Walks 13 pages at 5 viewports and flags anything clipped by an `overflow: hidden` ancestor **that cannot scroll**. The scroll-ancestor check is the whole trick — a hand-run audit without it produced 23 false positives on Settings alone. |
| `till.spec.mjs` | The till showing a total the bill does not contain. Quantity committing only on blur; Enter reverting the typed value; and the subtle one — a no-op commit leaving a stale guard set, so typing `3` over `3` and pressing F6 silently undid the unit flip and sold 1 KG instead of 50. |
| `reports.spec.mjs` | One careless edit breaking 58 panes at once. They share a list component and a currency helper. Checks every pane for `NaN`, `undefined`, `[object Object]`, `Invalid Date`, doubled currency, the `item(s)` plural bug, a blank pane with no empty state, and exactly one Print button. |
| `receipt.spec.mjs` | The paper the customer keeps. It is written into a popup via `window.open`, so nothing that inspects the app's own DOM can see it. Catches a barcode running off a 2in roll, and a withholding deduction printed as "Less: VAT". |
| `invoice.spec.mjs` | Losing a part-finished invoice to one Escape keystroke, and a grand total too small to check before saving. |
| `dashboard.spec.mjs` | A confident wrong number on the one screen nobody cross-checks. Every widget figure is traced to the ledger it claims to come from (sales list, AR/AP ageing, bill-profit, cash & bank) rather than to the endpoint that drew it; plus geometry and contrast at two sizes in both themes, the empty state on a private copy of the database that has not been traded through, and the module flags. |

## Adding a spec

A spec is a module exporting `name` and `async run({ browser, report })`:

```js
import { signIn, go, watchErrors } from "../harness.mjs";

export const name = "short description";

export async function run({ browser, report }) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page);
  await go(page, "Sales");            // nav labels carry a badge; matches on the end
  report.ok(condition, "what should be true", "detail shown only on failure");
  await page.close();
}
```

Write the assertion message as the thing that should be true, not the thing
being checked — the output is read when something has broken, usually by
someone who did not write the test.

## Notes

- `signIn` uses `admin` / `admin123`, the seeded credentials.
- Some rail entries are gated by module flags in the data. `go()` returns
  `false` rather than throwing when a destination is switched off, so a spec
  can skip it — do not assume all 19 destinations exist.
- Set `E2E_CHROMIUM` to a browser path if Playwright's own resolution does not
  suit your environment; otherwise it uses the installed Chromium.
- The suite signs tokens with a fixed throwaway `JWT_SECRET`. The server
  refuses to boot in production without a real one
  (`backend/shared/middleware/auth.js:16`), which is the correct behaviour and
  is not affected by this.
