/**
 * hosted.test.js — the books, kept on a hosted database.
 *
 * This exercises `database/libsql.js` and the hosted store in
 * `database/db.js` against a real HTTP server on localhost that speaks the
 * pipeline protocol. Not a mock of our own client — an actual socket, actual
 * JSON, actual status codes — because the things that go wrong with a hosted
 * database are protocol things: a transaction that silently ran on the wrong
 * connection, an integer that came back as a string, a 401 reported as
 * "Server error".
 *
 * The one that matters most is the transaction. Over HTTP a connection is a
 * `baton` passed from answer to request, and BEGIN, the writes and COMMIT must
 * all travel on the same one. If they do not, the COMMIT commits nothing, the
 * writes are discarded when the server reaps the connection they were on, and
 * the till has already told the shopkeeper the sale went through. The server
 * below fails the test if that ever happens, rather than trusting the client
 * to have got it right.
 */
const http = require("http");
const { describe, it, expect } = require("./tiny-test");
const libsql = require("../database/libsql");
const db = require("../database/db");

/* ── a server that speaks the protocol and remembers what it was asked ──── */
function fakeServer() {
  const state = {
    /* connectionId -> [sql, …], so a test can assert what travelled together */
    conns: new Map(),
    seen: [],
    nextConn: 1,
    /* set by a test to change how the server answers */
    status: 200,
    plainText: null,
    dropBaton: false,
    errorOn: null,
    rows: null,
  };

  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (state.status !== 200) {
        if (state.plainText) {
          res.writeHead(state.status, { "content-type": "text/plain" });
          return res.end(state.plainText);
        }
        res.writeHead(state.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "no" }));
      }

      /* Continue the named connection, or open one. */
      let id = body.baton ? Number(String(body.baton).split(":")[1]) : state.nextConn++;
      if (!state.conns.has(id)) state.conns.set(id, []);

      const results = [];
      let closed = false;
      for (const r of (body.requests || [])) {
        if (r.type === "close") { closed = true; continue; }
        const sql = r.stmt.sql;
        state.conns.get(id).push(sql);
        state.seen.push({ conn: id, sql, args: r.stmt.args });
        if (state.errorOn && sql.includes(state.errorOn)) {
          results.push({ type: "error", error: { message: "UNIQUE constraint failed: expenses.client_ref", code: "SQLITE_CONSTRAINT" } });
          continue;
        }
        results.push({
          type: "ok",
          response: {
            type: "execute",
            result: state.rows || {
              cols: [{ name: "id" }, { name: "name" }, { name: "amount" }, { name: "note" }],
              rows: [[{ type: "integer", value: "7" }, { type: "text", value: "Rent" },
                      { type: "float", value: 12.5 }, { type: "null" }]],
              affected_row_count: 1,
              last_insert_rowid: "42",
            },
          },
        });
      }

      /* A closed connection hands back no baton — which is exactly how a
         server tells a client the connection is gone. */
      const baton = closed || state.dropBaton ? null : `b:${id}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ baton, base_url: null, results }));
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      state.url = `http://127.0.0.1:${srv.address().port}`;
      state.close = () => new Promise((r) => srv.close(r));
      resolve(state);
    });
  });
}

/* ── values ──────────────────────────────────────────────────────────────── */

