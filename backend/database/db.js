/**
 * db.js — storage abstraction (blueprint §5.2).
 *
 * Presents one API over two engines:
 *   - query(sql, params)         -> Promise<{ rows, insertId, changes }>
 *   - pool.getConnection()       -> a connection with begin/commit/rollback
 *
 * ── why every call is a promise now ───────────────────────────────────────
 *
 * It used to be synchronous, because the database was a file in this process's
 * memory and a query was a function call. It is a promise because the database
 * may now live somewhere else: `GENIUS_DB_URL` points the whole application at
 * a hosted SQLite database (Turso / libSQL — see database/libsql.js), which is
 * what lets a phone and a till read the same books at the same time instead of
 * taking turns with a snapshot.
 *
 * A network call cannot be made to look synchronous, so the local engine was
 * made to look asynchronous instead: with sql.js the promise below is already
 * settled when the caller receives it, and nothing waits on anything. The cost
 * is one `await` per call site, which is mechanical. The alternative — two
 * shapes of the same API, one per engine — would mean every route in the tree
 * knowing which kind of database it was talking to, and that knowledge leaking
 * into the money-moving paths is exactly what this file exists to prevent.
 *
 * sql.js keeps the DB in memory, so we persist to a single file on disk after
 * every committed write (debounced). The file path comes from GENIUS_DB_PATH,
 * defaulting to ./data/genius.db — point this at a Render persistent disk in prod.
 *
 * Why sql.js instead of better-sqlite3: it needs no native compilation, so the
 * same artifact runs on any host (and in restricted CI sandboxes). The blueprint
 * always intended this as the portable fallback.
 *
 * ── one store, or many ────────────────────────────────────────────────────
 *
 * Everything below that owns a database — the handle, the dirty flag, the
 * end-of-turn flush, the transaction depth, the write mutex, the capacity
 * warning — used to be module-level state, because there was exactly one file.
 * It is now `makeStore(path)`, created once as `central`.
 *
 * That is not a cosmetic change. Going online means one SQLite file per
 * company (see ONLINE-ONBOARDING.md): sharing one file between shops makes
 * every shop's sale export every other shop's data, turns a 45-year ceiling
 * into a three-month one, and makes one shop's till queue behind another's.
 * The manager that opens, caches and evicts those files is `tenancy.js`, and
 * it holds `makeStore` instances — so a tenant file gets the atomic save, the
 * transaction-aware flush, the stuck-lock watchdog and the wasm capacity
 * warning that took this file thirteen rounds to get right, rather than a
 * second implementation that has to learn them again.
 *
 * With `SPLIT_STORAGE` unset — every installation shipped so far — there is
 * exactly one store and this file behaves precisely as it did before.
 */
const fs = require("fs");
const path = require("path");
/* sql.js is loaded when it is first needed rather than at require time.
   An installation whose books are hosted (GENIUS_DB_URL) never opens a local
   database and should not fail to start because the local engine is missing;
   it is still loaded for per-company exports, which build a real SQLite file
   out of a company's rows. */
let _initSqlJs = null;
function initSqlJs(...args) {
  if (!_initSqlJs) {
    try { _initSqlJs = require("sql.js"); }
    catch (e) {
      throw new Error(
        "This installation keeps its books in a file on this computer, which needs the sql.js " +
        "engine, and it could not be loaded (" + e.message + ").");
    }
  }
  return _initSqlJs(...args);
}
const libsql = require("./libsql");

/* The product was renamed to Genius POS. An installation made before that has
   its books in `vyapar.db` and its path in `VYAPAR_DB_PATH`, and a rename that
   loses a shop's books is not a rename, it is a disaster. So: the old variable
   is still honoured, and an old file where the new one would go is moved across
   once, before anything opens it. */
const DB_PATH = process.env.GENIUS_DB_PATH || process.env.VYAPAR_DB_PATH ||
                path.join(__dirname, "..", "data", "genius.db");

/* Asked twice: once here, in the file-shaped work that happens at require
   time, and once below where the engine is chosen. A hosted installation must
   not create directories or move files around on a disk it may not even be
   able to write to — a container filesystem is often read-only, and failing to
   boot over a folder nobody will ever look in would be a poor trade. */
const HOSTED = !!(process.env.GENIUS_DB_URL || "").trim();

if (!HOSTED) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

