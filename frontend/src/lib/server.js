/**
 * server.js — which server this copy of the interface talks to.
 *
 * ── why this is not simply "/api" any more ───────────────────────────────
 *
 * On the desktop and in a browser, the interface is served BY the server it
 * talks to, so `/api` on its own origin is exactly right and needs no
 * configuration. That is still the default and still what happens.
 *
 * Inside the Android app it is wrong in a way that is worth stating plainly:
 * the pages are served from the app bundle, so the app's own origin is
 * `http://localhost` — the phone itself. `/api` there does not mean "the
 * shop's server", it means "this phone", and there is nothing listening. The
 * app has no way to guess the address either: a downloaded APK is identical
 * for every shop, and only the shopkeeper knows where their own server is.
 *
 * So the address is resolved in this order:
 *
 *   1. what the person typed on the "connect to your shop" screen,
 *   2. `VITE_API_BASE`, baked in at build time — for an app built for one
 *      known shop, where asking would be a pointless first screen,
 *   3. this page's own origin, which is every existing installation.
 *
 * ── what must NOT be here ────────────────────────────────────────────────
 *
 * The database address and its access token are not in this file and must
 * never be put in it. They are read-write keys to every shop's books, and
 * anything the app holds is readable by anyone who downloads the app — an APK
 * is a zip file and its strings are one command away. The phone talks to the
 * server; only the server talks to the database. That is the whole reason
 * there is a server in this arrangement at all.
 */
const KEY = "vy_server";

/** True when this is the packaged Android app rather than a browser. */
export function isNative() {
  try {
    const c = window.Capacitor;
    return !!(c && (typeof c.isNativePlatform === "function" ? c.isNativePlatform() : c.isNative));
  } catch { return false; }
}

/** The address the shopkeeper gave us, or "" — always without a trailing slash. */
export function savedServer() {
  try { return (localStorage.getItem(KEY) || "").replace(/\/+$/, ""); } catch { return ""; }
}

/** Remember it. Checked by the connect screen before it gets here. */
export function setServer(url) {
  try { localStorage.setItem(KEY, String(url || "").trim().replace(/\/+$/, "")); } catch { /* storage off */ }
}

export function clearServer() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

/** What every request is prefixed with. */
export function apiBase() {
  const saved = savedServer();
  if (saved) return `${saved}/api`;
  /* Baked in at build time for an app built for one shop. Vite replaces this
     at compile time, so the `import.meta.env` guard is for the test and Node
     contexts where it does not exist. */
  try {
    const baked = import.meta.env && import.meta.env.VITE_API_BASE;
    if (baked) return `${String(baked).replace(/\/+$/, "")}/api`;
  } catch { /* not a Vite build */ }
  return "/api";
}

/**
 * Does this copy need to be told where its server is before it can do
 * anything?
 *
 * Only the packaged app, and only until it has been told once. A browser is
 * already talking to the right place by definition — it was served by it.
 */
export function needsServer() {
  return isNative() && !savedServer() && !bakedIn();
}

function bakedIn() {
  try { return !!(import.meta.env && import.meta.env.VITE_API_BASE); } catch { return false; }
}

/**
 * Is there really a Genius POS server at this address?
 *
 * Asked before the address is saved, because the alternative is a shopkeeper
 * typing one character wrong and then meeting "wrong email or password" on
 * every attempt for the rest of the evening — the error would be about the
 * thing they were doing, not about the thing that was wrong.
 *
 * `/api/health` is public and answers with the version, so this also catches
 * the address of something that is a web server but not this one.
 */
export async function checkServer(url) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, why: "Start the address with http:// or https://" };
  }
  let res;
  try {
    res = await fetch(`${base}/api/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      /* Long enough for a slow phone connection, short enough that a wrong
         address does not look like a hung app. */
      signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
    });
  } catch {
    return { ok: false, why: "Could not reach that address. Check the spelling, and that the phone is online." };
  }
  if (!res.ok) return { ok: false, why: `That address answered ${res.status}. It may not be your shop's server.` };
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  const version = body && (body.version || (body.data && body.data.version));
  if (!version) {
    return { ok: false, why: "Something answered there, but it is not a Genius POS server." };
  }
  return { ok: true, version };
}
