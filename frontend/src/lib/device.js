/**
 * device.js — the token that says "this computer has already proved itself".
 *
 * Signing in from a device the account has not used before needs a code from
 * the email. Once that has been done, the server hands back a token and this
 * keeps it, so the same person on the same machine is not asked again for the
 * next thirty days.
 *
 * ── what it is, and what it is not ───────────────────────────────────────
 *
 * It is **not** a session, and it is not enough to sign in with. On its own it
 * proves nothing at all — the password is still required every time, and this
 * only decides whether the *second* step is asked for. So a copy of it taken
 * off a shop PC buys somebody nothing unless they also have the password, at
 * which point they have what the token was protecting anyway.
 *
 * That is why it lives in localStorage next to everything else, rather than in
 * a cookie with flags that this app has no server-rendered pages to set. It is
 * also why it is kept under its own key: signing out clears the session, and
 * clearing the trust as well would ask a cashier for an emailed code every
 * single morning — which is the behaviour this whole mechanism exists to
 * avoid.
 *
 * It is cleared when the account revokes the device from another machine
 * (the server simply stops honouring it, and the next sign-in asks for a code
 * and issues a new one), and when a password is reset.
 */
const KEY = "vy_device";

/** The token for this machine, or "" if it has never earned one. */
export function deviceToken() {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}

/** Remember a token the server has just issued. */
export function setDeviceToken(token) {
  try {
    if (token) localStorage.setItem(KEY, token);
  } catch { /* a browser with storage switched off simply asks for a code each time */ }
}

/** Forget it — this machine will be asked for a code next time. */
export function forgetDevice() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}
