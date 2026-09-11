/**
 * server.js — app bootstrap (blueprint §5.1).
 * One Express app serves /api/* AND the built SPA. Same code local or hosted.
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");

/* Before any route file is required, because they build their routers the
   moment they are. Without this an `async` handler that throws produces a
   rejected promise Express never looks at: no log, no error reply, and no
   reply at all — the till spins until it times out. See the file itself. */
require("./shared/asyncroutes").install();

const { init, query } = require("./database/db");
const { setup } = require("./database/setup");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * The hashes of the inline scripts in the built page.
 *
 * A content policy of `script-src 'self'` refuses inline script, which is the
 * point of it — but the boot note in index.html has to be inline, because its
 * whole job is to say something when no file has loaded. Hashing it is the
 * narrow exception: that exact text may run, and nothing else may.
 *
 * Read once at boot. The build always runs before the server starts, so there
 * is nothing to keep in step by hand.
 */
function inlineScriptHashes() {
  try {
    const html = fs.readFileSync(path.join(__dirname, "..", "frontend", "dist", "index.html"), "utf8");
    const out = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (!m[1]) continue;
      out.push("'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
    }
    return out;
  } catch {
    /* No built page yet (a bare `node server.js` before a build). The policy
       simply omits the exception and the boot note stays quiet, which is the
       safe direction to fail in. */
    return [];
  }
}

// 1) Security / parsing.
/* A content policy the interface actually fits inside: everything it loads is
   its own, so `self` is enough for scripts, and the only concession is inline
   styles, which React writes as style attributes. Nothing here reaches out to
   the internet, so `connect-src 'self'` also means a compromised page cannot
   post a shop's takings anywhere.
   GENIUS_NO_CSP=1 turns it off if a customisation ever needs it — a switch
   worth having, but not a default. */
app.use(helmet({
  contentSecurityPolicy: process.env.GENIUS_NO_CSP === "1" ? false : {
    useDefaults: false,
    directives: {
      "default-src":     ["'self'"],
      /* index.html carries one inline script — the eight-second "this did not
         load" note. Its hash is read out of the built markup at boot, so
         exactly that one may run and everything else must still come from a
         file we served. Nothing to keep in step by hand: change the markup,
         rebuild, and the hash follows. */
      "script-src":      ["'self'", ...inlineScriptHashes()],
      /* Inter is loaded from Google Fonts by frontend/index.html. Self-hosting
         it would be better for a till that spends its day offline — until then
         the two hosts have to be named, or every screen falls back to Segoe. */
      "style-src":       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "img-src":         ["'self'", "data:", "blob:"],
      "font-src":        ["'self'", "data:", "https://fonts.gstatic.com"],
      "connect-src":     ["'self'"],
      "object-src":      ["'none'"],
      "base-uri":        ["'self'"],
      "form-action":     ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
  /* The till is served over plain HTTP on localhost; HSTS would be a
     promise it cannot keep and would poison the browser for the host name. */
  hsts: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
/* The interface is served from this same origin, so nothing legitimate is
   cross-origin. Leaving CORS wide open matters once GENIUS_LAN=1 puts the till
   on the shop's Wi-Fi: any page on that network could otherwise call the API.
   GENIUS_ORIGINS is the escape hatch for a deliberate second front end. */
const ALLOWED = String(process.env.GENIUS_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // same-origin and curl
    if (ALLOWED.includes(origin)) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    /* The packaged phone app. Its pages come from the app bundle, so its
       origin is the app itself rather than this server: `https://localhost`
       on Android (matched above) and `capacitor://localhost` on iOS. Listing
       them is not a hole — these origins cannot be claimed by a web page, so
       allowing them does not allow any site on the shop's Wi-Fi. */
    if (/^(capacitor|ionic):\/\/localhost$/.test(origin)) return cb(null, true);
    return cb(null, false);                             // refused, not thrown
  },
  credentials: true,
}));
app.use(morgan("tiny"));
app.use(express.json({ limit: "50mb" }));

/* 1b) Nothing under /api is cacheable.
   API replies went out with no Cache-Control at all, which lets a browser apply
   heuristic freshness and serve a GET out of its own cache without asking. That
   is how the Sales screen could open showing two invoices and Sh 42,900 while
   the books held six — a reply from minutes earlier, replayed, and corrected
   only once something forced a fresh request. These are live business figures;
   none of them are reusable. */
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  next();
});

// 2) Response helpers (blueprint §13.1) — used everywhere.
app.use((req, res, next) => {
  res.success = (data, message = "OK", status = 200) => res.status(status).json({ success: true, message, data });
  res.fail = (message, status = 400, errors = null) => res.status(status).json({ success: false, message, errors });
  res.notFound = (message = "Not found") => res.status(404).json({ success: false, message });
  next();
});

