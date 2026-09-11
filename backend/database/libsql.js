/**
 * libsql.js — a small client for a hosted SQLite database (Turso / libSQL).
 *
 * ── why this is hand-written and not `@libsql/client` ─────────────────────
 *
 * The same reason `db.js` runs sql.js rather than better-sqlite3: this app is
 * installed by copying a folder onto a shop PC, and anything that needs a
 * native build or a fresh `npm install` on the day of the install is a thing
 * that fails on the day of the install. The wire protocol below is small,
 * documented, and stable, and `cloud.service.js` already talks to a server
 * with nothing but `require("https")`, so this is the idiom the tree uses.
 *
 * It also means the hosted mode can be read, reasoned about and fixed by
 * whoever maintains this, rather than being a dependency whose behaviour under
 * a dropped connection has to be taken on faith.
 *
 * ── the protocol ─────────────────────────────────────────────────────────
 *
 * One endpoint: POST {base}/v2/pipeline, JSON in, JSON out.
 *
 *   { baton, requests: [ { type: "execute", stmt: { sql, args, want_rows } } ] }
 *
 * The answer carries a `baton`. Sending it back on the next call continues the
 * *same server-side connection*; leaving it out gets a fresh one. That single
 * fact is what makes transactions possible over HTTP, and it is why a
 * connection here is an object that holds a baton rather than a socket:
 * BEGIN, the writes, and COMMIT must all be on one connection or the COMMIT
 * commits nothing and the writes are rolled back when the connection is
 * reaped. Losing a baton mid-transaction is therefore treated as a failure,
 * never retried, and never silently re-issued on a new connection.
 *
 * Values are tagged on both sides ({type:"integer", value:"42"}), because
 * JSON cannot tell an integer from a float and SQLite very much can.
 */
const https = require("https");
const http = require("http");
const { URL } = require("url");

/* Turso hands out `libsql://name-org.turso.io`. That is the same host over
   HTTPS; the scheme only tells a client which protocols it may try. Accepting
   all three spellings means a URL pasted from the dashboard works. */
function httpBase(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  if (!s) throw new Error("No database URL was given.");
  if (s.startsWith("libsql://")) return "https://" + s.slice("libsql://".length);
  if (s.startsWith("https://") || s.startsWith("http://")) return s;
  return "https://" + s;
}

/* ── values on and off the wire ───────────────────────────────────────────── */

function toArg(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { type: "null" };
    /* Integer or float matters: SQLite's own type affinity follows it, and a
       quantity stored as 3.0 where the schema expects 3 changes what
       comparisons and SUMs return. */
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: v };
  }
  if (Buffer.isBuffer(v)) return { type: "blob", base64: v.toString("base64") };
  if (v instanceof Uint8Array) return { type: "blob", base64: Buffer.from(v).toString("base64") };
  if (v instanceof Date) return { type: "text", value: v.toISOString() };
  return { type: "text", value: String(v) };
}

function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  switch (v.type) {
    case "null": return null;
    case "text": return v.value;
    case "float": return typeof v.value === "number" ? v.value : Number(v.value);
    case "blob": return Buffer.from(v.base64 || "", "base64");
    case "integer": {
      /* Integers arrive as strings so nothing is lost in JSON. Anything a
         shop's books can hold — ids, counts, money in cents — is inside the
         range a double represents exactly, and returning a Number keeps every
         caller in this tree working unchanged. Past that range the string is
         handed back rather than quietly rounded, because a wrong id is worse
         than an unexpected type. */
      const n = Number(v.value);
      return Number.isSafeInteger(n) ? n : v.value;
    }
    default: return v.value === undefined ? null : v.value;
  }
}

/* ── the request ──────────────────────────────────────────────────────────── */

function postJson(url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`That database URL is not valid: ${url}`)); }
    const lib = u.protocol === "http:" ? http : https;
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(u, {
      method: "POST",
      headers: Object.assign({
        "content-type": "application/json",
        "content-length": payload.length,
      }, token ? { authorization: `Bearer ${token}` } : {}),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("The database did not answer in time")));
    req.on("error", (e) => reject(friendly(e)));
    req.end(payload);
  });
}

