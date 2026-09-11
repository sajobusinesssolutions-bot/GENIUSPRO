/**
 * electron/main.js — the Windows desktop shell for Genius POS.
 *
 * The same Express backend and the same React bundle that run when a shop
 * hosts it themselves, boxed so a shopkeeper can double-click an icon and
 * have a till. Nothing about the application changes: it is the identical
 * server on localhost, so a build tested on the web is tested here too.
 *
 * What a packaged app has to get right that a development wrapper does not:
 *
 *   · It has to listen. `server.js` calls app.listen() only when it is the
 *     process entry point; under Electron it is a required module, so the
 *     window would open on a port with nothing behind it.
 *   · The books belong in the user's profile, not in the installed folder,
 *     or the next update deletes them.
 *   · Production refuses to start without a JWT secret and there is no shell
 *     to export one from, so the first run mints one.
 *   · The first run must also create an account somebody can sign in with,
 *     IN PROCESS — a child process cannot change directory into an asar
 *     archive, so spawning the seed script does nothing in exactly the build
 *     that needs it, and leaves the shopkeeper at a login screen with no
 *     account behind it.
 *   · Those first credentials must not be the ones printed in the manual.
 *   · When it breaks at four in the afternoon in a shop three hours away,
 *     somebody has to be able to read what happened. Hence the log file.
 *
 * Run from source:  npm run desktop
 * Package:          npm run dist:win
 */
const path   = require("path");
const fs     = require("fs");
const net    = require("net");
const os     = require("os");
const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, Menu, shell, dialog, session } =
  require("electron");
const updater = require("./updater");

/* ------------------------------------------------------------------ *
 * where things live
 * ------------------------------------------------------------------ */
const DATA_DIR = app.getPath("userData");
fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * The product used to be called Sajo Books, and Windows put its folder under
 * that name. Renaming the app moves the folder Electron hands us, which would
 * silently present an established shop with an empty till. So on the first
 * start under the new name, an old folder is carried across whole — books,
 * session key and window position together.
 */
(function carryOldProfileOver() {
  try {
    if (fs.readdirSync(DATA_DIR).length) return;   // already done, or nothing to do
  } catch { return; }
  const here = path.dirname(DATA_DIR);
  for (const name of ["sajo-books", "Sajo Billing & POS", "sajo-pos", "Sajo POS"]) {
    const from = path.join(here, name);
    if (from === DATA_DIR || !fs.existsSync(from)) continue;
    try {
      for (const entry of fs.readdirSync(from)) {
        fs.renameSync(path.join(from, entry), path.join(DATA_DIR, entry));
      }
      console.log(`Carried the shop's files over from "${name}".`);
      return;
    } catch (e) {
      console.error(`Could not carry "${name}" over:`, e.message);
    }
  }
})();

const DB_FILE   = path.join(DATA_DIR, "genius.db");
const KEY_FILE  = path.join(DATA_DIR, "session.key");
const WIN_FILE  = path.join(DATA_DIR, "window.json");
const LOG_DIR   = path.join(DATA_DIR, "logs");
const LOG_FILE  = path.join(LOG_DIR, "genius.log");

/* ------------------------------------------------------------------ *
 * the log
 *
 * A packaged Windows GUI app has no console. Everything the shell and the
 * server print goes to a file the shopkeeper can be asked to send, rolled so
 * it cannot fill a disk over a year of trading.
 * ------------------------------------------------------------------ */
const LOG_MAX = 2 * 1024 * 1024;                 /* roll at 2 MB, keep one */
function startLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch { /* no log yet */ }
    const out = fs.createWriteStream(LOG_FILE, { flags: "a" });
    const util = require("util");
    const tee = (kind, original) => (...args) => {
      try {
        out.write(`${new Date().toISOString()} ${kind} ` +
          args.map((a) => (typeof a === "string" ? a : util.inspect(a))).join(" ") + "\n");
      } catch { /* a full disk must not stop the till */ }
      try { original(...args); } catch { /* no console in a packaged build */ }
    };
    console.log   = tee("INFO ", console.log.bind(console));
    console.warn  = tee("WARN ", console.warn.bind(console));
    console.error = tee("ERROR", console.error.bind(console));
    console.log(`--- Genius POS ${app.getVersion()} starting · ${os.platform()} ${os.release()} ---`);
  } catch { /* logging is a convenience, never a precondition */ }
}
startLog();

