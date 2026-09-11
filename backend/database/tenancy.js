/**
 * tenancy.js — one SQLite file per company, opened on demand.
 *
 * ── why this exists ───────────────────────────────────────────────────────
 *
 * `db.js` keeps a whole database in wasm memory and exports the entire file on
 * every committed write. For one shop on one machine that is a good design and
 * round ten measured its ceiling at roughly 45 years of trading. Point it at
 * one shared hosted instance and every property inverts:
 *
 *   - every shop's sale exports every other shop's data;
 *   - the 2 GB wasm ceiling becomes a *shared* ceiling — 45 years for one shop
 *     is about three months across two hundred;
 *   - one write mutex means shop A's sale queues behind shop B's;
 *   - a tenant-scoping bug stops being one shop's problem and becomes a breach.
 *
 * So each company gets its own file, and this is the thing that opens, caches
 * and closes them. It holds `makeStore` instances rather than a second storage
 * implementation, so a company file inherits the atomic save, the
 * transaction-aware flush, the stuck-lock watchdog and the capacity warning
 * that took thirteen rounds to get right.
 *
 * ── how a statement finds its file ────────────────────────────────────────
 *
 * `AsyncLocalStorage` carries the company for the duration of a request, set
 * once by the auth middleware, and `database/router.js` says whether a given
 * statement belongs to the company or to the central file. Nothing else in the
 * application changes: all forty-five callers still import `{ query, pool }`.
 *
 * ── what is deliberately NOT solved here ──────────────────────────────────
 *
 * **A transaction cannot span two files.** SQLite has no distributed commit
 * and inventing one on top of two wasm handles would be a lie. So a write to
 * the other database from inside an open transaction throws by name, and the
 * handful of operations that genuinely touch both — creating a company,
 * accepting an invitation, restoring — have to order their writes so that a
 * crash between them leaves something repairable rather than something wrong.
 * Making that loud is the whole point; a silent half-commit across two files
 * is the same class of failure as round twelve's silent restore.
 *
 * Off unless `SPLIT_STORAGE=1`. Every installation shipped so far keeps one
 * file and never enters this code.
 */
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const db = require("./db");
const { homeOf, CROSS_HOME } = require("./router");

const als = new AsyncLocalStorage();

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/* How many company files may be open at once. Each costs its own wasm memory,
   so this is a memory budget rather than a file-handle one: thirty 20 MB shops
   is fine, three hundred is not. */
const MAX_OPEN = num(process.env.TENANT_MAX_OPEN, 24);
/* A shop that has not been touched for this long is closed. Closing flushes
   first, so nothing is lost — it costs the next request a re-open. */
const IDLE_MS = num(process.env.TENANT_IDLE_MINUTES, 10) * 60 * 1000;

const enabled = () => process.env.SPLIT_STORAGE === "1";

/** Where a company's file lives. Beside the central one, in `firms/`. */
function fileFor(firmId) {
  return path.join(path.dirname(db.DB_PATH), "firms", `firm-${Number(firmId)}.db`);
}

/**
 * The same idea when the books are hosted: one database per company, named by
 * a template rather than a path.
 *
 *   GENIUS_DB_URL_TEMPLATE=libsql://geniuspos-firm{firm}-acme.turso.io
 *
 * There is no default and no fallback to the central database, deliberately.
 * Every reason this file exists — one shop's data never leaving with another's,
 * one shop's write never queueing behind another's, a scoping bug staying one
 * shop's problem rather than becoming a breach — is a reason not to quietly
 * put two companies in one database because a variable was missing.
 */
function urlFor(firmId) {
  const tpl = (process.env.GENIUS_DB_URL_TEMPLATE || "").trim();
  if (!tpl) {
    throw new Error(
      "This installation keeps a database per company (SPLIT_STORAGE=1) on hosted storage, but " +
      "GENIUS_DB_URL_TEMPLATE is not set, so there is no address for company " + Number(firmId) + "'s " +
      "books. Set it to the database address with {firm} where the company number goes.");
  }
  if (!tpl.includes("{firm}")) {
    throw new Error("GENIUS_DB_URL_TEMPLATE has no {firm} in it, so every company would be sent to the same database.");
  }
  return tpl.replace(/\{firm\}/g, String(Number(firmId)));
}

