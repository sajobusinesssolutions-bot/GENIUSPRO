/**
 * rowmenu.jsx — the one ⋮ menu every list row opens.
 *
 * Why this file exists
 * --------------------
 * There were two of these. `.rd-menu-fixed` in styles.css (portalled, themed)
 * and `.dk-rowmenu` in deck.css (absolutely positioned, and — measured in
 * Chromium — with *no rule at all for its children*). The second one is what a
 * shopkeeper saw on Items and on Sales: the panel drew, but every option inside
 * it was a browser-default `<button>` — `appearance: auto`, ButtonFace beige,
 * a 2px outset bevel, `display: inline-block`. Inline-block boxes flow and
 * wrap, so "Edit item" and "Adjust stock" shared a line and the rest wrapped
 * underneath at whatever x the previous one ended, which is the staircase of
 * loose beige rectangles in the photographs. It was never a missing stylesheet
 * or a renamed class; the rows simply never had a rule written for them.
 *
 * A second, quieter fault in the same markup: the panel was `position:
 * absolute` inside the table cell, so on a long list the last rows opened their
 * menu into the card's `overflow: hidden` and it was cut off — the same trap
 * documented for the Reports date popover in deck.css (C4.4). The escape is the
 * same one: a fixed-position box, which no ancestor's overflow can clip. The
 * popover uses CSS anchor positioning and therefore does not flip in Firefox;
 * here we own the component, so placement is measured in JavaScript instead and
 * behaves identically in every browser.
 *
 * Menu shape
 * ----------
 *   { label, onClick, icon?, danger?, disabled?, hint? }
 *   "-" or { sep: true }            a rule between groups
 *   { custom: <jsx/> | fn(close) }  non-action content (the category swatches)
 *   false / null                    skipped, so `cond && {…}` reads naturally
 */
import React from "react";
import ReactDOM from "react-dom";

const GAP = 6;          /* trigger → panel */
const EDGE = 8;         /* nearest the window edge a panel may sit */

export function RowMenu({
  actions,
  items,
  label = "Actions",
  className = "dk-dots",
  width = 252,
  disabled = false,
  children,
}) {
  /* Both prop names are in use across the pages this replaced; accepting
     either means a row menu can never be handed undefined and blow up. */
  const list = React.useMemo(
    () => (actions || items || []).filter(Boolean),
    [actions, items]
  );

  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);   /* null = measured not yet */
  const btnRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const restoreFocus = React.useRef(false);

  const rows = list.filter((a) => a && !a.sep && a !== "-" && !a.custom);

  const close = React.useCallback((giveFocusBack) => {
    restoreFocus.current = !!giveFocusBack;
    setOpen(false);
  }, []);

  /* Measure, then place. The old menu guessed its height as
     `rows * 40 + 12`; a guess is wrong the moment an option wraps to two
     lines, and being wrong here means the panel hangs off the bottom of the
     window. This reads the real box. */
  const place = React.useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    const p = panelRef.current;
    if (!b || !p) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = p.offsetHeight;
    const w = p.offsetWidth;

    const below = vh - b.bottom - GAP - EDGE;
    const above = b.top - GAP - EDGE;

    let top;
    let maxH = null;
    if (h <= below) {
      top = b.bottom + GAP;                       /* the normal case */
    } else if (h <= above) {
      top = b.top - GAP - h;                      /* flip above the trigger */
    } else {
      /* Neither side fits — a very long menu, or a small window. Sit against
         the roomier edge and scroll inside rather than off-screen. */
      if (above > below) { maxH = above; top = EDGE; }
      else { maxH = below; top = b.bottom + GAP; }
    }

    /* Right edges aligned with the trigger, then shifted — not flipped —
       back inside the window, because a row menu at the far right of a table
       has no room on either side of its own trigger. */
    let left = b.right - w;
    if (left + w > vw - EDGE) left = vw - EDGE - w;
    if (left < EDGE) left = EDGE;

    setPos({ top: Math.round(top), left: Math.round(left), maxH: maxH ? Math.round(maxH) : null });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    setPos(null);
    place();
  }, [open, place]);

  React.useEffect(() => {
    if (open) {
      /* Focus the panel, not the first option: a screen reader should hear
         the menu before it hears "Edit item", and arrow keys still start at
         the top. */
      panelRef.current?.focus();
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      btnRef.current?.focus();
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close(false);
    };
    /* Closing on scroll rather than re-placing: the trigger scrolls away
       under the fixed panel otherwise, leaving a menu pointing at a
       different row than the one it will act on. */
    const onScroll = () => close(false);
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  const focusable = () =>
    Array.from(panelRef.current?.querySelectorAll(".dkm-item:not([disabled])") || []);

  const onKeyDown = (e) => {
    const f = focusable();
    if (!f.length && e.key !== "Escape") return;
    const at = f.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); f[(at + 1 + f.length) % f.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); f[(at <= 0 ? f.length : at) - 1]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); f[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); f[f.length - 1]?.focus(); }
    else if (e.key === "Tab") { close(true); }
  };

  const run = (a) => {
    if (a.disabled) return;
    close(true);
    a.onClick?.();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        {children || "⋮"}
      </button>

      {open && ReactDOM.createPortal(
        <div
          ref={panelRef}
          className="dkm-panel"
          role="menu"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            width,
            top: pos ? pos.top : 0,
            left: pos ? pos.left : 0,
            maxHeight: pos?.maxH || undefined,
            /* Rendered once at 0,0 to be measured. Hidden for that one frame
               so nobody sees it in the corner. */
            visibility: pos ? "visible" : "hidden",
          }}
        >
          {list.map((a, i) => {
            if (a === "-" || a.sep) return <div key={i} className="dkm-rule" role="separator" />;
            /* `custom` may be a function so non-action content (the category
               colour swatches) can dismiss the menu after it acts. */
            if (a.custom) return (
              <div key={i} className="dkm-custom">
                {typeof a.custom === "function" ? a.custom(() => close(true)) : a.custom}
              </div>
            );
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`dkm-item${a.danger ? " danger" : ""}`}
                disabled={!!a.disabled}
                title={a.hint || undefined}
                onClick={() => run(a)}
              >
                {a.icon ? <span className="dkm-ic">{a.icon}</span> : <span className="dkm-ic" aria-hidden="true" />}
                <span className="dkm-label">{a.label}</span>
                {/* WCAG 1.4.1: a red word is not a warning to anyone who
                    cannot see the red. Destructive options say so. */}
                {a.danger ? <span className="dkm-flag">destructive</span> : null}
                {a.disabled && a.hint ? <small className="dkm-hint">{a.hint}</small> : null}
              </button>
            );
          })}
          {!rows.length && !list.length ? <div className="dkm-empty">No actions</div> : null}
        </div>,
        document.body
      )}
    </>
  );
}

export default RowMenu;
