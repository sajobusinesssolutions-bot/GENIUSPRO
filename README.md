# Genius POS

**Till, stock and double-entry books for Ugandan shops.** One Express server
serving both the API and a React interface, a SQLite database that needs no
native build step, and a printed receipt at the end of it.

The premise: a shopkeeper should never keep books. They sell, buy and take
money, and the books are a by-product of having done so — complete enough to
file tax from and to argue with a supplier over. Every till sale posts, in one
transaction, the invoice and its lines, the stock movement out of the right
batch, the journal entries, and the party balance. There is no "post to
accounts" step, because a step somebody can forget is a set of books that is
wrong by the amount they forgot.

*A full illustrated system reference ships with this repository —
`Genius-POS-Anatomy.pdf`. Read that first if you want the whole picture.*

---

## Run it

Node 20 or newer. Nothing else — no database server, no build toolchain, no
native compilation.

```bash
npm run build      # installs both packages and builds the interface
npm start          # http://localhost:4000
```

The backend serves the built interface, so there is one origin and no CORS in
production. On a fresh database the first start makes an `admin` account with a
password generated on that machine — printed once, and saved in
`backend/data/first-run.txt`. For a demo shop with sample stock and customers,
run `node backend/seed.js --demo` against an empty database instead; that path
keeps the familiar `admin`/`admin123`.

For interface development with hot reload, run the two halves separately:

```bash
npm run dev:api    # the server on :4000
npm run dev:web    # Vite on :5173, proxying /api
```

Desktop is the same server and the same bundle inside an Electron window
(`electron/main.js`).

## Settings that matter

| Variable | What it does |
|---|---|
| `JWT_SECRET` | **Required in production** — signs every session. The server refuses to start without one, because a working default would let anyone who unzipped the installer forge an admin token. |
| `GENIUS_DB_PATH` | Where the database file lives. Defaults to `backend/data/genius.db`. Ignored when `GENIUS_DB_URL` is set. |
| `GENIUS_DB_URL` / `GENIUS_DB_TOKEN` | Keep the books on a hosted SQLite database (Turso / libSQL) instead of a file, so a till and a phone can both work on them at once. Setting the URL without the token is refused at boot. See [docs/HOSTED-DATABASE.md](docs/HOSTED-DATABASE.md). |
| `GENIUS_DB_URL_TEMPLATE` | With `SPLIT_STORAGE=1` and hosted books, the address of each company's own database, with `{firm}` where the company number goes. There is no fallback: without it the app refuses rather than putting two businesses in one database. |
| `PORT` | Defaults to 4000. |
| `SPLIT_STORAGE` | `1` gives each company its own SQLite file, with a small central one for identity. Needed to host more than one shop; see below. |
| `TENANT_MAX_OPEN` / `TENANT_IDLE_MINUTES` | How many company files may be open at once (24) and how long an idle one is kept (10 min). |
| `DEVICE_TRUST_DAYS` | How long a computer or phone stays trusted after it has been verified with an emailed sign-in code. Defaults to 30. |
| `EMAIL_PROVIDER` | `console` (default), `postmark`, `resend`, `smtp` or `none`. Verification codes and invitations go through it. |
| `EMAIL_FROM` / `APP_URL` | The sending address, and the base for invitation links. With `APP_URL` unset, links are built from the address the request arrived on. |
| `LOGIN_MAX_PER_IP` / `LOGIN_MAX_PER_ACCOUNT` | Sign-in throttle, counted in the database so several processes share one set of attempts. |

## Hosting more than one shop

The single-file arrangement is right for one shop on one machine and wrong for
a shared server: every shop's sale would export every other shop's data, and a
45-year storage ceiling becomes about three months across two hundred shops. So
each company gets its own file.

```bash
node backend/database/split.js  backend/data/genius.db  /srv/genius
# → /srv/genius/central.db  and  /srv/genius/firms/firm-N.db, each verified
#   against the original's control totals before it is written

GENIUS_DB_PATH=/srv/genius/central.db SPLIT_STORAGE=1 JWT_SECRET=… npm start
```

