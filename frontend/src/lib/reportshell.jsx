// reportshell.jsx — the common furniture every report screen needs.
//
// Modelled on the SACCO Manager report layout: a printed company header, a
// totals band, then a table that can be sorted, trimmed to the columns you
// care about, exported and printed. Built once here so all ten reports gain
// it together rather than each growing its own half-version.
import React from "react";
import { Icon } from "./icons.jsx";
import { Empty } from "./ui.jsx";

/* ── Paper colours ────────────────────────────────────────────────────────
 *
 * A shop running the app in dark mode printed every one of the 58 reports as
 * an empty ruled grid. Nothing was hidden and nothing failed to render: the
 * page went to the printer with the dark theme's text colour still on it —
 * #E7EAF0, which is 1.18:1 against white paper. The browser drops the dark
 * *background* when it prints (background graphics are off by default), so the
 * paper stayed white and the figures came out as ghost-grey, while the table
 * rules, which are drawn in a dark colour in dark mode, printed perfectly.
 * That is exactly the page the shopkeeper photographed: DATE / DESCRIPTION /
 * ACCOUNT / IN / OUT / RUNNING, ruled and empty, with the odd figure showing
 * through wherever a value happened to be painted in a semantic colour.
 *
 * The screen theme is a choice about a screen. Paper is always white, so the
 * printed report is pinned to paper colours here rather than left to inherit
 * whatever the operator picked. Rewriting the design tokens (rather than
 * blanket-forcing every element to black) keeps the meaning that colour
 * carries — a negative profit still prints red, an overdue age still prints
 * red — while guaranteeing all of it is dark enough to read.
 *
 * The `!important` rules underneath the tokens exist because `styles.css` sets
 * a few literal dark-mode colours (`body[data-theme="dark"] td { color:#E7EAF0 }`
 * and friends) that a token cannot reach and that outrank a plain class rule.
 *
 * This lives in a component rather than in the stylesheet so the report screen
 * carries its own print contract: whoever adds report number 59 gets it.
 */
const PRINT_CSS = `
@media print {
  .dk-rp {
    --text:#111; --muted:#4A4A4A; --faint:#555; --border:#9A9A9A; --border-strong:#666;
    --ok:#0A6B2E; --good:#0A6B2E; --bad:#A0132A; --danger:#A0132A; --warn:#7A4A00;
    --primary:#173A6B; --accent:#173A6B;
    --card:#fff; --card-2:#fff; --bg:#fff; --panel:#fff;
    --ok-bg:#fff; --bad-bg:#fff; --warn-bg:#fff; --muted-bg:#fff;
    --primary-tint:#fff; --accent-tint:#fff; --sk-shine:#fff;
    color:#111 !important; background:#fff !important;
  }
  .dk-rp, .dk-rp .dk-card, .dk-rp .dk-tablecard, .dk-rp .rpt-totals,
  .dk-rp .sum-chip, .dk-rp .ha-card, .dk-rp table, .dk-rp thead, .dk-rp tbody, .dk-rp tfoot {
    background:#fff !important; background-image:none !important;
  }
  .dk-rp td, .dk-rp th { color:#111 !important; background:#fff !important; border-color:#9A9A9A !important; }
  .dk-rp h1, .dk-rp h2, .dk-rp h3, .dk-rp .sub,
  .dk-rp .rt-label, .dk-rp .rt-value, .dk-rp .sc-label, .dk-rp .sc-value,
  .dk-rp .l, .dk-rp .v, .dk-rp .s, .dk-rp .note, .dk-rp .rpt-count,
  .dk-rp .state-block, .dk-rp .state-block *, .dk-rp .dk-empty { color:#111 !important; }
  /* Chips and cards read as boxes only because of their fill on screen; with
     background graphics off they would print as unlabelled floating text. */
  .dk-rp .rpt-totals, .dk-rp .sum-chip, .dk-rp .ha-card { border:1px solid #9A9A9A !important; }
  /* The column headings are pinned to the top of the scrollport on screen
     (deck.css: .dk-rp-body .tw th { position: sticky }). On paper that pin
     collides with the repeating header group the print stylesheet asks for,
     and Chromium loses the fragmentation: a report longer than one page
     printed its first pageful of rows and then page after page carrying
     nothing but the column headings and the totals line. A 23-line profit
     report came out as one page of figures followed by four ruled, empty
     ones. Nothing sticks to anything on paper — there is no scrollport — so
     the pin simply comes off. */
  .dk-rp th { position: static !important; }
  /* The report card is a flex column with a scrolling body (deck.css:
     .dk-rp-body { flex:1; overflow:auto }). Chromium paginates block layout;
     it does not fragment a flex item across pages — it prints as much of it as
     fits on the first page and drops the rest, while the repeating header
     group keeps being emitted. That is how a 24-line stock movement report
     printed twelve lines and then a page carrying nothing but DATE / ITEM /
     DIR / QTY / REF / SOURCE. Laying the card out as plain blocks for print
     lets the table break across pages the ordinary way. */
  .dk-rp .dk-tablecard, .dk-rp .dk-rp-body, .dk-rp .dk-rp-head { display:block !important; }
  .dk-rp .dk-rp-body { flex:none !important; overflow:visible !important; }

  /* ── The table, as a business document ────────────────────────────────
   * A shop photographed a printed Z report whose rows had become tall bordered
   * boxes with the values stacked and pushed right. That is styles.css:663 —
   * the max-width:780px breakpoint that turns tables into cards for a
   * counter tablet — applying to paper, because A4 less Chrome's default 0.4in
   * margins is 717px. Putting the table back is global (deck.css, the block at
   * the very end: every printed .tw table had the fault, not only reports).
   *
   * What is left here is the report's own house style: a tight rule-per-row
   * grid rather than the airy screen spacing, so a fifty-line report is one
   * page and not three. The row-number column is headed "#" and holds
   * right-aligned numerals, so the heading is pinned to the same edge. */
  .dk-rp .rpt-table { font-size:8.5pt; }
  .dk-rp .rpt-table th, .dk-rp .rpt-table td { padding:2.5px 6px !important; line-height:1.35; }
  .dk-rp .rpt-table th.rpt-no, .dk-rp .rpt-table td.rpt-no {
    width:26px !important; text-align:right !important; padding-right:8px !important;
  }
  .dk-rp .rpt-table tbody td { border-bottom:1px solid #D2D2D2 !important; }
  .dk-rp .rpt-table tbody tr:last-child td { border-bottom:1.2px solid #555 !important; }
  /* Long text wraps inside its own column instead of forcing the table wider
     than the sheet, which is what pushes the right-hand columns off it — but a
     money column never wraps. An eleven-column report printed "Sh 42,000.0"
     with the last zero on the next line, and a figure broken across two lines
     is a figure nobody can read down a column. */
  .dk-rp .rpt-table td { overflow-wrap:break-word; }
  .dk-rp .rpt-table td.num, .dk-rp .rpt-table td.amt,
  .dk-rp .rpt-table tfoot td { white-space:nowrap; }
  /* Headings are the widest thing in a narrow money column; letting them wrap
     buys the figures their width back. */
  .dk-rp .rpt-table thead th { white-space:normal !important; }
}`;

