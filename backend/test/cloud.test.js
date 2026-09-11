/**
 * Tests for modules/system/cloud.service.js — the cloud copy.
 *
 * The two refusals are the reason this feature is safe, so they are the reason
 * this file exists. A guard that is written down and never exercised is a
 * comment: it can be broken by an unrelated edit and nothing will say so until
 * a shop loses a day's trading.
 *
 * A stand-in server holds the records in memory and a stand-in database holds
 * the marks, so a whole upload and download runs here — 1.6 MB across four
 * chunks, compared byte for byte on the way back. No network, no sql.js.
 */
const { describe, it, expect } = require("./tiny-test");
const crypto = require("crypto");
const Module = require("module");
const path = require("path");

/* ── the stand-ins ─────────────────────────────────────────────────────── */

/* Each computer keeps its own `app_settings`, which is exactly why the sync
   marks live outside the export. Sharing one table between the two fake
   devices would let A believe it had sent B's upload itself, and the upload
   guard would appear to pass while doing nothing. */
const marks = { dev_A: {}, dev_B: {} };
let device = "dev_A";
let app = marks.dev_A;
let invoices = 3;

function beDevice(d) { device = d; app = marks[d]; }

function query(sql, args = []) {
  const s = sql.replace(/\s+/g, " ").trim();
  if (/^SELECT svalue FROM app_settings WHERE skey = \?/i.test(s)) {
    return { rows: app[args[0]] ? [{ svalue: app[args[0]] }] : [] };
  }
  if (/^INSERT INTO app_settings/i.test(s)) { app[args[0]] = args[1]; return { rows: [] }; }
  if (/SUM\(grand_total\)/i.test(s)) return { rows: [{ n: invoices * 1000 }] };
  if (/COUNT\(\*\) n FROM sale_invoices/i.test(s)) return { rows: [{ n: invoices }] };
  if (/COUNT\(\*\) n FROM/i.test(s)) return { rows: [{ n: 0 }] };
  return { rows: [] };
}

const realLoad = Module._load;
Module._load = function (r, parent, ...a) {
  if (typeof r === "string") {
    /* `hosted()` decides whether this screen has anything to do at all: a
       hosted installation has no local file to upload. These tests are about
       the snapshot path, so the stub says the books are local. */
    if (r.endsWith("database/db")) return { query, hosted: () => false, central: null };
    if (r.endsWith("licence/licence.service")) {
      return {
        DEFAULT_SERVER: "http://server.test",
        read: () => ({ key: "GENIUS-PRO-XXXX", device: { id: device }, server: "http://server.test" }),
        status: () => ({ hasKey: true }),
      };
    }
  }
  return realLoad.call(this, r, parent, ...a);
};
const cloud = require(path.join(__dirname, "..", "modules", "system", "cloud.service.js"));
Module._load = realLoad;

let store = new Map();
cloud.setTransport(async (server, route, body) => {
  if (route === "/d/push") {
    for (const r of body.records || []) {
      store.set(r.id, { id: r.id, v: r.v, dev: body.deviceId, rec: r.rec });
    }
    return { status: 200, body: { ok: true } };
  }
  if (route === "/d/pull" || route === "/d/snapshot") {
    return { status: 200, body: { ok: true, records: [...store.values()] } };
  }
  return { status: 404, body: { error: "no route" } };
});

/* Big enough to need several chunks, so the split is actually exercised. */
const BOOKS = crypto.randomBytes(1600 * 1024);
let restored = null;
const exportFirm = async () => ({ bytes: BOOKS, manifest: {} });
const restoreFirm = async (bytes) => { restored = Buffer.from(bytes); return { ok: true }; };
const FIRM = 1;

/* The runner starts every `it` body the moment it is registered and awaits the
   promises afterwards, so async tests overlap. These share one stand-in server
   and one set of marks, which overlapping bodies trample. `serial` puts them
   back in a queue: each waits for the one before it. */
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

function reset() {
  store = new Map();
  marks.dev_A = {}; marks.dev_B = {};
  beDevice("dev_A");
  invoices = 3;
  restored = null;
}

describe("cloud copy — the round trip", () => {
  it("splits a big export, and brings it back byte for byte", () => serial(async () => {
    reset();
    const up = await cloud.upload({ firmId: FIRM, exportFirm });
    expect(up.ok).toBe(true);
    expect(up.parts > 1).toBe(true);
    expect(up.bytes).toBe(BOOKS.length);

    const down = await cloud.download({ firmId: FIRM, restoreFirm });
    expect(down.ok).toBe(true);
    expect(Buffer.compare(restored, BOOKS)).toBe(0);
  }));

  it("writes the head last, so a half-finished upload is invisible", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    expect([...store.keys()].pop()).toBe(`${FIRM}:head`);
  }));

  it("says so plainly when there is nothing up there", () => serial(async () => {
    reset();
    const r = await cloud.download({ firmId: FIRM, restoreFirm, force: true });
    expect(r.ok).toBe(false);
    expect(/no copy of this business/i.test(r.why)).toBe(true);
  }));
});

describe("cloud copy — the refusals that make it safe", () => {
  it("will not overwrite local work with the server's copy", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    invoices = 9;                                  /* a morning's trading */
    const r = await cloud.download({ firmId: FIRM, restoreFirm });
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(restored).toBe(null);                   /* nothing was touched */
  }));

  it("does it anyway when told to, deliberately", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    invoices = 9;
    const r = await cloud.download({ firmId: FIRM, restoreFirm, force: true });
    expect(r.ok).toBe(true);
  }));

  it("will not overwrite another computer's upload", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });          /* A sends */
    beDevice("dev_B");
    await cloud.upload({ firmId: FIRM, exportFirm, force: true });  /* B sends */
    beDevice("dev_A");
    invoices = 12;
    const r = await cloud.upload({ firmId: FIRM, exportFirm });
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(r.theirs.device).toBe("dev_B");
  }));
});

describe("cloud copy — a damaged copy never reaches the books", () => {
  it("refuses a snapshot with a chunk missing", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    store.delete(`${FIRM}:part:1`);
    const r = await cloud.download({ firmId: FIRM, restoreFirm, force: true });
    expect(r.ok).toBe(false);
    expect(/incomplete/i.test(r.why)).toBe(true);
    expect(restored).toBe(null);
  }));

  it("refuses a snapshot whose bytes have been altered", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    const p0 = store.get(`${FIRM}:part:0`);
    /* A character that is definitely not the one already there. Writing a
       fixed "A" made this test pass by luck: one run in sixty-four the first
       character already was an A, the tamper was a no-op, and the test
       reported that the digest check had caught something it never saw. */
    const first = p0.rec.data[0];
    const other = first === "A" ? "B" : "A";
    store.set(`${FIRM}:part:0`, { ...p0, rec: { i: 0, data: other + p0.rec.data.slice(1) } });
    const r = await cloud.download({ firmId: FIRM, restoreFirm, force: true });
    expect(r.ok).toBe(false);
    expect(/checksum/i.test(r.why)).toBe(true);
    expect(restored).toBe(null);
  }));
});

describe("cloud copy — what the screen is told", () => {
  it("knows the two copies agree straight after an upload", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    const s = await cloud.status(FIRM);
    expect(s.reachable).toBe(true);
    expect(s.changed_since_upload).toBe(false);
    expect(s.remote.from_this_computer).toBe(true);
  }));

  it("knows this computer is ahead once it has traded", () => serial(async () => {
    reset();
    await cloud.upload({ firmId: FIRM, exportFirm });
    invoices = 40;
    const s = await cloud.status(FIRM);
    expect(s.changed_since_upload).toBe(true);
  }));
});
