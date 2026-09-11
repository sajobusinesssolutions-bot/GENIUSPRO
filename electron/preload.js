/**
 * electron/preload.js — the bridge that makes a "default printer" setting
 * possible at all.
 *
 * A web page cannot list printers or choose one: window.print() always hands
 * over to the browser's own dialog and JavaScript is not allowed to influence
 * it. That is a browser security rule, not something the app can work around.
 * Inside the desktop shell we have Electron's print API, so here the setting
 * becomes real — pick a printer once and receipts go straight to it.
 *
 * The app checks for window.geniusPrint and falls back to the browser dialog when
 * it isn't there, so the same build runs in both places.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("geniusPrint", {
  available: true,

  /** @returns {Promise<{name:string, displayName:string, isDefault:boolean}[]>} */
  listPrinters: () => ipcRenderer.invoke("genius:list-printers"),

  /**
   * Print an HTML document straight to a named printer.
   * @param {string} html
   * @param {{deviceName?:string, silent?:boolean, copies?:number, thermal?:boolean,
   *          widthMm?:number}} opts   widthMm is the roll: 58 or 80
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  print: (html, opts) => ipcRenderer.invoke("genius:print", { html, opts: opts || {} }),

  /**
   * The same document written to a PDF the shopkeeper chooses a place for.
   * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
   */
  savePdf: (html, name) => ipcRenderer.invoke("genius:pdf", { html, name }),

  /** Opens Explorer on the database file, for a manual copy. */
  showDataFolder: () => ipcRenderer.invoke("genius:data-folder"),
});

/**
 * Updates, for the app's own update screen.
 *
 * The updater used to speak only in native message boxes, which meant a
 * shopkeeper could not answer "what version am I on", "what changed" or "how
 * far has it got" without waiting for a box to appear on its own schedule.
 * The screen asks these instead.
 */
contextBridge.exposeInMainWorld("geniusUpdate", {
  available: true,
  /** {status, version, current, percent, notes, portable, updatable, why} */
  status: () => ipcRenderer.invoke("genius:update-status"),
  /** Look now. Returns immediately; poll `status()` for the answer. */
  check: () => ipcRenderer.invoke("genius:update-check"),
  /** Install what has been downloaded. Quits the till and comes back. */
  install: () => ipcRenderer.invoke("genius:update-install"),
  /** The releases page, in the shopkeeper's browser. */
  releases: () => ipcRenderer.invoke("genius:releases"),
  /** Turn the background check on or off. The manual check always works. */
  setAuto: (on) => ipcRenderer.invoke("genius:update-auto", !!on),
});