/* Nothing should end this process without saying why, in the log. */
process.on("uncaughtException",  (e) => console.error("uncaught:", (e && e.stack) || e));
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", (e && e.stack) || e));

/**
 * The signing key for sessions. Generated once on this machine and never
 * shown to anybody — a shipped default would let anyone who unzipped the
 * installer forge an admin token on every copy sold.
 */
function sessionKey() {
  try {
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (k.length >= 32) return k;
  } catch { /* first run */ }
  const k = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(KEY_FILE, k, { encoding: "utf8", mode: 0o600 });
  return k;
}

/** The first free port from `start`, giving up rather than scanning forever. */
function freePort(start, tries) {
  const left = tries === undefined ? 100 : tries;
  return new Promise((resolve, reject) => {
    if (left <= 0) return reject(new Error(`No free port near ${start}`));
    const s = net.createServer();
    s.once("error", () => { s.close(() => {}); resolve(freePort(start + 1, left - 1)); });
    s.once("listening", () => s.close(() => resolve(start)));
    s.listen(start, "127.0.0.1");
  });
}

const readJSON  = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o)); } catch { /* not worth a dialog */ } };

let win = null;
let server = null;
let PORT = 0;
let quitting = false;

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */
async function boot() {
  process.env.GENIUS_DB_PATH = DB_FILE;
  process.env.JWT_SECRET     = process.env.JWT_SECRET || sessionKey();
  process.env.NODE_ENV       = process.env.NODE_ENV   || "production";

  PORT = Number(process.env.PORT) || (await freePort(3777));
  process.env.PORT = String(PORT);

  /* Deny every permission, because nothing here asks for one. Electron's
     default is to grant, so a page that got in could otherwise turn on the
     camera or read the clipboard without anybody being asked. */
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  await firstRunSeed();

  const { app: api, ready } = require(path.join(__dirname, "..", "backend", "server.js"));
  await ready;

  /* server.js listens only when it is the entry point; here it is not. On one
     machine 127.0.0.1 is the right answer — GENIUS_LAN=1 is the deliberate
     exception for a shop that wants a second till on the same Wi-Fi. */
  const host = process.env.GENIUS_LAN === "1" ? "0.0.0.0" : "127.0.0.1";
  server = await new Promise((resolve, reject) => {
    const s = api.listen(PORT, host, () => resolve(s));
    s.on("error", reject);
  });
  console.log(`serving on http://${host}:${PORT}`);

  openWindow();
}

/**
 * The first run on a new machine.
 *
 * Everything a shop needs except the logins: the person setting the till up
 * says who they are and chooses their own password on the first screen. That
 * is better than generating one and putting it in a dialog they have to
 * transcribe, and it means there is never a moment where a working password
 * exists that nobody chose.
 */
async function firstRunSeed() {
  if (fs.existsSync(DB_FILE)) return;
  let ensureSeeded;
  try {
    ({ ensureSeeded } = require(path.join(__dirname, "..", "backend", "shared", "firstrun.js")));
  } catch (e) {
    console.error("first-run module missing:", e.message);
    return;                                    /* the server still explains itself */
  }
  try {
    const r = await ensureSeeded({ quiet: true });
    if (r && r.seeded) console.log("first run: the shop is ready, waiting to be claimed");
  } catch (e) {
    console.error("first-run setup failed:", (e && e.stack) || e);
    dialog.showErrorBox("Genius POS could not set this till up",
      `The first-run setup did not finish:\n\n${(e && e.message) || e}\n\nThe log is at:\n${LOG_FILE}`);
  }
}

/* ------------------------------------------------------------------ *
 * the window
 * ------------------------------------------------------------------ */
