/**
 * printprompt.jsx — "that's saved. Print it?"
 *
 * One helper behind every transactional save in the app, so the question is
 * asked the same way and answered from one setting whatever was saved.
 *
 * ── the three rules this file exists to enforce ────────────────────────────
 *
 * 1. **It runs after the save has succeeded, never before.** The prompt is a
 *    question about a document that exists. Asking first would mean either
 *    printing something the server then refused, or holding a save open behind
 *    a dialog while the till waits.
 *
 * 2. **A print that fails must not make the save look failed.** The record is
 *    already written and the user has already been told. So `print()` is
 *    wrapped: a popup blocker, a missing printer bridge or a template throwing
 *    surfaces as its own message about printing, and the save's own toast
 *    stands.
 *
 * 3. **An explicit print instruction is not a question.** The till's
 *    "Confirm & print" already says what it wants; routing it through here
 *    would ask a shopkeeper to confirm the thing they just clicked. Those call
 *    sites keep calling `printInvoice` directly.
 *
 * The dialog is its own host rather than an option on `confirmDialog`, for two
 * reasons: `confirmDialog` resolves a bare boolean and thirty-odd call sites
 * depend on that, and this dialog has a third piece of state — the "don't ask
 * again" tick — that a boolean cannot carry. Per §5 of the design review this
 * is a decision, so a dialog is the right home for it; a document would be a
 * full screen.
 */
import React from "react";
import api from "./api.js";
import { printSetting, savePrintSetting, printInvoice, printVoucher } from "./print.js";
import { toast } from "./ui.jsx";
import { cur, inr } from "./tax.js";

let pushPrompt = null;

/**
 * Offer to print a document that has just been saved.
 *
 * @param {object}   o
 * @param {string}   o.noun     what comes out — "receipt", "invoice", "voucher"
 * @param {string}   o.number   the document number, e.g. "INV-000012"
 * @param {string}  [o.detail]  a second line: party, amount, whatever names it
 * @param {Function} o.print    async () => void — fetches and prints
 *
 * Resolves when the question is settled. Never rejects: a printing failure is
 * reported to the user and swallowed here, because the caller's next line is
 * usually "close the form and reload the list" and that must still happen.
 */
export async function askToPrint({ noun = "document", number = "", detail = "", print }) {
  if (typeof print !== "function") return;

  let mode = "ask";
  try { mode = (await printSetting("print_after_save", "ask")) || "ask"; }
  catch { mode = "ask"; }   /* settings unreachable → ask, never print blind */

  if (mode === "never") return;
  if (mode !== "always") {
    const answer = await new Promise((resolve) => {
      if (!pushPrompt) return resolve({ print: false, remember: false });
      pushPrompt({ noun, number, detail, resolve });
    });
    if (answer.remember) {
      /* Remembering is a setting change, and a setting change that silently
         fails would have the shopkeeper believe they had turned the prompt off
         while it kept appearing. */
      try { await savePrintSetting("print_after_save", answer.print ? "always" : "never"); }
      catch { toast("Couldn't save that preference — the prompt will appear again", "warn"); }
    }
    if (!answer.print) return;
  }

  try { await print(); }
  catch (e) {
    /* Rule 2. The save stands; only the printing failed, and the message says
       so rather than implying the document was lost. */
    toast(`${cap(noun)} saved, but printing failed${e && e.message ? ` — ${e.message}` : ""}`, "warn");
  }
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* Mounted once beside ConfirmHost. Same pattern, same lifecycle. */
export function PrintPromptHost() {
  const [d, setD] = React.useState(null);
  const [remember, setRemember] = React.useState(false);

  React.useEffect(() => { pushPrompt = setD; return () => { pushPrompt = null; }; }, []);
  /* A fresh dialog must never inherit the last one's tick. */
  React.useEffect(() => { if (d) setRemember(false); }, [d]);

  const done = React.useCallback((print) => {
    /* Not named `cur` — that is the currency helper imported above, and
       shadowing it here would be a live grenade for the next edit. */
    setD((prev) => { if (prev) prev.resolve({ print, remember }); return null; });
  }, [remember]);

  React.useEffect(() => {
    if (!d) return;
    const h = (e) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      /* Both stopped, not just defaulted. Pages bind their own window-level
         Escape — Create Invoice closes on it (C2.3) and the till runs a
         barcode burst reader on keydown — and a key answering this dialog must
         not also reach them. Without this, one Escape both declines the print
         and closes the panel underneath. */
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      done(e.key === "Enter");
    };
    /* Capture, because the till binds its own window-level key handlers for the
       barcode burst reader and F-keys — the same reason Escape had to be taken
       explicitly for Create Invoice (C2.3). A dialog that is open owns the
       keyboard. */
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [d, done]);

  if (!d) return null;

  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="cf-box" role="alertdialog" aria-modal="true" aria-labelledby="pp-title">
        <div className="cf-icon">🖨</div>
        <h3 id="pp-title">Print {d.noun}{d.number ? ` ${d.number}` : ""}?</h3>
        {d.detail && <p>{d.detail}</p>}

        <label className="pp-remember">
          <input type="checkbox" checked={remember}
                 onChange={(e) => setRemember(e.target.checked)} />
          {/* Stated as what it will do, not as "don't ask again" — the same
              choice means "always print" or "never print" depending on which
              button is pressed next, and the shopkeeper should be able to read
              that off the screen rather than infer it. */}
          <span>Remember my answer and stop asking</span>
        </label>

        <div className="cf-actions">
          <button className="btn btn-ghost" onClick={() => done(false)}>Don't print</button>
          <button className="btn btn-primary" onClick={() => done(true)} autoFocus>Print</button>
        </div>

        {remember && (
          <div className="pp-note" role="status">
            You can change this any time in Settings → Print.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── the two shapes every call site reduces to ─────────────────────────────
 *
 * Fourteen save handlers wire into this file. If each one assembled its own
 * document, fetched its own detail row and picked its own wording, they would
 * drift the way the nineteen row menus in twelve files drifted before §1 of the
 * review. So there are exactly two entry points, and a call site is one line.
 */

/**
 * A document with priced lines — sale, invoice, purchase, credit note,
 * debit note, challan, estimate.
 *
 * The document is fetched fresh rather than printed from what the form had in
 * hand. The server is what numbered it, what rounded it and what applied the
 * tax rules, and printing the client's copy would put a figure on paper that
 * the books do not hold. That divergence is exactly the class of bug round nine
 * found when a screen showed two invoices while the ledger held six.
 */
export function offerDocPrint({ path, noun, number, party, detail, context = "invoice", docTitle }) {
  return askToPrint({
    noun, number, detail,
    print: async () => {
      const full = await api.get(path);
      await printInvoice(full, party || full.party_name || "—", context, { docTitle });
    },
  });
}

/**
 * A money document with one amount — payment in or out, expense, other income.
 *
 * These have no server-side detail endpoint worth a second round trip; the
 * amount and the party are what the form just submitted and what the server
 * acknowledged, so the voucher is built here.
 */
export function offerVoucherPrint({ noun = "voucher", title, number, party, direction, amount,
                                    rows, note, detail, applied, format }) {
  return askToPrint({
    noun, number,
    detail: detail ?? `${cur()} ${inr(amount)}${party ? ` · ${party}` : ""}`,
    /* `applied` is which bills the money settled; `format` lets a caller ask
       for a slip or a page rather than following the shop's printer. Both are
       passed straight through — this function's job is the question, not the
       document. */
    print: () => printVoucher({ title, number, party, direction, amount, rows, note, applied, format }),
  });
}