/** Rendered once per report pane — see PRINT_CSS above. */
export function ReportPrintStyles() {
  return <style media="print" dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />;
}

/* ── Company header ───────────────────────────────────────────────────────
   Hidden on screen, shown when printing. A report that leaves the building
   without the firm's name on it is not much use to anyone receiving it. */
export function ReportPrintHeader({ firm = {}, settings = {}, title, caption }) {
  const st = settings || {};
  const on = (k, dflt = "1") => (st[k] ?? dflt) !== "0";
  const address = firm.address || st.firm_address;
  const phone = firm.phone || st.firm_phone;
  const email = firm.email || st.firm_email;
  const tin = firm.tin || st.firm_tin;

  return (
    <div className="rpt-print-head">
      <div className="rph-firm">{firm.name || st.firm_name || "—"}</div>
      <div className="rph-meta">
        {on("print_show_address") && address ? <span>{address}</span> : null}
        {on("print_show_phone") && phone ? <span>Tel {phone}</span> : null}
        {on("print_show_email", "0") && email ? <span>{email}</span> : null}
        {tin ? <span>TIN {tin}</span> : null}
      </div>
      <div className="rph-title">{title}</div>
      {caption ? <div className="rph-caption">{caption}</div> : null}
    </div>
  );
}

/* ── Totals band ──────────────────────────────────────────────────────────
   The two or three figures someone actually opened the report for, above the
   detail rather than buried at the foot of a long table. */