const open = new Map();   // firmId -> store

/**
 * The store for a company, opened if necessary.
 *
 * Synchronous on purpose, and still so now that `query()` is not: the SQL
 * router picks a company's store from *inside* `query()`, before there is a
 * promise to attach anything to, so this cannot be made to await. On a local
 * installation the open is a `readFileSync` plus a wasm parse — the same thing
 * boot does — and lands on the first request for a company after an eviction.
 * On a hosted one there is nothing to open at all: the store holds an address.
 */
function storeFor(firmId) {
  const id = Number(firmId);
  if (!id) throw new Error("No company in context — the storage layer does not know which file to use.");
  let s = open.get(id);
  if (s) return s;

  if (db.hosted()) {
    /* Nothing is opened here — a hosted store holds an address, not a handle,
       and the first statement is what proves the address works. That keeps
       this function synchronous, which the SQL router depends on. */
    s = db.makeRemoteStore({ url: urlFor(id), token: db.remote.token, label: `firm-${id}` });
  } else {
    fs.mkdirSync(path.dirname(fileFor(id)), { recursive: true });
    s = db.makeStore(fileFor(id), { label: `firm-${id}` });
    s.openSync();
  }
  db.registerStore(s);
  open.set(id, s);
  evictIfCrowded();
  return s;
}

/* Close the least recently used files once there are too many open.
 *
 * A store in a transaction or holding its write lock is never closed — closing
 * it would roll back a sale somebody is in the middle of ringing up. If every
 * open store is busy, nothing is evicted and the cap is exceeded rather than a
 * live transaction being destroyed: a memory limit is a budget, and a
 * half-rung sale is not. */
function evictIfCrowded() {
  while (open.size > MAX_OPEN) {
    const idle = [...open.entries()]
      .filter(([, s]) => !s.inTransaction() && !s.locked())
      .sort((a, b) => b[1].idleMs() - a[1].idleMs());
    if (!idle.length) {
      console.warn("tenancy: %d company files open, all of them busy — over the %d cap.", open.size, MAX_OPEN);
      return;
    }
    closeOne(idle[0][0]);
  }
}

/** Close one company's file, saving anything outstanding first. */
function closeOne(firmId) {
  const s = open.get(Number(firmId));
  if (!s) return false;
  open.delete(Number(firmId));
  db.unregisterStore(s);
  s.close();
  return true;
}

/** Close every company file that has been idle too long. */
function sweep() {
  for (const [id, s] of [...open.entries()]) {
    if (s.inTransaction() || s.locked()) continue;
    if (s.idleMs() > IDLE_MS) closeOne(id);
  }
}
const sweeper = setInterval(sweep, Math.max(60000, IDLE_MS / 4));
if (sweeper.unref) sweeper.unref();

/* ── the request's company ────────────────────────────────────────────────── */

/** Run `fn` with `firmId` as the company every statement inside it belongs to. */
function withFirm(firmId, fn) {
  /* The surrounding context is carried, not replaced.
     `setupAll` pins a store and then names the company inside it; the first
     version of this built a fresh context and dropped the pin, so the schema
     for a brand-new company was written to whichever file the router thought
     each `CREATE TABLE` belonged to. The company's file came out with no
     tables in it and the first insert said "no such table: roles". */
  const ctx = als.getStore() || {};
  return als.run({ ...ctx, firmId: Number(firmId) || null }, fn);
}

