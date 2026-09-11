# The Android app

*Building Genius POS as an installable Android app, against the hosted
database.*

---

## The shape of it, before anything else

Three things, and they are not interchangeable:

```
   Android app                 Render (or any Node host)          Turso
   ───────────                 ─────────────────────────          ─────
   what people see       ──►   every business rule           ──►   the books
   no database access          the only thing with the             SQL, nothing
                               database credentials                else
```

**The app never touches the database.** Not "should not" — must not. The Turso
token is read-write access to every shop's books, and an APK is a zip file
whose strings anyone can read with one command. Ship the token inside the app
and you have published it. So the phone talks to your server, your server talks
to Turso, and the credentials exist in exactly one place: the server's
environment.

This is also the answer to "Turso or Render, which is better?" — neither, both.
Turso is a database and cannot run your code. Render runs your code and has no
database of its own. You need one of each.

---

## Step 1 — the server must exist first

The app is useless without an address to talk to, so deploy the server before
building anything.

1. Create the Turso database and get its URL and token — see
   [HOSTED-DATABASE.md](HOSTED-DATABASE.md).
2. Deploy this repository to Render with the blueprint in `render.yaml`. Set
   `GENIUS_DB_URL` and `GENIUS_DB_TOKEN` in the dashboard as secrets, not in
   the file.
3. Check it answers:

   ```
   curl https://yourshop.onrender.com/api/health
   ```

   You should get JSON with a version in it. That address is what you type into
   the app on first run, so keep it to hand.

**Use https.** The app's own pages run on `https://localhost` inside the
WebView, and Android refuses to let an https page call a plain-http address.
A Render URL is https already. A shop's own computer on the local Wi-Fi is not,
and needs the extra step at the bottom of this file.

---

## Step 2 — build the app

You need a machine with Node, a JDK, and the Android SDK — Android Studio
installs all three. None of this can be done from a sandbox or a CI box without
the SDK.

```
# once, from the repository root
npm install
npx cap add android          # creates the android/ project

# every time you want a build
npm run android:sync         # builds the web app and copies it in
npm run android:open         # opens Android Studio, or:
npm run android:apk          # android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:sync` runs the normal `npm run build` first, so the app always
contains the same interface the desktop and the browser get. There is one
codebase; the Android app is a shell around it.

To publish on the Play Store, `npm run android:bundle` produces the `.aab`
Google asks for. That needs a signing key you generate once and keep — losing it
means never being able to update the listing again.

### Building for one known shop

By default the app asks for the server address on first run. If you are
building for a single shop and that question is just an obstacle, bake the
address in:

```
VITE_API_BASE=https://yourshop.onrender.com npm run android:sync
```

The connect screen is then skipped entirely.

---

## Step 3 — first run

The app opens on **Connect to your shop** and asks for the server address. It
checks the address really is a Genius POS server before saving it — a single
mistyped character would otherwise turn into "wrong email or password" on every
attempt for the rest of the evening, which is an error about the wrong thing.

After that it is the ordinary sign-in screen, and the address is never asked for
again. It can be changed later under Settings → About & updates → This phone
talks to.

Signing in with an email address will ask for a six-digit code the first time,
because the phone is a device the account has not used before. That is the
second factor working as intended. The phone is then remembered for thirty
days.

---

## What the app is and is not

**It is** the same interface, in a shell, talking to your server over the
internet. Everything the browser can do it can do.

**It is not offline-capable.** No connection means no sales, exactly as on the
hosted desktop. A phone in a shop with patchy signal will stop working
mid-transaction, and that is worth knowing before staff rely on it. There is no
local copy on the phone and nothing queues up to be sent later.

**It has no hardware access yet.** Capacitor makes the camera, printing and
push notifications reachable, but none of them are wired up here. Barcode
scanning through the phone camera is the obvious first one and would need a
Capacitor plugin plus a screen to use it.

---

## Running against a shop's own computer instead of a host

If the phone and the till are on the same Wi-Fi and you would rather not host
anything, the phone can talk to the desktop directly. Two changes are needed,
and both weaken security, so do this only on a network you control:

1. Start the desktop server with `GENIUS_LAN=1` so it listens on the network
   rather than only on itself, and note its address (Settings → About shows it).
2. That address is plain http, which the app will refuse. Allow it by setting
   `"androidScheme": "http"` and `"allowMixedContent": true` in
   `capacitor.config.json`, then rebuilding.

Everything then travels the shop's Wi-Fi unencrypted, including passwords. It
is acceptable on a closed network with a known set of devices and a bad idea
anywhere else.
