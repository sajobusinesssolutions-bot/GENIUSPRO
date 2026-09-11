"use strict";
/**
 * cloud.service.js — a company's books, kept on the licence server.
 *
 * ── what this is, and what it deliberately is not ─────────────────────────
 *
 * It is a **safe copy off the premises, and a way to move a business to
 * another computer**. Upload takes the same verified export the Companies
 * screen already produces and puts it on the server; download brings it back
 * through the same restore, with the same control totals checked before
 * anything is committed.
 *
 * It is **not** live replication between two tills. That distinction is the
 * whole of this file's design, so it is worth stating why rather than leaving
 * somebody to discover it.
 *
 * Live replication needs every row to have an identity that two computers
 * cannot both invent. This schema numbers rows with `INTEGER PRIMARY KEY
 * AUTOINCREMENT`, so a till in Kampala and a till in Jinja, both offline,
 * both writing their next sale, both produce invoice id 412. Merge those by
 * id and one shop's sale silently becomes the other's — a class of corruption
 * that shows up months later in a VAT return and cannot be undone. Making that
 * safe means a globally unique key on every row of thirty-odd tables and a
 * merge rule per table, and shipping a half-tested version of that into books
 * people file taxes from would be indefensible.
 *
 * So the rule this file enforces instead is **one book, one place at a time**:
 *
 *   · Uploading records which computer sent it and when.
 *   · Downloading over a book that has changed since the last upload refuses,
 *     and says what would be lost, unless somebody deliberately overrides it.
 *   · Uploading over a copy that came from a *different* computer since your
 *     last upload refuses the same way.
 *
 * Two shopkeepers who take turns — counter in the morning, back office in the
 * evening — are served exactly. Two tills selling at once are told plainly
 * that this is not that, which is better than a merge that quietly loses one
 * of them.
 *
 * ── how it travels ────────────────────────────────────────────────────────
 *
 * The server's data endpoints take JSON records of at most a few megabytes a
 * call, and a shop's books are bigger than that within a year. So the export
 * is split into fixed-size chunks, each a record of its own, plus one small
 * head record naming how many there are and the SHA-256 of the whole. The
 * download reassembles, checks the digest, and only then hands the bytes to
 * the restore. A truncated or reordered download cannot reach the books.
 */
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { query } = require("../../database/db");
const db = require("../../database/db");
const licence = require("../licence/licence.service");

/** Base64 characters per chunk. ~700 KB of payload, comfortably inside the
 *  server's 4 MB body limit with the JSON envelope around it. */
const CHUNK = 700 * 1024;

/* The collection every part of a snapshot lives in on the server. */
const COLL = "snapshot";

/* ── talking to the server ─────────────────────────────────────────────── */
function post(server, route, body, timeout = 60000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(route, server); } catch { return reject(new Error("That server address is not valid")); }
    const lib = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = lib.request(u, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": payload.length },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let d = {};
        try { d = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* handled below */ }
        resolve({ status: res.statusCode, body: d });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("The server did not answer")); });
    req.on("error", (e) => reject(new Error(e.message === "socket hang up" ? "No connection" : e.message)));
    req.end(payload);
  });
}

/**
 * Every call carries the licence key and this computer's id, because that is
 * what the server authorises against. There is no separate cloud password to
 * lose: a shop that can run the till can reach its own books, and a licence
 * that has been blocked cannot.
 */
function credentials() {
  const l = licence.read();
  if (!l.key) throw Object.assign(new Error("This installation has no licence key, so it has nowhere to sync to."), { status: 400 });
  return { key: l.key, deviceId: (l.device && l.device.id) || "", server: l.server || licence.DEFAULT_SERVER };
}

/* The one place a request leaves this process, kept swappable.
 *
 * Not a general plugin point — it exists so the tests can run a whole upload
 * and download against a stand-in server and prove the guards actually fire.
 * A refusal that is only written down and never exercised is a comment. */
let transport = post;
function setTransport(fn) { transport = fn || post; }

async function call(route, body) {
  const c = credentials();
  const r = await transport(c.server, route, Object.assign({ key: c.key, deviceId: c.deviceId }, body));
  if (r.status === 403) {
    const why = (r.body && r.body.error) || "This licence may not sync";
    throw Object.assign(new Error(why), { status: 403, licenceStatus: r.body && r.body.status });
  }
  if (r.status !== 200 || (r.body && r.body.ok === false)) {
    throw new Error((r.body && r.body.error) || `The server answered ${r.status}`);
  }
  return r.body;
}

/* ── what this computer knows about the last sync ──────────────────────────
 *
 * Kept in `app_settings`, which belongs to the installation rather than to a
 * company — and therefore is NOT inside the export. A marker that travelled
 * inside the backup would come back saying "already uploaded" the moment a
 * copy was restored, which is exactly when it is least true.
 */