(function carryOldBooksOver() {
  if (HOSTED) return;                                       // no local file to carry
  if (fs.existsSync(DB_PATH)) return;                       // nothing to decide
  /* Two places the old books can be: where the old variable pointed, or beside
     where the new file would go. The variable comes first — a deployment that
     set VYAPAR_DB_PATH to another disk means it, and looking only next door
     would abandon exactly the books this is here to save. */
  const candidates = [
    process.env.VYAPAR_DB_PATH,
    path.join(path.dirname(DB_PATH), "vyapar.db"),
  ].filter(Boolean).filter((p) => p !== DB_PATH);
  const old = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!old) return;
  try {
    fs.renameSync(old, DB_PATH);
    console.log(`Carried the books over from ${old} to ${DB_PATH}.`);
    return;
  } catch { /* a different disk: rename cannot cross one, so copy */ }
  /* Copying has to land whole or not at all. A half-copied file at DB_PATH
     would satisfy the check above on the next start, and the intact original
     would never be looked at again. */
  const staging = DB_PATH + ".migrating";
  try {
    fs.copyFileSync(old, staging);
    const fd = fs.openSync(staging, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(staging, DB_PATH);
    console.log(`Copied the books over from ${old} to ${DB_PATH}.`);
  } catch (e) {
    try { fs.unlinkSync(staging); } catch { /* may not exist */ }
    console.error("Could not carry the old database over:", e.message);
  }
})();

let SQL = null;

/* ── how much this can hold, and saying so before it stops holding it ────────
 *
 * sql.js runs SQLite in a WebAssembly linear memory. That memory grows on
 * demand but is capped at 2 GB by the wasm build, and the whole database lives
 * inside it — the file bytes, SQLite's page cache, and (during a save) the
 * export copy. So there is a real ceiling, and it is set by the size of the
 * file, not by anything the shop does.
 *
 * Measured, on generated shops (`seed-large.js`), booting the real server and
 * driving the real endpoints:
 *
 *     invoices     rows      file      opens   worst endpoint
 *      20,000      380k    31.8 MB     0.6s    1.3s
 *     100,000      1.9M     169 MB     1.9s    2.2s (after the new indexes)
 *     300,000      5.6M     486 MB      12s    5.7s
 *     500,000      9.3M     989 MB      20s     11s   ← 2.9 GB peak RSS
 *
 * 500,000 invoices works. It is also close to the wall: the peak is roughly
 * twice the file, and 2 GB of that has to fit in wasm. Somewhere a little past
 * a 1 GB file the open stops succeeding, and when it stops it stops with
 * `RuntimeError: memory access out of bounds`, which tells a shopkeeper
 * nothing.
 *
 * In trading terms 500,000 invoices is about 45 years at 30 sales a day, or 15
 * years at 90. The warning below fires at 600 MB — around 300,000 invoices, or
 * 27 years at 30 a day — which is early enough that "archive the old years"
 * is a calm decision rather than an emergency.
 *
 * Per file, deliberately: the ceiling is a property of a database, and one
 * company's twenty years is nothing to do with another's.
 */
const WARN_BYTES = 600 * 1024 * 1024;
const CEILING_NOTE =
  "This app keeps the whole database in memory, and that memory tops out a little past 1 GB.\n" +
  "Nothing is wrong yet and nothing has been lost — but this file will not grow for ever.\n" +
  "Ask whoever set the system up to archive the oldest completed years to a separate\n" +
  "backup file and remove them from the live one. Do it while the shop is still trading\n" +
  "normally, not after it stops.";

/* The wasm heap failing is not a bug report, it is a capacity fact. Say which. */
function explainIfOutOfMemory(e, what, bytes) {
  const msg = String((e && e.message) || e);
  if (!/memory access out of bounds|out of memory|Array buffer allocation|Invalid typed array length|RangeError/i.test(msg)) return e;
  return new Error(
    `The database is too large for this app to ${what} (${(bytes / 1048576).toFixed(0)} MB).\n${CEILING_NOTE}\n` +
    `(underlying error: ${msg})`
  );
}

/**
 * One database file, and everything that owns it.
 *
 * @param {string} file      where it lives on disk
 * @param {object} [opts]    { label } for log messages
 */
