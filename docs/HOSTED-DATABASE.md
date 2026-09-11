# Putting the books online

*How to move Genius POS from a database file on one computer to a hosted
database that a desktop till and a phone can both use at the same time.*

---

## What this changes, in one paragraph

Until now a shop's books lived in a SQLite **file** on one computer, and the
Sync screen moved a *snapshot* of that file between machines: one book, one
place at a time. Two tills could take turns, but they could not both sell at
once. Pointing the app at a hosted database changes the arrangement itself —
there is now **one database, live, that every till and phone reads and writes
directly**. A sale rung up at the counter is on the phone in the back office
the moment it is saved. Nothing is uploaded or downloaded, because there is
nothing to move.

Two things are given up in exchange, and both are real:

- **The till needs an internet connection.** With the books in a file, a
  broken connection was somebody else's problem. With them hosted, a till that
  cannot reach the database cannot sell. There is no offline replica in this
  build. If the shop's connection is unreliable, read "Should you actually do
  this?" at the bottom before going further.
- **The daily whole-file backup stops running**, because there is no file on
  that computer to copy. Backups become the hosting provider's job. The app
  says so on the Sync screen and in the log rather than quietly taking copies
  of nothing.

---

## Why Turso

The database is SQLite. Turso hosts **libSQL**, which is SQLite — the same
dialect, the same `AUTOINCREMENT`, the same `datetime('now')`, the same
`ON CONFLICT DO UPDATE`. So the schema, every query in the forty-one route
files, and the whole tenant/backup classification move across unchanged. On
Postgres — Supabase, Neon, Render's own — all of that would have to be
rewritten and re-tested, which is a project rather than a setting.

The app talks to it over Turso's HTTP protocol with nothing but Node's built-in
`https` (`backend/database/libsql.js`), so there is no package to install and
nothing to compile on a shop PC.

---

## Step 1 — create the database

1. Sign up at <https://turso.tech> and install their CLI:

   ```
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```

2. Create the database. Put it in the region nearest the shop — every query is
   a round-trip, and the distance is the latency:

   ```
   turso db create geniuspos-acme --location jnb      # jnb = Johannesburg
   turso db list                                       # note the URL
   ```

3. Get the two things the app needs:

   ```
   turso db show geniuspos-acme --url
   # libsql://geniuspos-acme-<org>.turso.io

   turso db tokens create geniuspos-acme
   # eyJhbGciOi…   ← the access token
   ```

Keep the token somewhere safe. It is the key to the shop's books: anyone
holding it can read and change everything. It is not a password anybody types —
it goes in the server's configuration and nowhere else. If one is ever pasted
into a chat, an email or a screenshot, revoke it and make another:

```
turso db tokens invalidate <database>     # kills every token for it
turso db tokens create <database>         # issue a fresh one
```

### Check it before going further

```
node backend/tools/hosted-check.js --to <url> --token <token>
```

It writes nothing and answers the two questions that matter:

- **Do these credentials work from this computer?** A refusal from the database
  (bad or expired token) and a refusal from something in between (a proxy, a
  company firewall, a host allowlist) are both a 403 and look identical. This
  says which, so nobody spends an afternoon issuing new tokens that also do not
  work.
- **How far away is it?** Every query is now a round-trip, and a busy screen is
  a dozen of them. The tool measures one query and multiplies, because the
  number people feel is not the region name on the dashboard. Over ~250 ms a
  till will feel slow, and moving the database to a nearer region is one
  command while it is still empty — a migration once it is not.

---

## Step 2 — move the existing books up

**Close the till first.** Anything rung up after the copy starts stays in the
old file and will not be in the hosted database.

```
node backend/tools/books-online.js \
  --from ./backend/data/genius.db \
  --to   libsql://geniuspos-acme-<org>.turso.io \
  --token <the access token> \
  --dry-run
```

`--dry-run` reads the file, counts what would be copied and writes nothing.
When the numbers look like your shop, run it again without `--dry-run`.

What the tool does and refuses to do:

- It **never writes to the local file.** If anything fails, the shop still has
  its books where they were and can carry on trading on them.
- It **refuses a destination that already has rows** unless you pass `--force`.
  Running it twice would add a second copy of every sale rather than replacing
  the first — and a doubled ledger still adds up, which is what makes it
  dangerous.
