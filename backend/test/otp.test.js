/**
 * otp.test.js — the second factor, and the two ways past it that are meant to
 * exist.
 *
 * Signing in with a password alone is enough for a device that has already
 * proved itself; anything else needs a code from the account's email, or one
 * of the backup codes printed when the account was set up. This pins the
 * properties that make that worth having, because every one of them fails
 * quietly if it is wrong — a second factor that is not actually checked looks
 * exactly like one that is, from every screen and from most tests.
 */
const { describe, it, expect } = require("./tiny-test");
const db = require("../database/db");
const devices = require("../shared/devices");
const { signChallenge, readChallenge } = require("../shared/challenge");
const jwt = require("jsonwebtoken");
const { SECRET } = require("../shared/middleware/auth");

/* A database of our own, so these tests neither need the shipped schema nor
   disturb anything else running in this process. */
let ready = null;
function fresh() {
  if (ready) return ready;
  ready = (async () => {
    await db.init();
    const store = db.makeStore(require("path").join(
      require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "genius-otp-")), "otp.db"),
      { label: "otp" });
    store.openSync();
    db.installRouter(() => store);
    await store.query(`CREATE TABLE trusted_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, token_hash TEXT NOT NULL,
      label TEXT, created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT,
      expires_at TEXT NOT NULL, revoked_at TEXT)`);
    await store.query(`CREATE TABLE backup_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, code_hash TEXT NOT NULL,
      used_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    return store;
  })();
  return ready;
}

/* ── which device is this ────────────────────────────────────────────────── */

describe("naming a device", () => {
  it("reads the common browsers, most specific first", async () => {
    await fresh();
    const l = (ua) => devices.deviceLabel({ headers: { "user-agent": ua } });
    /* Edge and Opera both claim to be Chrome, and Chrome claims to be Safari.
       Tested in the wrong order every browser comes out as "Chrome". */
    expect(l("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537 (KHTML) Chrome/120 Safari/537 Edg/120"))
      .toBe("Windows · Edge");
    expect(l("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537 Chrome/120 Safari/537"))
      .toBe("Windows · Chrome");
    expect(l("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537 Chrome/120 Mobile Safari/537"))
      .toBe("Android · Chrome");
    expect(l("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Version/17 Safari/605"))
      .toBe("Mac · Safari");
  });

  it("says something rather than nothing when the browser will not say", async () => {
    await fresh();
    expect(devices.deviceLabel({ headers: {} })).toBe("Unknown device");
    expect(devices.deviceLabel(null)).toBe("Unknown device");
  });
});

/* ── trusting a device ───────────────────────────────────────────────────── */

describe("a device that has proved itself", () => {
  it("is trusted afterwards, and was not before", async () => {
    await fresh();
    expect(await devices.deviceTrusted(1, "never-issued")).toBe(false);
    const token = await devices.rememberDevice(1, "Windows · Chrome");
    expect(await devices.deviceTrusted(1, token)).toBe(true);
  });

  it("is trusted for the account that earned it and no other", async () => {
    await fresh();
    /* Without the account in the lookup, one person's trusted laptop would
       answer "already verified" for somebody else's email address, and the
       code step would be skipped for an account that had never been near the
       machine. */
    const token = await devices.rememberDevice(2, "Mac · Safari");
    expect(await devices.deviceTrusted(2, token)).toBe(true);
    expect(await devices.deviceTrusted(3, token)).toBe(false);
  });

  it("stores no token that could be read back out", async () => {
    const store = await fresh();
    const token = await devices.rememberDevice(4, "Linux · Firefox");
    const rows = (await store.query("SELECT token_hash FROM trusted_devices WHERE account_id = 4")).rows;
    expect(rows.length).toBe(1);
    /* A copy of this table must not be a folder of working devices. */
    expect(rows[0].token_hash === token).toBe(false);
    expect(rows[0].token_hash.length).toBe(64);      // sha-256, hex
  });

  it("stops being trusted once it is revoked", async () => {
    await fresh();
    const token = await devices.rememberDevice(5, "Windows · Chrome");
    const [row] = await devices.listDevices(5);
    expect(await devices.revokeDevice(5, row.id)).toBe(true);
    expect(await devices.deviceTrusted(5, token)).toBe(false);
  });

  it("cannot be revoked by another account", async () => {
    await fresh();
    const token = await devices.rememberDevice(6, "Windows · Chrome");
    const [row] = await devices.listDevices(6);
    expect(await devices.revokeDevice(999, row.id)).toBe(false);
    expect(await devices.deviceTrusted(6, token)).toBe(true);
  });

  it("stops being trusted once it has expired", async () => {
    const store = await fresh();
    const token = await devices.rememberDevice(7, "Old machine");
    await store.query("UPDATE trusted_devices SET expires_at = datetime('now', '-1 day') WHERE account_id = 7");
    /* Thirty days from when it was trusted, not from when it was last used —
       otherwise a device used daily is never asked again. */
    expect(await devices.deviceTrusted(7, token)).toBe(false);
  });

  it("lets a password reset clear every device at once", async () => {
    await fresh();
    const a = await devices.rememberDevice(8, "one");
    const b = await devices.rememberDevice(8, "two");
    expect(await devices.revokeAllDevices(8)).toBe(2);
    /* A reset is what somebody does when they think another person has their
       password. Leaving that person's computer trusted would mean the reset
       locked the thief out of the password and left the way around it open. */
    expect(await devices.deviceTrusted(8, a)).toBe(false);
    expect(await devices.deviceTrusted(8, b)).toBe(false);
  });
});

/* ── backup codes ────────────────────────────────────────────────────────── */

describe("backup codes", () => {
  it("issues ten, in a shape somebody can copy off paper", async () => {
    await fresh();
    const codes = await devices.issueBackupCodes(20);
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(c)).toBe(true);
      /* 0/O and 1/I/L are left out on purpose: these are read off a printed
         sheet by somebody who did not choose them. */
      expect(/[01OIL]/.test(c)).toBe(false);
    }
  });

  it("accepts one however it was typed", async () => {
    await fresh();
    const [code] = await devices.issueBackupCodes(21);
    expect(await devices.useBackupCode(21, code.toLowerCase().replace("-", " "))).toBe(true);
  });

  it("never accepts the same one twice", async () => {
    await fresh();
    const [code] = await devices.issueBackupCodes(22);
    expect(await devices.useBackupCode(22, code)).toBe(true);
    /* Single use is the whole point: a code that has let somebody in must not
       let in whoever was reading over their shoulder. */
    expect(await devices.useBackupCode(22, code)).toBe(false);
  });

  it("does not accept one account's code for another", async () => {
    await fresh();
    const [mine] = await devices.issueBackupCodes(23);
    await devices.issueBackupCodes(24);
    expect(await devices.useBackupCode(24, mine)).toBe(false);
  });

  it("counts down as they are spent", async () => {
    await fresh();
    const codes = await devices.issueBackupCodes(25);
    expect(await devices.backupCodesLeft(25)).toBe(10);
    await devices.useBackupCode(25, codes[0]);
    await devices.useBackupCode(25, codes[1]);
    expect(await devices.backupCodesLeft(25)).toBe(8);
  });

  it("kills the old sheet when a new one is printed", async () => {
    await fresh();
    const before = await devices.issueBackupCodes(26);
    const after = await devices.issueBackupCodes(26);
    /* Somebody asking for new codes has usually lost the old sheet. Codes they
       can no longer account for must stop working. */
    expect(await devices.useBackupCode(26, before[0])).toBe(false);
    expect(await devices.useBackupCode(26, after[0])).toBe(true);
    expect(await devices.backupCodesLeft(26)).toBe(9);
  });

  it("stores nothing a reader of the table could use", async () => {
    const store = await fresh();
    const codes = await devices.issueBackupCodes(27);
    const rows = (await store.query("SELECT code_hash FROM backup_codes WHERE account_id = 27")).rows;
    expect(rows.some((r) => codes.includes(r.code_hash))).toBe(false);
    expect(rows[0].code_hash.startsWith("$")).toBe(true);      // bcrypt, not a plain digest
  });

  it("refuses an empty or trivial guess without scanning anything", async () => {
    await fresh();
    await devices.issueBackupCodes(28);
    expect(await devices.useBackupCode(28, "")).toBe(false);
    expect(await devices.useBackupCode(28, "---")).toBe(false);
  });
});

/* ── the ticket that says the password was given ─────────────────────────── */

describe("the sign-in challenge", () => {
  it("names the account it was issued for", () => {
    expect(readChallenge(signChallenge(42)).acct).toBe(42);
  });

  it("refuses anything it did not sign", () => {
    expect(readChallenge("not-a-token")).toBe(null);
    expect(readChallenge(jwt.sign({ t: "otp", acct: 1 }, "some-other-secret"))).toBe(null);
    expect(readChallenge("")).toBe(null);
    expect(readChallenge(null)).toBe(null);
  });

  it("**refuses a token of any other kind, signed with the same secret**", () => {
    /* The one that matters. Every token this application issues is signed with
       the same key, so a signature check alone proves only that we minted it —
       not what for. Without the type check, an ordinary access token (which
       every signed-in cashier holds, and which is sent on every request) would
       be accepted as proof that somebody had passed a password check they had
       never seen, and the second factor would silently not exist. */
    expect(readChallenge(jwt.sign({ id: 1, username: "cashier" }, SECRET))).toBe(null);
    expect(readChallenge(jwt.sign({ t: "onboard", acct: 1 }, SECRET))).toBe(null);
    expect(readChallenge(jwt.sign({ t: "refresh", acct: 1 }, SECRET))).toBe(null);
  });

  it("refuses one that has run out", () => {
    expect(readChallenge(jwt.sign({ t: "otp", acct: 1 }, SECRET, { expiresIn: -60 }))).toBe(null);
  });

  it("refuses one with no usable account on it", () => {
    expect(readChallenge(jwt.sign({ t: "otp" }, SECRET))).toBe(null);
    expect(readChallenge(jwt.sign({ t: "otp", acct: 0 }, SECRET))).toBe(null);
    expect(readChallenge(jwt.sign({ t: "otp", acct: "not-a-number" }, SECRET))).toBe(null);
  });
});

/* ── putting the database layer back ─────────────────────────────────────
 *
 * These tests point the storage router at a database of their own, and that
 * router is module-level state in db.js — so leaving it installed would send
 * every suite that runs after this one to the wrong file. The runner executes
 * tests in the order they are registered, one after the previous has
 * finished, so a last test is where the cleanup goes. It is registered as a
 * test rather than done at the end of the file because the file finishes
 * running long before any of these bodies do. */
describe("cleaning up after these tests", () => {
  it("leaves the storage router as it found it", async () => {
    await fresh();
    db.installRouter(null);
    expect(db.central.label).toBe("central");
  });
});
