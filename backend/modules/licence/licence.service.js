"use strict";
/**
 * licence.service.js — the desktop's half of the licence.
 *
 * The same rules the phone app enforces, and for the same reasons. Whoever
 * reads one should recognise the other.
 *
 *   · A till checked recently opens at once and asks again in the background.
 *   · With no network it keeps selling on the last answer for seven days,
 *     and up to 300 bills, whichever runs out first.
 *   · Past that, or when the author blocks it, the till stops at the door:
 *     it can still read its books, run reports and take a backup out. It
 *     simply cannot record anything new. Nothing is deleted, and nothing is
 *     held hostage.
 *
 * And the three ways somebody tries to get it free, each of which the phone
 * app already meets:
 *
 *   1. Type an active licence straight into storage. Every answer from the
 *      server is signed with a key that never leaves it, and the signature is
 *      checked before a word of it is believed.
 *   2. Wind the clock back so the offline grace never runs out. Every signed
 *      answer carries the server's own clock; the highest time ever seen is
 *      kept, and a machine claiming to be earlier than that is not believed.
 *   3. Stay offline and keep selling. Grace is capped by work as well as by
 *      days.
 *
 * What is different from the phone: the licence lives in a file **beside** the
 * database rather than inside it. That is deliberate. Restoring last year's
 * backup must not restore last year's licence — a blocked till would come back
 * to life by pressing Restore, which is not a licence at all.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { DB_PATH } = require("../../database/db");

const FILE = path.join(path.dirname(DB_PATH), "licence.json");

const TRIAL_DAYS = 14;            /* a new installation trades free for this */
const GRACE_DAYS = 7;             /* days a till may run unchecked          */
const MAX_SALES  = 300;           /* bills allowed between two checks       */
const CLOCK_SLACK = 5 * 60000;    /* a machine may be five minutes out      */
const CHECK_EVERY = 6 * 3600 * 1000;
const DEFAULT_SERVER = process.env.GENIUS_LICENCE_SERVER || "https://licences.saljo.tech";

/* Words the shopkeeper reads. The server's own `reason` wins when it sends
   one — whatever the author typed when blocking a licence is what the shop
   is told, verbatim. */
const WORDS = {
  none:     ["This till has no licence yet", "Type the key you were given to start trading."],
  trialing: ["On trial", ""],
  trialover:["The trial has ended",
             "Type the licence key you were given. The books are all still here — "
             + "you can read them, run reports and take a backup out."],
  active:   ["Licensed", ""],
  trial:    ["On trial", "Everything is open while the trial lasts."],
  stale:    ["This till needs to check in",
             "It has been too long, or too many bills, since it last reached the licence server. Connect it once."],
  blocked:  ["This licence has been stopped", "Speak to whoever sold you the licence."],
  expired:  ["This licence has run out", "Renew it to carry on recording sales."],
  revoked:  ["This licence has been withdrawn", "Speak to whoever sold you the licence."],
  unknown:  ["This key is not on record", "Check it letter by letter, or ask for it again."],
  invalid:  ["This key is not a valid licence key", "Check it letter by letter."],
  unbound:  ["This computer is not on the licence", "Activate it again to add it."],
  toomany:  ["The licence has no room for this computer",
             "Release a computer that is no longer used, or move to a bigger plan."],
  unsigned: ["This licence cannot be proved",
             "The copy on this computer was not signed by the licence server. Type the key again to put it right."],
  clock:    ["The clock has been moved back",
             "This computer says it is earlier than it has already been. Set the date correctly, or connect once."],
};

/* ------------------------------------------------------------------ *
 * the file
 * ------------------------------------------------------------------ */
