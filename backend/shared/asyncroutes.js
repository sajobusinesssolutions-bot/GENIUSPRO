/**
 * asyncroutes.js — make Express 4 notice a handler that rejects.
 *
 * ── why this file has to exist ────────────────────────────────────────────
 *
 * Every route in this application used to be able to be synchronous, because
 * a query was a call into memory. Since the database moved behind a
 * connection (database/db.js), `query()` returns a promise and nearly every
 * handler in the tree is `async`.
 *
 * Express 4 does not await handlers. It calls them and moves on. So an
 * `async` handler that throws — a bad parameter, a constraint, the database
 * being unreachable — produces a rejected promise that Express never sees:
 *
 *   · the error handler in server.js does not run,
 *   · nothing is logged,
 *   · **no reply is ever sent**, so the till sits there with a spinner until
 *     its own timeout, and the shopkeeper is told nothing at all.
 *
 * That is a worse failure than the crash it replaced. Before this, a throw in
 * a synchronous handler at least reached the error handler and came back as
 * "Server error". Under Node 15 and later, an unhandled rejection also
 * terminates the process by default — so one bad request could take the till
 * down mid-sale.
 *
 * ── what it does ──────────────────────────────────────────────────────────
 *
 * It patches the router factory once, before any route file is required, so
 * every handler registered afterwards is wrapped: if it returns a promise,
 * a rejection is forwarded to `next(err)` and lands in the same error handler
 * a synchronous throw always did. Nothing else about the handler changes.
 *
 * Patching the factory rather than editing 273 route registrations is
 * deliberate. The alternative is an `asyncHandler(...)` call wrapped around
 * every route in forty-one files, where the failure mode of forgetting one is
 * silent — a single route that hangs instead of answering, discovered by a
 * cashier. One patch cannot be forgotten.
 *
 * It must be required BEFORE the route modules, because they call
 * `express.Router()` at require time. server.js does this on its first line
 * of application code.
 */
const express = require("express");

/* The registration methods that take handlers. `use` is included: middleware
   reads the database too (auth, the firm-in-context wrapper), and middleware
   that rejects silently is the same failure as a route that does. */
const METHODS = [
  "get", "post", "put", "patch", "delete", "head", "options", "all", "use",
];

function wrap(h) {
  if (typeof h !== "function") return h;            // path strings, arrays
  /* Express identifies an error handler by its arity, and re-wrapping would
     hide it — errors would then skip it and reach the default handler, which
     answers with a stack trace. Left exactly as it is. */
  if (h.length >= 4) return h;
  /* A mounted router or app is itself a function of three arguments. Wrapping
     one would work for the call, but it would also drop `.stack`, `.handle`
     and the other properties Express and our own tests reach for. Routers
     already forward their children's errors, so there is nothing to add. */
  if (h.stack || h.handle || h.__asyncWrapped) return h;

  const wrapped = function (req, res, next) {
    let out;
    /* A synchronous throw already reached `next` via Express's own try/catch,
       but only when Express is the caller. Catching here as well means the
       behaviour is identical whichever way the handler was reached. */
    try { out = h.call(this, req, res, next); }
    catch (e) { return next(e); }
    if (out && typeof out.then === "function") {
      /* `next` once, and only for a rejection. Resolving is not our business:
         the handler has already answered, or has deliberately called next()
         itself, and calling it again here would run the route twice. */
      Promise.resolve(out).catch(next);
    }
    return out;
  };
  wrapped.__asyncWrapped = true;
  /* Kept for stack traces and for anything that reports which handler ran. */
  Object.defineProperty(wrapped, "name", { value: h.name || "handler" });
  return wrapped;
}

let patched = false;

/** Patch Express's router and application prototypes. Safe to call twice. */
function install() {
  if (patched) return;
  patched = true;
  const targets = [express.Router, express.application];
  /* express.Router is the prototype object new routers are created from, and
     express.application is the one `app` is created from. Both carry their own
     copies of these methods, so both need patching or `app.get(...)` would
     stay unwrapped while `router.get(...)` was covered. */
  for (const proto of targets) {
    if (!proto) continue;
    for (const m of METHODS) {
      const original = proto[m];
      if (typeof original !== "function" || original.__asyncPatched) continue;
      const patchedFn = function (...args) {
        return original.apply(this, args.map(wrap));
      };
      patchedFn.__asyncPatched = true;
      Object.defineProperty(patchedFn, "name", { value: m });
      proto[m] = patchedFn;
    }
  }
}

module.exports = { install, wrap };