function makeStore(file, opts = {}) {
  const label = opts.label || path.basename(file);
  let db = null;
  let dirty = false;
  let pendingSave = null;   // setImmediate handle for the end-of-turn flush
  let txnDepth = 0;         // >0 while a BEGIN is open on the one sql.js handle
  let warnedAtBytes = 0;
  let lastTouched = Date.now();

  /* Connection-scoped settings. sql.js's export() closes and reopens the SQLite
     handle underneath us (that is how it reads the file back out of its virtual
     filesystem), and a reopened handle starts from SQLite's defaults — which
     means foreign_keys goes back to OFF. So this is applied on open AND after
     every save.
     *
     * ── what this pragma is actually doing, which is nothing ──────────────
     *
     * A previous round described this as closing a hole where "an orphan child
     * row was then accepted". That was wrong, and the correction is worth
     * having written down: **this schema declares no foreign keys at all.**
     * There is not one REFERENCES clause in any of the three setup files, so
     * `foreign_keys = ON` has nothing to enforce and never did. It is
     * harmless, and it is not the safety net the old comment promised.
     *
     * Declaring them properly would mean a table rebuild per constraint in
     * SQLite, and any orphan already in a shop's data would start hard-failing
     * writes at the till. So the integrity check lives in the test suite
     * instead — see test/orphans.test.js — where it can find the same problems
     * and report them without refusing a sale. The pragma stays because
     * turning it off would be a change for no reason, and because the day the
     * schema does declare a key, it will already be enforced. */
  function applyPragmas() {
    if (db) db.run("PRAGMA foreign_keys = ON;");
  }

  /** Current size of this database on disk, in bytes (0 if it has never saved). */
  function sizeBytes() {
    try { return fs.statSync(file).size; } catch { return 0; }
  }

  function capacityCheck(bytes) {
    if (bytes < WARN_BYTES) return;
    /* Re-warn every further 100 MB rather than on every save, so the log stays
       readable but the problem does not scroll away and get forgotten. */
    if (bytes < warnedAtBytes + 100 * 1024 * 1024) return;
    warnedAtBytes = bytes;
    console.warn(
      `\n*** The database "${label}" is now ${(bytes / 1048576).toFixed(0)} MB. ***\n${CEILING_NOTE}\n`
    );
  }

  /* Atomic save: write a temp file, flush it to the disk platter, then rename
     over the live DB. A power cut can now only lose the last write, never
     corrupt the file. */
  function persist() {
    if (!db) return;
    /* Never export with a transaction open. db.export() closes the handle, and
       closing discards the open transaction: the rows written since BEGIN are
       silently thrown away and the caller's COMMIT then fails with "cannot
       commit - no transaction is active". The save is not skipped, only
       deferred — commit() and rollback() flush as soon as the transaction is
       off. */
    if (txnDepth > 0) { dirty = true; return; }
    /* The export doubles the database in memory for an instant, so it is the
       first thing to fail when the wasm heap runs out. It still throws — a
       save that did not happen must never look like one that did — but it
       throws something the shopkeeper can act on instead of a wasm trap. */
    let data;
    try { data = Buffer.from(db.export()); }
    catch (e) { throw explainIfOutOfMemory(e, "save", sizeBytes()); }
    applyPragmas();              // the export reopened the handle and reset them
    const tmp = file + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);          // force to disk before we swap it in
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);    // atomic on the same filesystem
    capacityCheck(data.length);  // after the save: the shop's data is safe either way
    dirty = false;
    if (pendingSave) { clearImmediate(pendingSave); pendingSave = null; }
  }

  /**
   * Flush at the end of the current event-loop turn.
   *
   * This used to be a 200ms debounce with a 3s ceiling, which meant a write
   * the server had already answered "OK" to sat only in memory for up to a
   * fifth of a second — measurably: a held bill acknowledged and then
   * SIGKILLed 100ms later was gone on restart. It also let the 3s ceiling call
   * persist() synchronously from inside a transaction, which (see above)
   * destroys it.
   *
   * setImmediate runs once per loop iteration, after the current batch of I/O
   * callbacks. So a burst of writes handled in one turn still costs exactly
   * one export — the coalescing the debounce was there for — but the unsaved
   * window is one event-loop turn rather than 200-3000ms.
   *
   * It is still not a durability *guarantee*: the response is written to the
   * socket before the immediate runs, so a machine that loses power in that
   * sub-millisecond gap loses that write. Anything that must be on disk before
   * the client is told it happened goes through a transaction — commit() saves
   * synchronously before it returns.
   */
  function scheduleSave() {
    dirty = true;
    if (pendingSave || txnDepth > 0) return;
    pendingSave = setImmediate(() => { pendingSave = null; if (dirty) persist(); });
  }

  /* Never exit with unsaved work. */
  function flushOnExit() {
    try {
      /* A transaction still open at exit is by definition unfinished work, and
         persist() refuses to export around one. Roll it back so the save can
         proceed rather than dropping every committed write that came before
         it. */
      if (txnDepth > 0) { try { db.run("ROLLBACK"); } catch { /* already gone */ } txnDepth = 0; }
      if (dirty) persist();
    } catch (e) { console.error(`Final save failed for ${label}:`, e.message); }
  }

  /* The same open, for a caller that has no `await` to spend.
     The SQL router (database/router.js) decides which file a statement belongs
     to from inside `query()`, before there is anything to await, so the
     tenancy manager has to be able to open a company's file synchronously. It
     is only ever reachable after boot, by which point sql.js is loaded — which
     is asserted rather than assumed, because a null here would silently create
     an empty database over a shop's books. */
  function openSync() {
    if (db) return db;
    if (!SQL) throw new Error("The database layer is not initialised yet — call init() first.");
    if (fs.existsSync(file)) {
      capacityCheck(sizeBytes());
      try { db = new SQL.Database(fs.readFileSync(file)); }
      catch (e) { throw explainIfOutOfMemory(e, "open", sizeBytes()); }
    } else {
      db = new SQL.Database();
    }
    applyPragmas();
    return db;
  }

  async function open() {
    if (db) return db;
    if (!SQL) SQL = await initSqlJs();
    if (fs.existsSync(file)) {
      /* Say the size before trying, so a boot that dies here leaves the number
         in the log rather than only a wasm trap. */
      capacityCheck(sizeBytes());
      try { db = new SQL.Database(fs.readFileSync(file)); }
      catch (e) { throw explainIfOutOfMemory(e, "open", sizeBytes()); }
    } else {
      db = new SQL.Database();
    }
    applyPragmas();
    return db;
  }

  /* ── never call db.exec() ──────────────────────────────────────────────────
   *
   * sql.js 1.14.1's Database.exec() takes 16 bytes off the Emscripten stack
   * (`stackAlloc(4)` for its pzTail out-parameter) and never restores the stack
   * pointer. The leak is per call and independent of the data: the wasm stack
   * is 5 MB, so the 327,680th exec() walks the stack pointer off the bottom of
   * it and the next SQLite write dies with `RuntimeError: memory access out of
   * bounds` — measured at 328,905 bare `SELECT 1` calls on an empty database.
   *
   * This mattered because query() used to ask for last_insert_rowid() through
   * exec() after *every* write, so the process had a hard budget of ~328,000
   * writes and then fell over, whatever the database contained. That was the
   * ceiling the scale work kept hitting; it was never a data-volume limit.
   *
   * prepare()/step()/free() has no such leak (verified to 1,000,000 calls), so
   * the rowid comes back through a statement. Statements are not cached across
   * calls on purpose: persist() calls db.export(), which closes and reopens
   * the underlying handle, and any statement held over that point is a
   * dangling pointer into a freed sqlite3.
   */
  function lastInsertRowid() {
    const stmt = db.prepare("SELECT last_insert_rowid() AS id");
    try { return stmt.step() ? stmt.get()[0] : null; } finally { stmt.free(); }
  }

  /** Run a statement. SELECT -> rows; INSERT/UPDATE/DELETE -> insertId + changes.
   *
   *  Async by signature, not by behaviour: sql.js answers out of memory, so
   *  the promise is settled before the caller sees it. The shape exists so
   *  that the hosted engine, where the answer really does cross a network, is
   *  the same call to every caller in the tree. */
  async function query(sql, params = []) {
    lastTouched = Date.now();
    /* A missing field arrives as `undefined`, which sql.js refuses to bind — it
       throws a bare string with no stack, so the route's own validation never
       runs and the caller gets "Server error" instead of "Choose an invoice".
       `undefined` and SQL NULL mean the same thing here: not supplied.
       Convert, and let the route say what is actually wrong. */
    if (Array.isArray(params)) {
      for (let i = 0; i < params.length; i++) if (params[i] === undefined) params[i] = null;
    }
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("WITH")) {
      /* free() in a `finally`: a statement that throws part-way through (a bad
         bind, a constraint surfacing on step) otherwise leaks its sqlite3_stmt
         and the C string behind it for the lifetime of the process. */
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return { rows, insertId: null, changes: 0 };
      } finally { stmt.free(); }
    }
    db.run(sql, params);
    const insertId = lastInsertRowid();
    const changes = db.getRowsModified();
    scheduleSave();
    return { rows: [], insertId, changes };
  }

  /* ── one writer at a time ──────────────────────────────────────────────────
   *
   * There is exactly one sql.js handle per store, so there is exactly one
   * transaction. SQLite has no nested BEGIN: if a second request opened one
   * while the first was still running, the second BEGIN would throw and — far
   * worse — the two requests' statements would land in the same transaction,
   * so one rollback would undo the other's sale.
   *
   * Today that cannot happen by luck rather than by design: no money-moving
   * handler awaits real I/O between BEGIN and COMMIT, and Node cannot dispatch
   * another request while one runs synchronously. That is a property of every
   * handler in the tree, and it is one `await` away from not being true. This
   * mutex makes it a property of the *storage layer* instead: getConnection()
   * queues, so a handler that does await mid-transaction becomes slow rather
   * than wrong.
   *
   * Uncontended it costs nothing — the lock is free and the promise resolves in
   * the same microtask the caller was already awaiting.
   *
   * Per store, which is the point of splitting the files: one shop's slow
   * stock-take stops being every other shop's queue.
   */
  let lockHeld = false;
  const lockWaiters = [];
  let lockWatchdog = null;
  const LOCK_STUCK_MS = 30000;

  function acquireWriteLock() {
    return new Promise((resolve) => {
      const grant = () => {
        lockHeld = true;
        clearTimeout(lockWatchdog);
        /* A handler that never releases would wedge every till in the shop for
           good. Nothing in the tree does — all 25 call sites release in a
           `finally` — but "nothing does" is not a guarantee we can leave the
           counter depending on. Complain loudly and take the lock back. */
        lockWatchdog = setTimeout(() => {
          console.error("db: a connection to %s was held for %ds — forcing it open. This is a bug; the stack that took it never released.", label, LOCK_STUCK_MS / 1000);
          try { if (txnDepth > 0) { db.run("ROLLBACK"); txnDepth = 0; } } catch { /* nothing open */ }
          releaseWriteLock();
        }, LOCK_STUCK_MS);
        if (lockWatchdog.unref) lockWatchdog.unref();
        resolve();
      };
      if (!lockHeld) grant(); else lockWaiters.push(grant);
    });
  }

  function releaseWriteLock() {
    clearTimeout(lockWatchdog);
    lockWatchdog = null;
    const next = lockWaiters.shift();
    if (next) next(); else lockHeld = false;
  }

  /**
   * Connection / transaction helper. sql.js is single-threaded, so a
   * "connection" is a thin wrapper that issues transactions on the single
   * handle. The handler shape matches the blueprint's route pattern
   * (begin/commit/rollback/release).
   */
  function makeConnection(self) {
    let inTxn = false;
    let released = false;
    /* A connection belongs to one file, and one file is as far as a
       transaction reaches.
       *
       * With a single store this is the whole story. With a file per company
       * a handler inside `durable()` may name a table that lives in the other
       * database — reading one is harmless and is simply routed there, but
       * **writing** to it from inside an open transaction is not: the two
       * writes cannot commit or roll back together, and SQLite has no
       * distributed commit to borrow. So that throws, by name, and the few
       * operations that genuinely touch both — creating a company, accepting
       * an invitation, restoring one — have to order their writes so that a
       * crash between them leaves something repairable rather than something
       * silently wrong. Inventing a two-file commit that mostly works would be
       * the same class of failure as round twelve's silent restore. */
    const connQuery = async (sql, params) => {
      const target = storeFor(sql);
      if (target === self || target == null) return query(sql, params);
      const write = !/^\s*(SELECT|PRAGMA|WITH)/i.test(String(sql));
      if (write && inTxn) {
        const e = new Error(
          `This write belongs to a different database from the transaction it is inside ` +
          `(${target.label}, not ${label}), and the two cannot commit together. ` +
          `Do it before the transaction opens, or after it commits.`);
        e.code = "CROSS_HOME_WRITE";
        throw e;
      }
      return target.query(sql, params);
    };

    return {
      query: connQuery,
      async beginTransaction() { db.run("BEGIN"); inTxn = true; txnDepth++; },
      async commit() {
        db.run("COMMIT");
        inTxn = false; txnDepth = Math.max(0, txnDepth - 1);
        /* Synchronous, before this resolves and the route answers: a committed
           sale is on disk before the till is told it was rung up. */
        persist();
      },
      async rollback() {
        if (!inTxn) return;
        db.run("ROLLBACK");
        inTxn = false; txnDepth = Math.max(0, txnDepth - 1);
        /* Writes made before the BEGIN (or by an earlier request in this turn)
           are still owed a save; persist() deferred them while we were open. */
        if (dirty) persist();
      },
      /* Several routes release explicitly on an early return and again in
         their `finally`, so this has to be safe to call twice — a second call
         must not hand the write lock to two waiters at once. */
      release() {
        if (released) return;
        released = true;
        if (inTxn) { try { db.run("ROLLBACK"); } catch { /* nothing open */ } inTxn = false; txnDepth = Math.max(0, txnDepth - 1); }
        releaseWriteLock();
      },
    };
  }

  /* Put a freshly-opened handle in place of the live one.
   *
   * Three things have to happen together or the next save writes the *old*
   * database over the new file:
   *
   *  - the pending end-of-turn flush is cancelled and `dirty` cleared, because
   *    that immediate closes over nothing and would call persist() on whatever
   *    `db` is by then. It is a no-op once dirty is false, but leaving a live
   *    handle to a database nobody owns is how this class of bug comes back.
   *  - the old handle is closed, or its wasm pages stay allocated for the life
   *    of the process — on a 500 MB shop that is 500 MB leaked per restore.
   *  - pragmas are re-applied, because a new handle starts from SQLite's
   *    defaults and foreign_keys is one of them.
   */
  function swapHandle(next) {
    if (pendingSave) { clearImmediate(pendingSave); pendingSave = null; }
    dirty = false;
    const old = db;
    db = next;
    if (old && old !== next) { try { old.close(); } catch { /* already gone */ } }
    applyPragmas();
  }

  /**
   * Replace both the file on disk and the in-memory database with `buf`.
   *
   * This is the storage half of a restore, and the order is the whole point:
   *
   *   1. parse the candidate bytes FIRST. A buffer SQLite cannot open throws
   *      here, with the live database and the live file both untouched. The
   *      old restore wrote the file before finding out, so a damaged upload
   *      left the shop with no database at all.
   *   2. write the file the way persist() does — temp file, fsync, rename — so
   *      a power cut during a restore leaves either the old database or the
   *      new one, never half of each.
   *   3. only then swap the handle.
   *
   * The caller must hold the write lock (pool.getConnection) and must not be
   * inside a transaction; both are asserted, because getting this wrong loses
   * a sale that the till has already been told about.
   */
  function replaceDatabase(buf) {
    if (txnDepth > 0) throw new Error("A transaction is open — the database cannot be replaced underneath it.");
    if (!lockHeld) throw new Error("replaceDatabase called without the write lock — refusing to race the tills.");
    if (!SQL) throw new Error("The database layer is not initialised yet.");

    let next;
    try { next = new SQL.Database(Buffer.from(buf)); }
    catch (e) { throw explainIfOutOfMemory(e, "open that backup", Buffer.byteLength(buf)); }

    try {
      const tmp = file + ".tmp";
      const fd = fs.openSync(tmp, "w");
      try { fs.writeSync(fd, Buffer.from(buf)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } catch (e) {
      try { next.close(); } catch { /* nothing to close */ }
      throw e;
    }

    swapHandle(next);
  }

  /** Replace the in-memory DB with the current on-disk file (used by restore). */
  async function reloadFromFile() {
    if (!SQL) SQL = await initSqlJs();
    swapHandle(new SQL.Database(fs.readFileSync(file)));
  }

  /** Close the handle, saving first. Used when a tenant file is evicted. */
  function close() {
    flushOnExit();
    if (db) { try { db.close(); } catch { /* already gone */ } db = null; }
  }

  const store = {
    file, label, open, openSync, query, persist, reloadFromFile, replaceDatabase, close,
    locked: () => lockHeld,
    scheduleSave, flushOnExit, swapHandle, sizeBytes,
    inTransaction: () => txnDepth > 0,
    isOpen: () => !!db,
    idleMs: () => Date.now() - lastTouched,
    handle: () => db,
    pool: { async getConnection() { await acquireWriteLock(); return makeConnection(store); } },
  };
  return store;
}

/* ── the hosted engine ─────────────────────────────────────────────────────
 *
 * `GENIUS_DB_URL` moves the books off this computer and onto a hosted SQLite
 * database. Everything above stays exactly as it was and is simply not used;
 * nothing in the application above this file can tell the difference, which is
 * the whole point of the seam.
 *
 * What is deliberately NOT emulated here is the file. A hosted database has no
 * bytes on this disk to copy, so `persist`, `replaceDatabase`, `reloadFromFile`
 * and `handle` — the whole-file backup and restore path — refuse by name
 * instead of quietly doing nothing. A backup button that silently writes an
 * empty file is worse than one that says it cannot: the shop finds out which
 * it was on the day it needs the backup. The hosted equivalent is the
 * provider's own point-in-time restore, and the Sync screen says so.
 */
function makeRemoteStore(opts = {}) {
  const label = opts.label || "hosted";
  const client = libsql.createClient({ url: opts.url, token: opts.token, timeoutMs: opts.timeoutMs });
  let lastTouched = Date.now();
  let txnDepth = 0;

  const notAFile = (what) => {
    throw new Error(
      `${what} works on the database file, and this installation keeps its books on a hosted ` +
      `database (${client.base}) where there is no such file on this computer. Use the hosting ` +
      `provider's own backup and restore for that.`);
  };

  async function query(sql, params = []) {
    lastTouched = Date.now();
    /* Same courtesy the local engine does: `undefined` means "not supplied",
       and binding it would fail with an error that names neither the field nor
       the route. */
    if (Array.isArray(params)) {
      for (let i = 0; i < params.length; i++) if (params[i] === undefined) params[i] = null;
    }
    return client.execute(sql, params);
  }

  /* The write lock is kept, and for the same reason as the local engine: one
     transaction at a time per database, so a handler that awaits mid-write
     becomes slow rather than wrong. It is not the connection limit — the
     server has its own — it is this application's ordering guarantee. */
  let lockHeld = false;
  const lockWaiters = [];
  let lockWatchdog = null;
  const LOCK_STUCK_MS = 30000;

  function acquireWriteLock() {
    return new Promise((resolve) => {
      const grant = () => {
        lockHeld = true;
        clearTimeout(lockWatchdog);
        lockWatchdog = setTimeout(() => {
          console.error("db: a connection to %s was held for %ds — forcing it open. This is a bug.", label, LOCK_STUCK_MS / 1000);
          releaseWriteLock();
        }, LOCK_STUCK_MS);
        if (lockWatchdog.unref) lockWatchdog.unref();
        resolve();
      };
      if (!lockHeld) grant(); else lockWaiters.push(grant);
    });
  }
  function releaseWriteLock() {
    clearTimeout(lockWatchdog);
    lockWatchdog = null;
    const next = lockWaiters.shift();
    if (next) next(); else lockHeld = false;
  }

  function makeConnection(self) {
    /* One server-side connection for the life of this transaction. BEGIN, the
       writes and COMMIT must all travel on it — a COMMIT sent on a fresh
       connection commits nothing, and the writes are discarded when the
       original connection is reaped. libsql.js refuses rather than reconnects
       if that connection is lost part-way. */
    const sess = client.session();
    let inTxn = false;
    let released = false;

    const connQuery = async (sql, params) => {
      /* Which database this statement belongs to. With no tenancy router
         installed — a single-company installation, and every test that does
         not set one up — the answer is this one: a connection taken from a
         store is a connection to that store, and defaulting anywhere else
         would send a transaction's writes to a database it never opened. */
      const target = routedTo(sql, self);
      if (target === self || target == null) {
        lastTouched = Date.now();
        return sess.execute(sql, params);
      }
      const write = !/^\s*(SELECT|PRAGMA|WITH)/i.test(String(sql));
      if (write && inTxn) {
        const e = new Error(
          `This write belongs to a different database from the transaction it is inside ` +
          `(${target.label}, not ${label}), and the two cannot commit together. ` +
          `Do it before the transaction opens, or after it commits.`);
        e.code = "CROSS_HOME_WRITE";
        throw e;
      }
      return target.query(sql, params);
    };

    return {
      query: connQuery,
      async beginTransaction() { await sess.execute("BEGIN", []); inTxn = true; txnDepth++; },
      async commit() {
        await sess.execute("COMMIT", []);
        inTxn = false; txnDepth = Math.max(0, txnDepth - 1);
        /* Nothing to flush: the server acknowledged the COMMIT before this
           resolved, so the sale is durable before the till is told it rang. */
      },
      async rollback() {
        if (!inTxn) return;
        try { await sess.execute("ROLLBACK", []); } catch { /* connection already gone; nothing was committed */ }
        inTxn = false; txnDepth = Math.max(0, txnDepth - 1);
      },
      release() {
        if (released) return;
        released = true;
        if (inTxn) {
          inTxn = false; txnDepth = Math.max(0, txnDepth - 1);
          /* Not awaited: release() is called from a `finally` that has no
             await to spend, and an abandoned connection rolls back on the
             server anyway. Closing it is housekeeping, not correctness. */
          sess.execute("ROLLBACK", []).catch(() => {});
        }
        sess.close().catch(() => {});
        releaseWriteLock();
      },
    };
  }

  const store = {
    file: null,
    label,
    remote: true,
    url: client.base,
    async open() { await client.execute("SELECT 1", []); return true; },
    openSync() { return true; },
    query,
    persist() { /* the server holds it; there is nothing here to write */ },
    scheduleSave() { /* as above */ },
    flushOnExit() { /* as above */ },
    async reloadFromFile() { notAFile("Reloading from the database file"); },
    replaceDatabase() { notAFile("Restoring over the database file"); },
    handle() { notAFile("Reading the database file directly"); },
    swapHandle() { notAFile("Swapping the database file"); },
    close() { /* no handle of our own to close */ },
    locked: () => lockHeld,
    sizeBytes: () => 0,
    inTransaction: () => txnDepth > 0,
    isOpen: () => true,
    idleMs: () => Date.now() - lastTouched,
    pool: { async getConnection() { await acquireWriteLock(); return makeConnection(store); } },
  };
  return store;
}

/**
 * Where this installation keeps its books.
 *
 * Unset — every installation shipped so far — means the file on this disk and
 * the engine above it, unchanged. Set, and the same application runs against a
 * hosted database instead. It is one variable because it is one decision, and
 * a half-configured installation (a URL with no token, say) must fail at boot
 * with a sentence about it rather than at the first sale.
 */
const REMOTE = (() => {
  const url = (process.env.GENIUS_DB_URL || "").trim();
  if (!url) return null;
  const token = (process.env.GENIUS_DB_TOKEN || "").trim();
  if (!token && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(libsql.httpBase(url))) {
    throw new Error(
      "GENIUS_DB_URL is set but GENIUS_DB_TOKEN is not. A hosted database needs the access " +
      "token to go with the address; without one every statement would be refused.");
  }
  return { url, token };
})();

/* The one store every installation shipped so far has, and the one this file's
   exported functions are bound to. */
const central = REMOTE
  ? makeRemoteStore({ url: REMOTE.url, token: REMOTE.token, label: "central" })
  : makeStore(DB_PATH, { label: "central" });

/* Every store this process has open, so exit flushes all of them and not only
   the first. `tenancy.js` registers the per-company ones. */
const stores = new Set([central]);
function registerStore(s) { stores.add(s); return s; }
function unregisterStore(s) { stores.delete(s); }

function flushAllOnExit() {
  for (const s of stores) {
    try { s.flushOnExit(); } catch (e) { console.error("Final save failed:", e.message); }
  }
}
process.on("exit", flushAllOnExit);
["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, () => { flushAllOnExit(); process.exit(0); }));

/* ── the seam ─────────────────────────────────────────────────────────────
 *
 * `query` and `pool` are what all forty-five callers import, and they must
 * keep meaning "the database for this request". With one store that is the
 * central one. With per-company files it is whichever file the request's
 * company lives in, and `tenancy.js` answers that question — but only after it
 * has been installed, so this file has no dependency on it and the app boots
 * identically when it is not in use.
 */
let route = null;
function installRouter(fn) { route = fn; }
const storeFor = (sql) => (route ? route(sql) : central);
/* The same question, for a caller that knows which store is asking. Used by
   the hosted engine's connections, where "no router installed" must mean "this
   store" rather than "the central one". */
const routedTo = (sql, fallback) => (route ? (route(sql) || fallback) : fallback);

const query = (sql, params) => storeFor(sql).query(sql, params);
/**
 * A connection, on the database this request is about.
 *
 * `{ central: true }` asks for one on the central database instead. That is
 * not a convenience: the company-management routes write `firms`,
 * `memberships` and `invitations`, all of which are central, from a request
 * that is *about* a company — so the transaction they need is a central one
 * even though the request has a company in context. Without saying so they
 * would open a transaction on the company's file and then be refused the
 * write, correctly, by the guard in `makeConnection`.
 */
const pool = {
  async getConnection(opts = {}) {
    if (opts.central) return central.pool.getConnection();
    return storeFor(null).pool.getConnection();
  },
};

/**
 * Bring the storage layer up.
 *
 * sql.js is loaded in both modes, not only the local one. A hosted
 * installation still builds real SQLite files for per-company exports
 * (`firmexport.service` fills one with the company's rows through
 * `newDatabase()`), and losing "Download a copy" the moment a shop moves its
 * books online would take away the one copy it can hold in its own hand.
 */
async function init() {
  if (!SQL) {
    if (REMOTE) {
      /* Hosted: the local engine is only wanted for per-company exports, so a
         missing one is a missing feature, not a failed boot. Say which. */
      try { SQL = await initSqlJs(); }
      catch (e) { console.warn("Per-company exports are unavailable:", e.message); }
    } else {
      SQL = await initSqlJs();
    }
  }
  return central.open();
}

module.exports = {
  init, query, pool,
  persist: (...a) => central.persist(...a),
  reloadFromFile: (...a) => central.reloadFromFile(...a),
  replaceDatabase: (...a) => central.replaceDatabase(...a),
  inTransaction: () => central.inTransaction(),
  newDatabase, openBytes,
  DB_PATH, dbSizeBytes: () => central.sizeBytes(), WARN_BYTES,
  /* For the tenancy manager and for tests. */
  makeStore, makeRemoteStore, registerStore, unregisterStore, installRouter, central, stores,
  /* Null on a local installation. Read by the Sync screen and by tenancy.js,
     which needs to know whether a company's store is a file or an address. */
  remote: REMOTE,
  hosted: () => !!REMOTE,
};

/**
 * A fresh, empty database in memory, using the same sql.js the app runs on.
 *
 * Per-company export builds one of these, copies one firm's rows into it and
 * hands back the bytes — so an export is a real SQLite file rather than a
 * dump format of its own. That is what lets round twelve's four staged
 * restore checks, and `backup.service`'s open-and-read verification, work on
 * a company export unchanged.
 *
 * Throws rather than returning null if called before init(): a caller that got
 * a null here would write a zero-byte file and call it a backup.
 */
function newDatabase() {
  if (!SQL) throw new Error("Database not initialised yet");
  return new SQL.Database();
}

/** Open a database from bytes — used to read an export back and verify it. */
function openBytes(buf) {
  if (!SQL) throw new Error("Database not initialised yet");
  return new SQL.Database(new Uint8Array(buf));
}