function blank() {
  return {
    key: "", server: DEFAULT_SERVER, status: "none", reason: "",
    licence: null, signed: "", sig: "", pubkey: null,
    checkedAt: "", offlineSince: "", clockMark: 0, salesAt: 0,
    device: null, installedAt: "",
  };
}
let cache = null;
function read() {
  if (cache) return cache;
  try { cache = Object.assign(blank(), JSON.parse(fs.readFileSync(FILE, "utf8"))); }
  catch { cache = blank(); }
  if (!cache.device) cache.device = mintDevice();
  /* The day this installation first ran, which is when the trial starts. Set
     on the first read rather than on activation, because an installation that
     is never activated is exactly the one the trial is for. */
  if (!cache.installedAt) { cache.installedAt = new Date().toISOString(); write(cache); }
  return cache;
}
function write(l) {
  cache = l;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(l, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (e) { console.error("could not write the licence file:", e.message); }
  return l;
}

/** This installation, named once and kept. */
function mintDevice() {
  return {
    id: "pc_" + crypto.randomBytes(8).toString("hex"),
    name: (os.hostname() || "This computer").slice(0, 60),
    kind: "desktop",
  };
}

/* ------------------------------------------------------------------ *
 * a clock that only goes forwards
 * ------------------------------------------------------------------ */
function noteClock(l, serverIso) {
  const seen = Number(l.clockMark || 0);
  const candidates = [seen, Date.now()];
  if (serverIso) { const t = Date.parse(serverIso); if (t) candidates.push(t); }
  const top = Math.max(...candidates.filter((n) => n > 0));
  if (top > seen) l.clockMark = top;
  return l;
}
function clockWentBack(l) {
  return !!l.clockMark && Date.now() < Number(l.clockMark) - CLOCK_SLACK;
}

/* ------------------------------------------------------------------ *
 * proving the answer came from the server we were activated against
 * ------------------------------------------------------------------ */
function verifySigned(l) {
  if (!l.key) return { ok: null, why: "no licence" };
  if (!l.signed || !l.sig || !l.pubkey) {
    return { ok: false, why: "This licence carries no proof from the server" };
  }
  try {
    const pub = crypto.createPublicKey({ key: l.pubkey, format: "jwk" });
    /* ieee-p1363 — the same shape the server signs with, and the shape
       WebCrypto uses, so one server serves both apps. */
    const good = crypto.verify("sha256", Buffer.from(l.signed, "utf8"),
      { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(l.sig, "base64"));
    if (!good) return { ok: false, why: "The licence on this computer was not issued by the server" };
  } catch (e) {
    return { ok: false, why: "The licence could not be checked" };
  }
  let body = null;
  try { body = JSON.parse(l.signed); } catch { /* handled next */ }
  if (!body || !body.licence) return { ok: false, why: "The proof is unreadable" };
  if (body.device && l.device && body.device !== l.device.id) {
    return { ok: false, why: "This proof was issued to another computer" };
  }
  return { ok: true, body };
}

/**
 * The signed copy is the truth; the plain one is a convenience.
 *
 * Without this, editing `licence.json` to say `plan: "lifetime"` while leaving
 * the real signature in place would be believed — the signature would verify
 * (it covers the blob, not the plain copy) and every feature and limit would
 * be read from the edited fields. So whenever the proof is good and the two
 * disagree, the plain copy is put back from the proof.
 */
function reconcile(l) {
  const v = verifySigned(l);
  if (v.ok !== true) return l;
  const said = v.body.licence;
  if (JSON.stringify(said) !== JSON.stringify(l.licence) ||
      l.status !== (said.status || l.status)) {
    l.licence = said;
    if (said.status) l.status = said.status;
    write(l);
  }
  noteClock(l, v.body.serverTime);
  return l;
}

/* ------------------------------------------------------------------ *
 * the verdict
 * ------------------------------------------------------------------ */
function daysSinceCheck(l) {
  if (!l.checkedAt) return 999;
  return (Date.now() - Date.parse(l.checkedAt)) / 86400000;
}

/**
 * The free trial.
 *
 * A brand-new installation has no key, and must be able to set itself up and
 * trade — the phone app has always worked this way, and a till that refuses to
 * open before anybody has typed anything is not a trial, it is a brick. So no
 * key means a trial, counted from the first time the app ran.
 *
 * The clock guard applies here too: winding the machine back does not lengthen
 * a trial, because the highest date ever seen is what it is measured against.
 */
function trialDaysLeft(l) {
  if (!l.installedAt) return TRIAL_DAYS;
  const from = Date.parse(l.installedAt);
  if (!from) return TRIAL_DAYS;
  const now = Math.max(Date.now(), Number(l.clockMark) || 0);
  return Math.ceil((from + TRIAL_DAYS * 86400000 - now) / 86400000);
}

/**
 * @param salesSince how many bills since the last successful check — the
 *        caller counts them, because only it knows the books.
 */
function state(salesSince = 0) {
  let l = read();
  /* No key: the installation is either inside its trial or past it. Never
     simply "none", because "none" told the gate to refuse every write — which
     is how a fresh install came to refuse its own setup wizard. */
  if (!l.key) return trialDaysLeft(l) > 0 ? "trialing" : "trialover";

  l = reconcile(l);
  const v = verifySigned(l);
  if (v.ok === false) return "unsigned";
  if (clockWentBack(l)) return "clock";

  let base = l.status || "none";
  if (base === "active" || base === "trial") {
    if (daysSinceCheck(l) > GRACE_DAYS) return "stale";
    if (salesSince > MAX_SALES) return "stale";
  }
  return base;
}

const LIVE = ["active", "trial", "trialing"];
function ok(salesSince) { return LIVE.indexOf(state(salesSince)) > -1; }

/** Does the plan on this licence include this feature? */
function feature(name, salesSince) {
  const l = reconcile(read());
  if (!ok(salesSince)) return false;
  /* Everything is open during the trial — the point is to see the whole thing
     before paying for it. */
  if (state(salesSince) === "trialing") return true;
  const lic = l.licence;
  if (!lic || !lic.features) return true;     /* an older server said nothing */
  return lic.features.indexOf(name) > -1;
}

function limit(name, dflt) {
  const l = reconcile(read());
  const lim = (l.licence || {}).limits || {};
  const n = Number(lim[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Stopped at the door: reads still work, writing does not. */
function blocks(salesSince) {
  return LIVE.indexOf(state(salesSince)) < 0;
}

function words(s) { return WORDS[s] || WORDS.unknown; }

/** Everything a screen needs to explain itself. */
function status(salesSince = 0) {
  const l = reconcile(read());
  const s = state(salesSince);
  let [title, note] = words(s);
  const trialLeft = l.key ? null : trialDaysLeft(l);
  if (s === "trialing") {
    title = `Trial — ${trialLeft} day${trialLeft === 1 ? "" : "s"} left`;
    note = "Everything is open while the trial lasts. Type a licence key at any time.";
  }
  const v = verifySigned(l);
  return {
    state: s,
    blocks: blocks(salesSince),
    title,
    /* whatever the author typed when blocking it is what the shop reads */
    note: l.reason || (s === "unsigned" && v.why) || note,
    key: l.key ? l.key.slice(0, 11) + "…" : "",
    hasKey: !!l.key,
    server: l.server || DEFAULT_SERVER,
    checkedAt: l.checkedAt || null,
    offlineSince: l.offlineSince || null,
    daysSinceCheck: l.key ? Math.floor(daysSinceCheck(l)) : null,
    graceDays: GRACE_DAYS,
    trialDaysLeft: trialLeft,
    trialDays: TRIAL_DAYS,
    installedAt: l.installedAt || null,
    salesSince,
    maxSales: MAX_SALES,
    device: l.device,
    licence: l.licence,
    pinned: !!l.pubkey,
    clockSeen: l.clockMark ? new Date(l.clockMark).toISOString() : null,
  };
}

/* ------------------------------------------------------------------ *
 * talking to the server
 * ------------------------------------------------------------------ */
function post(server, route, body, timeout = 10000) {
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
        try { d = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* below */ }
        resolve({ status: res.statusCode, body: d });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("The licence server did not answer")); });
    req.on("error", (e) => reject(new Error(e.message === "socket hang up" ? "No connection" : e.message)));
    req.end(payload);
  });
}
function get(server, route, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(route, server); } catch { return reject(new Error("That server address is not valid")); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let d = {};
        try { d = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* below */ }
        resolve({ status: res.statusCode, body: d });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("The licence server did not answer")); });
    req.on("error", (e) => reject(new Error(e.message)));
    req.end();
  });
}