function mark(firmId, key) { return `cloud:${firmId}:${key}`; }
async function readMark(firmId, key) {
  try {
    const r = (await query("SELECT svalue FROM app_settings WHERE skey = ?", [mark(firmId, key)])).rows[0];
    return (r && r.svalue) || "";
  } catch { return ""; }
}
async function writeMark(conn, firmId, key, value) {
  await (conn || { query }).query(
    "INSERT INTO app_settings (skey, svalue, updated_at) VALUES (?,?,datetime('now')) " +
    "ON CONFLICT(skey) DO UPDATE SET svalue = excluded.svalue, updated_at = datetime('now')",
    [mark(firmId, key), String(value)]);
}

/**
 * A fingerprint of the books as they stand.
 *
 * Counts and money totals, not a hash of the file: two exports of an unchanged
 * database differ byte for byte (timestamps, page order), so a file hash would
 * report "changed" every time and the guard would mean nothing. What this
 * catches is the thing the guard is for — work done since the last upload.
 */
async function fingerprint(firmId) {
  const one = async (sql) => {
    try { const r = (await query(sql, [firmId])).rows[0]; return r ? Object.values(r)[0] : 0; }
    catch { return 0; }
  };
  const parts = [
    await one("SELECT COUNT(*) n FROM sale_invoices WHERE firm_id = ?"),
    await one("SELECT COALESCE(SUM(grand_total),0) n FROM sale_invoices WHERE firm_id = ?"),
    await one("SELECT COUNT(*) n FROM purchase_invoices WHERE firm_id = ?"),
    await one("SELECT COUNT(*) n FROM payments WHERE firm_id = ?"),
    await one("SELECT COUNT(*) n FROM expenses WHERE firm_id = ?"),
    await one("SELECT COUNT(*) n FROM items WHERE firm_id = ?"),
    await one("SELECT COUNT(*) n FROM parties WHERE firm_id = ?"),
    await one("SELECT COUNT(*) n FROM journal_entry_lines WHERE firm_id = ?"),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Split base64 into records the server will accept. */
function toRecords(firmId, b64, digest) {
  const parts = [];
  for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));
  const now = Date.now();
  const records = parts.map((data, i) => ({
    coll: COLL, id: `${firmId}:part:${i}`, v: now, rec: { i, data },
  }));
  /* The head goes LAST, so a download can never find a head describing chunks
     that have not arrived yet. A half-finished upload leaves the previous
     snapshot's head in place and is simply invisible. */
  records.push({
    coll: COLL, id: `${firmId}:head`, v: now,
    rec: { parts: parts.length, bytes: b64.length, digest, at: new Date().toISOString() },
  });
  return records;
}

/** Put the pieces back together, and refuse anything that does not add up. */
function fromRecords(firmId, records) {
  const byId = new Map();
  for (const r of records || []) if (r && r.id) byId.set(r.id, r);
  const head = byId.get(`${firmId}:head`);
  if (!head || !head.rec) return { ok: false, why: "There is no copy of this business on the server yet." };

  const meta = head.rec;
  const parts = [];
  for (let i = 0; i < Number(meta.parts || 0); i++) {
    const p = byId.get(`${firmId}:part:${i}`);
    if (!p || !p.rec || typeof p.rec.data !== "string") {
      return { ok: false, why: `The copy on the server is incomplete — part ${i + 1} of ${meta.parts} is missing. Nothing has been changed.` };
    }
    parts.push(p.rec.data);
  }
  const b64 = parts.join("");
  if (b64.length !== Number(meta.bytes)) {
    return { ok: false, why: "The copy on the server did not arrive whole. Nothing has been changed." };
  }
  const bytes = Buffer.from(b64, "base64");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (meta.digest && digest !== meta.digest) {
    return { ok: false, why: "The copy on the server does not match its own checksum, so it has been refused. Nothing has been changed." };
  }
  return { ok: true, bytes, meta, digest };
}

/* ── the two things a shopkeeper does ─────────────────────────────────────── */

/**
 * Send this company's books up.
 *
 * Refuses when the copy on the server came from a different computer since
 * this one last uploaded — that is somebody else's evening's work, and
 * overwriting it silently is the failure this whole file exists to avoid.
 * `force` is the deliberate override, and it is the caller's job to have
 * asked.
 */