describe("hosted database — values on the wire", () => {
  it("tells an integer from a float, because SQLite does", () => {
    expect(libsql.toArg(3).type).toBe("integer");
    expect(libsql.toArg(3).value).toBe("3");
    expect(libsql.toArg(3.5).type).toBe("float");
    /* A quantity stored as 3.0 where the schema means 3 changes what SUM and
       the comparisons in every stock query return. */
    expect(libsql.toArg(0).value).toBe("0");
  });

  it("sends a missing field as NULL rather than refusing it", () => {
    expect(libsql.toArg(undefined).type).toBe("null");
    expect(libsql.toArg(null).type).toBe("null");
  });

  it("brings integers back as numbers, so the money maths still works", () => {
    expect(libsql.fromValue({ type: "integer", value: "42" })).toBe(42);
    expect(libsql.fromValue({ type: "float", value: 12.5 })).toBe(12.5);
    expect(libsql.fromValue({ type: "null" })).toBe(null);
  });

  it("hands back an id too large to hold exactly rather than rounding it", () => {
    /* A wrong invoice id is worse than an unexpected type. */
    const huge = "9007199254740993";
    expect(libsql.fromValue({ type: "integer", value: huge })).toBe(huge);
  });

  it("accepts the address in any of the spellings the dashboard gives", () => {
    expect(libsql.httpBase("libsql://shop-acme.turso.io")).toBe("https://shop-acme.turso.io");
    expect(libsql.httpBase("https://shop-acme.turso.io/")).toBe("https://shop-acme.turso.io");
    expect(libsql.httpBase("shop-acme.turso.io")).toBe("https://shop-acme.turso.io");
  });
});

/* ── the store ───────────────────────────────────────────────────────────── */

describe("hosted database — reading and writing", () => {
  it("returns rows as objects, with the column names", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const r = await store.query("SELECT id, name, amount, note FROM expenses");
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].id).toBe(7);
      expect(r.rows[0].name).toBe("Rent");
      expect(r.rows[0].amount).toBe(12.5);
      expect(r.rows[0].note).toBe(null);
    } finally { await s.close(); }
  });

  it("reports the new row's id and how many rows changed", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const r = await store.query("INSERT INTO expenses (amount) VALUES (?)", [500]);
      expect(r.insertId).toBe(42);
      expect(r.changes).toBe(1);
    } finally { await s.close(); }
  });

  it("passes the parameters rather than pasting them into the SQL", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      await store.query("SELECT * FROM parties WHERE name = ?", ["O'Brien; DROP TABLE parties"]);
      const sent = s.seen[s.seen.length - 1];
      expect(sent.sql.includes("O'Brien")).toBe(false);
      expect(sent.args[0].value).toBe("O'Brien; DROP TABLE parties");
    } finally { await s.close(); }
  });
});

describe("hosted database — one transaction, one connection", () => {
  it("sends BEGIN, the write and COMMIT on the same connection", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const conn = await store.pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query("INSERT INTO sale_invoices (grand_total) VALUES (?)", [1000]);
        await conn.commit();
      } finally { conn.release(); }

      /* The whole of the transaction on one connection, in order. A COMMIT
         that arrived on a different connection would commit nothing at all,
         and the sale would be gone while the till said it was rung up. */
      const used = [...s.conns.entries()].filter(([, sqls]) => sqls.some((q) => q === "BEGIN"));
      expect(used.length).toBe(1);
      const [, sqls] = used[0];
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[1].startsWith("INSERT INTO sale_invoices")).toBe(true);
      expect(sqls[2]).toBe("COMMIT");
    } finally { await s.close(); }
  });

  it("rolls back on the same connection too", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const conn = await store.pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query("INSERT INTO sale_invoices (grand_total) VALUES (?)", [1000]);
        await conn.rollback();
      } finally { conn.release(); }
      const [, sqls] = [...s.conns.entries()].find(([, q]) => q.includes("BEGIN"));
      expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
    } finally { await s.close(); }
  });

  it("refuses to carry on when the connection is lost mid-transaction", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const conn = await store.pool.getConnection();
      let threw = "";
      try {
        await conn.beginTransaction();
        s.dropBaton = true;                       // the server drops the connection
        await conn.query("INSERT INTO sale_invoices (grand_total) VALUES (?)", [1000]);
        /* The next statement must not quietly open a fresh connection: it would
           be outside the transaction, and its write would commit on its own. */
        await conn.query("INSERT INTO payments (amount) VALUES (?)", [1000]);
      } catch (e) { threw = e.message; }
      finally { conn.release(); }
      expect(threw.includes("lost part-way through")).toBe(true);
    } finally { await s.close(); }
  });

  it("keeps a batch of statements on the transaction's own connection", async () => {
    /* The bulk copy in tools/books-online.js sends rows a batch at a time
       inside one transaction. A batch that opened its own connection would be
       outside that transaction: it would commit on its own and survive the
       rollback meant to undo it, leaving a table half-copied and looking
       whole. */
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const client = require("../database/libsql").createClient({ url: s.url, token: "t" });
      const sess = client.session();
      await sess.execute("BEGIN", []);
      await sess.executeMany([
        { sql: "INSERT INTO items (name) VALUES (?)", params: ["a"], wantRows: false },
        { sql: "INSERT INTO items (name) VALUES (?)", params: ["b"], wantRows: false },
      ]);
      await sess.execute("COMMIT", []);
      await sess.close();
      const used = [...s.conns.entries()].filter(([, q]) => q.includes("BEGIN"));
      expect(used.length).toBe(1);
      const [, sqls] = used[0];
      expect(sqls.length).toBe(4);              // BEGIN, two inserts, COMMIT
      expect(sqls[3]).toBe("COMMIT");
      expect(store.label).toBe("test");
    } finally { await s.close(); }
  });

  it("lets one transaction finish before the next one starts", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      const order = [];
      const one = (async () => {
        const c = await store.pool.getConnection();
        order.push("first in");
        await new Promise((r) => setTimeout(r, 20));
        order.push("first out");
        c.release();
      })();
      const two = (async () => {
        const c = await store.pool.getConnection();
        order.push("second in");
        c.release();
      })();
      await Promise.all([one, two]);
      /* The second waited. Without this a handler that awaits mid-write would
         interleave with another one's transaction. */
      expect(order).toEqual(["first in", "first out", "second in"]);
    } finally { await s.close(); }
  });
});

