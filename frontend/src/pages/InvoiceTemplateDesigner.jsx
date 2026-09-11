/**
 * InvoiceTemplateDesigner.jsx — the Custom Invoice Builder (print-template designer).
 *
 * Not to be confused with the InvoiceBuilder in pages/Invoices.jsx, which is the
 * Create Invoice / sale entry panel. Two components once shared that name and a
 * fix landed on the wrong one; this is the designer.
 *
 * A section rail on the left, an editor for the chosen section in the middle,
 * and a live preview on the right rendered by the very same function that
 * prints the real invoice, so the preview cannot lie.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api.js";
import { toast, confirmDialog } from "../lib/ui.jsx";
import { customHtml } from "../lib/print.js";
import { parseTemplate, defaultTemplate, PLACEHOLDERS, ITEM_COLUMNS } from "../lib/template.js";
import { Icon } from "../lib/icons.jsx";

const SECTIONS = [
  ["details", "Template Details", "M4 5h16v14H4z|M8 9h8|M8 13h5"],
  ["title", "Title", "M5 6h14|M9 6v12|M5 18h8"],
  ["logo", "Logo", "M4 5h16v14H4z|M8 11a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3|M4 16l5-4 4 3 3-2 4 3"],
  ["business", "Business info", "M4 8h16v12H4z|M9 8V5h6v3|M9 13h6"],
  ["client", "Client info", "M4 5h16v14H4z|M9 11a2 2 0 1 0 0-4a2 2 0 0 0 0 4|M6 17c.9-2 2-3 3-3s2.1 1 3 3"],
  ["columns", "Item Columns", "M4 5h16v14H4z|M4 9h16|M10 9v10|M15 9v10"],
  ["meta", "Custom Fields", "M4 6h16|M4 12h16|M4 18h10"],
  ["labels", "Labels", "M4 7h12l4 5-4 5H4z|M8 12h.01"],
  ["header", "Header", "M4 5h16v5H4z|M4 14h16|M4 18h10"],
  ["footer", "Footer", "M4 6h16|M4 10h10|M4 15h16v4H4z"],
  ["style", "Style", "M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2s-.9-2-2-2h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 0-10|M7.5 9.5h.01|M11 7h.01|M16 9.5h.01"],
  ["notes", "Notes", "M6 3h12v18H6z|M9 8h6|M9 12h6|M9 16h4"],
];

/* A fake but realistic invoice, so the preview shows a full page from the start. */
const DEMO_INV = {
  invoice_no: "INV-000001", invoice_date: new Date().toISOString().slice(0, 10),
  due_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
  doc_title: "INVOICE", sales_rep_name: "Salim A.", reference: "PO-4471",
  sub_total: 260000, discount_total: 10000, tax_total: 45000,
  grand_total: 295000, paid_amount: 100000, balance_due: 195000,
  party: { name: "Kampala Traders Ltd", organization: "Kampala Traders Ltd",
           phone: "0700 000 001", email: "accounts@kampalatraders.ug",
           address: "Plot 14, Nakasero Road, Kampala", tin: "1000123456", balance: 195000 },
  lines: [
    { description: "Cement 50kg", item_description: "Portland, grade 42.5", hsn_sac: "2523", quantity: 4, unit: "BAG", rate: 42000, discount_pct: 0, gst_rate: 18, line_total: 168000 },
    { description: "Sugar 1kg", item_description: "Refined white", hsn_sac: "1701", quantity: 10, unit: "PCS", rate: 5000, discount_pct: 5, gst_rate: 18, line_total: 47500 },
    { description: "Software installation", item_description: "On-site, half day", quantity: 1, unit: "SVC", rate: 45000, discount_pct: 0, gst_rate: 0, line_total: 45000 },
  ],
};

