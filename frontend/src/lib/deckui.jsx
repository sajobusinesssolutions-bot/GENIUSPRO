/* ── Deck table chrome ─────────────────────────────────────────────────────
   The document screens — Sales, Purchases — are the same shape in the deck:
   a title, quick filters, one search box, one date range, a table, and a
   pager pinned to the foot of the card. Shared from here so the two cannot
   drift apart, and so a third document screen costs a table and nothing else.
*/
import React from "react";
import ReactDOM from "react-dom";
import { inr, cur } from "./tax.js";
import { DateRangePicker, StateBlock } from "./ui.jsx";

export const money = (v) => `${cur()} ${inr(v)}`;

/* Status → pill tone. Anything unrecognised falls through to the neutral pill
   rather than being coloured by guesswork. */
export const STATUS_TONE = {
  paid: "good", settled: "good", converted: "good", delivered: "good", invoiced: "good",
  partial: "warn", open: "warn", pending: "warn",
  unpaid: "bad", overdue: "bad", cancelled: "bad",
  voided: "", draft: "",
};


/* ── Shared chrome: title, filter segment, search, date range, pager ────── */
export function TableCard({ title, createLabel, onCreate, canCreate, filters, filter, onFilter,
                    q, onQ, searchHint, range, onRange, children, showing, page, pages, onPage }) {
  return (
    <div className="dk-card dk-tablecard">
      <div className="dk-tablehead" style={{ position: "relative" }}>
        <h3>{title}</h3>
        {filters && (
          <div className="dk-seg2">
            {filters.map(([id, label]) => (
              <button key={id} className={filter === id ? "on" : ""} onClick={() => onFilter(id)}>{label}</button>
            ))}
          </div>
        )}
        <div className="spacer" />
        <input className="dk-input search" placeholder={searchHint} value={q} onChange={(e) => onQ(e.target.value)} />
        {/* The one date filter. This was the last two-bare-<input type="date">
            control in the app, and it is what the four busiest document
            screens render — leaving it meant the standard was not actually
            applied anywhere it mattered. The {from,to} prop shape is
            identical, so the pages need no change; they gain presets, a
            month list and a proper calendar. */}
        {range && (
          <DateRangePicker from={range.from} to={range.to}
                           onChange={(r) => onRange(r)}
                           className="drp-compact" />
        )}
        {canCreate && <button className="dk-create" style={{ height: 38 }} onClick={onCreate}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
          {createLabel}
        </button>}
      </div>

      <div className="dk-tablewrap dk-s">{children}</div>

      <div className="dk-pagefoot">
        <span className="count">{showing}</span>
        {pages > 1 && (
          <div className="nav">
            <button className="dk-pgbtn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
            <span className="of">Page {page} of {pages}</span>
            <button className="dk-pgbtn" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Pill({ status }) {
  return <span className={`dk-tpill ${STATUS_TONE[status] ?? ""}`}>{status}</span>;
}

/* Rows the list has not loaded yet, drawn at the right height so the table
   does not jump when they arrive. */
export function LoadingRows({ cols, n = 6 }) {
  return Array.from({ length: n }, (_, i) => (
    <tr key={i}>{Array.from({ length: cols }, (_, c) => (
      <td key={c}><span style={{ display: "block", height: 11, borderRadius: 4, background: "var(--sunk)" }} /></td>
    ))}</tr>
  ));
}


/* ── Failed reads ───────────────────────────────────────────────────────────
   A read that fails must not be drawn as a read that returned nothing. The
   old shape — `.catch(() => setRows([]))` — makes a dropped request
   indistinguishable from an empty ledger, so a shopkeeper on a flaky line is
   told "No invoices yet" about books that are full. Everything below exists
   so that the third state, "we could not load this", is as cheap to render
   as the other two and is worded the same way on every screen.

   `useRead` tracks the flag; `LoadFailed` / `FailedRows` draw it; `figure`
   refuses to print a money total that came out of a failed read. */

export function useRead() {
  const [failed, setFailed] = React.useState(false);
  /* read(promise, apply, blank) — on success clear the flag and apply the
     data; on failure raise the flag and only then fall back to `blank`, so
     the caller's render can tell the two apart. */
  const read = React.useCallback((p, apply, blank) => p
    .then((d) => { setFailed(false); apply(d); })
    .catch(() => { setFailed(true); if (blank !== undefined) apply(blank); }), []);
  return [failed, read, setFailed];
}

/* The one wording. "Could not load X" plus a retry — never a claim about the
   business. */
export function LoadFailed({ what = "this", onRetry, compact }) {
  return (
    <StateBlock
      error
      title={`Could not load ${what}`}
      sub={compact ? undefined : "The request did not reach the server, so nothing here is a statement about your business. Check the connection and try again."}
      actions={onRetry && <button className="dk-sbtn primary" onClick={onRetry}>Try again</button>}
    />
  );
}

/* Same thing inside a table body, where an empty <tbody> would read as "no
   rows". */
export function FailedRows({ cols, what, onRetry }) {
  return (
    <tr><td colSpan={cols} style={{ padding: 0 }}><LoadFailed what={what} onRetry={onRetry} /></td></tr>
  );
}

/* A number that came out of a failed read is not zero, it is unknown. Print
   an em dash instead — a zero looks like a fact. */
export const figure = (failed, text) => (failed ? "—" : text);

/* ── PageDock ──────────────────────────────────────────────────────────────
   Puts a slim bar of page-level actions — Save, Discard — at the foot of the
   window, below the scrolling content rather than on top of it.

   Why not simply pin the section header, which is where these buttons used to
   live? Because a pinned header covers whatever is scrolling underneath it,
   and a shopkeeper reading half a dropdown cannot scroll the header out of the
   way: it moves with them. Docking the buttons outside the scrollport removes
   the overlap entirely instead of trading one obscured control for another.

   The bar only exists while there is something to save, so a page at rest
   gives up no height to it. */
export function PageDock({ children, show = true }) {
  const [host, setHost] = React.useState(null);
  /* The slot lives in App's shell, which has always mounted by the time a page
     renders — but a lazily-loaded page can render before a paint, so look it
     up in an effect rather than during render. */
  React.useEffect(() => { setHost(document.getElementById("dk-dock")); }, []);
  if (!host || !show) return null;
  return ReactDOM.createPortal(<div className="dk-dockbar">{children}</div>, host);
}