/**
 * Run `fn` with every statement pinned to one store, whatever `router.js`
 * would otherwise say.
 *
 * For schema work only, and it is the one deliberate hole in the routing. A
 * `CREATE TABLE` has no company: the same DDL has to run against the central
 * file and against every company's file, and asking the router where
 * `CREATE TABLE items` belongs gets the right answer to the wrong question.
 *
 * It is not an escape hatch for ordinary queries. Everything else in this
 * application should be reachable through `withFirm`, and a statement that
 * needs pinning is a statement that has not decided which database it is
 * about.
 */
function withStore(store, fn) {
  return als.run({ firmId: currentFirm(), pinned: store }, fn);
}

/**
 * Bring every file's schema up to date: the central one, then each company's.
 *
 * Boot used to be one call to `setup()` against one file. With a file per
 * company there are N+1 schemas to migrate and **the failure mode of getting
 * this wrong is a company whose file is one migration behind** — which does
 * not announce itself, it just refuses a column at the till weeks later. So
 * every company is migrated at boot, in order, and a failure names which.
 */
function setupAll(setup, listFirms) {
  const done = [];
  return Promise.resolve()
    .then(() => withStore(db.central, () => setup()))
    .then(() => {
      const firms = listFirms();
      return firms.reduce((chain, f) => chain.then(() => {
        const store = storeFor(f.id);
        return withStore(store, () => withFirm(f.id, () => setup()))
          .then(() => done.push(f.id))
          .catch((e) => { throw new Error(`Company ${f.id} (${f.name || "unnamed"}) could not be migrated: ${e.message}`); });
      }), Promise.resolve());
    })
    .then(() => done);
}
/** The company in context, or null. */
function currentFirm() {
  const s = als.getStore();
  return s ? s.firmId : null;
}

/**
 * Express middleware: put the request's company into context.
 *
 * It runs after `verifyToken`, which is what decides which company this
 * request may touch — reading the membership and the firm's status from the
 * central database on every request. Taking the company from the token without
 * that check would make the storage layer the thing that decides which shop's
 * books are opened, which is precisely the wrong place for that decision.
 */
function tenantContext(req, res, next) {
  const firmId = req.user && req.user.firm_id;
  if (!firmId) return next();
  return withFirm(firmId, () => next());
}

/* ── routing ─────────────────────────────────────────────────────────────── */

/**
 * Which store answers a statement.
 *
 * `null` sql means "a connection, not a statement" — `pool.getConnection()`.
 * A connection belongs to the company, because that is where every transaction
 * in this application writes; the central database is written outside one.
 */
function route(sql) {
  if (!enabled()) return db.central;
  const ctx = als.getStore();
  if (ctx && ctx.pinned) return ctx.pinned;   // schema work — see withStore
  if (sql == null) {
    const id = currentFirm();
    return id ? storeFor(id) : db.central;
  }
  const h = homeOf(sql);
  if (h.home === CROSS_HOME) throw h.error;
  if (h.home === "tenant") {
    const id = currentFirm();
    if (!id) {
      throw new Error(
        `This statement belongs to a company's own database and no company is in context: ` +
        `${String(sql).replace(/\s+/g, " ").slice(0, 120)}. ` +
        `Wrap the work in withFirm(firmId, …).`);
    }
    return storeFor(id);
  }
  return db.central;
}

/** Turn it on. Called once at boot, and only when SPLIT_STORAGE=1. */
function install() {
  db.installRouter(route);
  return { enabled: enabled(), maxOpen: MAX_OPEN, idleMs: IDLE_MS };
}

/** What is open right now — for the tests and for an operations endpoint. */
function openFiles() {
  return [...open.entries()].map(([id, s]) => ({
    firm_id: id, file: s.file, bytes: s.sizeBytes(), idle_ms: s.idleMs(),
    in_transaction: s.inTransaction(),
  }));
}

module.exports = {
  install, route, storeFor, closeOne, sweep, openFiles, fileFor,
  withFirm, withStore, setupAll, currentFirm, tenantContext, enabled, MAX_OPEN, IDLE_MS,
};