function openWindow() {
  const g = readJSON(WIN_FILE, {});
  win = new BrowserWindow({
    width:  g.width  || 1280,
    height: g.height || 820,
    x: g.x, y: g.y,
    minWidth: 960, minHeight: 620,
    title: "Genius POS",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, "preload.js"),   // exposes window.geniusPrint
      spellcheck: false,
    },
  });
  if (g.maximized) win.maximize();

  win.loadURL(`http://127.0.0.1:${PORT}`);
  win.once("ready-to-show", () => win.show());

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    writeJSON(WIN_FILE, { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() });
  };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("close", remember);
  win.on("closed", () => { win = null; });

  /* The till never leaves itself. Anything else is denied here and handed to
     the shopkeeper's own browser — and only if it is http(s), because
     shell.openExternal on Windows will launch other protocol handlers too. */
  const mine = (url) => url.startsWith(`http://127.0.0.1:${PORT}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    /* A price list or an X report is printed by opening a blank window and
       writing the document into it, so about:blank has to be allowed — it
       carries nothing until the page fills it. */
    if (url === "about:blank" || url === "") return { action: "allow" };
    if (mine(url)) return { action: "allow" };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (mine(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  /* A blank window is the worst failure mode: it looks like the app is broken
     when the server simply has not answered. Only the main frame failing is
     worth interrupting a sale for — a subresource is not. */
  win.webContents.on("did-fail-load", (_e, code, why, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;     // -3 is an aborted redirect
    console.error(`main frame failed to load: ${code} ${why}`);
    if (win && !win.isDestroyed()) win.show();
    dialog.showErrorBox("Genius POS could not open",
      `The till did not answer on port ${PORT}.\n\n${why}\n\n` +
      `Close Genius POS and start it again. The log is at:\n${LOG_FILE}`);
  });

  /* A renderer that dies takes the till with it unless somebody notices. */
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit" || quitting) return;
    console.error("renderer gone:", JSON.stringify(details));
    const r = dialog.showMessageBoxSync(win, {
      type: "error",
      title: "Genius POS stopped responding",
      message: "The till closed unexpectedly.",
      detail: `Nothing already recorded is lost — the books are written as each sale is made.\n\n` +
        `Reason: ${details.reason}\nThe log is at:\n${LOG_FILE}`,
      buttons: ["Reopen the till", "Close Genius POS"],
      defaultId: 0, noLink: true,
    });
    if (r === 0 && win && !win.isDestroyed()) win.reload();
    else app.quit();
  });
  win.webContents.on("unresponsive", () => {
    console.warn("renderer unresponsive");
    const r = dialog.showMessageBoxSync(win, {
      type: "warning", title: "Genius POS is busy",
      message: "The till is not responding.",
      detail: "It may be finishing a large report. Wait a little, or reload it.",
      buttons: ["Wait", "Reload"], defaultId: 0, noLink: true,
    });
    if (r === 1 && win && !win.isDestroyed()) win.reload();
  });

  registerPrintHandlers();
  buildMenu();

  /* Updates come from the project's releases. The check waits until the till
     is open and usable — a shop opening at eight is not waiting on GitHub. */
  updater.start(function () { try { buildMenu(); } catch { /* menu is cosmetic */ } });
}

/* ------------------------------------------------------------------ *
 * printing — the reason the desktop build exists for many shops
 *
 * In a browser, window.print() hands control to the browser's dialog and no
 * script may pick the printer, so "default printer" cannot be honoured there.
 * Here we can list the real printers and print straight to a chosen one, so a
 * till fires receipts at the thermal printer with no dialog at all.
 * ------------------------------------------------------------------ */
const PRINT_TIMEOUT = 60000;

/* The document is written to a temp file rather than squeezed into a data:
   URL — Chromium caps those around 2 MB, and a long invoice with a logo on it
   goes past that with no useful error. */
function tempDoc(html) {
  const f = path.join(app.getPath("temp"),
    `genius-print-${crypto.randomBytes(6).toString("hex")}.html`);
  fs.writeFileSync(f, html || "<p>Nothing to print</p>", "utf8");
  return f;
}
const forget = (f) => { try { fs.unlinkSync(f); } catch { /* the OS will */ } };

/* A window for rendering paper: no node, no scripts, nothing to compromise. */
function paperWindow(extra) {
  return new BrowserWindow(Object.assign({
    show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      javascript: false,             // receipts are markup; nothing needs to run
      webSecurity: true,
    },
  }, extra || {}));
}

function registerPrintHandlers() {
  if (registerPrintHandlers.done) return;
  registerPrintHandlers.done = true;

  /* Only the till's own page may ask. */
  const fromTill = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

  ipcMain.handle("genius:list-printers", async (e) => {
    if (!fromTill(e)) return [];
    try {
      const list = await e.sender.getPrintersAsync();
      return list.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: !!p.isDefault,
      }));
    } catch (err) {
      console.error("could not list printers:", err.message);
      return [];
    }
  });

  ipcMain.handle("genius:print", async (e, args) => {
    if (!fromTill(e)) return { ok: false, error: "refused" };
    const { html, opts } = args || {};
    const o = opts || {};
    /* With no printer named there is nothing to print to. A system print
       dialog raised from a hidden window either never appears or appears
       detached from the till, and the promise would never settle — so refuse
       plainly and let the page fall back to its own preview, which is what it
       already does with any unsuccessful answer. */
    if (!o.deviceName) {
      return { ok: false, error: "no-printer",
               message: "No printer chosen — pick one under Settings › Printing." };
    }
    const file = tempDoc(html);
    const job = paperWindow();
    try {
      await job.loadFile(file);
      await new Promise((r) => setTimeout(r, 150));            // let fonts settle
      const settings = {
        silent: o.silent !== false && !!o.deviceName,
        deviceName: o.deviceName || undefined,
        printBackground: true,
        copies: Math.max(1, Number(o.copies) || 1),
        margins: o.thermal ? { marginType: "none" } : { marginType: "default" },
      };
      /* A 58mm or 80mm roll is not a paper size Windows offers by name, so it
         goes in microns. The height is left long and the driver cuts. */
      const mm = parseInt(o.widthMm, 10);
      if (o.thermal && mm > 20 && mm < 300) settings.pageSize = { width: mm * 1000, height: 297000 };

      return await Promise.race([
        new Promise((resolve) => {
          job.webContents.print(settings, (ok, reason) =>
            resolve({ ok, error: ok ? undefined : reason }));
        }),
        new Promise((resolve) => setTimeout(() => resolve({
          ok: false, error: "timeout",
          message: "The printer did not answer. Check that it is on and has paper.",
        }), PRINT_TIMEOUT)),
      ]);
    } catch (err) {
      console.error("print failed:", err.message);
      return { ok: false, error: String(err.message || err) };
    } finally {
      if (!job.isDestroyed()) job.destroy();
      forget(file);
    }
  });

  /* The same document as a PDF, for a customer who wants it emailed. */
  ipcMain.handle("genius:pdf", async (e, args) => {
    if (!fromTill(e)) return { ok: false, error: "refused" };
    const { html, name } = args || {};
    const to = await dialog.showSaveDialog(win, {
      title: "Save as PDF",
      defaultPath: path.join(app.getPath("documents"), (name || "genius-pos") + ".pdf"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (to.canceled || !to.filePath) return { ok: false, error: "cancelled" };
    const file = tempDoc(html);
    const job = paperWindow();
    try {
      await job.loadFile(file);
      await new Promise((r) => setTimeout(r, 150));
      fs.writeFileSync(to.filePath, await job.webContents.printToPDF({ printBackground: true }));
      return { ok: true, path: to.filePath };
    } catch (err) {
      console.error("pdf failed:", err.message);
      return { ok: false, error: String(err.message || err) };
    } finally {
      if (!job.isDestroyed()) job.destroy();
      forget(file);
    }
  });

  /* Where the books actually are, for a shopkeeper who wants to copy the file. */
  ipcMain.handle("genius:data-folder", async (e) => {
    if (!fromTill(e)) return null;
    shell.showItemInFolder(DB_FILE);
    return DB_FILE;
  });

  /* ── Updates, on a screen instead of in a dialog ────────────────────────
   * The updater only ever spoke through native message boxes: a shopkeeper
   * could not find out what version they were on, what was in the new one, or
   * how far a download had got, without waiting for a box to appear. These
   * three let the app draw it. */
  ipcMain.handle("genius:update-status", async (e) => {
    if (!fromTill(e)) return null;
    return updater.status();
  });
  ipcMain.handle("genius:update-check", async (e) => {
    if (!fromTill(e)) return null;
    updater.check(false);          /* quiet: the screen is the notification */
    return updater.status();
  });
  ipcMain.handle("genius:update-install", async (e) => {
    if (!fromTill(e)) return { ok: false, why: "Not allowed" };
    return updater.install();
  });
  /* Turning the background check off. Not "never update" — the button on the
     Updates screen still works; the shop just decides when to look. It exists
     for two real situations: a metered phone connection, where a 90MB
     installer downloading silently costs money, and a shop that has settled on
     a version that works. */
  ipcMain.handle("genius:update-auto", async (e, on) => {
    if (!fromTill(e)) return { ok: false, why: "Not allowed" };
    const r = updater.setAuto(!!on);
    try { buildMenu(); } catch { /* menu is cosmetic */ }
    return r;
  });
  ipcMain.handle("genius:releases", async (e) => {
    if (!fromTill(e)) return null;
    shell.openExternal(updater.RELEASES);
    return updater.RELEASES;
  });
}

/* ------------------------------------------------------------------ *
 * the menu
 * ------------------------------------------------------------------ */
/* The one place the menu says anything about updates, so the wording and the
   updater's actual state cannot drift apart. */
function updateMenuLabel() {
  const s = updater.status();
  if (s.portable)                return "Check for a new version…";
  if (s.status === "ready")      return `Install version ${s.version}…`;
  if (s.status === "downloading")return `Downloading version ${s.version}… ${s.percent || 0}%`;
  if (s.status === "current")    return "Check for updates (up to date)";
  if (s.status === "failed")     return "Check for updates…";
  return "Check for updates…";
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "&File", submenu: [
      { label: "Open in a browser", click: () => shell.openExternal(`http://127.0.0.1:${PORT}`) },
      { label: "Show my data folder", click: () => shell.showItemInFolder(DB_FILE) },
      { label: "Show the log", click: () => shell.showItemInFolder(LOG_FILE) },
      { type: "separator" },
      { role: "quit", label: "Exit" },
    ]},
    { label: "&Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ]},
    { label: "&View", submenu: [
      { role: "reload" }, { role: "forceReload" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { role: "togglefullscreen" },
      { label: "Developer tools", accelerator: "F12", role: "toggleDevTools" },
    ]},
    { label: "&Help", submenu: [
      { label: updateMenuLabel(), click: () => updater.check(true) },
      { label: "What is new", click: () => shell.openExternal(updater.RELEASES) },
      { type: "separator" },
      { label: "About Genius POS", click: () => dialog.showMessageBox(win, {
        type: "info",
        title: "Genius POS",
        message: `Genius POS ${app.getVersion()}`,
        detail: [
          `Serving on http://127.0.0.1:${PORT}`,
          `Your books:  ${DB_FILE}`,
          `The log:     ${LOG_FILE}`,
          `Updates:     ${updateMenuLabel()}`,
          "",
          `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
          "",
          "Powered by SALJO TECH",
        ].join("\n"),
      })},
      { label: "Using Genius POS from another device", click: () => dialog.showMessageBox(win, {
        type: "info",
        title: "Use Genius POS from another device",
        message: "A phone or a second till on the same Wi-Fi can use this one.",
        detail:
          "This window serves the till on 127.0.0.1, which is this computer only.\n\n" +
          "To let other devices in, start Genius POS with GENIUS_LAN=1 set. It will " +
          "then listen on the whole network and Windows will ask you to allow it " +
          "through the firewall.\n\n" +
          "Only on the shop's own network, and change the sign-in passwords first.",
      })},
    ]},
  ]));
}

/* ------------------------------------------------------------------ *
 * shutting down without losing a sale
 *
 * The store flushes on process exit of its own accord, but Windows does not
 * guarantee that on a logoff or a shutdown. Flushing explicitly costs nothing
 * and closes the window where a sale made a moment ago is still only in
 * memory.
 * ------------------------------------------------------------------ */
function flushBooks() {
  try {
    const db = require(path.join(__dirname, "..", "backend", "database", "db.js"));
    (db.stores || []).forEach((s) => {
      try { s.flushOnExit(); } catch (e) { console.error("flush:", e.message); }
    });
  } catch { /* the server never started; nothing is open */ }
}
function shutDown() {
  if (quitting) return;
  quitting = true;
  try { server && server.close(); } catch { /* going anyway */ }
  flushBooks();
  console.log("--- stopped ---");
}

/* ------------------------------------------------------------------ *
 * one shop, one copy
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(boot).catch((e) => {
    console.error("could not start:", (e && e.stack) || e);
    dialog.showErrorBox("Genius POS could not start",
      `${(e && e.message) || e}\n\nThe log is at:\n${LOG_FILE}`);
    app.quit();
  });

  app.on("child-process-gone", (_e, d) => console.error("child process gone:", JSON.stringify(d)));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", shutDown);
  app.on("session-end", shutDown);            // Windows logoff or shutdown
}
