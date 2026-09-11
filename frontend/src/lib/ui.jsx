// ui.jsx — shared "pro" primitives (blueprint §6.5)
import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom";
import { inr, cur, dualQty } from "./tax.js";
import api, { currentUser, onConnection, reportReachable } from "./api.js";
import { Icon } from "./icons.jsx";

/**
 * useActiveUsers — the firm's active staff, loaded once and shared.
 * Used by the sales-rep picker on every transaction screen.
 */
export function useActiveUsers() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    // /users/reps is readable by any signed-in user; /users needs users.view
    api.get("/users/reps").then((list) => setUsers(list || []))
      .catch(() => setUsers([]));
  }, []);
  return users;
}

/**
 * SalesRepPicker — choose which staff member a sale/purchase is credited to.
 *
 * Defaults to the logged-in user, but a cashier can attribute the sale to the
 * waiter or floor staff who actually made it. `required` (driven by the
 * require_sales_rep setting) shows the asterisk and lets the parent block save.
 * Value is the user id as a string, "" when unset.
 */
export function SalesRepPicker({ value, onChange, users, required, label = "Sales rep" }) {
  const list = users && users.length ? users : [];
  return (
    <Field label={required ? `${label} *` : label}>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}
              className={required && !value ? "needs-value" : ""}>
        <option value="">{required ? "— choose a rep —" : "— none —"}</option>
        {list.map((u) => (
          <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
        ))}
      </select>
    </Field>
  );
}

const TONE = {
  paid: "ok", active: "ok", cleared: "ok",
  partial: "warn", pending: "warn", unpaid: "bad", overdue: "bad", cancelled: "muted",
};
export function StatusPill({ status }) {
  const tone = TONE[String(status || "").toLowerCase()] || "info";
  return <span className={`pill pill-${tone}`}>{status}</span>;
}

export function Money({ value, className = "" }) {
  return <span className={`money ${className}`}>{cur()} {inr(value)}</span>;
}

export function SkeletonRows({ rows = 6, cols = 4 }) {
  return [...Array(rows)].map((_, i) => (
    <tr key={i}>
      {[...Array(cols)].map((__, j) => (
        <td key={j}><span className="sk" /></td>
      ))}
    </tr>
  ));
}