/** Remember what the server said, proof and all. */
function remember(l, d, salesNow) {
  l.status = d.status || (d.ok ? "active" : "unknown");
  l.reason = d.reason || "";
  if (d.licence) l.licence = d.licence;
  if (d.signed && d.sig) { l.signed = d.signed; l.sig = d.sig; }
  l.checkedAt = new Date().toISOString();
  l.offlineSince = "";
  l.salesAt = Number(salesNow) || 0;
  noteClock(l, d.serverTime);
  return write(l);
}

/**
 * Activation. The public key is fetched and **pinned** first — from then on
 * this till believes one server and no other, so a second server cannot be
 * put in front of it and hand it a licence.
 */
async function activate({ key, server, salesNow }) {
  const l = read();
  if (server) l.server = String(server).trim();
  if (key) l.key = String(key).trim().toUpperCase();
  if (!l.key) throw new Error("Type the licence key first");
  write(l);

  const pk = await get(l.server, "/v1/pubkey");
  const jwk = pk.body && pk.body.key;
  if (!jwk) throw new Error("Could not reach the licence server");
  if (l.pubkey && JSON.stringify(l.pubkey) !== JSON.stringify(jwk)) {
    throw new Error("This till is pinned to a different licence server");
  }
  l.pubkey = jwk;
  write(l);

  const r = await post(l.server, "/v1/activate", {
    key: l.key, device: l.device, app: { build: require("../../shared/version") },
  });
  remember(l, r.body || {}, salesNow);
  const v = verifySigned(read());
  if (v.ok === false) throw new Error(v.why);
  return status(0);
}

/** The background check. Losing the network changes nothing that day. */
async function check({ salesNow } = {}) {
  const l = read();
  if (!l.key) return status(0);
  try {
    const r = await post(l.server, "/v1/check", { key: l.key, deviceId: l.device.id });
    remember(l, r.body || {}, salesNow);
  } catch (e) {
    /* Being offline in a Ugandan shop is the ordinary case, not an incident:
       keep the last answer and start the grace clock. */
    if (!l.offlineSince) l.offlineSince = new Date().toISOString();
    write(l);
    return Object.assign(status(0), { offline: true, why: e.message });
  }
  return status(0);
}

function forget() { return write(Object.assign(blank(), { device: read().device })); }

function setServer(server) {
  const l = read();
  l.server = String(server || "").trim() || DEFAULT_SERVER;
  return write(l);
}

/** Bills recorded since the last successful check. */
function salesBaseline() { return Number(read().salesAt || 0); }

module.exports = {
  FILE, GRACE_DAYS, MAX_SALES, TRIAL_DAYS, CHECK_EVERY, DEFAULT_SERVER, WORDS,
  trialDaysLeft,
  read, write, state, ok, blocks, feature, limit, status, words, reconcile,
  activate, check, forget, setServer, salesBaseline, verifySigned, noteClock, clockWentBack,
};
