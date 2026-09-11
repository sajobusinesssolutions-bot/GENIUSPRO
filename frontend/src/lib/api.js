// api.js — fetch wrapper (blueprint §6.2): JWT, silent refresh on 401, unwrap {success,data}
import { apiBase } from "./server.js";

/* Read per request rather than once at module load.
 *
 * In a browser and on the desktop this is always "/api" and the indirection
 * costs nothing. In the Android app the address is whatever the shopkeeper
 * typed on the connect screen, and that can be changed while the app is
 * running — a constant captured at import time would keep talking to the old
 * server until the app was killed and reopened, which is exactly the moment
 * somebody is trying to fix a wrong address. */
const base = () => apiBase();
let refreshing = null;

function tokens() {
  return { t: localStorage.getItem("vy_token"), r: localStorage.getItem("vy_refresh") };
}
export function setSession({ token, refresh, user, firm, permissions, account }) {
  if (token) localStorage.setItem("vy_token", token);
  if (refresh) localStorage.setItem("vy_refresh", refresh);
  /* The account rides on the user record rather than in a key of its own, so
     every `currentUser()` in the app — and there are many — sees it without a
     second lookup. Absent for counter staff, who have no account. */
  if (user) localStorage.setItem("vy_user", JSON.stringify(
    account ? { ...user, account_id: account.id, email: account.email, companies: account.companies } : user));
  if (firm) localStorage.setItem("vy_firm", JSON.stringify(firm));
  if (permissions) localStorage.setItem("vy_perms", JSON.stringify(permissions));
}
export function clearSession() {
  /* vy_pos_cart belongs in this list even though it is not credentials. An
     unfinished till bill written to localStorage outlives the person who rang
     it up — sign out, hand the machine to the next cashier, and their first
     customer is looking at somebody else's Sh 50,000 line. The Till now asks
     before resuming a saved bill, so this is the second lock rather than the
     only one, but a bill that cannot survive a sign-out is better than one
     that survives and has to be questioned. vy_pos_ref goes with it: leaving
     the idempotency key behind makes the next unrelated sale look to the
     server like a retry of the discarded one. */
  ["vy_token", "vy_refresh", "vy_user", "vy_firm", "vy_perms", "vy_pos_cart", "vy_pos_ref"]
    .forEach((k) => localStorage.removeItem(k));
}
export const currentUser = () => JSON.parse(localStorage.getItem("vy_user") || "null");
export const currentFirm = () => JSON.parse(localStorage.getItem("vy_firm") || "null");

/* Re-read the business details after they're edited, so the sidebar, receipts and
   headers show what was just entered instead of the stale copy from login. */
export async function refreshFirm() {
  try {
    const f = await api.get("/settings/firm");
    if (f) localStorage.setItem("vy_firm", JSON.stringify(f));
    return f;
  } catch { return null; }
}

/* ── idempotency keys ───────────────────────────────────────────────────────
   A reference for one attempt at writing one document, sent as `client_ref`.
   The server stores it under UNIQUE(firm_id, client_ref) and hands back the
   document it already has when the same reference returns, so a retry after a
   lost response cannot post a second sale, refund or void.

   Minted ONCE PER ATTEMPT, never per retry. Every try at the same document
   must carry the same value or the key protects nothing, so the caller has to
   hold on to it — the till keeps it in localStorage, which is what lets it
   survive a page reload — and mint a fresh one only when it begins a
   genuinely new document.

   randomUUID needs a secure context, and a shop running the till over plain
   http on the shop LAN is not one, so there is a fallback. The value only has
   to be unique within one firm; the timestamp prefix carries most of that on
   its own and the two random tails carry the rest. */
export function newClientRef() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* insecure origin — fall through */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function setPermissions(perms) {
  localStorage.setItem("vy_perms", JSON.stringify(perms || []));
}
export function can(module, action) {
  const perms = JSON.parse(localStorage.getItem("vy_perms") || "[]");
  return perms.some((p) => p.module === module && p.action === action);
}

/**
 * Owner or administrator — the mirror of the server's `requireOwner`.
 *
 * The irreversible things you can do to a whole business — suspend it, delete
 * it, empty it, restore over it, lock the panel — are now refused by the
 * server for anybody else. This exists so those buttons are not drawn at all
 * rather than drawn and then answered with a 403, which reads to the person
 * pressing it as the app being broken rather than as them not being allowed.
 *
 * It is a courtesy, never the guard: the server decides, always. Keep the two
 * rules the same shape — the owner, or somebody trusted with settings.
 */
export function isAdmin() {
  const u = JSON.parse(localStorage.getItem("vy_user") || "null");
  return !!(u && u.is_owner) || can("settings", "edit");
}