describe("hosted database — saying what went wrong", () => {
  it("names a rejected token instead of answering 'server error'", async () => {
    const s = await fakeServer();
    try {
      s.status = 401;
      const store = db.makeRemoteStore({ url: s.url, token: "stale", label: "test" });
      let msg = "";
      try { await store.query("SELECT 1"); } catch (e) { msg = e.message; }
      expect(msg.includes("token")).toBe(true);
    } finally { await s.close(); }
  });

  it("blames the network, not the token, when something in between refuses", async () => {
    /* A proxy or firewall answers 403 in plain text; the database answers in
       JSON. Told "your token was rejected", somebody spends the afternoon
       issuing new tokens that also do not work. */
    const s = await fakeServer();
    try {
      s.status = 403;
      s.plainText = "Host not in allowlist: shop.turso.io";
      const store = db.makeRemoteStore({ url: s.url, token: "fine", label: "test" });
      let msg = "";
      try { await store.query("SELECT 1"); } catch (e) { msg = e.message; }
      expect(msg.includes("not the database's")).toBe(true);
      expect(msg.includes("allowlist")).toBe(true);
      expect(msg.includes("expired")).toBe(false);
    } finally { await s.close(); }
  });

  it("passes a constraint failure through untouched", async () => {
    const s = await fakeServer();
    try {
      /* The idempotency layer recognises a duplicate by this message. Reworded
         here, a safely-retried sale would come back as a 500 instead. */
      s.errorOn = "INSERT INTO expenses";
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      let msg = "";
      try { await store.query("INSERT INTO expenses (client_ref) VALUES (?)", ["x"]); }
      catch (e) { msg = e.message; }
      expect(msg.includes("UNIQUE constraint failed")).toBe(true);
    } finally { await s.close(); }
  });

  it("refuses whole-file backup rather than writing an empty one", async () => {
    const s = await fakeServer();
    try {
      const store = db.makeRemoteStore({ url: s.url, token: "t", label: "test" });
      let msg = "";
      try { store.replaceDatabase(Buffer.from("x")); } catch (e) { msg = e.message; }
      /* A backup button that silently produces nothing is found out on the one
         day it matters. */
      expect(msg.includes("no such file on this computer")).toBe(true);
    } finally { await s.close(); }
  });
});

