import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ErrorBoundary } from "./lib/ui.jsx";
import "./styles.css";
import "./deck.css";

// Apply the saved theme before first paint so the app never flashes the wrong one.
const appTheme = localStorage.getItem("vy_app_theme") || "light";
document.body.setAttribute("data-theme", appTheme);
// The till used to default to "light" independently of the app, so switching the
// app to dark left the till painting light text on dark surfaces (1.12:1). It now
// follows the app unless the operator has explicitly picked a till theme.
document.body.setAttribute("data-pos-theme", localStorage.getItem("vy_pos_theme") || appTheme);
document.body.setAttribute("data-accent", localStorage.getItem("vy_accent") || "blue");

/* ── Never show a blank screen ─────────────────────────────────────────────
 *
 * There were error boundaries around the till and around the page area, but
 * nothing around the app itself — so anything that failed in the sign-in
 * screen, the setup wizard, or App's own render tore the whole tree down and
 * left a blank window with no message anywhere. A shopkeeper cannot report
 * that, and nobody can diagnose it from the outside.
 *
 * Two things fix it for good: a boundary at the root, and every uncaught
 * error posted back to the server, where it lands in the black window and in
 * the log file support asks for. Reporting is best-effort and silent — a
 * failure to report an error must never itself become one.
 */
let reported = 0;
function report(kind, message, stack) {
  if (reported++ > 20) return;             /* a render loop must not flood the log */
  try {
    const body = JSON.stringify({
      kind,
      message: String(message || "").slice(0, 1000),
      stack: String(stack || "").slice(0, 4000),
      url: location.pathname + location.search,
      agent: navigator.userAgent,
    });
    /* sendBeacon survives the page being torn down; fetch is the fallback. */
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/system/client-error", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/system/client-error", {
        method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true,
      }).catch(() => {});
    }
  } catch { /* nothing in here is worth a second failure */ }
}
window.addEventListener("error", (e) => report("error", e.message, e.error && e.error.stack));
window.addEventListener("unhandledrejection", (e) => {
  const r = (e && e.reason) || {};
  report("unhandled-rejection", r.message || String(r), r.stack);
});

createRoot(document.getElementById("root")).render(
  <ErrorBoundary
    onError={(err, info) =>
      report("render", err && err.message, (err && err.stack) || (info && info.componentStack))}
  >
    <App />
  </ErrorBoundary>
);