async function tryRefresh() {
  if (!refreshing) {
    refreshing = (async () => {
      const { r } = tokens();
      if (!r) return false;
      const res = await fetch(`${base()}/auth/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: r }),
      });
      if (!res.ok) return false;
      const j = await res.json();
      if (!j.success) return false;
      setSession(j.data);
      return true;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/* Surface unexpected failures centrally.
   Many screens do `.catch(() => {})` because a failed background load isn't worth
   interrupting the user — but that also hid real outages. Server faults and
   unreachable-network errors now raise one toast (deduped), while ordinary
   validation errors (4xx) stay silent here and are handled by the caller. */
let notifyError = null;
export function setErrorNotifier(fn) { notifyError = fn; }
let lastNotice = { msg: "", at: 0 };
function surface(msg) {
  const now = Date.now();
  if (msg === lastNotice.msg && now - lastNotice.at < 8000) return;  // don't spam
  lastNotice = { msg, at: now };
  if (notifyError) notifyError(msg);
}

/* ── connection state ───────────────────────────────────────────────────────
   Every request in the app comes through here, so this is the only place that
   knows the server has stopped answering. A toast lasts three seconds; an
   outage lasts as long as it lasts. Listeners (ConnectionWatcher) are told the
   moment a request fails and the moment one succeeds again, so the user has a
   standing indicator rather than a notice they may have blinked and missed. */
const connListeners = new Set();
let reachable = true;
export function onConnection(fn) {
  connListeners.add(fn);
  fn(reachable);
  return () => connListeners.delete(fn);
}
export function isReachable() { return reachable; }
function setReachable(v) {
  if (reachable === v) return;
  reachable = v;
  connListeners.forEach((fn) => { try { fn(v); } catch {} });
}
/** Lets a health probe outside this wrapper (ConnectionWatcher) feed the same state. */
export function reportReachable(v) { setReachable(!!v); }

/* No response is worse than a bad one: without a deadline a dropped connection
   leaves the caller's spinner turning for as long as the browser holds the
   socket, which at a till means a cashier staring at "Saving…" with no way
   out. Everything the app asks for is a local SQLite query, so a request still
   silent after this long is not slow, it is gone. */
const TIMEOUT_MS = 25000;
const OFFLINE_MSG = "Can't reach the server — check the connection and try again";

/* Which till this is — not which login.
 *
 * A shop that signs both counters in as the same account had two cashiers
 * resume one parked bill and both delete it, so a table's order was rung up
 * twice and neither cashier was told. The server cannot tell two browsers on
 * one login apart, so the browser has to say.
 *
 * sessionStorage, deliberately, not localStorage: localStorage is shared
 * across tabs of the same origin, which is exactly the two-tills-one-login
 * case this exists to distinguish. sessionStorage is per tab and survives a
 * reload. If it is unavailable (private mode) we fall back to a value that
 * lives as long as the page, which is still better than nothing.
 *
 * Sent on every request rather than only the one endpoint that reads it
 * today: it costs nothing and the next claim-shaped guard needs no client
 * change. */
let memClientId = null;
function clientId() {
  if (memClientId) return memClientId;
  const mint = () => (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    let v = sessionStorage.getItem("vy_client_id");
    if (!v) { v = mint(); sessionStorage.setItem("vy_client_id", v); }
    memClientId = v;
  } catch { memClientId = mint(); }
  return memClientId;
}

/**
 * `retried` is how a 401 gets exactly one second chance, and no more.
 *
 * The rule used to be "on a 401, refresh the session and try again", with
 * nothing to stop the second attempt doing the same thing. `/auth/refresh`
 * succeeds for anybody with a live session, so any route that answers 401 for
 * a reason OTHER than an expired token — "this business is locked with a PIN"
 * is one — sent the app round that loop for ever: refresh, retry, 401,
 * refresh. The screen never got its answer and the server was hammered by a
 * till that looked merely slow.
 *
 * One retry is all the original intent ever needed: a token expires once, and
 * refreshing it fixes it or it does not.
 */
/* ── refusing a write we already know cannot land ──────────────────────────
 *
 * A dropped connection used to be discovered by trying: the request went out,
 * the browser held the socket for twenty-five seconds, and the caller got an
 * error that could not say whether the document had been posted or not. For a
 * GET that is merely slow. For a payment it is the worst possible answer —
 * "something happened, we don't know what" — and it is the answer a cashier
 * gets while a customer waits.
 *
 * So a write is refused BEFORE it is sent when the connection is known to be
 * down. "Known" is doing real work there: `reachable` is a cached belief that
 * the health probe refreshes every two seconds, and a stale `false` would
 * block a shop whose network came back a moment ago. So the belief is checked
 * against a fast probe before anything is refused, and only a probe that also
 * fails turns into a refusal.
 *
 * The wording is the point. "Nothing was saved" is a promise this can keep,
 * because the request never left the browser — which is exactly what the
 * cashier needs to know before they decide whether to key it in again.
 */
const PROBE_MS = 2500;
const BLOCKED_MSG = "No connection to the server — nothing was saved. Try again when the connection is back.";

async function probe() {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), PROBE_MS) : null;
  try {
    const r = await fetch(`${base()}/health`, { cache: "no-store", ...(ctl ? { signal: ctl.signal } : {}) });
    return r.ok;
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}

/* One probe shared by every write that arrives while the line is down, rather
   than one per request: a form saving eight expense lines should ask once. */
let probing = null;
function probeOnce() {
  if (!probing) probing = probe().finally(() => { setTimeout(() => { probing = null; }, 400); });
  return probing;
}

async function refuseIfOffline(method) {
  if (method === "GET") return;                         /* a read that fails is just a failed read */
  /* The browser's own answer is the cheapest and, when it says offline, the
     most certain: no radio, no cable, nothing left to try. */
  const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!browserOffline && reachable) return;             /* believed up — let it go */
  if (!browserOffline && await probeOnce()) { setReachable(true); return; }
  setReachable(false);
  surface(BLOCKED_MSG);
  const err = new Error(BLOCKED_MSG);
  err.offline = true;
  err.blocked = true;
  /* The distinction the whole guard exists for: this request never left, so
     the server cannot have acted on it. Nothing is in doubt. */
  err.ambiguous = false;
  throw err;
}

async function raw(method, path, body, retried = false) {
  if (!retried) await refuseIfOffline(method);
  const { t } = tokens();
  let res;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  const timer = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS) : null;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": clientId(),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(ctl ? { signal: ctl.signal } : {}),
    });
  } catch (netErr) {
    setReachable(false);
    /* The request LEFT. Whether the server acted on it is genuinely unknown,
       and saying "failed" here would be a lie in half the cases — the half
       where the document was posted and only the reply was lost. Writes get
       wording that tells the truth and tells the operator what to do: press
       Save again. Every write that can post money carries a reference the
       server recognises, so a second press cannot post a second document. */
    const msg = method === "GET"
      ? (timedOut ? "The server did not answer in time — check the connection and try again" : OFFLINE_MSG)
      : "The connection dropped before the server answered. Press Save again — it is safe: if it did go through, this will find it rather than record it twice.";
    surface(msg);
    const err = new Error(msg);
    err.offline = true;
    err.timeout = timedOut;
    /* The request left the browser; whether the server acted on it is unknown.
       For anything that writes, a blind retry can post the same document
       twice, so callers are told the outcome is ambiguous rather than failed. */
    err.ambiguous = method !== "GET";
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  setReachable(true);
  if (res.status === 401 && !retried && path !== "/auth/login" && (await tryRefresh())) {
    return raw(method, path, body, true);
  }
  const json = await res.json().catch(() => ({ success: false, message: "Bad response" }));
  if (!json.success) {
    if (res.status >= 500) surface(json.message || "The server ran into a problem");
    /* A licence refusal is not an ordinary failure. The server attaches the
       whole licence state to it, and the app has to switch to the licence
       screen rather than show a toast the cashier will retry forever. Told
       once here, so no caller has to remember. */
    if (res.status === 403 && json.licence) {
      err_licence(json.licence);
      const e = new Error(json.message || "This till is stopped");
      e.status = 403;
      e.licence = json.licence;
      e.ambiguous = false;
      throw e;
    }
    const err = new Error(json.message || "Request failed");
    err.status = res.status;
    /* The server's structured detail, not only its sentence. The sign-in
       screen needs to know that a refusal means "name the shop first" rather
       than "wrong password", and that distinction is in here. */
    err.errors = json.errors || null;
    /* The server answered, so it decided: it did not write anything behind our
       back, and a retry is safe. */
    err.ambiguous = false;
    throw err;
  }
  return json.data;
}

/* Whoever is showing the screen subscribes; the api layer does not know or
   care what a React component is. */
let licenceWatcher = null;
export function onLicenceRefusal(fn) { licenceWatcher = fn; }
function err_licence(state) { try { licenceWatcher && licenceWatcher(state); } catch { /* ignore */ } }

const api = {
  get: (p) => raw("GET", p),
  post: (p, b) => raw("POST", p, b),
  put: (p, b) => raw("PUT", p, b),
  /* DELETE carries a body here. Most do not need one, but deleting a company
     requires its name typed back, and a confirmation that travelled in the URL
     would sit in every proxy log and browser history between here and the
     server. `raw` already handles a body for any method. */
  delete: (p, b) => raw("DELETE", p, b),
};
export default api;