- It copies **one transaction per table**, so a table lands whole or not at
  all.

Starting a brand-new shop instead? Skip this step entirely. The app creates its
schema on first boot against an empty database.

---

## Step 3 — point the app at it

Two environment variables, and a restart:

```
GENIUS_DB_URL=libsql://geniuspos-acme-<org>.turso.io
GENIUS_DB_TOKEN=<the access token>
```

That is the whole switch. `GENIUS_DB_PATH` is ignored once `GENIUS_DB_URL` is
set; no folders are created and no local file is touched, so the old one stays
exactly where it is as a copy you hold yourself.

A URL with no token is refused at boot with a sentence saying so, rather than
starting and failing at the first sale.

**On Windows (desktop till):** set them for the service or in the shortcut that
starts the app, not in a `.bat` file that ships in the folder — the token
should not travel with the installer.

**On Render:** the service no longer needs the persistent disk, because there
is no file to persist. In `render.yaml`, drop the `disk:` block and the
`GENIUS_DB_PATH` variable, and add the two above (set `GENIUS_DB_TOKEN` as a
secret in the dashboard rather than committing it).

---

## Step 4 — let the phone in

The desktop app runs its own copy of the server inside Electron and talks to
`127.0.0.1`, so a phone cannot reach it. Give the phone a server it *can*
reach — the same application, deployed once:

1. Deploy this repo to Render (or any Node host) with the two variables above.
2. Open that address on the phone and sign in.

Both are now reading the same books: the desktop through its own local server,
the phone through the hosted one, and both of those through the one hosted
database.

**One thing must match across every server that shares a database:**

```
JWT_SECRET=<the same value everywhere>
```

Sign-in tokens are signed with it. Different secrets on two servers means a
person signed in on one is a stranger to the other.

---

## A database per company (optional)

An installation serving several businesses can keep them in separate hosted
databases, which is what `SPLIT_STORAGE=1` does with files today. Create one
database per company, named so a template can find it, and set:

```
SPLIT_STORAGE=1
GENIUS_DB_URL=libsql://geniuspos-central-<org>.turso.io
GENIUS_DB_URL_TEMPLATE=libsql://geniuspos-firm{firm}-<org>.turso.io
GENIUS_DB_TOKEN=<a token valid for all of them>
```

`{firm}` is replaced with the company's number. There is deliberately **no
fallback**: if the template is missing, the app refuses rather than quietly
putting two businesses in one database — every reason the split exists is a
reason not to do that by accident.

---

## After the move

- **Check the Sync screen.** It should say "These books are online" and name
  the database. If it still offers to send a copy up, the variables did not
  reach the process.
- **Turn on point-in-time restore** in Turso. This is now the backup. The app's
  own daily copy does not run and says so in the log.
- **Keep the old file.** Until the hosted database has traded for a few days it
  is the only copy of those books you hold in your own hand.
- **"Download a copy" still works.** Companies → the business → Download a copy
  builds a real SQLite file from the hosted rows, so a shop is never locked in.

---

## Should you actually do this?

Worth it when: more than one person needs to be in the books at once, a phone
needs the same figures as the till, the shop's internet is dependable, or the
current computer failing would lose everything.

Not worth it when: one person sells from one till and the connection drops
often. A till that cannot sell during a power cut at the exchange is a worse
shop than one whose books are only on its own disk, and the existing Sync
screen already gets a copy off the premises. Hosting the books solves
*sharing*, not *safety* — a nightly backup solves safety, and it is cheaper.

The honest middle path, if sharing is the goal but the connection is not
dependable: host the database, keep the desktop till on its local file for
selling, and give the office the hosted one for figures. That is not something
this build does for you — it would need the offline replica described in the
next section — but it is worth knowing the choice exists before committing.

---

## What is not built yet

- **Offline replicas.** Turso supports a local copy that syncs in the
  background, which would let a till keep selling through an outage. This build
  connects straight to the hosted database. Adding replicas means deciding what
  happens when two tills change the same row while apart — real conflict
  resolution over money, which is not something to bolt on quietly.
- **Whole-file restore against a hosted database.** It refuses by name; use the
  provider's point-in-time restore. Per-company export and import still work.
