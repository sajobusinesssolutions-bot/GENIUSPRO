import React from "react";
import ReactDOM from "react-dom";
import { Icon } from "./icons.jsx";
import { inr, cur } from "./tax.js";

/* ── DocShell — one full-screen shell for every document editor ─────────────
   A purchase, a purchase order, a debit or credit note, an estimate, a challan
   and an expense are all the same shape of thing: a header of who/when/which
   number, a body of lines that can be any length at all, and a total that
   decides whether the document is right. They were all being drawn as centred
   dialogs.

   That failed in a way somebody photographed: `.modal-full` is forced to
   `height: 100vh` (styles.css:931) inside a `.modal-backdrop` that carries
   40px of padding (deck.css:2885), so the dialog was 80px taller than the
   space it was centred in. The bottom 40px — which is exactly where the Total
   row and the Save button sit — was drawn below the bottom edge of the screen,
   with no scrollbar anywhere able to reach it, because the overflow belonged
   to the backdrop rather than to the dialog. You could fill the form in and
   never see what you were about to commit.

   So the shell owns the geometry itself and never relies on being centred:

     · the whole thing is `position: fixed; inset: 0` — its height is the
       viewport's height by construction, so there is nothing to overflow;
     · it is a three-row grid, and only the middle row scrolls. A fifty-line
       bill lengthens the scrollport, not the shell, so the action bar cannot
       be pushed anywhere;
     · the total lives in the footer row, which is a sibling of the scrollport
       rather than the last thing inside it. That is the difference between "on
       screen once you scroll" and "on screen".

   One shell, six documents. The alternative — a full-screen variant per page —
   is six chances for one of them to drift back into a dialog, and this
   codebase has already been bitten by that kind of near-duplicate.

   Props:
     title      what the document is        ("Record purchase")
     docNo      its number, or how one is going to be allocated ("Auto: PUR-…")
     meta       one short line of context under the title (optional)
     onClose    close/back — never wired to a backdrop click, see below
     onSave     the primary action, in the header AND in the footer
     saveLabel  text for it (carry the total in it, as the old forms did)
     busy       disables both save buttons and says "Saving…"
     summary    [{ label, value, tone }] — the running breakdown in the footer
     total      { label, value } — the one figure the shopkeeper checks
     actions    extra header controls, to the left of Save
     footNote   a sentence under the summary, for anything that needs saying */

/**
 * `fill` — the body stops being the scrollport and becomes a plain flex column,
 * so a child can own the scrolling instead.
 *
 * Every document editor so far is a form that grows downward, and scrolling the
 * whole sheet is right for those. Bulk update is not one: it is a toolbar over
 * a table of every item in the shop. If the sheet scrolls, the search box —
 * the only way to find the row you came to edit — scrolls off the top, and the
 * fix people reach for is to pin it, which §5 of the design review rules out
 * because a pinned bar always covers something.
 *
 * With `fill`, the toolbar simply never moves, because nothing around it
 * overflows: the table scrolls inside itself and its own headings stay put,
 * which is the one sticky the review calls legitimate.
 */
export function DocShell({
  title, docNo, meta, onClose, onSave, saveLabel = "Save", busy = false,
  summary = [], total, actions = null, footNote = null, fill = false, children,
}) {
  const bodyRef = React.useRef(null);
  const restoreTo = React.useRef(null);

  React.useEffect(() => {
    restoreTo.current = document.activeElement;
    return () => restoreTo.current?.focus?.();
  }, []);

  /* Escape leaves the editor, matching every other overlay in the app — but
     only when nothing is stacked on top of it. A combo dropdown, a picker
     modal or a confirm dialog takes the key first, so Escape backs out one
     layer at a time instead of throwing away a half-typed document. The combos
     stop propagation themselves (lib/ui.jsx:705); the layers that cannot are
     named here. */
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".modal-backdrop, .dk-sheet-veil, .cf-backdrop")) return;
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* The page behind must not scroll while this is up. Without it a wheel over
     the header scrolls the list underneath, which reads as the editor moving. */
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return ReactDOM.createPortal(
    /* No dismiss-on-backdrop, and no backdrop: this is a screen, not a dialog.
       Losing a part-built document to a stray click is worse than one extra
       click to leave. */
    <div className="doc-fs" role="dialog" aria-modal="true"
         aria-label={typeof title === "string" ? title : undefined}>
      <header className="doc-fs-head">
        {/* Header, body and footer each carry their own `.doc-fs-col`, and all
            three are the same width with the same margins. Before this only the
            body was constrained: the sheet was a centred 1180px column while the
            title bar and the footer's totals ran the full width of the window,
            so on a wide screen the document number sat hundreds of pixels left
            of the first field under it and the grand total sat right of the
            line it was totalling. Nothing lined up with anything, which somebody
            photographed. */}
        <div className="doc-fs-col">
        <button className="doc-fs-back" onClick={onClose} aria-label={`Close ${typeof title === "string" ? title : "editor"}`}>
          <Icon n="close" size={15} />
        </button>
        <div className="doc-fs-titles">
          <h2>{title}</h2>
          <div className="doc-fs-sub">
            {docNo ? <span className="doc-fs-no dk-n">{docNo}</span> : null}
            {meta ? <span className="doc-fs-meta">{meta}</span> : null}
          </div>
        </div>
        <div className="doc-fs-spacer" />
        {actions}
        <button className="btn btn-primary doc-fs-save" onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : saveLabel}
        </button>
        </div>
      </header>

      <div className={`doc-fs-body ${fill ? "is-fill" : ""}`} ref={bodyRef}>
        <div className={`doc-fs-sheet doc-fs-col ${fill ? "is-fill" : ""}`}>{children}</div>
      </div>

      <footer className="doc-fs-foot">
        <div className="doc-fs-col">
        <div className="doc-fs-sums">
          {summary.filter(Boolean).map((s, i) => (
            <span key={i} className="doc-fs-sum">
              <span className="l">{s.label}</span>
              <span className={`v dk-n ${s.tone || ""}`}>{s.value}</span>
            </span>
          ))}
          {footNote ? <span className="doc-fs-note">{footNote}</span> : null}
        </div>
        {total && (
          <div className="doc-fs-grand">
            <span className="l">{total.label || "Total"}</span>
            <span className="v dk-n">{total.value}</span>
          </div>
        )}
        <div className="doc-fs-acts">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : saveLabel}
          </button>
        </div>
        </div>
      </footer>
    </div>,
    document.body
  );
}

