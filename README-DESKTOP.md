# Genius POS — the Windows build

The desktop app is not a different program. It is the same Express server and
the same React bundle, in a window, with the printer picker that a browser is
not allowed to give you.

## Build it

On a Windows PC with [Node.js](https://nodejs.org) LTS installed:

**Double-click `build-windows.bat`.**

The first run downloads Electron — about 90 MB — and takes a few minutes.
After that it is quick. When it finishes, `dist-desktop\` holds:

    Genius-POS-Setup-1.43.0.exe        the installer
    Genius-POS-1.43.0-portable.exe     runs from a USB stick, installs nothing

The same thing by hand, if you prefer a terminal:

```bat
npm install
npm --prefix frontend install && npm --prefix frontend run build
npm --prefix backend install --omit=dev
npx electron-builder --win nsis portable --x64
```

To see it run before packaging: `npm run desktop`.

Building on macOS or Linux instead produces a `.dmg` or an `.AppImage` from
the same config. A **Windows** installer has to be built on Windows unless you
have Wine — that is an electron-builder rule, not ours.

## Starting fresh

Settings → Backup → **Start fresh** empties this business and runs the setup
wizard again — for a copy that came with demonstration data, or a shop starting
its books over. The business, its people, its chart of accounts and its roles
stay; the trading goes, and optionally the items and customers with it.

A verified dated copy is taken first — taken, not offered — and appears in the
list of backups directly above, so undoing it is the same three clicks as
undoing a restore. The walk-in customer survives, because the till cannot ring
a sale without one.

No database ships with the installer any more. It used to, and that file
carried six invoices, five payments and a customer called `sajo` from
somebody's testing, with `setup_done` already set — so a new shop inherited a
stranger's books *and* never saw the wizard.

## What the first run does

It sets the shop up — the company, the roles and their permissions, the chart
of accounts, the units, the walk-in customer — and **no logins at all**. Then
the browser opens and asks the person sitting at the till who they are:

    What is the business called?      Namuli Traders
    Your name                         Grace Namuli
    The name you will sign in with    grace
    Choose a password                 ········

That account is the owner. Filling it in signs them straight in, and the setup
wizard carries on: tax, what you sell, and **the rest of your staff's logins**.
More can be added at any time under Settings › Users.

There is no password to look up. Generating one and printing it in a console
window for somebody to read back is worse in every way — one more thing to
lose, and a working password that nobody chose, existing on a machine that can
serve a whole shop's Wi-Fi before anyone has decided who should have it.

Two rules make the first screen safe:

- **It works only while there is nobody.** The moment one account exists the
  route is closed for good, so it can never add a second administrator to a
  shop that is trading.
- **It answers only the machine it runs on.** An unclaimed till left on a
  shop's Wi-Fi would otherwise belong to whoever opened the address first. Set
  `GENIUS_CLAIM_ANYWHERE=1` if you really do need to set one up from a phone —
  a deliberate act, not a default.

For sample customers and stock to demonstrate with, run
`node backend/seed.js --demo` against a fresh database instead — that path
keeps the familiar `admin`/`admin123`.

## Forgotten passwords

At the machine itself, in `backend/`:

```
node shared/firstrun.js --password                       the first account
node shared/firstrun.js --password grace                 a named one
node shared/firstrun.js --password grace "one you pick"
```

It prints the new password and touches nothing else — not one sale,
customer or item. It runs on the machine rather than over the network, so it
is not a way past the sign-in screen: whoever can run it can already read the
database file.

## Where the shop's books live

    C:\Users\<name>\AppData\Roaming\Genius POS\genius.db

Outside the installed folder, deliberately: an update replaces the program and
must never touch the books. **File → Show my data folder** opens it. Backing up
is copying that one file, and the app's own Settings → Backup does it properly.

Uninstalling leaves the books alone.

**Upgrading from Sajo Books.** The folder Windows gives an app is named after
the app, so the rename would have moved it and presented an established shop
with an empty till. The first start under the new name carries the old folder
across whole — books, session key, window position — and a `vyapar.db` beside
it is renamed to `genius.db`. Old `SAJO_*` / `VYAPAR_*` environment variables
are still honoured, and a backup made under the old name still restores.

## When something goes wrong

`npm --prefix frontend run check` finds a component that is used but never
defined or imported — the mistake that builds perfectly well and then blanks
the screen the moment React reaches that line. `start.bat` runs it after every
build and warns; it does not stop the shop opening for a checker.

**The screen is never blank.** There is an error boundary around the whole app,
not only around the page area, so a crash shows what broke and offers to
reload. If the bundle never even loads, the page itself says so after eight
seconds. And every uncaught error is posted to `/api/system/client-error`,
which prints it in the black window and writes it to the log — so "it went
blank" is now a report somebody can act on.


    C:\Users\<name>\AppData\Roaming\Genius POS\logs\genius.log

A packaged Windows app has no console, so everything the shell and the server
print goes there instead, rolled at 2 MB. **File → Show the log** opens it.
That is the file to ask a shop for when they call.

The shell also says something rather than dying quietly: a failed load, a dead
renderer, a hung page and a failed startup each get a dialog naming the log.

## Sessions

Production refuses to start without `JWT_SECRET`, and rightly: a default would
let anyone who unzipped the installer forge an admin token on every copy sold.
A packaged app has no shell to set one from, so the first run generates 32
random bytes and keeps them in `session.key`. Delete that file and everyone is
signed out; nothing else is lost.

## Printing

This is why many shops want the desktop build at all.

In a browser, `window.print()` hands over to the browser's dialog and no script
may choose the printer — so "default printer" cannot be honoured on the web,
at all, by anyone. Inside the window it becomes real:

| | |
|---|---|
| `geniusPrint.listPrinters()` | the printers Windows knows, with the default marked |
| `geniusPrint.print(html, opts)` | straight to `opts.deviceName`, no dialog |
| `geniusPrint.savePdf(html, name)` | the same document as a PDF |
| `geniusPrint.showDataFolder()` | Explorer, on the database file |

`opts.thermal` with `opts.widthMm: 58` or `80` sets the page in microns, which
is how a roll has to be expressed — Windows has no name for it. With no
printer chosen the call returns `{ok:false, error:"no-printer"}` rather than
raising a dialog nobody can see, and the page falls back to its own preview. A
printer that never answers times out after a minute instead of hanging the
till. The frontend checks for `window.geniusPrint`, so one bundle runs both
here and on the web.

## What it will and will not let a page do

The window runs with context isolation on, no node integration, and the
renderer sandboxed. Every browser permission — camera, microphone, location,
clipboard reading — is denied outright, because nothing here asks for one.
A link that is not the till's own page is refused inside the window and handed
to the shopkeeper's browser, and only if it is `http(s)`: `shell.openExternal`
on Windows will launch other protocol handlers, and that is a way in.

Receipts render in their own window with **JavaScript switched off** — a
receipt is markup, nothing in it needs to run — and the print bridge answers
only the till's own page.

The server sends a content policy that keeps the interface to its own origin,
so a compromised page cannot post a shop's takings anywhere. `GENIUS_NO_CSP=1`
turns it off if a customisation ever needs it.

## A second till on the same Wi-Fi

The window serves `127.0.0.1` — this computer only. Starting with `GENIUS_LAN=1`
set makes it listen on the whole network, and Windows will ask you to allow it
through the firewall. Then a phone or a second PC on the same Wi-Fi opens
`http://<this-pc-ip>:3777`.

Change the sign-in passwords first. It is the same server with the same
sign-in, but it is a sign-in screen facing whatever else is on that network.
Cross-origin calls are refused unless you name the origin in `GENIUS_ORIGINS`.

## Before you sell it

Two things are configured but deliberately switched off, because neither can
be finished from a source tree:

**Code signing.** An unsigned installer meets "Windows protected your PC" on
every machine, and the warning never goes away, because each new build is a
new unknown binary. Buy an OV certificate — an EV one earns SmartScreen
reputation immediately — then fill in the `win:` block in
`electron-builder.yml`, or set `CSC_LINK` and `CSC_KEY_PASSWORD` in the
environment.

**Automatic updates.** Add `electron-updater`, set a `publish:` provider, and
call `checkForUpdatesAndNotify()` after the window opens. This only works once
signing does: NSIS updates require signature continuity. Until then, updating
means sending an installer.

## If the build fails

**"node is not recognized"** — Node.js is not installed, or the window was
opened before installing it. Install it and run the .bat again.

**npm errors on the first step** — no internet, or a proxy in the way. The
build needs to reach the npm registry and GitHub once.

**The .exe is written and then vanishes** — antivirus. Unsigned installers get
quarantined. Exclude `dist-desktop\`, or sign the build.

**A blank window when you run it** — the server did not answer. `npm run desktop`
from a terminal shows why; the usual cause is that `frontend/dist` was never
built.

---

Powered by SALJO TECH