/* Node's network errors are accurate and useless to a shopkeeper. */
function friendly(e) {
  const code = e && e.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Error("The database could not be found. Check the internet connection and the database address.");
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
    return new Error("The connection to the database dropped.");
  }
  if (code === "ETIMEDOUT" || /did not answer/.test(String(e && e.message))) {
    return new Error("The database did not answer in time.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * A client for one hosted database.
 *
 * @param {object} opts  { url, token, timeoutMs }
 */
function createClient(opts = {}) {
  const base = httpBase(opts.url);
  const token = opts.token || "";
  const timeoutMs = Number(opts.timeoutMs) || 30000;
  /* The server may name a different host to send the rest of a session to
     (a replica closest to this shop). Honoured per connection, not globally. */

  /**
   * Send a batch of statements. `baton` continues an existing connection;
   * `null` starts a fresh one.
   *
   * @returns {{results: Array, baton: string|null, base: string}}
   */
  async function pipeline(stmts, session) {
    const requests = stmts.map((s) => ({
      type: "execute",
      stmt: { sql: s.sql, args: (s.params || []).map(toArg), want_rows: s.wantRows !== false },
    }));
    /* A one-off batch closes its connection in the same round-trip rather than
       leaving one parked on the server until it is reaped. A batch that is
       part of a session does not, because the session is the point. */
    if (!session) requests.push({ type: "close" });

    const url = (session && session.base ? session.base : base).replace(/\/+$/, "") + "/v2/pipeline";
    const res = await postJson(url, token, {
      baton: session ? session.baton : null,
      requests,
    }, timeoutMs);

    if (res.status === 401 || res.status === 403) {
      /* Who actually refused this matters, and the status code alone does not
         say. The database answers in JSON; a proxy, a company firewall or a
         captive network answers in plain text — and a shopkeeper told "your
         access token was rejected" when the real cause is a blocked host will
         spend the afternoon making new tokens that also do not work.
         (Found the hard way: a sandbox egress proxy returned exactly this 403
         with the body "Host not in allowlist", and this client reported it as
         an expired token.) */
      if (!res.json) {
        throw Object.assign(new Error(
          `Something between this computer and the database refused the connection ` +
          `(${res.status})${res.text ? `: ${res.text.trim().slice(0, 200)}` : ""}. ` +
          `That is a network answer, not the database's — check a proxy, firewall or ` +
          `allowlist before changing the access token.`), { status: res.status, network: true });
      }
      throw Object.assign(
        new Error("The database refused this installation's credentials. The access token may have expired or been revoked."),
        { status: res.status });
    }
    if (res.status === 404) {
      throw new Error("That database does not exist at that address.");
    }
    if (res.status !== 200 || !res.json) {
      throw new Error(`The database answered ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`);
    }

    const body = res.json;
    if (session) {
      /* A session that loses its baton has lost its connection, and with it any
         open transaction. Say so here rather than letting the next statement
         run on a fresh connection outside the transaction it thinks it is in —
         that is how a half-written sale gets committed. */
      if (!body.baton) session.dead = true;
      else session.baton = body.baton;
      if (body.base_url) session.base = body.base_url;
    }

    const out = [];
    for (const r of (body.results || [])) {
      if (!r) { out.push(null); continue; }
      if (r.type === "error") {
        const msg = (r.error && r.error.message) || "The database refused that statement";
        const err = new Error(msg);
        err.code = r.error && r.error.code;
        /* Carried through unchanged: the idempotency layer recognises a unique
           constraint by its message, and rewording it here would turn a
           handled retry into a 500. */
        throw err;
      }
      const result = r.response && r.response.result;
      if (!result) { out.push({ rows: [], insertId: null, changes: 0 }); continue; }
      const cols = (result.cols || []).map((c) => c.name);
      const rows = (result.rows || []).map((r2) => {
        const o = {};
        for (let i = 0; i < cols.length; i++) o[cols[i]] = fromValue(r2[i]);
        return o;
      });
      out.push({
        rows,
        insertId: result.last_insert_rowid == null ? null : Number(result.last_insert_rowid),
        changes: Number(result.affected_row_count || 0),
      });
    }
    return out;
  }

  /** One statement, on its own connection. */
  async function execute(sql, params) {
    const [r] = await pipeline([{ sql, params }]);
    return r || { rows: [], insertId: null, changes: 0 };
  }

  /**
   * A server-side connection that survives across calls, which is what a
   * transaction needs. Nothing else in this file holds state.
   */
  function session() {
    const s = { baton: null, base, dead: false };
    return {
      async execute(sql, params) {
        if (s.dead) {
          throw new Error("The connection to the database was lost part-way through. Nothing that had not already been committed was saved.");
        }
        const [r] = await pipeline([{ sql, params }], s);
        return r || { rows: [], insertId: null, changes: 0 };
      },
      /* Many statements in one round-trip, on *this* connection. The
         connection is the point: a batch sent on a fresh one would be outside
         whatever transaction this session has open, so it would commit on its
         own and survive the rollback that was supposed to undo it. Used by the
         bulk copy in tools/books-online.js, where the difference is minutes
         against hours for a shop with a few hundred thousand rows. */
      async executeMany(stmts) {
        if (s.dead) {
          throw new Error("The connection to the database was lost part-way through. Nothing that had not already been committed was saved.");
        }
        return pipeline(stmts, s);
      },
      /* Ends the server-side connection. Called from release(), so a request
         that finishes does not leave one open until the server times it out. */
      async close() {
        if (s.dead || !s.baton) return;
        try {
          const url = (s.base || base).replace(/\/+$/, "") + "/v2/pipeline";
          await postJson(url, token, { baton: s.baton, requests: [{ type: "close" }] }, timeoutMs);
        } catch { /* the server reaps it anyway; never fail a request over this */ }
        s.dead = true;
      },
      alive: () => !s.dead,
    };
  }

  return { execute, session, base, pipeline };
}

module.exports = { createClient, httpBase, toArg, fromValue };
