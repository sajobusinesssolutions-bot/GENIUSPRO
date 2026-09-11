/**
 * storage.store.test.js — a store is a database file, and there can be many.
 *
 * `db.js` used to hold one database in module-level state. Splitting storage
 * per company turns that state into `makeStore(path)`, and these are the
 * properties the tenancy manager depends on: a store opens its own file, saves
 * it atomically, knows whether it is in a transaction, and closes without
 * losing anything.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, expect } = require("./tiny-test");
const db = require("../database/db");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-store-"));
const fileA = path.join(dir, "a.db");
const fileB = path.join(dir, "b.db");

describe("one store per database file", () => {
  it("opens a file that does not exist yet", async () => {
    await db.init();                 // loads sql.js; the shipped database is only read
    const a = db.makeStore(fileA, { label: "a" });
    a.openSync();
    expect(a.isOpen()).toBe(true);
  });

  it("saves what is written to it", async () => {
    await db.init();
    const a = db.makeStore(fileA, { label: "a" });
    a.openSync();
    await a.query("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    await a.query("INSERT INTO t (v) VALUES ('hello')");
    a.persist();
    expect(fs.existsSync(fileA)).toBe(true);
  });

  it("…and reads it back from disk", async () => {
    await db.init();
    const again = db.makeStore(fileA, { label: "a2" });
    again.openSync();
    expect((await again.query("SELECT v FROM t")).rows[0].v).toBe("hello");
    again.close();
  });

  it("**two stores do not see each other's rows**", async () => {
    await db.init();
    /* The property the whole split rests on. If this were false, "one file per
       company" would be one file with extra steps. */
    const b = db.makeStore(fileB, { label: "b" });
    b.openSync();
    await b.query("CREATE TABLE IF NOT EXISTS t (v TEXT)");
    await b.query("INSERT INTO t (v) VALUES ('other')");
    expect((await b.query("SELECT v FROM t")).rows.map((r) => r.v).join(",")).toBe("other");
    b.close();
  });

  it("each has its own write lock", async () => {
    await db.init();
    const a = db.makeStore(fileA, { label: "a" });
    a.openSync();
    const b = db.makeStore(fileB, { label: "b" });
    b.openSync();
    const ca = await a.pool.getConnection();
    /* b's lock is free while a's is held — one shop's slow stock-take must not
       be every other shop's queue, which was the point of splitting. */
    expect(a.locked() && !b.locked()).toBe(true);
    const cb = await b.pool.getConnection();
    expect(b.locked()).toBe(true);
    ca.release(); cb.release();
    a.close(); b.close();
  });

  it("knows when it is inside a transaction", async () => {
    await db.init();
    const a = db.makeStore(fileA, { label: "a" });
    a.openSync();
    const c = await a.pool.getConnection();
    await c.beginTransaction();
    expect(a.inTransaction()).toBe(true);
    await c.rollback();
    expect(a.inTransaction()).toBe(false);
    c.release();
    a.close();
  });
});