/* 2b) The licence gate.
 *
 * One middleware, sitting in front of every route mounted below, so a route
 * added next year cannot forget it. The rule is the phone app's rule, and it
 * is the whole reason a stopped till is not a hostage situation:
 *
 *   **Reading always works.** Every GET goes through — the books, the
 *   reports, the backup download, the company export. Nothing is deleted and
 *   nothing is withheld. A shop whose licence lapsed can still find out what
 *   it sold last March and take its data out.
 *
 *   **Writing stops.** Everything else is refused with a 403 the interface
 *   recognises and turns into the licence screen.
 *
 * The allow-list is short and every entry earns its place: sign-in must work
 * or nobody can reach the licence screen to fix it; the licence routes
 * themselves obviously; and restore, because being able to put yesterday's
 * books back is part of "nothing is held hostage".
 */
const licence = require("./modules/licence/licence.service");
const ALWAYS_ALLOWED = [
  /^\/api\/auth\//,          // sign in, sign up, reset — the way back in
  /^\/api\/licence(\/|$)/,   // the screen that fixes it
  /^\/api\/system\/restore/, // put the books back
  /^\/api\/system\/client-error$/, // a crash report is not a business record
  /^\/api\/health$/,
];
app.use("/api", async (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const url = req.originalUrl.split("?")[0];
  if (ALWAYS_ALLOWED.some((re) => re.test(url))) return next();

  let salesSince = 0;
  try {
    const at = licence.salesBaseline();
    const n = (await query("SELECT COUNT(*) c FROM sale_invoices")).rows[0].c;
    salesSince = Math.max(0, n - at);
  } catch { /* before the schema exists, or mid-restore: fall through */ }

  if (!licence.blocks(salesSince)) return next();

  const s = licence.status(salesSince);
  return res.status(403).json({
    success: false,
    licence: s,                       /* the interface switches to the licence screen on this */
    message: s.note && s.note !== s.title ? `${s.title} — ${s.note}` : s.title,
  });
});

// 3) API routes.
/* Onboarding first: signup, verification, password reset and invitations are
   the routes somebody reaches before they have an account, and they are
   deliberately a separate file from the sign-in routes they sit beside. */
/* One SQLite file per company, when asked for. Off by default: every
   installation shipped so far keeps a single file and never enters this code.
   See database/tenancy.js and ONLINE-ONBOARDING.md. */
if (process.env.SPLIT_STORAGE === "1") {
  const t = require("./database/tenancy").install();
  console.log(`Storage: one file per company (up to ${t.maxOpen} open, idle ${Math.round(t.idleMs / 60000)} min).`);
}

app.use("/api/licence", require("./modules/licence/licence.routes").router);
app.use("/api/auth", require("./modules/auth/onboarding.routes"));
app.use("/api/auth", require("./modules/auth/auth.routes"));
app.use("/api/companies", require("./modules/companies/companies.routes"));
app.use("/api/parties", require("./modules/parties/parties.routes"));
app.use("/api/reminders", require("./modules/parties/reminders.routes"));
app.use("/api/serials", require("./modules/items/serials.routes"));
app.use("/api/repacks", require("./modules/items/repacks.routes"));
app.use("/api/stock-takes", require("./modules/items/stocktake.routes"));
app.use("/api/items", require("./modules/items/items.routes"));
app.use("/api/sales", require("./modules/sales/sales.routes"));
app.use("/api/purchase-orders", require("./modules/purchases/purchaseorders.routes"));
app.use("/api/purchases", require("./modules/purchases/purchases.routes"));
app.use("/api/expenses", require("./modules/expenses/expenses.routes"));
app.use("/api/payments", require("./modules/payments/payments.routes"));
app.use("/api/money", require("./modules/money/money.routes"));
app.use("/api/staff", require("./modules/staff/staff.routes"));
app.use("/api/tax", require("./modules/tax/tax.routes"));
app.use("/api/recurring", require("./modules/recurring/recurring.routes"));
app.use("/api/installments", require("./modules/installments/installments.routes"));
app.use("/api/manufacturing", require("./modules/manufacturing/manufacturing.routes"));
app.use("/api/offers", require("./modules/offers/offers.routes"));
app.use("/api/loyalty", require("./modules/loyalty/loyalty.routes"));
app.use("/api/warranty", require("./modules/warranty/warranty.routes"));
app.use("/api/reports", require("./modules/reports/reports.routes"));
app.use("/api/returns", require("./modules/returns/returns.routes"));
app.use("/api/system", require("./modules/system/system.routes"));
app.use("/api/utilities", require("./modules/utilities/utilities.routes"));
app.use("/api/estimates", require("./modules/estimates/estimates.routes"));
app.use("/api/pos", require("./modules/pos/pos.routes"));
app.use("/store", require("./modules/store/store.routes"));
app.use("/api/shifts", require("./modules/shifts/shifts.routes"));
app.use("/api/settings", require("./modules/settings/settings.routes"));
app.use("/api/users", require("./modules/users/users.routes"));
app.use("/api/accounting", require("./modules/accounting/accounting.routes"));
app.use("/api/dashboard", require("./modules/dashboard/dashboard.routes"));
const appVersion = require("./shared/version");
app.get("/api/health", (req, res) => res.success({ ok: true, version: appVersion.version() }));

