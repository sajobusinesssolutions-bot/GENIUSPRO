"use strict";
/**
 * electron/updater.js — keeping the till on the current build.
 *
 * Updates come from the project's GitHub releases. `electron-updater` does
 * the real work: it reads `latest.yml` from the newest release, compares it
 * with what is installed, downloads the installer in the background and
 * hands it to NSIS when the shopkeeper is ready.
 *
 * Three deliberate choices:
 *
 *   · **Nothing installs itself mid-trade.** The download is silent, the
 *     install is not. A till that restarts on its own in the middle of a
 *     queue is worse than a till one version behind.
 *
 *   · **A missing updater is not a crash.** `electron-updater` is a real
 *     dependency, but a portable build, a source checkout with no install,
 *     or a stripped package can all leave it absent. Everything here is
 *     behind a guard, and when it is not there the app says where to get
 *     the new build instead of dying.
 *
 *   · **The portable build never offers to update itself**, because there
 *     is nothing to install over — it is one .exe on a memory stick. It is
 *     told where the download is and left alone.
 *
 * Unsigned builds do update. What signing buys is the absence of a
 * SmartScreen warning on the way in; see README-DESKTOP.md.
 */
const { app, dialog, shell, Menu } = require("electron");
const fs = require("fs");
const path = require("path");

/* The repository this build watches. It is the same one electron-builder was
   told to publish to (see electron-builder.yml → publish), written here as
   well so the app can SAY where it is looking — a shop told "could not check
   for a new version" with no idea what it was checking has nothing to report
   to anybody. Change both together. */