async function upload({ firmId, exportFirm, force = false, userId = null }) {
  const c = credentials();

  if (!force) {
    const there = await call("/d/pull", { firmId: String(firmId), since: 0, limit: 1 }).catch(() => null);
    const head = there && (there.records || []).find((r) => r.id === `${firmId}:head`);
    const lastMine = await readMark(firmId, "uploaded_v");
    if (head && head.dev && head.dev !== c.deviceId && String(head.v) !== lastMine) {
      return {
        ok: false, conflict: true,
        why: "The copy on the server was sent from another computer after your last upload. " +
             "Sending this one would replace it.",
        theirs: { device: head.dev, at: head.rec && head.rec.at },
      };
    }
  }

  /* `exportFirm` answers {bytes, manifest}; older callers and the tests hand
     back the buffer alone. Accept both rather than depending on which. */
  const made = await exportFirm(firmId);
  const bytes = Buffer.isBuffer(made) ? made : Buffer.from(made.bytes);
  const b64 = bytes.toString("base64");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const records = toRecords(firmId, b64, digest);

  /* One call per record keeps every request small and means a dropped line
     costs one chunk rather than the whole upload. */
  let sent = 0;
  for (const r of records) {
    await call("/d/push", { firmId: String(firmId), records: [r] });
    sent++;
  }

  await writeMark(null, firmId, "uploaded_at", new Date().toISOString());
  await writeMark(null, firmId, "uploaded_v", String(records[records.length - 1].v));
  await writeMark(null, firmId, "uploaded_fp", await fingerprint(firmId));
  await writeMark(null, firmId, "uploaded_bytes", String(bytes.length));
  if (userId) await writeMark(null, firmId, "uploaded_by", String(userId));

  return { ok: true, parts: sent - 1, bytes: bytes.length, digest };
}

/**
 * Bring the books back down.
 *
 * Two guards, both refusals rather than warnings:
 *
 *   · nothing is restored unless it reassembles and matches its own digest;
 *   · nothing is restored over a book that has changed since the last upload,
 *     because that change is work that exists nowhere else.
 */
async function download({ firmId, restoreFirm, force = false, userId = null }) {
  const d = await call("/d/snapshot", { firmId: String(firmId) });
  const got = fromRecords(firmId, d.records);
  if (!got.ok) return got;

  if (!force) {
    const fpNow = await fingerprint(firmId);
    const fpUploaded = await readMark(firmId, "uploaded_fp");
    if (fpUploaded && fpNow !== fpUploaded) {
      return {
        ok: false, conflict: true,
        why: "This computer has recorded work since its last upload. Bringing the server's copy " +
             "down would replace that work, and it is not saved anywhere else.",
        taken_at: got.meta.at,
      };
    }
  }

  const out = await restoreFirm(got.bytes, { intoFirmId: firmId, userId });
  await writeMark(null, firmId, "downloaded_at", new Date().toISOString());
  await writeMark(null, firmId, "uploaded_fp", await fingerprint(firmId));
  return { ok: true, taken_at: got.meta.at, bytes: got.bytes.length, restored: out };
}

/**
 * Where this company stands: what is here, what is up there, and whether the
 * two agree. Everything a person needs before pressing either button.
 */
async function status(firmId) {
  /* When the books are already hosted there is nothing for this screen to
     upload. Snapshot sync exists to move a *local file* off the premises and
     between computers; a hosted database is off the premises by definition,
     and every till and phone is reading the same one live. Offering "upload a
     copy" here would invite somebody to overwrite a live database with a
     snapshot, which is the one thing that must not be a button.
     So this reports the arrangement and stops. */
  if (db.hosted()) {
    return {
      firm_id: firmId,
      hosted: true,
      hosted_at: (db.central && db.central.url) || null,
      licensed: true,
      /* Nothing about "which computer has the newest copy" applies: there is
         one copy, and it is not on any of them. */
      changed_since_upload: false,
      reachable: null,
      remote: null,
    };
  }

  let lic = {};
  try { lic = await licence.status(0); } catch { lic = {}; }
  const out = {
    firm_id: firmId,
    hosted: false,
    /* Sync is a paid feature on the server; saying so here means the screen
       can explain rather than showing a button that always fails. */
    licensed: !!lic.hasKey,
    server: (licence.read().server) || licence.DEFAULT_SERVER,
    device: (licence.read().device || {}).id || "",
    uploaded_at: await readMark(firmId, "uploaded_at") || null,
    downloaded_at: await readMark(firmId, "downloaded_at") || null,
    uploaded_bytes: Number(await readMark(firmId, "uploaded_bytes")) || 0,
    fingerprint: await fingerprint(firmId),
    uploaded_fingerprint: await readMark(firmId, "uploaded_fp") || null,
    reachable: null,
    remote: null,
  };
  out.changed_since_upload = !!out.uploaded_fingerprint && out.fingerprint !== out.uploaded_fingerprint;

  if (!out.licensed) return out;
  try {
    const there = await call("/d/pull", { firmId: String(firmId), since: 0, limit: 1 });
    out.reachable = true;
    const head = (there.records || []).find((r) => r.id === `${firmId}:head`);
    if (head) {
      out.remote = {
        at: head.rec && head.rec.at,
        parts: head.rec && head.rec.parts,
        bytes: head.rec && head.rec.bytes,
        device: head.dev || null,
        from_this_computer: head.dev === out.device,
      };
    }
  } catch (e) {
    out.reachable = false;
    out.why = e.message;
  }
  return out;
}

module.exports = {
  CHUNK, COLL,
  upload, download, status, setTransport,
  /* exported for the tests, which is the only reason they are not private */
  toRecords, fromRecords, fingerprint, readMark, writeMark,
};