// 4) Serve the built SPA in production, with a catch-all to index.html.
const dist = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(dist)) {
  /* Hashed asset filenames change on every build, so they can be cached hard.
     index.html must never be cached, or the browser keeps asking for chunk
     names that the new build no longer contains — which is exactly the
     "Failed to fetch dynamically imported module" error after an update. */
  app.use(express.static(dist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) res.set("Cache-Control", "no-store, must-revalidate");
      /* Vite separates the content hash with a hyphen — index-DwbWu4Hc.css —
         so a pattern expecting a dot here silently never matches and every
         asset falls back to revalidation. Accept either separator. */
      else if (/[-.][0-9a-zA-Z_-]{8,}\.(js|css)$/.test(filePath)) res.set("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.set("Cache-Control", "no-store, must-revalidate");
    res.sendFile(path.join(dist, "index.html"));
  });
}

// 5) 404 + error handler (last).
app.use("/api", (req, res) => res.notFound());
app.use((err, req, res, next) => {
  /* "Too big" is not a server fault, and anonymising it is actively unhelpful.
     express.json's limit rejects the request before any route runs, so the
     handler below turned it into "Something went wrong. Reference: k3f9a2" —
     no mention of size, nothing to act on, at the exact moment someone is
     trying to recover their books. The restore routes now take a raw binary
     body with a far larger ceiling, but anything still posting base64 (an
     older client, a script) lands here, so say what happened and what to do. */
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    const mb = (n) => `${Math.round(Number(n) / 1048576)} MB`;
    const restoring = /\/restore/.test(req.originalUrl || "");
    return res.status(413).json({
      success: false,
      message: restoring
        ? `That backup is bigger than this route accepts as text (limit ${mb(err.limit || 0)}). ` +
          "Upload the .db file itself instead of pasting its contents — the Backup screen does " +
          "that. Nothing has been changed."
        : `That upload is too large (limit ${mb(err.limit || 0)}).`,
    });
  }

  /* A raw err.message reaches the browser and can hand an attacker your table
     and column names (a SQLite error quotes them verbatim). Log the real thing
     against a short reference id, and return only the id to the client — enough
     for a user to quote when they report a problem, useless to an attacker.
     In development we still return the detail so debugging isn't blindfolded. */
  const ref = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  console.error(`[err ${ref}]`, err);
  const dev = process.env.NODE_ENV !== "production";
  res.status(err.status || 500).json({
    success: false,
    ref,
    message: dev ? (err.message || "Server error") : `Something went wrong. Reference: ${ref}`,
  });
});

const ready = (async () => {
  await init();
  if (process.env.SPLIT_STORAGE === "1") {
    /* N+1 schemas rather than one: the central file, then every company's.
       A company left one migration behind does not announce itself — it
       refuses a column at the till, weeks later. */
    const tenancy = require("./database/tenancy");
    const { query } = require("./database/db");
    const done = await tenancy.setupAll(setup, async () =>
      (await query("SELECT id, name FROM firms ORDER BY id")).rows);
    console.log(`DB ready, schema ensured — central + ${done.length} compan${done.length === 1 ? "y" : "ies"}.`);
  } else {
    await setup();
    console.log("DB ready, schema ensured.");
  }
})();

ready.then(() => {
  if (require.main === module) {
    app.listen(PORT, () => console.log(`Genius POS on http://localhost:${PORT}`));
  }
}).catch((e) => {
  /* Whoever required this module owns the failure — the desktop shell shows a
     dialog, the CLI prints below. Without this catch the derived promise is
     unhandled, and on Node 20 an unhandled rejection ends the process before
     the owner can say anything useful about it. */
  if (require.main === module) {
    console.error("Genius POS could not start:", (e && e.stack) || e);
    process.exit(1);
  }
});

module.exports = { app, ready };