function Ic({ d, size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {String(d).split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export default function InvoiceTemplateDesigner({ onClose, onSaved }) {
  const [tpl, setTpl] = useState(defaultTemplate);
  const [st, setSt] = useState({});
  const [sec, setSec] = useState("details");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const areaRef = useRef(null);

  useEffect(() => {
    api.get("/settings")
      .then((d) => { setSt(d.values || {}); setTpl(parseTemplate((d.values || {}).print_custom_template)); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  /* Deliberately NO Escape-to-close here. This is the print-template designer:
     everything on it is unsaved work until Save is pressed, and a template is
     laid out over many minutes, so a stray Escape throwing it away is worse than
     one click on Cancel. The Escape shortcut the backlog asked for belongs to
     the Create Invoice panel, in pages/Invoices.jsx, which is where it now is. */

  const set = (patch) => setTpl((t) => ({ ...t, ...patch }));
  const setStyle = (patch) => setTpl((t) => ({ ...t, style: { ...t.style, ...patch } }));
  const setLabel = (k, v) => setTpl((t) => ({ ...t, labels: { ...t.labels, [k]: v } }));

  /* The preview is the real printer, pointed at demo data. */
  const html = useMemo(() => {
    try {
      return customHtml({ inv: DEMO_INV, partyName: DEMO_INV.party.name,
        firm: { name: st.firm_name || "SALJO TECH", address: st.firm_address || "Fort Portal, Uganda",
                phone: st.firm_phone || "0700 123 456", email: st.firm_email || "sales@example.com",
                tin: st.firm_tin || "1000999888" },
        taxes: [{ name: "VAT", rate: 18, mode: "add", amount: 45000 }], st, tpl });
    } catch (e) { return `<pre style="padding:20px;color:#b00">Preview error: ${e.message}</pre>`; }
  }, [tpl, st]);

  /* Insert a placeholder at the cursor in whichever textarea is focused. */
  const insert = (key) => {
    const el = areaRef.current;
    const token = `{%${key}%}`;
    if (!el) return toast("Click into a text box first, then pick a placeholder");
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    const next = el.value.slice(0, s) + token + el.value.slice(e);
    const field = el.dataset.field;
    set({ [field]: next });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + token.length; });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.put("/settings", { print_custom_template: JSON.stringify(tpl), print_theme_regular: "custom" });
      toast("Template saved — invoices will print with this layout");
      onSaved && onSaved();
      onClose();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const reset = async () => {
    if (!(await confirmDialog({ title: "Reset template?", body: "This puts every section back to the starting layout. Nothing else is affected.", confirmLabel: "Reset" }))) return;
    setTpl(defaultTemplate());
  };

  const Area = ({ field, rows = 6, hint }) => (
    <>
      <textarea ref={areaRef} data-field={field} rows={rows} className="ib-area"
                value={tpl[field] || ""} onFocus={(e) => { areaRef.current = e.target; }}
                onChange={(e) => set({ [field]: e.target.value })} />
      {hint && <div className="ib-hint">{hint}</div>}
    </>
  );

  return (
    /* No dismiss-on-backdrop: these hold part-built documents, and losing one
     to a stray click is worse than one extra click to leave. Close via the
     X in the header, or Cancel. */
    <div className="slide-veil">
      <div className="slide-panel ib-shell" onClick={(e) => e.stopPropagation()}>
        <div className="ib-top">
          <h2>Custom Invoice Builder</h2>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={reset}>Reset</button>
          <button className="btn btn-ghost" onClick={onClose}><Icon n="close" size={14} /> Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !loaded}>
            {busy ? "Saving…" : "💾 Save"}
          </button>
        </div>

        <div className="ib-body">
          <div className="ib-rail">
            {SECTIONS.map(([id, label, icon]) => (
              <button key={id} className={`ib-tab ${sec === id ? "on" : ""}`} onClick={() => setSec(id)}>
                <Ic d={icon} /> {label}
              </button>
            ))}
          </div>

          <div className="ib-edit">
            {sec === "details" && (
              <>
                <h3>Template Details</h3>
                <label className="ib-lbl">Template name</label>
                <input value={tpl.name} onChange={(e) => set({ name: e.target.value })} />
                <div className="ib-hint">Only you see this — it names the layout, not the invoice.</div>
              </>
            )}
            {sec === "title" && (
              <>
                <h3>Title</h3>
                <label className="ib-lbl">Document title</label>
                <Area field="title" rows={2} hint="Leave the placeholder in to let the document type set itself (Invoice, Tax Invoice, Quote)." />
              </>
            )}
            {sec === "logo" && (
              <>
                <h3>Logo</h3>
                <label className="ib-check">
                  <input type="checkbox" checked={!!tpl.showLogo} onChange={(e) => set({ showLogo: e.target.checked })} />
                  Show the company logo on this template
                </label>
                <div className="ib-hint">
                  The logo image itself is set in Settings → Print. If “Print company logo” is off there, it stays off everywhere.
                </div>
              </>
            )}
            {sec === "business" && (
              <>
                <h3>Business info</h3>
                <label className="ib-lbl">Your details block</label>
                <Area field="business" hint="A line whose placeholders are all empty is dropped, so a missing TIN leaves no blank gap." />
              </>
            )}
            {sec === "client" && (
              <>
                <h3>Client info</h3>
                <label className="ib-lbl">Bill-to block</label>
                <Area field="client" />
              </>
            )}
            {sec === "columns" && (
              <>
                <h3>Item Columns</h3>
                <div className="ib-hint" style={{ marginTop: 0 }}>Pick the columns for the item table. Name, Qty, Price and Subtotal are always shown.</div>
                {ITEM_COLUMNS.map((c) => (
                  <label key={c.key} className="ib-check">
                    <input type="checkbox" disabled={c.always}
                           checked={c.always || (tpl.columns || []).includes(c.key)}
                           onChange={(e) => set({ columns: e.target.checked
                             ? [...(tpl.columns || []), c.key]
                             : (tpl.columns || []).filter((x) => x !== c.key) })} />
                    {c.label}{c.always && <span className="ib-tag">always</span>}
                  </label>
                ))}
              </>
            )}
            {sec === "meta" && (
              <>
                <h3>Custom Fields</h3>
                <div className="ib-hint" style={{ marginTop: 0 }}>Rows shown in the small table beside the bill-to block.</div>
                {["invoice_no", "invoice_date", "due_date", "reference", "sales_rep", "client_tin"].map((k) => (
                  <label key={k} className="ib-check">
                    <input type="checkbox" checked={(tpl.meta || []).includes(k)}
                           onChange={(e) => set({ meta: e.target.checked
                             ? [...(tpl.meta || []), k]
                             : (tpl.meta || []).filter((x) => x !== k) })} />
                    {tpl.labels?.[k] || k}
                  </label>
                ))}
              </>
            )}
            {sec === "labels" && (
              <>
                <h3>Labels</h3>
                <div className="ib-hint" style={{ marginTop: 0 }}>Rename anything printed on the invoice — useful for another language or house style.</div>
                {["billTo", "invoice_no", "invoice_date", "due_date", "sub_total", "tax_total", "grand_total", "paid_amount", "balance_due"].map((k) => (
                  <div key={k} className="ib-row">
                    <span>{k.replace(/_/g, " ")}</span>
                    <input value={tpl.labels?.[k] || ""} onChange={(e) => setLabel(k, e.target.value)} />
                  </div>
                ))}
              </>
            )}
            {sec === "header" && (<><h3>Header</h3><label className="ib-lbl">Printed above everything</label><Area field="header" rows={4} /></>)}
            {sec === "footer" && (<><h3>Footer</h3><label className="ib-lbl">Printed at the bottom</label><Area field="footer" rows={4} /></>)}
            {sec === "notes" && (<><h3>Notes</h3><label className="ib-lbl">Printed under the totals</label><Area field="notes" rows={4} /></>)}
            {sec === "style" && (
              <>
                <h3>Style</h3>
                <div className="ib-row"><span>Accent colour</span>
                  <input type="color" value={tpl.style?.accent || "#2F6FE0"} onChange={(e) => setStyle({ accent: e.target.value })} /></div>
                <div className="ib-row"><span>Base font size</span>
                  <input type="number" min="9" max="16" value={tpl.style?.font || 12} onChange={(e) => setStyle({ font: Number(e.target.value) })} /></div>
                <label className="ib-check">
                  <input type="checkbox" checked={tpl.style?.showGrid !== false} onChange={(e) => setStyle({ showGrid: e.target.checked })} /> Table grid lines
                </label>
                <label className="ib-check">
                  <input type="checkbox" checked={tpl.style?.headerBg !== false} onChange={(e) => setStyle({ headerBg: e.target.checked })} /> Filled table header
                </label>
              </>
            )}

            {["title", "business", "client", "header", "footer", "notes"].includes(sec) && (
              <div className="ib-ph">
                <div className="ib-ph-head">Placeholders — click to insert at the cursor</div>
                {PLACEHOLDERS.map((g) => (
                  <div key={g.group} className="ib-ph-grp">
                    <div className="ib-ph-name">{g.group}</div>
                    {g.items.map(([k, label]) => (
                      <button key={k} className="ib-chip" onClick={() => insert(k)} title={`{%${k}%}`}>{label}</button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ib-prev">
            <div className="ib-prev-head">Live preview · sample data</div>
            <iframe title="Invoice preview" className="ib-frame" srcDoc={html} />
          </div>
        </div>
      </div>
    </div>
  );
}