/* A titled block inside the sheet. Every document uses the same one so the
   rhythm of the six editors is identical. */
export function DocSection({ title, hint, children, wide }) {
  return (
    <section className={`doc-sec ${wide ? "wide" : ""}`}>
      {title ? <div className="doc-sec-h">{title}</div> : null}
      {children}
      {hint ? <div className="doc-sec-hint">{hint}</div> : null}
    </section>
  );
}

/* The two-column top of a document: who it is with, and its particulars. */
export function DocTop({ children }) { return <div className="doc-top">{children}</div>; }

/* Who the document is with, read back after they are picked. Two suppliers
   spelt alike are one wrong pick apart, and the balance line is the cheapest
   way to notice: "nothing outstanding" under a name you have been paying all
   month means you have chosen the wrong one. */
export function DocParty({ party, emptyHint }) {
  if (!party) return <div className="doc-party is-empty">{emptyHint}</div>;
  const bal = Number(party.balance) || 0;
  return (
    <div className="doc-party">
      <div className="doc-party-name">{party.name}</div>
      <div className="doc-party-meta">
        {[party.party_no, party.billing_address, party.phone].filter(Boolean).join(" · ") || "No address on file"}
      </div>
      <div className="doc-party-foot">
        <span className="doc-fs-meta">{party.gstin ? `Tax no. ${party.gstin}` : "No tax number"}</span>
        <span className={`dk-n ${bal > 0 ? "amt-owed" : bal < 0 ? "amt-received" : "amt-zero"}`}>
          {bal ? `${cur()} ${inr(Math.abs(bal))} ${bal > 0 ? "due" : "in advance"}` : "Nothing outstanding"}
        </span>
      </div>
    </div>
  );
}

/* The breakdown, in the body, beside the lines it comes from. The footer
   repeats the grand total and nothing else — this is where somebody checks
   that the tax and the discount are the ones they expected. */
/* `taxActive` says whether tax is switched on for this document, which is not
   the same question as whether the tax happens to be zero. Estimates, credit
   notes and purchases all pass it down from useTaxRules(); it defaults false so
   a caller that forgets shows no tax rather than a permanent "Tax 0". */
export function DocTotals({ calc, note, taxActive = false }) {
  return (
    <div className="zoho-totals doc-totals">
      <div className="totals-box">
        <div className="totals-row"><span className="lbl">Sub total</span><span className="num">{cur()} {inr(calc.gross_total)}</span></div>
        {calc.discount_total > 0 && (
          <div className="totals-row"><span className="lbl">Discount</span><span className="num amt-paid">−{cur()} {inr(calc.discount_total)}</span></div>
        )}
        {taxActive && (
          <div className="totals-row"><span className="lbl">Tax</span>
            <span className={`num ${calc.tax_total < 0 ? "amt-reversal" : ""}`}>
              {calc.tax_total < 0 ? "−" : "+"}{cur()} {inr(Math.abs(calc.tax_total))}
            </span></div>
        )}
        {calc.round_off !== 0 && (
          <div className="totals-row"><span className="lbl">Round off</span><span className="num">{cur()} {inr(calc.round_off)}</span></div>
        )}
        <div className="totals-row grand"><span>Total</span><span className="num">{cur()} {inr(calc.grand_total)}</span></div>
        {note ? <div className="doc-totals-note">{note}</div> : null}
      </div>
    </div>
  );
}

/* Everything the footer needs, worked out once: the same figures, in the same
   order, under all six documents. */
export function docSummary(calc, taxActive = false) {
  return [
    { label: "Sub total", value: `${cur()} ${inr(calc.gross_total)}` },
    calc.discount_total > 0 ? { label: "Discount", value: `−${cur()} ${inr(calc.discount_total)}`, tone: "amt-paid" } : null,
    taxActive ? { label: "Tax", value: `${calc.tax_total < 0 ? "−" : "+"}${cur()} ${inr(Math.abs(calc.tax_total))}` } : null,
  ].filter(Boolean);
}

/* A responsive grid of Fields. Collapses to one column rather than letting a
   date input dictate the track width. */
export function DocFields({ children, cols }) {
  return <div className={`doc-fields ${cols === 3 ? "c3" : ""}`}>{children}</div>;
}