export function Modal({ title, onClose, children, wide, full, dismissible = false }) {
  const box = React.useRef(null);
  const restoreTo = React.useRef(null);

  React.useEffect(() => {
    restoreTo.current = document.activeElement;
    // focus the first sensible control so keyboard users start inside the dialog
    const first = box.current?.querySelector(
      "input:not([type=hidden]):not([disabled]), select, textarea, button:not(.icon-btn)"
    );
    (first || box.current)?.focus?.();

    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== "Tab" || !box.current) return;
      // keep Tab inside the dialog
      const f = [...box.current.querySelectorAll(
        'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const firstEl = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreTo.current?.focus?.();   // hand focus back where it came from
    };
  }, [onClose]);

  /* Portalled to <body>. Rendered in place, the backdrop sat inside .content —
     whose `animation: rise ... both` keeps a transform applied, and a
     transformed ancestor becomes the containing block for position:fixed. The
     result was a dim that stopped at the sidebar and a dialog centred on the
     content area rather than the screen. */
  return ReactDOM.createPortal(
    <div
      className="modal-backdrop"
      /* Clicking away no longer discards. Losing a half-typed customer to a
         stray click is a far worse outcome than one extra click to leave. */
      onMouseDown={(e) => { if (e.target === e.currentTarget && dismissible) onClose?.(); }}
    >
      <div ref={box} className={`modal ${full ? "modal-full" : wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true"
           aria-label={typeof title === "string" ? title : undefined} tabIndex={-1}>
        {/* A titleless dialog rendered an empty header bar, which read as a
            large dead band above the content. Drop the bar and float the close
            control instead. */}
        {title ? (
          <div className="modal-head">
            <h3>{title}</h3>
            <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><Icon n="close" size={15} /></button>
          </div>
        ) : (
          <button className="icon-btn modal-x" onClick={onClose} aria-label="Close dialog">
            <Icon n="close" size={15} />
          </button>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export function Field({ label, children, half }) {
  return (
    <label className={`field ${half ? "field-half" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ icon = "○", title, hint, sub, text, error, actions }) {
  /* `sub` and `hint` both appear at call sites; accept either so explanatory
     text is never silently dropped. */
  const detail = hint ?? sub ?? text;
  /* Some call sites give only the explanatory line and no heading. Show it as
     the heading rather than rendering an empty state with no words in it. */
  return <StateBlock icon={icon} title={title || detail} sub={title ? detail : undefined}
                     error={error} actions={actions} />;
}

/* ── Toasts: non-blocking feedback instead of alert() ── */
let pushToast = null;
/* The same sentence twice, stacked, is the app shouting. It happens on a real
   path: a dropped connection is announced once by the api layer (which knows
   the outage) and once by the form's own `catch (e) { toast(e.message) }`,
   because neither can see the other. Rather than teach every caller to check,
   an identical message inside a couple of seconds is treated as the one event
   it is. Different messages are never merged. */
let lastToast = { message: "", at: 0 };
export function toast(message, tone = "ok") {
  const now = Date.now();
  if (message && message === lastToast.message && now - lastToast.at < 2500) return;
  lastToast = { message, at: now };
  if (pushToast) pushToast({ message, tone, id: now + Math.random() });
}
export function ToastHost() {
  const [list, setList] = React.useState([]);
  React.useEffect(() => {
    pushToast = (t) => {
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.ttl || 3200);
    };
    return () => { pushToast = null; };
  }, []);
  /* The deck's toast: one dark pill centred at the foot of the window with a
     tick in the accent of its tone. Undo is not in the deck but is a shipped
     affordance, so it rides inside the same pill. */
  return (
    <div className="dk-toast-host">
      {list.map((t) => (
        <div key={t.id} className={`dk-toast ${t.tone === "bad" ? "bad" : t.tone === "warn" ? "warn" : ""}`}
             role="status" aria-live="polite">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#4ADE80"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {t.tone === "bad"
              ? <><path d="M12 8v5" /><path d="M12 16h.01" /><path d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z" /></>
              : <path d="M20 6L9 17l-5-5" />}
          </svg>
          <span>{t.message}</span>
          {t.undo && (
            <button className="toast-undo" onClick={() => { t.undo(); setList((l) => l.filter((x) => x.id !== t.id)); }}>
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── action sheet ──────────────────────────────────────────────────────────
   The deck's confirm-before-you-commit dialog. Where confirmDialog() asks a
   yes/no question in prose, a sheet reads back exactly what is about to
   happen — the fields, or the rows, or both — before it will commit.

     await sheet({
       kicker: "Payment", title: "Record USh 240,000",
       sub: "Against INV-000148 — Okello James",
       fields: [{ label: "Method", value: "Cash" }, { label: "Date", value: "29 Jul" }],
       list:   [["INV-000148", "28 Jul", "USh 240,000", "good"]],
       note:   "The balance moves to the customer's account.",
       primary: "Record payment",
     });

   Resolves true on confirm, false on cancel or Escape. */
let pushSheet = null;
export function sheet(opts) {
  return new Promise((resolve) => {
    if (!pushSheet) return resolve(false);
    pushSheet({ ...opts, resolve });
  });
}

export function SheetHost() {
  const [d, setD] = React.useState(null);
  React.useEffect(() => { pushSheet = setD; return () => { pushSheet = null; }; }, []);
  const done = React.useCallback((v) => { setD((cur) => { if (cur) cur.resolve(v); return null; }); }, []);
  React.useEffect(() => {
    if (!d) return;
    const h = (e) => { if (e.key === "Escape") done(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [d, done]);
  if (!d) return null;

  const fields = d.fields || [];
  const rows = d.list || [];
  const wide = fields.length > 0 || rows.length > 0;
  const dot = (tone) => tone === "good" ? "var(--good)" : tone === "bad" ? "var(--danger)"
    : tone === "warn" ? "var(--warnc)" : "var(--accent)";
  const val = (tone) => tone === "bad" ? "var(--danger)" : tone === "good" ? "var(--good)" : "var(--ink)";

  return (
    <div className="dk-sheet-veil" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className={`dk-sheet ${wide ? "wide" : ""} ${d.danger ? "danger" : ""}`} role="dialog" aria-modal="true">
        <div className="dk-sheet-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dk-sheet-kicker">{d.kicker || "Action"}</div>
            <h2>{d.title || ""}</h2>
            {d.sub && <div className="dk-sheet-sub">{d.sub}</div>}
          </div>
          <button className="dk-sheet-x" onClick={() => done(false)} aria-label="Close">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12" /><path d="M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="dk-sheet-body dk-s">
          {fields.length > 0 && (
            <div className="dk-sheet-fields">
              {fields.map((f, i) => (
                <label key={i} className={`dk-sheet-field ${f.full ? "full" : ""}`}>
                  <span>{f.label}</span>
                  <div className={f.num ? "dk-n" : ""}
                       style={{ color: f.muted ? "var(--faint)" : "var(--ink)", fontWeight: f.muted ? 600 : 650 }}>
                    {f.value == null || f.value === "" ? "—" : f.value}
                  </div>
                </label>
              ))}
            </div>
          )}

          {rows.length > 0 && (
            <div className="dk-sheet-list">
              {rows.map((r, i) => (
                <div key={i} className="dk-sheet-row">
                  <span className="dk-sheet-dot" style={{ background: dot(r[3]) }} />
                  <span className="nm">{r[0]}</span>
                  <span className="mt">{r[1]}</span>
                  <span className="vl dk-n" style={{ color: val(r[3]) }}>{r[2]}</span>
                </div>
              ))}
            </div>
          )}

          {d.note && (
            <div className="dk-sheet-note">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z" /><path d="M12 8h.01" /><path d="M12 12v4" />
              </svg>
              <span>{d.note}</span>
            </div>
          )}
        </div>

        <div className="dk-sheet-foot">
          <span className="note">{d.danger ? "This cannot be undone" : "Nothing is saved until you confirm"}</span>
          <button className="dk-sheet-cancel" onClick={() => done(false)}>{d.cancel || "Cancel"}</button>
          <button className="dk-sheet-go" onClick={() => done(true)} autoFocus>{d.primary || "Continue"}</button>
        </div>
      </div>
    </div>
  );
}

/* ── the ⋮ row menu ──────────────────────────────────────────────────────
   Kept as a name because a dozen screens import it. The implementation now
   lives in lib/rowmenu.jsx, which is also what the six hand-rolled
   `.dk-rowmenu` panels on Items, Sales and Purchases were replaced with — so
   there is exactly one row menu in the app instead of two that diverged. */
export { RowMenu } from "./rowmenu.jsx";


/* Submit button that disables itself while its handler is running.
   Prevents duplicate documents/payments from an impatient double-click. */
export function SubmitButton({ onClick, children, className = "btn btn-primary", busyLabel = "Working…", disabled, ...rest }) {
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  const handle = async (e) => {
    if (busy) return;
    setBusy(true);
    try { await onClick?.(e); } finally { if (alive.current) setBusy(false); }
  };
  return (
    <button {...rest} className={className} onClick={handle} disabled={busy || disabled}>
      {busy ? busyLabel : children}
    </button>
  );
}


/* Keeps one bad render from blanking the whole app mid-sale. */
export class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    console.error("UI error:", err, info);
    /* The root boundary passes a reporter, so a crash reaches the server log
       rather than only a console nobody has open. */
    try { this.props.onError && this.props.onError(err, info); } catch { /* never twice */ }
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 28, maxWidth: 620, margin: "40px auto", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>⚠</div>
        <h2 style={{ marginBottom: 6 }}>This screen ran into a problem</h2>
        <p style={{ color: "var(--muted)", fontSize: 13.5 }}>
          Nothing was lost — your saved sales, stock and settings are safe.
          Reload this screen to carry on.
        </p>
        <pre style={{ textAlign: "left", background: "var(--muted-bg)", padding: 10, borderRadius: 8, fontSize: 11.5, overflow: "auto", maxHeight: 220, margin: "14px 0", whiteSpace: "pre-wrap" }}>
          {String((this.state.err && this.state.err.message) || this.state.err)}
          {this.state.err && this.state.err.stack
            ? "\n\n" + String(this.state.err.stack).split("\n").slice(0, 8).join("\n")
            : ""}
        </pre>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button className="btn btn-primary" onClick={() => this.setState({ err: null })}>Try again</button>
          <button className="btn btn-ghost" onClick={() => window.location.reload()}>Reload app</button>
        </div>
      </div>
    );
  }
}

/* Shows a banner when the server can't be reached (shop Wi-Fi drops, laptop sleeps).
 *
 * Three things this has to get right, none of which a bare ten-second poll did:
 *
 *  - Notice at once. A failed save is the first anyone knows the line is down,
 *    and its toast is gone in three seconds. api.js reports every failed and
 *    every successful request here, so the banner is up before the toast has
 *    faded and stays up for as long as the outage lasts.
 *  - Recover without a reload. While down it probes every two seconds instead
 *    of every ten, so coming back is seconds, not a coffee break — and it says
 *    "back" rather than just vanishing, because the cashier has a half-saved
 *    sale on screen and needs to be told to press the button again.
 *  - Never lie. The probe result feeds back into api.js, so one component's
 *    view of the connection is the whole app's.
 */
export function ConnectionWatcher() {
  const [down, setDown] = useState(false);
  const [back, setBack] = useState(false);   // brief "connection is back" note
  const wasDown = React.useRef(false);

  /* api.js is the single choke point for requests — believe it first. */
  useEffect(() => onConnection((ok) => setDown(!ok)), []);

  useEffect(() => {
    let stop = false;
    const ping = async () => {
      let ok = false;
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        ok = r.ok;
      } catch { ok = false; }
      if (stop) return;
      reportReachable(ok);   // keep api.js and this banner on one story
      setDown(!ok);
    };
    ping();
    /* Probe hard while down so the shop is not waiting on a slow poll. */
    const iv = setInterval(ping, down ? 2000 : 10000);
    const on = () => ping();
    const off = () => setDown(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      stop = true; clearInterval(iv);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [down]);

  useEffect(() => {
    if (down) { wasDown.current = true; setBack(false); return; }
    if (!wasDown.current) return;
    wasDown.current = false;
    setBack(true);
    const t = setTimeout(() => setBack(false), 6000);
    return () => clearTimeout(t);
  }, [down]);

  if (down) {
    return (
      <div className="conn-banner" role="status" aria-live="polite" data-conn="down">
        ⚠ Can't reach the server — reconnecting… Nothing on screen is lost; anything you were
        saving has not been saved, so try again once this clears.
      </div>
    );
  }
  if (back) {
    return (
      <div className="conn-banner" role="status" aria-live="polite" data-conn="back"
           style={{ background: "#166534", color: "#fff" }}>
        ✓ Connection is back — if a save failed a moment ago, try it again now.
      </div>
    );
  }
  return null;
}


/* Paging controls for server-paged lists. */
export function Pager({ page, pages, total, limit, onPage, onLimit }) {
  if (!total) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <div className="pager">
      <span className="pager-info">Showing <b>{from}–{to}</b> of <b>{total}</b></span>
      <div className="pager-ctl">
        <select value={limit} onChange={(e) => onLimit(Number(e.target.value))} title="Rows per page">
          {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <button className="btn btn-ghost" disabled={page <= 1} onClick={() => onPage(1)}>«</button>
        <button className="btn btn-ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
        <span className="pager-page">Page {page} of {pages}</span>
        <button className="btn btn-ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
        <button className="btn btn-ghost" disabled={page >= pages} onClick={() => onPage(pages)}>»</button>
      </div>
    </div>
  );
}

/* ─────────── Styled confirmations ───────────
   Replaces the browser's "localhost:3000 says…" popups with a dialog that
   matches the app. Returns a promise so callers read like the old confirm(). */
let pushConfirm = null;

export function confirmDialog(opts) {
  const o = typeof opts === "string" ? { message: opts } : (opts || {});
  /* Callers have written the explanatory line as `body`; treat it as the
     message rather than dropping it. */
  if (o.body && !o.message) o.message = o.body;
  return new Promise((resolve) => {
    if (!pushConfirm) return resolve(window.confirm(o.message || "Are you sure?"));
    pushConfirm({ ...o, resolve });
  });
}

export function ConfirmHost() {
  const [d, setD] = React.useState(null);
  React.useEffect(() => { pushConfirm = setD; return () => { pushConfirm = null; }; }, []);
  React.useEffect(() => {
    if (!d) return;
    const h = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter") done(true);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  const done = (v) => { if (d) { d.resolve(v); setD(null); } };
  if (!d) return null;
  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="cf-box" role="alertdialog" aria-modal="true">
        <div className={`cf-icon ${d.danger ? "danger" : ""}`}>{d.danger ? "⚠" : "?"}</div>
        <h3>{d.title || "Please confirm"}</h3>
        {d.message && <p>{d.message}</p>}
        {d.detail && <div className="cf-detail" style={{ whiteSpace: "pre-line" }}>{d.detail}</div>}
        <div className="cf-actions">
          <button className="btn btn-ghost" onClick={() => done(false)}>{d.cancelLabel || "Cancel"}</button>
          <button className={`btn ${d.danger ? "btn-danger" : "btn-primary"}`} onClick={() => done(true)} autoFocus>
            {d.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Print preview ───────────
   Shows the exact document in an iframe with Print / Cancel, so nobody sends
   the wrong layout to paper — and a blocked popup can't fail silently. */
let pushPreview = null;

export function showPrintPreview(html, opts = {}) {
  if (!pushPreview) {                       // fallback: old behaviour
    const w = window.open("", "_blank");
    if (!w) { toast("Your browser blocked the print window — allow popups for this site", "bad"); return; }
    w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 250);
    return;
  }
  pushPreview({ html, ...opts });
}

/**
 * The print preview.
 *
 * More than a look at the page, because in the desktop shell there is a real
 * printing API behind it: the shop can choose which printer, how many copies,
 * zoom in on the small print, and save the same document as a PDF to email.
 * In a plain browser none of that is possible — `window.print()` hands over to
 * the browser's own dialog and no script may influence it — so those controls
 * are simply absent there rather than present and inert, and the one thing the
 * browser will do to the page against our wishes (stamp its URL and the date
 * across the top and bottom) is said out loud, with the fix.
 */
export function PrintPreviewHost() {
  const [p, setP] = React.useState(null);
  const [zoom, setZoom] = React.useState(100);
  const [printers, setPrinters] = React.useState([]);
  const [device, setDevice] = React.useState("");
  const [copies, setCopies] = React.useState(1);
  const [working, setWorking] = React.useState("");
  const frame = React.useRef(null);
  const bridge = typeof window !== "undefined" ? window.geniusPrint : null;

  React.useEffect(() => { pushPreview = setP; return () => { pushPreview = null; }; }, []);
  React.useEffect(() => {
    if (!p || !frame.current) return;
    const doc = frame.current.contentDocument;
    doc.open(); doc.write(p.html); doc.close();
    setZoom(100); setCopies(1); setWorking("");
  }, [p]);
  React.useEffect(() => {
    if (!p || !bridge || !bridge.listPrinters) return;
    bridge.listPrinters().then((list) => {
      setPrinters(list || []);
      const d = (list || []).find((x) => x.isDefault);
      setDevice((cur) => cur || (d ? d.name : ""));
    }).catch(() => {});
  }, [p]);

  if (!p) return null;

  const close = () => setP(null);

  const doPrint = async () => {
    /* Through the shell when there is one: it prints the document itself, so
       nothing adds a URL or a date to it. */
    if (bridge && bridge.available) {
      setWorking("Printing…");
      const res = await bridge.print(p.html, {
        deviceName: device || undefined,
        copies: Math.max(1, Number(copies) || 1),
        thermal: p.thermal || false,
      }).catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
      setWorking("");
      if (res && res.ok) { toast("Sent to printer"); close(); return; }
      toast((res && (res.message || res.error)) || "Could not reach the printer", "bad");
      return;
    }
    try {
      frame.current.contentWindow.focus();
      frame.current.contentWindow.print();
      toast("Sent to printer");
    } catch { toast("Could not reach the printer", "bad"); }
  };

  const savePdf = async () => {
    if (!bridge || !bridge.savePdf) return;
    setWorking("Saving…");
    const res = await bridge.savePdf(p.html, (p.title || "document").replace(/[^\w -]+/g, "") + ".pdf")
      .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
    setWorking("");
    if (res && res.ok) toast(res.path ? `Saved to ${res.path}` : "Saved");
    else if (res && res.error) toast(res.error, "bad");
  };

  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pv-box">
        <div className="pv-head">
          <b>{p.title || "Print preview"}</b>
          <span className="pv-sub">{p.subtitle || ""}</span>
          <div className="pv-zoom">
            <button className="icon-btn" title="Smaller"
                    onClick={() => setZoom((z) => Math.max(50, z - 10))}>−</button>
            <span>{zoom}%</span>
            <button className="icon-btn" title="Bigger"
                    onClick={() => setZoom((z) => Math.min(200, z + 10))}>+</button>
          </div>
          <button className="icon-btn" onClick={close} style={{ marginLeft: 4, fontSize: 19 }}>
            <Icon n="close" size={15} />
          </button>
        </div>

        <div className="pv-body">
          <div className="pv-page" style={{ width: `${zoom}%` }}>
            <iframe ref={frame} title="preview" />
          </div>
        </div>

        <div className="pv-foot">
          {bridge && bridge.available ? (
            <>
              {printers.length > 0 && (
                <select className="dk-input pv-printer" value={device} onChange={(e) => setDevice(e.target.value)}>
                  {printers.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.displayName || x.name}{x.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              )}
              <label className="pv-copies">
                Copies
                <input type="number" min="1" max="20" value={copies}
                       onChange={(e) => setCopies(e.target.value)} />
              </label>
              <button className="btn btn-ghost" onClick={savePdf} disabled={!!working}>Save as PDF</button>
            </>
          ) : (
            <span className="pv-hint">
              Your browser adds its own page header and footer. In the print dialog, turn off
              “Headers and footers” for a clean document — the desktop app does it for you.
            </span>
          )}
          <div className="spacer" style={{ flex: 1 }} />
          {/* The same document on the other paper. Offered here because which
              one is wanted is decided with the customer at the counter, not by
              going into Settings and back. */}
          {p.alsoPrint && (
            <button className="btn btn-ghost" disabled={!!working}
                    onClick={() => { close(); p.alsoPrint.run(); }}>
              {p.alsoPrint.label}
            </button>
          )}
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={doPrint} disabled={!!working}>
            <Icon n="print" size={15} /> {working || "Print"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Undo toast — for reversible actions, gentler than a confirm dialog. */
export function toastUndo(message, onUndo, seconds = 10) {
  if (!pushToast) return;
  const id = Date.now() + Math.random();
  pushToast({ id, message, tone: "ok", undo: onUndo, ttl: seconds * 1000 });
}

/* Type-to-search item picker. A plain <select> is unusable past a few dozen items —
   this filters as you type, matching name, code or barcode, and takes a scanner. */
/**
 * useAnchoredList — positions a dropdown against an anchor element and renders
 * it through a portal.
 *
 * An absolutely-positioned list is clipped by the first ancestor with
 * `overflow` set, which on the invoice line grid is the scrolling table
 * wrapper. The symptom is a list that looks like it never opened, then appears
 * once focus moves and the layout shifts — the reported "items only show after
 * I press Tab". Rendering to document.body with fixed coordinates takes the
 * list out of that clipping context entirely.
 */
export function useAnchoredList(anchorRef, open) {
  const [box, setBox] = React.useState(null);

  React.useLayoutEffect(() => {
    if (!open || !anchorRef.current) { setBox(null); return; }
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const flip = below < 240 && r.top > below;   // not enough room under it
      setBox({
        left: r.left,
        width: Math.max(r.width, 300),
        ...(flip ? { bottom: window.innerHeight - r.top + 4, maxHeight: r.top - 12 }
                 : { top: r.bottom + 4, maxHeight: below - 12 }),
      });
    };
    measure();
    /* Scroll can come from any ancestor, so listen in the capture phase. */
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, anchorRef]);

  const render = (children) => {
    if (!open || !box) return null;
    return ReactDOM.createPortal(
      <div className="combo-list combo-list-fixed" style={{ position: "fixed", ...box }}>
        {children}
      </div>,
      document.body
    );
  };
  return render;
}

/**
 * PartyCombo — searchable customer/supplier picker with inline creation.
 *
 * Replaces a bare <select>, which forced you to leave a half-built invoice,
 * go to Parties, add the customer, come back and start again. Matches on name,
 * phone and party number; whatever you have typed pre-fills the create form.
 */
export function PartyCombo({
  parties, value, onPick, onCreated, kind = "customer",
  placeholder = "Search name or phone…", autoFocus,
}) {
  const chosen = (parties || []).find((p) => String(p.id) === String(value));
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const [creating, setCreating] = React.useState(null);   // seed text, or null
  const wrap = React.useRef(null);
  const renderList = useAnchoredList(wrap, open);

  React.useEffect(() => {
    const away = (e) => {
      if (e.target.closest && e.target.closest(".combo-list-fixed")) return;
      if (wrap.current && !wrap.current.contains(e.target)) { setOpen(false); setQ(""); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const term = q.trim().toLowerCase();
  const list = !term ? (parties || []).slice(0, 50) : (parties || []).filter((p) =>
    p.name.toLowerCase().includes(term) ||
    (p.phone || "").toLowerCase().includes(term) ||
    (p.party_no || "").toLowerCase().includes(term)
  ).slice(0, 50);

  const choose = (p) => { onPick(String(p.id)); setQ(""); setOpen(false); };
  const startCreate = () => { setCreating(q.trim()); setOpen(false); };

  return (
    <>
      <div className="combo" ref={wrap}>
        <input
          className="cell-input"
          autoFocus={autoFocus}
          value={open ? q : (chosen ? chosen.name : "")}
          placeholder={chosen ? chosen.name : placeholder}
          onFocus={() => { setOpen(true); setQ(""); setHi(0); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              if (list[hi]) choose(list[hi]); else if (term) startCreate();
            } else if (e.key === "Escape" && open) {
              /* The list is a fixed portal on document.body, so an Escape
                 handler on window cannot tell it is there. Swallow the key
                 while the list is visible: it closes, and whatever sits behind
                 (the invoice panel) only sees the next Escape. */
              e.stopPropagation();
              setOpen(false); setQ("");
            }
          }}
        />
        {renderList(
          <>
            {list.map((p, n) => (
              <button key={p.id} type="button" className={`combo-row ${n === hi ? "on" : ""}`}
                      onMouseEnter={() => setHi(n)} onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(p)}>
                <span className="combo-av" style={{ background: "#3A4763" }}>{p.name[0].toUpperCase()}</span>
                <span className="combo-name">
                  {p.name}
                  <small>{[p.party_no, p.phone].filter(Boolean).join(" · ")}</small>
                </span>
                {Number(p.balance) ? (
                  <span className="combo-price num">{cur()} {inr(Math.abs(p.balance))} {Number(p.balance) > 0 ? "due" : "adv"}</span>
                ) : null}
              </button>
            ))}
            {list.length === 0 && <div className="combo-empty">No match for “{q}”</div>}
            <button type="button" className="combo-create"
                    onMouseDown={(e) => e.preventDefault()} onClick={startCreate}>
              <span className="cc-plus">+</span>
              New {kind}{term ? <> — “<b>{q.trim()}</b>”</> : null}
            </button>
          </>
        )}
      </div>
      {creating !== null && (
        <PartyQuickCreate
          seedName={creating} kind={kind}
          onClose={() => setCreating(null)}
          onSaved={(p) => {
            setCreating(null);
            if (onCreated) onCreated(p);
            onPick(String(p.id));
          }}
        />
      )}
    </>
  );
}

/**
 * PartyQuickCreate — the full party record, without leaving the invoice.
 * Anything not needed to raise an invoice sits under Advanced, closed.
 */
export function PartyQuickCreate({ seedName = "", kind = "customer", onClose, onSaved }) {
  const [f, setF] = React.useState({
    name: seedName, party_type: kind === "supplier" ? "supplier" : "customer",
    phone: "", email: "", gstin: "", billing_address: "", shipping_address: "",
    opening_balance: "", credit_limit: "", credit_days: "",
  });
  const [sameAddress, setSameAddress] = React.useState(true);
  const [adv, setAdv] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  const save = async () => {
    if (!f.name.trim()) return toast("Give the " + kind + " a name", "bad");
    setBusy(true);
    try {
      const body = {
        ...f,
        shipping_address: sameAddress ? f.billing_address : f.shipping_address,
        opening_balance: Number(f.opening_balance) || 0,
        credit_limit: Number(f.credit_limit) || 0,
        credit_days: Number(f.credit_days) || 0,
      };
      const saved = await api.post("/parties", body);
      toast(`${f.name} added`, "ok");
      onSaved({ id: saved.id, party_no: saved.party_no, ...body, balance: body.opening_balance });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`New ${kind}`} onClose={onClose} wide>
      <Field label="Name">
        <input value={f.name} onChange={set("name")} autoFocus placeholder="Business or person" />
      </Field>
      <div className="row2">
        <Field label="Phone"><input value={f.phone} onChange={set("phone")} placeholder="07xx xxx xxx" /></Field>
        <Field label="Email"><input value={f.email} onChange={set("email")} placeholder="Optional" /></Field>
      </div>
      <div className="row2">
        <Field label="TIN">
          <input value={f.gstin} onChange={set("gstin")} placeholder="Optional" />
        </Field>
        <Field label="Type">
          <select value={f.party_type} onChange={set("party_type")}>
            <option value="customer">Customer</option>
            <option value="supplier">Supplier</option>
            <option value="both">Both</option>
          </select>
        </Field>
      </div>
      <Field label="Billing address">
        <textarea rows={2} value={f.billing_address} onChange={set("billing_address")} />
      </Field>
      <label className="inline-check">
        <input type="checkbox" checked={sameAddress} onChange={(e) => setSameAddress(e.target.checked)} />
        Shipping address is the same
      </label>
      {!sameAddress && (
        <Field label="Shipping address">
          <textarea rows={2} value={f.shipping_address} onChange={set("shipping_address")} />
        </Field>
      )}

      <button type="button" className="adv-toggle" onClick={() => setAdv((a) => !a)}>
        {adv ? "▾" : "▸"} Advanced — opening balance, credit terms
      </button>
      <Collapse open={adv}>
        <div className="row3">
          <Field label="Opening balance (Sh)">
            <input type="number" value={f.opening_balance} onChange={set("opening_balance")} placeholder="0" />
          </Field>
          <Field label="Credit limit (Sh)">
            <input type="number" value={f.credit_limit} onChange={set("credit_limit")} placeholder="0" />
          </Field>
          <Field label="Credit days">
            <input type="number" value={f.credit_days} onChange={set("credit_days")} placeholder="0" />
          </Field>
        </div>
      </Collapse>

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : `Save ${kind}`}
        </button>
      </div>
    </Modal>
  );
}


/**
 * ItemQuickCreate — add a missing item without abandoning the document.
 *
 * Deliberately the shortest form that produces a sellable item; everything
 * else has a sensible default and can be filled in on the Items screen later.
 * Reaching a half-built invoice, discovering the item does not exist and
 * having to throw the invoice away to go and create it is the workflow this
 * removes.
 */
export function ItemQuickCreate({ seedName = "", onClose, onSaved }) {
  const [f, setF] = React.useState({
    name: seedName, unit: "PCS", sale_price: "", purchase_price: "",
    barcode: "", opening_stock: "", item_type: "product",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  const save = async () => {
    if (!f.name.trim()) return toast("Give the item a name", "bad");
    setBusy(true);
    try {
      const saved = await api.post("/items", {
        name: f.name.trim(), unit: f.unit || "PCS", item_type: f.item_type,
        sale_price: Number(f.sale_price) || 0,
        purchase_price: Number(f.purchase_price) || 0,
        barcode: f.barcode.trim() || null,
        opening_stock: Number(f.opening_stock) || 0,
      });
      toast(`${f.name} added`, "ok");
      onSaved({
        id: saved.id, name: f.name.trim(), unit: f.unit || "PCS",
        sale_price: Number(f.sale_price) || 0,
        purchase_price: Number(f.purchase_price) || 0,
        on_hand: Number(f.opening_stock) || 0,
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title="New item" onClose={onClose} wide>
      <Field label="Item name">
        <input value={f.name} onChange={set("name")} autoFocus placeholder="What is it called?" />
      </Field>
      <div className="row3">
        <Field label="Type">
          <select value={f.item_type} onChange={set("item_type")}>
            <option value="product">Product</option>
            <option value="service">Service</option>
          </select>
        </Field>
        <Field label="Unit">
          <input value={f.unit} onChange={set("unit")} placeholder="PCS" />
        </Field>
        <Field label="Barcode">
          <input value={f.barcode} onChange={set("barcode")} placeholder="Optional" />
        </Field>
      </div>
      <div className="row3">
        <Field label="Selling price"><input type="number" value={f.sale_price} onChange={set("sale_price")} placeholder="0" /></Field>
        <Field label="Cost price"><input type="number" value={f.purchase_price} onChange={set("purchase_price")} placeholder="0" /></Field>
        {f.item_type === "product" && (
          <Field label="Opening stock"><input type="number" value={f.opening_stock} onChange={set("opening_stock")} placeholder="0" /></Field>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save item"}</button>
      </div>
    </Modal>
  );
}

export function ItemCombo({ items, value, onPick, onCreated, placeholder = "Type or scan an item…" }) {
  const chosen = items.find((i) => String(i.id) === String(value));
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const wrap = React.useRef(null);
  const renderList = useAnchoredList(wrap, open);
  const [creating, setCreating] = React.useState(null);

  React.useEffect(() => {
    /* The list now lives on document.body, so "outside" has to exclude it too
       or the first click on a result closes the combo before it registers. */
    const away = (e) => {
      if (e.target.closest && e.target.closest(".combo-list-fixed")) return;
      if (wrap.current && !wrap.current.contains(e.target)) { setOpen(false); setQ(""); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const term = q.trim().toLowerCase();
  const list = !term ? items.slice(0, 50) : items.filter((i) =>
    i.name.toLowerCase().includes(term) ||
    (i.item_code || "").toLowerCase().includes(term) ||
    (i.barcode || "").toLowerCase().includes(term) ||
    (i.barcodes || []).some((c) => String(c).toLowerCase() === term)
  ).slice(0, 50);

  const choose = (it) => { onPick(it.id); setQ(""); setOpen(false); };

  return (
    <div className="combo" ref={wrap}>
      <input
        className="cell-input"
        value={open ? q : (chosen ? chosen.name : "")}
        placeholder={chosen ? chosen.name : placeholder}
        onFocus={() => { setOpen(true); setQ(""); setHi(0); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") {
            // an exact code match wins — that's a scanner, not a person typing
            const exact = items.find((i) => (i.barcode || "").toLowerCase() === term || (i.item_code || "").toLowerCase() === term);
            const pick = exact || list[hi];
            if (pick) { e.preventDefault(); choose(pick); }
          } else if (e.key === "Escape" && open) {
            /* Same one-layer-at-a-time rule as PartyCombo: a visible list wins
               Escape over the panel or modal behind it. */
            e.stopPropagation();
            setOpen(false); setQ("");
          }
        }}
      />
      {renderList(
        <>
        {list.length === 0 ? (
          /* Nothing matched. The create row below is the answer, so say so
             here rather than leaving a dead end with an offer underneath it
             that reads as part of the furniture. */
          <div className="combo-empty">
            Nothing matches “{q}”{onCreated ? " — add it below" : ""}
          </div>
        ) : list.map((it, n) => (
          <button key={it.id} type="button" className={`combo-row ${n === hi ? "on" : ""}`}
                  onMouseEnter={() => setHi(n)} onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(it)}>
            {it.image ? <img src={it.image} alt="" /> : <span className="combo-av" style={{ background: it.color || "#3A4763" }}>{it.name[0].toUpperCase()}</span>}
            <span className="combo-name">
              {it.name}
              {/* Was printing the raw base quantity with the primary unit, so a
                 dual-unit item read "118.98 BAG in stock". dualQty splits it the
                 same way every other stock label does. */}
              <small>{it.item_code || ""}{it.on_hand != null ? ` · ${dualQty(it.on_hand, it.unit || "", it.secondary_unit, it.conversion_rate)} in stock` : ""}</small>
            </span>
            <span className="combo-price">{it.sale_price != null ? `${cur()} ${Number(it.sale_price).toLocaleString()}` : ""}</span>
          </button>
        ))}
        {onCreated && (
          /* Highlighted when nothing matched, because then it is the only
             thing on the list that can be pressed. A shopkeeper entering a
             supplier's bill meets an item they have never stocked several
             times a month, and going to Items, adding it, and starting the
             bill again is the reason half of them stop entering bills. */
          <button type="button" className={`combo-create ${list.length === 0 ? "is-only" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setCreating(q.trim()); setOpen(false); }}>
            <span className="cc-plus">+</span>
            New item{q.trim() ? <> — “<b>{q.trim()}</b>”</> : null}
          </button>
        )}
        </>
      )}
      {creating !== null && (
        <ItemQuickCreate
          seedName={creating}
          onClose={() => setCreating(null)}
          onSaved={(it) => { setCreating(null); onCreated(it); onPick(it.id); }}
        />
      )}
    </div>
  );
}

/* ── BulkItemPicker — Zoho "Add Items in Bulk": search, tick items, set qty, add all at once ── */
export function BulkItemPicker({ items, onAdd, onClose }) {
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState({}); // id -> qty
  const list = React.useMemo(() => {
    const t = q.toLowerCase().trim();
    return (items || []).filter((i) =>
      !t || i.name.toLowerCase().includes(t) || (i.item_code || "").toLowerCase().includes(t)).slice(0, 200);
  }, [items, q]);
  const count = Object.keys(sel).length;
  const toggle = (id) => setSel((s) => {
    const n = { ...s };
    if (n[id] != null) delete n[id]; else n[id] = 1;
    return n;
  });
  return (
    <Modal title="Add Items in Bulk" onClose={onClose} wide>
      <input autoFocus placeholder="Search items by name or code…" value={q} onChange={(e) => setQ(e.target.value)}
             style={{ width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 10 }} />
      <div style={{ maxHeight: 380, overflow: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
        <table className="tw" style={{ margin: 0 }}>
          <thead><tr><th style={{ width: 34 }} /><th>Item</th><th className="amt">Price</th><th className="amt">Stock</th><th style={{ width: 110 }} className="amt">Qty</th></tr></thead>
          <tbody>
            {list.length === 0 ? <tr><td colSpan={5}><Empty icon="□" title="No matching items" /></td></tr> :
              list.map((i) => (
                <tr key={i.id} className="hl" style={{ cursor: "pointer" }} onClick={() => toggle(i.id)}>
                  <td><input type="checkbox" checked={sel[i.id] != null} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td>{i.name}{i.item_code ? <span style={{ color: "var(--muted)", fontSize: 12.5, fontWeight: 500 }}> · {i.item_code}</span> : null}</td>
                  <td className="amt num">{Number(i.sale_price || 0).toLocaleString()}</td>
                  <td className="amt num">{i.is_inventory ? i.on_hand : "—"}</td>
                  <td className="amt" onClick={(e) => e.stopPropagation()}>
                    {sel[i.id] != null && (
                      <input type="number" min="0" value={sel[i.id]} className="cell-input" style={{ width: 90, textAlign: "right" }}
                             onChange={(e) => setSel((s) => ({ ...s, [i.id]: e.target.value }))} />
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!count}
                onClick={() => { onAdd(Object.entries(sel).map(([id, qty]) => ({ id: Number(id), qty: Number(qty) || 1 }))); onClose(); }}>
          Add {count || ""} item{count === 1 ? "" : "s"}
        </button>
      </div>
    </Modal>
  );
}

/* ═══ Design system v2 primitives ═══ */

/**
 * Tooltip — the single most-skipped piece of a dashboard. Any icon-only
 * control or abbreviated label should carry one; you cannot assume a user
 * knows what a glyph means.
 */
export function Tip({ label, below, children }) {
  if (!label) return children;
  return (
    <span className="tip-wrap">
      {children}
      <span className={`tip ${below ? "tip-below" : ""}`} role="tooltip">{label}</span>
    </span>
  );
}

/** An icon button that always explains itself. */
export function IconButton({ icon, label, onClick, danger, below, ...rest }) {
  return (
    <Tip label={label} below={below}>
      <button className="icon-btn" aria-label={label} onClick={onClick}
              style={danger ? { color: "var(--bad)" } : undefined} {...rest}>{icon}</button>
    </Tip>
  );
}

/**
 * Chip — categorical values with a small set of options read faster as a
 * shape and colour than as a word in a column of words.
 */
export function Chip({ tone = "", dot, children }) {
  return <span className={`chip ${tone ? `chip-${tone}` : ""}`}>{dot && <span className="dot" />}{children}</span>;
}

/** Map a status word to a tone once, so every screen agrees on what red means. */
const TONES = {
  paid: "ok", active: "ok", created: "ok", "in cover": "ok", settled: "ok", received: "ok", open: "warn",
  partial: "warn", pending: "warn", draft: "warn", paused: "warn", "ending soon": "warn",
  overdue: "bad", expired: "bad", failed: "bad", cancelled: "bad", void: "bad", rejected: "bad",
  repaired: "ok", replaced: "ok", refunded: "info", ended: "", retired: "", off: "",
};
export function StatusChip({ value, dot = true }) {
  const v = String(value ?? "").toLowerCase();
  return <Chip tone={TONES[v] ?? ""} dot={dot}>{value}</Chip>;
}

/**
 * StateBlock — one component for empty, error and no-results, so these
 * states are designed rather than left as a blank rectangle.
 */
export function StateBlock({ icon = "□", title, sub, error, actions }) {
  return (
    <div className={`state-block ${error ? "is-error" : ""}`}>
      <div className="ic">{error ? "!" : icon}</div>
      <h4>{title}</h4>
      {sub && <p>{sub}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/**
 * Skeletons shaped like what is loading. A generic grey block tells the user
 * nothing; a row of the right shape tells them what is about to appear.
 */
export function Skeleton({ variant = "text", width, style }) {
  return <span className={`sk sk-${variant}`} style={{ width, ...style }} />;
}
export function SkeletonTable({ rows = 6, cols = 5, numericFrom = 2 }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c}>
              <Skeleton variant={c >= numericFrom ? "num" : "text"}
                        width={c >= numericFrom ? undefined : `${58 + ((r * 7 + c * 13) % 32)}%`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Copy a cell's value without leaving the table. */
export function CopyCell({ value, children }) {
  const [done, setDone] = React.useState(false);
  if (value == null || value === "") return children ?? "—";
  return (
    <span className="copy-cell">
      {children ?? value}
      <button className="copy-btn" aria-label="Copy"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard?.writeText(String(value))
                  .then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })
                  .catch(() => toast("Could not copy", "bad"));
              }}>{done ? "✓" : "⧉"}</button>
    </span>
  );
}

/* ── Date range picker ─────────────────────────────────────────────────
   Presets first, calendar second: most of the time somebody wants "this
   month", not to hunt for two specific days. The calendar is there when
   they genuinely need it. */

const iso = (d) => d.toISOString().slice(0, 10);
const startOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const endOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

export function presetRanges(now = new Date()) {
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const lastMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
  return [
    { id: "today", label: "Today", from: iso(t), to: iso(t) },
    { id: "7d", label: "Last 7 days", from: iso(addDays(t, -6)), to: iso(t) },
    { id: "30d", label: "Last 30 days", from: iso(addDays(t, -29)), to: iso(t) },
    { id: "mtd", label: "This month", from: iso(startOfMonth(t)), to: iso(t) },
    { id: "lastmo", label: "Last month", from: iso(startOfMonth(lastMonth)), to: iso(endOfMonth(lastMonth)) },
    { id: "ytd", label: "This year", from: `${t.getUTCFullYear()}-01-01`, to: iso(t) },
  ];
}

/* Whole months, newest first — the affordance Staff (12-month <select>) and
   Tax (15) had before this control replaced them. Payroll, commission and VAT
   are monthly jobs: "June" has to stay one click, not two calendar clicks and
   an Apply. Bounds are exact (1st → last day) because those pages snap
   whatever range they are given to a whole month anyway.
   Deliberately separate from presetRanges(), whose six entries are unchanged
   so existing callers see no difference. */
export function monthRanges(count = 12, now = new Date()) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    out.push({
      id: `m-${iso(first).slice(0, 7)}`,
      label: first.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }),
      from: iso(first),
      to: iso(endOfMonth(first)),
    });
  }
  return out;
}

const fmt = (s) => {
  if (!s) return "—";
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/* Callers hand this null, undefined, "" and occasionally a Date. One shape
   comes out: a "YYYY-MM-DD" string or "". Without this the picker rendered
   "— → —" for an unset filter and crashed the month grid on a bad value. */
const asIso = (v) => {
  if (!v) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : iso(v);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};

function MonthGrid({ month, from, to, onPick }) {
  const first = startOfMonth(month);
  const lead = (first.getUTCDay() + 6) % 7;           // weeks start Monday
  const days = endOfMonth(month).getUTCDate();
  const todayIso = iso(new Date());
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), d)));
  return (
    <div className="drp-grid">
      {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div className="dow" key={i}>{d}</div>)}
      {cells.map((d, i) => {
        if (!d) return <span key={i} />;
        const v = iso(d);
        const isStart = v === from, isEnd = v === to;
        const inRange = from && to && v > from && v < to;
        const edge = isStart || isEnd;
        return (
          <button key={i} type="button"
            className={`drp-day ${inRange ? "in-range" : ""} ${edge ? "edge" : ""} ${isStart ? "start" : ""} ${isEnd ? "end" : ""} ${isStart && isEnd ? "only" : ""} ${v === todayIso ? "today" : ""}`}
            onClick={() => onPick(v)}>{d.getUTCDate()}</button>
        );
      })}
    </div>
  );
}

/**
 * DateRangePicker — the one date filter.
 *
 *   <DateRangePicker from={from} to={to} onChange={(r) => setRange(r)} />
 *
 * Props
 *   from, to    "YYYY-MM-DD" | "" | null | undefined | Date. An unset filter
 *               is "" / null / undefined at either end and is legal — the
 *               control then reads "All dates" rather than "— → —".
 *   onChange(r) always called with { from: string, to: string }; both are ""
 *               when the user clears. Never called with null.
 *   align       "right" (default) | "left" — which edge the panel hangs off.
 *   allowAll    default true. Adds the "All dates" preset and the Clear
 *               action. Pass false where a range is mandatory.
 *   allLabel    default "All dates" — the empty-state wording on the trigger.
 *   disabled    default false.
 *   className   appended to the trigger, e.g. "drp-trigger" sizing variants.
 *   months      default 12. How many whole months the "Pick a month" list
 *               offers, newest first. Each emits exact month bounds. Pass 0
 *               to hide the section, 15 to match Tax's old <select>.
 */
export function DateRangePicker({
  from, to, onChange, align = "right",
  allowAll = true, allLabel = "All dates", disabled = false, className = "",
  months = 12,
}) {
  /* Normalise once at the top so nothing below has to care what was passed. */
  const f = asIso(from), t2 = asIso(to);
  const isAll = !f && !t2;

  const [open, setOpen] = React.useState(false);
  const [month, setMonth] = React.useState(() => startOfMonth(new Date((asIso(to) || iso(new Date())) + "T00:00:00Z")));
  const [draft, setDraft] = React.useState({ from: f, to: t2 });
  const ref = React.useRef(null);
  const presets = React.useMemo(() => presetRanges(), []);
  const monthList = React.useMemo(() => (months > 0 ? monthRanges(months) : []), [months]);

  React.useEffect(() => { setDraft({ from: asIso(from), to: asIso(to) }); }, [from, to]);
  /* Reopening on an unset filter should land on this month, not on whatever
     month was last browsed. */
  React.useEffect(() => {
    if (open) setMonth(startOfMonth(new Date((asIso(to) || asIso(from) || iso(new Date())) + "T00:00:00Z")));
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const activePreset = presets.find((p) => p.from === f && p.to === t2);
  /* "Last month" is in both lists; the preset wins so the trigger keeps its
     friendlier wording. */
  const activeMonth = !activePreset && monthList.find((m) => m.from === f && m.to === t2);
  const pick = (v) => {
    /* First click starts a new range; second click closes it, flipping the
       ends if the user picked backwards. */
    setDraft((d) => (!d.from || d.to || v < d.from) ? { from: v, to: "" } : { from: d.from, to: v });
  };
  /* Always hands the caller two strings, so `range.from` is safe to append to
     a query string without a null check. */
  const apply = (r) => { onChange({ from: asIso(r?.from), to: asIso(r?.to) }); setOpen(false); };

  const label = isAll ? (allowAll ? allLabel : "Pick dates")
    : activePreset ? activePreset.label
    : activeMonth ? activeMonth.label
    : f && t2 ? `${fmt(f)} → ${fmt(t2)}`
    : `${fmt(f || t2)} →`;   /* half-open range: one end only */

  return (
    <div className="drp" ref={ref}>
      <button type="button" className={`drp-trigger ${isAll ? "" : "on"} ${className}`.trim()}
              disabled={disabled} onClick={() => setOpen((o) => !o)}
              aria-haspopup="dialog" aria-expanded={open} aria-label={`Date range: ${label}`}>
        <span className="cal" aria-hidden="true">▤</span>
        {label}
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="drp-panel" role="dialog" aria-label="Choose a date range"
             style={align === "left" ? { right: "auto", left: 0 } : undefined}>
          <div className="drp-presets">
            {allowAll && (
              <button type="button" className={isAll ? "on" : ""}
                      onClick={() => apply({ from: "", to: "" })}>{allLabel}</button>
            )}
            {presets.map((p) => (
              <button key={p.id} type="button" className={activePreset?.id === p.id ? "on" : ""}
                      onClick={() => apply({ from: p.from, to: p.to })}>{p.label}</button>
            ))}
            {monthList.length > 0 && (
              <>
                <div className="drp-cap">Pick a month</div>
                <div className="drp-months">
                  {monthList.map((m) => (
                    <button key={m.id} type="button" className={activeMonth?.id === m.id ? "on" : ""}
                            onClick={() => apply({ from: m.from, to: m.to })}>{m.label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div>
            <div className="drp-cal">
              <div className="drp-head">
                <IconButton icon="‹" label="Previous month" below
                            onClick={() => setMonth((m) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 1)))} />
                <span className="mo">{month.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</span>
                <IconButton icon="›" label="Next month" below
                            onClick={() => setMonth((m) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1)))} />
              </div>
              <MonthGrid month={month} from={draft.from} to={draft.to} onPick={pick} />
            </div>
            <div className="drp-foot">
              <span className="rng">{draft.from ? fmt(draft.from) : "—"} → {draft.to ? fmt(draft.to) : "…"}</span>
              <span style={{ display: "flex", gap: 8 }}>
                {allowAll && <button className="btn btn-ghost btn-sm" onClick={() => apply({ from: "", to: "" })}>Clear</button>}
                <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" disabled={!draft.from || !draft.to}
                        onClick={() => apply(draft)}>Apply</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ Motion helpers ═══
   Everything here checks the user's reduce-motion setting first and simply
   renders the final state if motion is unwanted. */

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  React.useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/**
 * CountUp — a headline figure counts to its value instead of appearing.
 *
 * Eased rather than linear so it decelerates into the final number, and it
 * always lands exactly on the target: a money figure that stops at 38,539
 * because of rounding would be worse than no animation at all.
 */
export function CountUp({ value, duration = 700, decimals = 0, prefix = "", suffix = "" }) {
  const reduced = usePrefersReducedMotion();
  const target = Number(value) || 0;

  /* Paper cannot animate. A print begun while a figure is still climbing puts
     whatever frame it was on onto the page — a Z report stating the day's
     takings as some number on the way to the real one. That is worse than an
     ugly report, because it does not look like an artefact, it looks like a
     figure. beforeprint fires before Chromium snapshots the page, so land on
     the value there; matchMedia("print") covers a print started from code. */
  const printing = () => (typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("print").matches : false);
  const [still, setStill] = React.useState(printing);
  React.useEffect(() => {
    const on = () => setStill(true);
    const off = () => setStill(false);
    window.addEventListener("beforeprint", on);
    window.addEventListener("afterprint", off);
    return () => {
      window.removeEventListener("beforeprint", on);
      window.removeEventListener("afterprint", off);
    };
  }, []);

  const [shown, setShown] = React.useState(reduced || printing() ? target : 0);
  const fromRef = React.useRef(0);

  React.useEffect(() => {
    if (reduced || still) { setShown(target); fromRef.current = target; return; }
    const from = fromRef.current;
    if (from === target) return;
    let raf, start;
    const step = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);           // cubic ease-out
      setShown(p === 1 ? target : from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced, still]);

  const text = Number(shown).toLocaleString(undefined, {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
  return <span className="num">{prefix}{text}{suffix}</span>;
}

/** Determinate or indeterminate progress for jobs that take a moment. */
export function Progress({ value }) {
  const indet = value == null;
  return (
    <div className={`prog ${indet ? "indeterminate" : ""}`} role="progressbar"
         aria-valuenow={indet ? undefined : Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <i style={indet ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** A tick that draws itself — used to confirm a save without a toast. */
export function Tick() {
  return (
    <svg className="tick" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12.5l5.2 5.2L20 7" />
    </svg>
  );
}

/**
 * A button that shows its own progress: idle → working → a tick, then back.
 * Saves a toast for the commonest case and puts the feedback where the user
 * is already looking — at the thing they clicked.
 */
export function ActionButton({ onClick, children, className = "btn btn-primary", busyLabel = "Working…", doneLabel = "Saved", ...rest }) {
  const [state, setState] = React.useState("idle");
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  const run = async (e) => {
    if (state !== "idle") return;
    setState("busy");
    try {
      await onClick?.(e);
      if (!alive.current) return;
      setState("done");
      setTimeout(() => alive.current && setState("idle"), 1400);
    } catch (err) {
      if (!alive.current) return;
      setState("idle");
      throw err;
    }
  };
  return (
    <button className={className} onClick={run} disabled={state === "busy"} {...rest}>
      {state === "busy" && <span className="spin" />}
      {state === "done" && <Tick />}
      {state === "busy" ? busyLabel : state === "done" ? doneLabel : children}
    </button>
  );
}

/**
 * Briefly highlight a row the system just changed, so an automatic update is
 * visible rather than silent. Returns the class to spread onto the <tr>.
 */
export function useJustChanged(key, ms = 1200) {
  const [hot, setHot] = React.useState(false);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    setHot(true);
    const t = setTimeout(() => setHot(false), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return hot ? "just-changed" : "";
}

/** Collapsible section with a height transition that needs no measuring. */
export function Collapse({ open, children }) {
  return (
    <div className={`collapse ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/** Shake an element to signal a refusal — colour alone is easy to miss. */
export function useShake() {
  const [on, setOn] = React.useState(false);
  const fire = React.useCallback(() => { setOn(true); setTimeout(() => setOn(false), 400); }, []);
  return [on ? "shake" : "", fire];
}

/* ═══ Micro-charts ═══
   Small charts inside a KPI card carry the colour a dashboard needs while
   actually saying something — a bare coloured icon does not. */

/** A trend line for a KPI. Draws itself in, and flattens gracefully. */
export function Sparkline({ data = [], width = 108, height = 32, tone = "var(--accent)", fill = true }) {
  const reduced = usePrefersReducedMotion();
  const pts = (data || []).map(Number).filter((n) => Number.isFinite(n));
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = width / (pts.length - 1);
  const xy = pts.map((v, i) => [i * stepX, height - 3 - ((v - min) / span) * (height - 6)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = React.useId();
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      {fill && (
        <>
          <defs>
            <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tone} stopOpacity=".26" />
              <stop offset="100%" stopColor={tone} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#g${id})`} />
        </>
      )}
      <path d={line} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={reduced ? undefined : "chart-line"} style={reduced ? undefined : { "--len": width * 2 }} />
    </svg>
  );
}

/** A ring for "how far through" figures — clearer than a bare percentage. */
export function Donut({ value = 0, size = 54, thickness = 7, tone = "var(--accent)", label }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`${pct}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted-bg)" strokeWidth={thickness} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={thickness}
              strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: "stroke-dasharray .8s cubic-bezier(.16,1,.3,1)" }} />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
            style={{ fontSize: size * 0.26, fontWeight: 700, fill: "var(--text)" }}>
        {label ?? `${Math.round(pct)}%`}
      </text>
    </svg>
  );
}

/** Small bars — good for "last N days" without the weight of a real chart. */
export function MiniBars({ data = [], width = 108, height = 32, tone = "var(--accent)" }) {
  const pts = (data || []).map(Number).filter(Number.isFinite);
  if (!pts.length) return <svg width={width} height={height} aria-hidden="true" />;
  const max = Math.max(...pts, 1);
  const gap = 2;
  const bw = Math.max(2, (width - gap * (pts.length - 1)) / pts.length);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      {pts.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 2));
        return <rect key={i} className="chart-bar" x={i * (bw + gap)} y={height - h} width={bw} height={h}
                     rx="1.5" fill={tone} opacity={0.35 + 0.65 * (v / max)} />;
      })}
    </svg>
  );
}