export function TotalsBand({ items = [] }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="rpt-totals">
      {shown.map((t, i) => (
        <div key={i} className={`rt-cell ${t.tone ? `rt-${t.tone}` : ""}`}>
          <div className="rt-label">{t.label}</div>
          <div className="rt-value num">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

/* Values arrive already formatted for display, so sorting has to look past the
   thousands separators and currency prefix to the number underneath. Falls
   back to locale-aware text comparison for genuinely non-numeric columns. */
function compare(a, b) {
  const na = Number(String(a ?? "").replace(/[^\d.-]/g, ""));
  const nb = Number(String(b ?? "").replace(/[^\d.-]/g, ""));
  const bothNumeric = String(a ?? "").search(/\d/) >= 0 && String(b ?? "").search(/\d/) >= 0
    && !Number.isNaN(na) && !Number.isNaN(nb);
  if (bothNumeric) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}

function toCsv(cols, rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map((c) => cell(c.h)).join(",");
  const body = rows.map((r) => cols.map((c) => {
    const raw = c.fmt ? c.fmt(r[c.k], r) : r[c.k];
    /* fmt may return an element for on-screen use; fall back to the raw value
       so the export carries data rather than "[object Object]". */
    return cell(typeof raw === "object" && raw !== null ? r[c.k] : raw);
  }).join(",")).join("\n");
  return `${head}\n${body}`;
}

/**
 * ReportTable — sortable, column-selectable, exportable.
 *
 * Drop-in for the previous plain table: same `cols` / `rows` / `foot` shape,
 * so every report picked this up without being rewritten.
 */
export function ReportTable({
  cols, rows, foot, empty = "Nothing in this range",
  title = "report", numbered = true, onCount,
}) {
  const [sort, setSort] = React.useState(null);      // { k, dir }
  const [hidden, setHidden] = React.useState(() => new Set());
  const [picker, setPicker] = React.useState(false);
  const pickRef = React.useRef(null);

  React.useEffect(() => {
    if (!picker) return;
    const away = (e) => { if (pickRef.current && !pickRef.current.contains(e.target)) setPicker(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [picker]);

  const shownCols = cols.filter((c) => !hidden.has(c.k));

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.k === sort.k);
    const out = [...rows].sort((x, y) => {
      const a = col?.fmt ? col.fmt(x[col.k], x) : x[sort.k];
      const b = col?.fmt ? col.fmt(y[col.k], y) : y[sort.k];
      const av = typeof a === "object" ? x[sort.k] : a;
      const bv = typeof b === "object" ? y[sort.k] : b;
      return compare(av, bv);
    });
    return sort.dir === "desc" ? out.reverse() : out;
  }, [rows, sort, cols]);

  React.useEffect(() => { if (onCount) onCount(rows.length); }, [rows.length, onCount]);

  const cycle = (k) => setSort((s) =>
    !s || s.k !== k ? { k, dir: "asc" } : s.dir === "asc" ? { k, dir: "desc" } : null);

  const download = () => {
    const csv = toCsv(shownCols, sorted);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!rows.length) return <Empty title={empty} />;

  return (
    <>
      <div className="rpt-actions no-print">
        <span className="rpt-count">{rows.length} row{rows.length === 1 ? "" : "s"}</span>
        <div className="rpt-actions-r">
          {sort && (
            <button className="btn btn-ghost btn-sm" onClick={() => setSort(null)}>Clear sort</button>
          )}
          <div className="rpt-pick-wrap" ref={pickRef}>
            <button className="btn btn-ghost btn-sm" onClick={() => setPicker((p) => !p)}>
              Columns{hidden.size ? ` (${cols.length - hidden.size}/${cols.length})` : ""}
            </button>
            {picker && (
              <div className="rpt-pick">
                {cols.map((c) => (
                  <label key={c.k} className="rpt-pick-row">
                    <input
                      type="checkbox" checked={!hidden.has(c.k)}
                      onChange={() => setHidden((h) => {
                        const next = new Set(h);
                        /* Never let the last column be switched off — an empty
                           table reads as a broken report, not a filtered one. */
                        if (next.has(c.k)) next.delete(c.k);
                        else if (cols.length - next.size > 1) next.add(c.k);
                        return next;
                      })}
                    />
                    {c.h}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={download}>
            <Icon n="download" size={14} /> Export CSV
          </button>
          {/* Print lives once, in the report page toolbar (Reports.jsx). It calls
             window.print(), which takes the whole page either way, so a second
             copy here was the identical action twice on one screen. */}
        </div>
      </div>

      <table className="tw rpt-table">
        <thead>
          <tr>
            {numbered && <th className="rpt-no">#</th>}
            {shownCols.map((c) => {
              const active = sort && sort.k === c.k;
              return (
                <th key={c.k} className={`${c.num ? "amt" : ""} sortable ${active ? "sorted" : ""}`}
                    onClick={() => cycle(c.k)} title="Sort by this column">
                  {c.h}
                  <span className="sort-mark">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="hl">
              {numbered && <td className="rpt-no num">{i + 1}</td>}
              {shownCols.map((c) => (
                <td key={c.k} className={c.num ? "amt num" : ""}>
                  {c.fmt ? c.fmt(r[c.k], r) : r[c.k]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && foot.length ? (
          <tfoot>
            <tr>
              {numbered && <td className="rpt-no" />}
              {/* foot is aligned to the full `cols` array, so it has to be
                  filtered through the same visibility set or the totals slide
                  under the wrong headings the moment a column is hidden. */}
              {cols.map((c, i) => (hidden.has(c.k) ? null : (
                <td key={c.k} className={i > 0 ? "amt num" : ""}>{foot[i]}</td>
              )))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </>
  );
}