const REPO = { owner: "sajobusinesssolutions-bot", repo: "GeniusPOS" };
const RELEASES = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`;
const FIRST_CHECK_AFTER = 30 * 1000;          /* let the till open first */
const CHECK_EVERY       = 6 * 3600 * 1000;

let autoUpdater = null;
let state = { status: "idle", version: null, why: "", checking: false, lastCheck: null };
let onChange = () => {};
let timer = null;

/* ── Whether to look on a schedule ─────────────────────────────────────────
 *
 * Until now the answer was always yes, and there was no way to say otherwise.
 * That is wrong for two real situations: a shop on a metered phone connection,
 * where a 90MB installer downloading silently in the background is money; and
 * a shop that has settled on a version that works and does not want a new one
 * appearing without somebody deciding to fetch it.
 *
 * Off does NOT mean "never update". The button on the Updates screen still
 * works, and still says what is available — the shop just decides when to
 * look. Kept in a small file beside the database rather than in settings,
 * because it is a property of this installation and not of the business:
 * copying a business to another computer must not carry it over.
 */
const prefPath = () => path.join(app.getPath("userData"), "update-prefs.json");

function prefs() {
  try { return JSON.parse(fs.readFileSync(prefPath(), "utf8")) || {}; }
  catch { return {}; }
}
function autoOn() { return prefs().auto !== false; }
function setAuto(on) {
  const want = !!on;
  try {
    fs.mkdirSync(path.dirname(prefPath()), { recursive: true });
    fs.writeFileSync(prefPath(), JSON.stringify({ ...prefs(), auto: want }, null, 2));
  } catch (e) {
    console.warn("could not save the update preference:", e.message);
    return { ok: false, why: "That preference could not be saved on this computer." };
  }
  schedule();
  onChange(state);
  return { ok: true, auto: want };
}

/* A portable .exe has nothing to install over. */
function isPortable() {
  return process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
}

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    console.warn("electron-updater is not installed — updates will be manual:", e.message);
    return null;
  }
  autoUpdater.autoDownload = true;            /* fetch quietly */
  autoUpdater.autoInstallOnAppQuit = false;   /* but never restart unasked */
  autoUpdater.logger = {
    info:  (m) => console.log("update:", m),
    warn:  (m) => console.warn("update:", m),
    error: (m) => console.error("update:", m),
    debug: () => {},
  };

  autoUpdater.on("checking-for-update", () => { state.checking = true; onChange(state); });
  autoUpdater.on("update-not-available", () => {
    state = { status: "current", version: app.getVersion(), why: "", checking: false,
              lastCheck: new Date().toISOString() };
    onChange(state);
  });
  autoUpdater.on("update-available", (info) => {
    state = { status: "downloading", version: info && info.version, why: "", checking: false,
              notes: notesOf(info), releasedAt: (info && info.releaseDate) || null };
    console.log(`a newer build is out: ${state.version}`);
    onChange(state);
  });
  autoUpdater.on("download-progress", (p) => {
    state.status = "downloading";
    state.percent = Math.round(p.percent || 0);
    onChange(state);
  });
  autoUpdater.on("update-downloaded", (info) => {
    state = { status: "ready", version: info && info.version, why: "", checking: false,
              notes: notesOf(info) || state.notes, releasedAt: (info && info.releaseDate) || state.releasedAt };
    onChange(state);
    offerToInstall();
  });
  autoUpdater.on("error", (e) => {
    /* Being offline is the ordinary case in a Ugandan shop, not an incident. */
    state = { status: "failed", version: state.version,
              why: String((e && e.message) || e), checking: false,
              lastCheck: new Date().toISOString() };
    console.warn("update check failed:", state.why);
    onChange(state);
  });
  return autoUpdater;
}

/* What the release actually said. electron-updater hands notes back either as
   a string or as a list of {version, note} — a screen that only handled the
   first showed "[object Object]" to every shop on the day somebody published
   a release the other way. */
function notesOf(info) {
  const n = info && info.releaseNotes;
  if (!n) return "";
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map((x) => (x && x.note) || "").filter(Boolean).join("\n\n");
  return "";
}

/** Ask, once the download is on disk. Never assume. */
function offerToInstall(loud) {
  const r = dialog.showMessageBoxSync({
    type: "info",
    title: "Genius POS — a new version is ready",
    message: `Version ${state.version} has been downloaded.`,
    detail:
      "Installing takes about half a minute and closes the till while it runs.\n\n" +
      "Your books are not touched by an update — they live outside the program.\n\n" +
      "If you are serving customers, choose Later. It will be offered again next time.",
    buttons: ["Install and restart", "Later"],
    defaultId: 1, cancelId: 1, noLink: true,
  });
  if (r === 0) {
    console.log("installing update", state.version);
    /* isSilent: false so the shopkeeper sees the installer doing something;
       isForceRunAfter: true so the till comes back by itself. */
    autoUpdater.quitAndInstall(false, true);
  } else if (loud) {
    console.log("update postponed by the operator");
  }
}

/**
 * Check now.
 * `loud` means a person asked, so say something either way.
 */
function check(loud) {
  if (isPortable()) {
    if (loud) {
      const r = dialog.showMessageBoxSync({
        type: "info",
        title: "Genius POS — portable copy",
        message: "This is the portable build, which cannot update itself.",
        detail: "Download the newest one and replace this file. Your books are " +
                "kept separately and are not affected.",
        buttons: ["Open the downloads page", "Close"],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (r === 0) shell.openExternal(RELEASES);
    }
    return;
  }
  const u = load();
  if (!u) {
    if (loud) {
      const r = dialog.showMessageBoxSync({
        type: "info",
        title: "Genius POS — updates",
        message: "This copy cannot update itself.",
        detail: `Running version ${app.getVersion()}. The newest one is always on the ` +
                "downloads page.",
        buttons: ["Open the downloads page", "Close"],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (r === 0) shell.openExternal(RELEASES);
    }
    return;
  }
  /* A download already on disk should be offered again rather than re-fetched. */
  if (state.status === "ready") { offerToInstall(loud); return; }

  u.checkForUpdates().then(() => {
    if (loud && state.status === "current") {
      dialog.showMessageBox({
        type: "info", title: "Genius POS",
        message: "This is the newest version.",
        detail: `Running ${app.getVersion()}.`,
        buttons: ["Close"], noLink: true,
      });
    }
  }).catch((e) => {
    console.warn("update check failed:", (e && e.message) || e);
    if (loud) {
      dialog.showMessageBox({
        type: "warning", title: "Genius POS",
        message: "Could not check for a new version.",
        detail: `${(e && e.message) || e}\n\nThe till carries on working exactly as it is.`,
        buttons: ["Close"], noLink: true,
      });
    }
  });
}

/* Arm or disarm the background schedule to match the preference. Called at
   start-up and again whenever the switch is flipped, so turning it off stops
   the next check rather than the one after the restart. */
function schedule() {
  if (timer) { clearTimeout(timer.first); clearInterval(timer.every); timer = null; }
  if (!autoOn()) { console.log("automatic updates are off"); return; }
  if (isPortable() || !app.isPackaged) return;
  timer = {
    first: setTimeout(() => check(false), FIRST_CHECK_AFTER),
    every: setInterval(() => check(false), CHECK_EVERY),
  };
}

/** Start the background schedule. Called once, after the window is open. */
function start(notify) {
  if (typeof notify === "function") onChange = notify;
  if (isPortable()) { console.log("portable build — no automatic updates"); return; }
  if (!app.isPackaged) { console.log("running from source — no automatic updates"); return; }
  schedule();
}

function status() {
  return Object.assign({
    releases: RELEASES,
    /* Where it looks. A shop told "could not check for a new version" with no
       idea what it was checking has nothing it can report to anybody. */
    repo: `${REPO.owner}/${REPO.repo}`,
    auto: autoOn(),
    portable: isPortable(),
    current: app.getVersion(),
    /* `packaged` is the difference between "no update is available" and "this
       copy was never able to update itself", and a screen that cannot tell
       them apart tells a developer their build is up to date for ever. */
    packaged: app.isPackaged,
    updatable: !isPortable() && app.isPackaged && !!load(),
  }, state);
}

/**
 * Install what has been downloaded, asked for from the app's own screen.
 *
 * Refuses when nothing is on disk rather than restarting into the same
 * version: "Install" that quits the till and brings back exactly what it was
 * is the worst possible answer to a shopkeeper serving a queue.
 */
function install() {
  if (state.status !== "ready") return { ok: false, why: "There is nothing downloaded to install yet." };
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 250);
  return { ok: true };
}

module.exports = { start, check, status, install, setAuto, RELEASES, REPO };