Counter staff then name their shop with a **shop code** (`kampala-hardware`)
before their username; owners sign in with an email address and need no code.
Whole-file automatic backups switch themselves off in this mode and say so — a
copy of the central file would contain no company's books while looking, in the
list, exactly like a backup.

## What is in here

```
backend/          Express, 29 modules, 39 route files, the engines and the storage layer
  database/       db.js (stores, transactions, atomic save), setup*.js (73 tables),
                  router.js (which file a statement belongs in), tenancy.js, split.js
  shared/         tax chain, accounting poster, stock poster, units, provisioning,
                  permissions catalogue, email, auth codes
  modules/        one directory per domain concern
  test/           unit suites (npm test) and API suites (need a running server)
frontend/src/
  pages/          31 screens
  lib/            the shared components — one implementation each
  deck.css        the live design layer, with the type and spacing scales at the top
e2e/              browser specs and the audit tools
electron/         the desktop shell
```

## Checking your work

```bash
npm test                       # 73 unit tests, no server needed
npm run test:e2e               # the browser suite (needs `npm run build` first)
npm run audit:layout           # every control reachable, 10 pages × 4 viewports
npm run audit:visual           # type combinations, container depth, money alignment
npm run audit:css              # which stylesheet rules are actually reached
```

The audits sign in for themselves. On a database that holds more than one
company they need to be told which — `GENIUS_SHOP=my-business npm run
audit:layout` — because an unauthenticated tool cannot guess, and saying so
beats timing out on a field that is not there.

The API suites need a server and a throwaway database:

```bash
cp backend/data/genius.db /tmp/t.db
GENIUS_DB_PATH=/tmp/t.db JWT_SECRET=dev-secret-key-1234 PORT=4177 \
  EMAIL_PROVIDER=console node backend/server.js > /tmp/t.log &
node backend/test/onboarding.e2e.js   http://localhost:4177 /tmp/t.log
node backend/test/staffsignin.e2e.js  http://localhost:4177 /tmp/t.log
node backend/test/settings.e2e.js     http://localhost:4177
node backend/test/split.e2e.js        http://localhost:4177 /tmp/t.log
```

**Never point the suites at `backend/data/genius.db`.** That file is what
ships; every session has verified it byte-for-byte
(`md5 3485fb029291858b7e7df67072a805d6`).

## Two rules worth knowing before you change anything

**A write is not saved until it is on the platter.** Ordinary writes flush at
the end of the event-loop turn; anything inside `durable()` commits
synchronously *before* the reply is sent. The handler returns a *function* that
sends the response — return anything else and the transaction rolls back. It
follows that nothing which must survive a refusal (a guess counter, an audit of
an attempt) may be written inside one.

**No statement may name tables from two databases.** Once storage is split,
`database/router.js` refuses a straddling statement by name — because a
`LEFT JOIN` across the boundary does not error, it returns the other side blank,
and the screen renders a missing cashier as "Unknown" rather than as broken. A
test walks every SQL literal in the tree and fails the build on a new one.

## The written record

Every change since the baseline has a report beside it, and each one names what
was verified and what was not.

| | |
|---|---|
| `Genius-POS-Anatomy.pdf` / `.html` | the whole system, illustrated |
| `docs/FIX-REPORT.md` | sixteen rounds of correction, with what each found |
| `docs/SESSION-*-REPORT.md` | print, bulk update, settings, companies, backup, the panel, onboarding, per-company storage, the shop code, the settings that did nothing, type, spacing |
| `docs/UI-REVIEW.md` | the outside design review the visual work answers |
| `docs/SETTINGS-MAP.md` | all 124 settings, and which are still inert |
| `docs/ONLINE-ONBOARDING.md` | the hosting decisions, and why |
| `docs/BACKUP-PROPOSAL.md` | per-company backup, and the finding it rests on |

## Not true yet

No mail provider is configured (codes print to the server log). Twenty settings
are still inert and hidden rather than pretending. Scheduled per-company
backups, and importing a company as a *new* company, do not exist. Reports and
the all-businesses panel have no per-account rate limit. Single currency across
businesses, by decision. Billing columns are carried from the first migration
and read by nothing.

---

SALJO TECH · v1.42.0
"# GeniusPOS" 
