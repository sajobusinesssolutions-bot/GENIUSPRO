import React, { useState, useMemo } from "react";
import api from "../lib/api.js";
import { Empty, toast, DateRangePicker, confirmDialog } from "../lib/ui.jsx";
import { code128Svg } from "../lib/barcode.js";
import { inr as inrFmt, cur as curSym } from "../lib/tax.js";
import { Icon } from "../lib/icons.jsx";
import { printReportNode } from "../lib/print.js";

/* The tools, in bands. Five loose buttons in a row said nothing about which
   of them was safe to press — "Import items" and "Verify my data" are very
   different kinds of act, and both looked identical. They are grouped by what
   they do to the shop's data now: bring it in, take it out, look at it, or
   change it. */
const TOOL_BANDS = [
  ["Bringing data in", [
    ["import",  "Import items", "A spreadsheet of products, matched column by column"],
  ]],
  ["Taking data out", [
    ["export",  "Export to a spreadsheet", "Any part of the books as CSV, for Excel or an accountant"],
    ["barcode", "Barcode labels", "Print shelf and product labels for anything you sell"],
  ]],
  ["Looking at the data", [
    ["verify",     "Health check", "Confirms the books balance and stock matches its ledger"],
    ["duplicates", "Find duplicates", "Items and customers entered twice under slightly different names"],
    ["storage",    "What is in here", "How much this business has recorded, and since when"],
    ["audit",      "Audit log", "Every void, price change and deletion, and who did it"],
  ]],
];

export default function Utilities() {
  const [tab, setTab] = useState("import");
  const current = TOOL_BANDS.flatMap(([, rows]) => rows).find(([id]) => id === tab);

  return (
    <div className="dk-tools">
      <nav className="dk-card flush dk-tools-nav" aria-label="Data tools">
        {TOOL_BANDS.map(([band, rows]) => (
          <div className="dk-tools-band" key={band}>
            <div className="cap">{band}</div>
            {rows.map(([id, label, note]) => (
              <button key={id} className={`dk-tools-item ${tab === id ? "on" : ""}`}
                      aria-current={tab === id ? "true" : undefined}
                      onClick={() => setTab(id)}>
                <span className="nm">{label}</span>
                <span className="s">{note}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="dk-tools-body">
        {current && (
          <div className="dk-tools-title">
            <h2>{current[1]}</h2>
            <p>{current[2]}</p>
          </div>
        )}
        {tab === "import" && <ImportItems />}
        {tab === "export" && <ExportData />}
        {tab === "barcode" && <Barcodes />}
        {tab === "verify" && <Verify />}
        {tab === "duplicates" && <Duplicates />}
        {tab === "storage" && <Storage />}
        {tab === "audit" && <AuditLog />}
      </div>
    </div>
  );
}

/* ── Duplicates ───────────────────────────────────────────────────────────
 *
 * The commonest mess in a shop's data, and nothing looked for it. Two items
 * called the same thing means stock split across both and a reorder figure
 * that is wrong for each; two customers on one phone number means a debt
 * that reads as settled on one card and outstanding on the other.
 *
 * It reports and does not merge. Merging is a decision with consequences —
 * which name survives, whose balance is right — and belongs to a person
 * looking at the two records, not to a button on a list.
 */
const DUP_KINDS = [
  ["item_names",    "Items with the same name",        "Stock is split between them, and each shows a reorder figure that is wrong"],
  ["item_barcodes", "Items sharing a barcode",         "A scan at the till can only pick one of them, and it may not be the one on the shelf"],
  ["party_names",   "Customers or suppliers named the same", "A statement sent to one of them will be missing what is on the other"],
  ["party_phones",  "Two records on one phone number", "Usually the same person entered twice — reminders will go out twice as well"],
];

function Duplicates() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setD(await api.get("/utilities/duplicates")); } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  const found = d ? DUP_KINDS.reduce((a, [k]) => a + ((d[k] || []).length), 0) : 0;

  return (
    <div className="dk-card">
      <div className="dk-card-head">
        <h3>Duplicates</h3>
        <button className="dk-sbtn primary" onClick={run} disabled={busy}>
          {busy ? "Looking…" : d ? "Check again" : "Look for duplicates"}
        </button>
      </div>
      {!d ? (
        <Empty icon="⧉" title="Nothing checked yet"
               hint="Looks for items and parties entered more than once — by name, by barcode and by phone number." />
      ) : found === 0 ? (
        <Empty icon="✓" title="No duplicates found"
               hint="Every item and every party in this business is entered once." />
      ) : (
        <div className="dk-dups">
          {DUP_KINDS.map(([key, title, why]) => {
            const rows = d[key] || [];
            if (!rows.length) return null;
            return (
              <section key={key}>
                <h4>{title}<span className="n dk-n">{rows.length}</span></h4>
                <p>{why}</p>
                <ul>
                  {rows.map((r) => (
                    <li key={r.k}>
                      <b>{r.names}</b>
                      <span className="dk-n">{r.n} records</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="dk-dups-note">
            Nothing here has been changed. Open the two records and decide which to keep —
            merging is a judgement about whose balance and whose name is right, and the app
            should not make it for you.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── What is in here ──────────────────────────────────────────────────────
 * "Is this getting big?" and "how far back does it go?" had nowhere to be
 * asked. Row counts and the oldest invoice date answer both.
 */
function Storage() {
  const [d, setD] = useState(null);
  const [failed, setFailed] = useState(false);
  React.useEffect(() => {
    api.get("/utilities/storage").then(setD).catch(() => setFailed(true));
  }, []);

  if (failed) return <div className="dk-card"><div className="dk-empty">Could not read the figures.</div></div>;
  if (!d) return <div className="dk-card"><div className="dk-empty">Counting…</div></div>;

  const max = Math.max(1, ...d.tables.map((t) => t.rows));
  return (
    <div className="dk-card">
      <div className="dk-card-head">
        <h3>Records in this business</h3>
        <span className="n dk-n">
          {inrFmt(d.total)} in total{d.oldest ? ` · trading recorded since ${d.oldest}` : ""}
        </span>
      </div>
      <div className="dk-storage">
        {d.tables.map((t) => (
          <div className="row" key={t.table}>
            <span className="nm">{t.label}</span>
            <span className="bar"><i style={{ width: `${Math.max(2, (t.rows / max) * 100)}%` }} /></span>
            <b className="v dk-n">{inrFmt(t.rows)}</b>
          </div>
        ))}
      </div>
      <div className="dk-storage-foot">
        Everything here lives in one file on this computer. Settings → Backup writes a copy of it,
        and Sync keeps one on the server.
      </div>
    </div>
  );
}

/* Split a CSV line, honouring "quoted, fields" and doubled "" escapes. */
function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/* Read the file into a header row + raw rows. Mapping happens in step 2. */
function parseCsvTable(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { header: [], rows: [] };
  return { header: splitCsvLine(lines[0]), rows: lines.slice(1).map(splitCsvLine) };
}

/* The item fields the import can fill, and the header names we auto-detect. */
const IMPORT_FIELDS = [
  { key: "name", label: "Item Name", required: true, aliases: ["name", "item name", "itemname", "item", "description", "product"] },
  { key: "item_code", label: "Item Code / SKU", aliases: ["item code", "itemcode", "sku", "code", "barcode"] },
  { key: "unit", label: "Unit", aliases: ["unit", "uom", "units"] },
  { key: "sale_price", label: "Sale Price", aliases: ["sale price", "saleprice", "selling price", "price", "rate", "mrp"] },
  { key: "purchase_price", label: "Purchase Price", aliases: ["purchase price", "purchaseprice", "cost", "cost price", "buying price"] },
  { key: "opening_stock", label: "Opening Stock", aliases: ["opening stock", "openingstock", "stock", "quantity", "qty", "on hand"] },
  { key: "reorder_level", label: "Reorder Level", aliases: ["reorder level", "reorderlevel", "minimum stock", "min stock", "low stock"] },
];

const norm = (h) => String(h || "").trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
/* Guess a column for each field from the file's header row. */
function autoMap(header) {
  const m = {};
  for (const f of IMPORT_FIELDS) {
    const i = header.findIndex((h) => f.aliases.includes(norm(h)));
    if (i >= 0) m[f.key] = String(i);
  }
  return m;
}

function ImportItems() {
  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [onDuplicate, setOnDuplicate] = useState("skip");
  const [map, setMap] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const table = useMemo(() => parseCsvTable(text), [text]);
  const mapped = useMemo(() => {
    if (map.name == null || map.name === "") return [];
    return table.rows.map((cells) => {
      const r = {};
      for (const f of IMPORT_FIELDS) {
        const ci = map[f.key];
        if (ci != null && ci !== "") r[f.key] = cells[Number(ci)] ?? "";
      }
      return r;
    }).filter((r) => (r.name || "").trim());
  }, [table, map]);

  const readFile = (file) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast("That file is over 25 MB", "bad");
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result);
      const t = parseCsvTable(raw);
      if (!t.header.length) return toast("Could not read any columns from that file", "bad");
      /* Stay on step 1: the wizard has real Next/Back controls now, so the
         file arriving must not yank the page out from under the reader. */
      setText(raw); setFileName(file.name); setMap(autoMap(t.header));
      toast(`${file.name} read — ${t.rows.length} row${t.rows.length === 1 ? "" : "s"} found`);
    };
    reader.readAsText(file);
  };

  const run = async () => {
    if (!mapped.length) return toast("Nothing to import", "bad");
    setBusy(true);
    try {
      const r = await api.post("/utilities/import-items", { rows: mapped, on_duplicate: onDuplicate });
      setResult(r);
      toast(`Import finished — ${r.created} added${r.updated ? `, ${r.updated} updated` : ""}${r.skipped ? `, ${r.skipped} skipped` : ""}`);
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const reset = () => { setStep(1); setText(""); setFileName(""); setMap({}); setResult(null); };
  const sample = () => {
    fetch("/api/utilities/sample-items-csv", { headers: { Authorization: `Bearer ${localStorage.getItem("vy_token")}` } })
      .then((r) => r.blob())
      .then((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "sample-items.csv"; a.click(); })
      .catch(() => toast("Could not fetch the sample file", "bad"));
  };

  const Steps = () => (
    <div className="wiz-steps">
      {[[1, "Configure"], [2, "Map Fields"], [3, "Preview"]].map(([n, label], i) => (
        <React.Fragment key={n}>
          {i > 0 && <span className="wiz-line" />}
          <span className={`wiz-step ${step === n ? "on" : ""} ${step > n ? "done" : ""}`}>
            <span className="n">{step > n ? "✓" : n}</span>{label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <div className="panel w-wide">
      <div className="panel-head">
        <h2>Items — Import</h2>
        {fileName && <span style={{ color: "var(--muted)", fontSize: 13.5 }}>{fileName}</span>}
      </div>
      <div style={{ padding: 18 }}>
        <Steps />

        {step === 1 && (
          <>
            <div className={`wiz-drop ${dragOver ? "over" : ""}`}
                 onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                 onDragLeave={() => setDragOver(false)}
                 onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files[0]); }}>
              <div className="ic">⤓</div>
              <div className="big">Drag and drop a file to import</div>
              <label className="btn btn-primary" style={{ cursor: "pointer" }}>
                Choose File
                <input type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }}
                       onChange={(e) => readFile(e.target.files[0])} />
              </label>
              <div className="meta">Maximum file size: 25 MB · File format: CSV or TSV</div>
            </div>
            <p className="wiz-note">
              Download a{" "}
              {/* 93x15 as plain text; padded out to a 28px-tall target. */}
              <a href="#" onClick={(e) => { e.preventDefault(); sample(); }}
                 style={{ display: "inline-flex", alignItems: "center", minHeight: 28, padding: "0 4px" }}>sample CSV file</a>{" "}
              and compare it to your import file to be sure the columns line up.
            </p>
            <div className="wiz-dup">
              {/* Not marked required: it is already answered — "Skip" is the
                  default and one of the two is always selected. */}
              <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 4 }}>
                Duplicate Handling
              </div>
              {[["skip", "Skip Duplicates", "Keeps the items already on file and ignores matching rows in the import file."],
                ["overwrite", "Overwrite items", "Imports the duplicates and updates the existing items with what the file says."]].map(([v, title, note]) => (
                <label className="opt" key={v} style={{ minHeight: 28, alignItems: "center" }}>
                  <input type="radio" name="on-duplicate" checked={onDuplicate === v} onChange={() => setOnDuplicate(v)}
                         style={{ width: 18, height: 18, margin: "5px 5px 5px 0", flex: "none" }} />
                  <span className="txt"><b>{title}</b>{note}</span>
                </label>
              ))}
            </div>
            <div className="wiz-foot">
              <button className="btn btn-ghost" disabled title="You are on the first step">← Back</button>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {!fileName && <span style={{ color: "var(--muted)", fontSize: 13.5 }}>Choose a file to continue</span>}
                <button className="btn btn-primary" disabled={!fileName || !table.header.length}
                        onClick={() => setStep(2)}>Next: Map fields</button>
              </span>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="wiz-note" style={{ marginTop: 0 }}>
              We matched your columns to item fields where the names lined up. Change anything that looks wrong —
              <b> Item Name</b> is the only one that must be mapped.
            </p>
            <div className="wiz-map">
              <table className="tw" style={{ margin: 0 }}>
                <thead><tr><th style={{ width: "36%" }}>Item field</th><th>Column in your file</th><th>First value</th></tr></thead>
                <tbody>
                  {IMPORT_FIELDS.map((f) => {
                    const ci = map[f.key];
                    const preview = ci != null && ci !== "" && table.rows[0] ? table.rows[0][Number(ci)] : "";
                    return (
                      <tr key={f.key}>
                        <td>{f.label}{f.required && <span style={{ color: "var(--bad)" }}> *</span>}</td>
                        <td>
                          <select value={ci ?? ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}>
                            <option value="">— not imported —</option>
                            {table.header.map((h, i) => <option key={i} value={String(i)}>{h || `Column ${i + 1}`}</option>)}
                          </select>
                        </td>
                        <td style={{ color: "var(--muted)", fontSize: 12.5, fontWeight: 500 }}>{preview || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="wiz-foot">
              <button className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
              <button className="btn btn-primary" disabled={map.name == null || map.name === ""}
                      onClick={() => setStep(3)}>Next: Preview</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            {result ? (
              <>
                <div style={{ padding: "10px 0 4px", fontSize: 13.5 }}>
                  <b>{result.created}</b> items added
                  {result.updated ? <> · <b>{result.updated}</b> updated</> : null}
                  {result.skipped ? <> · <b>{result.skipped}</b> skipped</> : null}
                </div>
                {result.problems?.length > 0 && (
                  <div className="wiz-note">
                    Rows we could not use: {result.problems.map((p) => `row ${p.row} (${p.reason})`).join(", ")}
                  </div>
                )}
                <div className="wiz-foot">
                  <button className="btn btn-ghost" onClick={reset}>Import another file</button>
                  <button className="btn btn-primary"
                          onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "items" } }))}>
                    Go to Items
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="wiz-note" style={{ marginTop: 0 }}>
                  {mapped.length} row{mapped.length === 1 ? "" : "s"} ready ·
                  duplicates will be <b>{onDuplicate === "skip" ? "skipped" : "overwritten"}</b>.
                  Showing the first 10.
                </p>
                <div className="wiz-map">
                  <table className="tw" style={{ margin: 0 }}>
                    <thead><tr>
                      {IMPORT_FIELDS.filter((f) => map[f.key] != null && map[f.key] !== "").map((f) => (
                        <th key={f.key} className={f.key.includes("price") || f.key.includes("stock") || f.key.includes("level") ? "amt" : ""}>{f.label}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {mapped.slice(0, 10).map((r, i) => (
                        <tr key={i}>
                          {IMPORT_FIELDS.filter((f) => map[f.key] != null && map[f.key] !== "").map((f) => (
                            <td key={f.key} className={f.key.includes("price") || f.key.includes("stock") || f.key.includes("level") ? "amt num" : ""}>
                              {r[f.key] || "—"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="wiz-foot">
                  <button className="btn btn-ghost" onClick={() => setStep(2)}>← Back to mapping</button>
                  <button className="btn btn-primary" disabled={busy || !mapped.length} onClick={run}>
                    {busy ? "Importing…" : `Import ${mapped.length} item${mapped.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* Two exports — items and parties — became seven. A shop asked by its
   accountant for "last year's sales as a spreadsheet" had no way to produce
   one from this screen and was reduced to printing a report and typing it
   back in. The list comes from the server so it cannot drift from what the
   server can actually produce. */
function ExportData() {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState("");

  React.useEffect(() => {
    api.get("/utilities/exports").then(setList).catch(() => setList([]));
  }, []);

  const dl = (id, name) => {
    setBusy(id);
    fetch(`/api/utilities/export/${id}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("vy_token")}` },
    })
      .then((r) => { if (!r.ok) throw new Error("Export failed"); return r.blob(); })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        URL.revokeObjectURL(a.href);
        toast(`${name} downloaded`);
      })
      .catch(() => toast("That export did not come through", "bad"))
      .finally(() => setBusy(""));
  };

  return (
    <div className="dk-card">
      <div className="dk-card-head"><h3>Export to a spreadsheet</h3></div>
      {list === null ? (
        <div className="dk-empty">Loading…</div>
      ) : (
        <div className="dk-exports">
          {list.map((e) => (
            <button key={e.id} disabled={busy === e.id} onClick={() => dl(e.id, e.name)}>
              <span className="ic" aria-hidden="true"><Icon n="download" size={16} /></span>
              <span className="t">
                <span className="nm">{e.label}</span>
                <span className="fn dk-n">{e.name}</span>
              </span>
              <span className="go">{busy === e.id ? "…" : "\u2193"}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dk-storage-foot">
        Every file is CSV and opens straight in Excel or Google Sheets. Amounts are plain
        numbers with no currency symbol, so the spreadsheet can add them up.
      </div>
    </div>
  );
}

function Barcodes() {
  const [items, setItems] = React.useState([]);
  const [itemId, setItemId] = React.useState("");
  const [text, setText] = React.useState("");
  const [count, setCount] = React.useState(12);
  React.useEffect(() => { api.get("/items").then(setItems).catch(() => {}); }, []);
  const item = items.find((i) => i.id === Number(itemId));
  const value = text || (item ? (item.barcode || item.item_code || `ITEM-${String(item.id).padStart(4, "0")}`) : "");
  const svg = value ? code128Svg(value) : "";

  const printSheet = () => {
    if (!svg) return;
    const w = window.open("", "_blank");
    const label = `<div style="display:inline-block;text-align:center;margin:6px;padding:6px;border:1px dashed #ccc">
      ${item ? `<div style="font:600 11px sans-serif;margin-bottom:2px">${item.name}</div>` : ""}
      ${svg}
      ${item ? `<div style="font:700 12px sans-serif;margin-top:2px">${curSym()} ${inrFmt(item.sale_price)}</div>` : ""}
    </div>`;
    w.document.write(`<html><body style="margin:8px">${label.repeat(Number(count) || 1)}</body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  return (
    <div className="panel w-mid">
      <div className="panel-head"><h2>Barcode generator (Code 128)</h2></div>
      <div style={{ padding: 18 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <select value={itemId} onChange={(e) => { setItemId(e.target.value); setText(""); }}
                  style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
            <option value="">Pick an item…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <input placeholder="…or type any code" value={text} onChange={(e) => setText(e.target.value)}
                 style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8 }} />
        </div>
        {svg ? (
          <>
            <div style={{ textAlign: "center", padding: 16, background: "#fff", border: "1px solid var(--border)", borderRadius: 10 }}
                 dangerouslySetInnerHTML={{ __html: svg }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
              <span style={{ fontSize: 13.5, color: "var(--muted)" }}>Labels per sheet</span>
              <input type="number" value={count} onChange={(e) => setCount(e.target.value)}
                     style={{ width: 70, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 8, textAlign: "right" }} />
              <button className="btn btn-primary" onClick={printSheet}><Icon n="print" size={15} /> Print label sheet</button>
            </div>
            <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 10 }}>
              Scanning this barcode in POS finds the item instantly (the search box matches barcodes too).
            </p>
          </>
        ) : <Empty icon="▌" title="Choose an item or type a code" />}
      </div>
    </div>
  );
}

function Verify() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setResult(await api.get("/utilities/verify")); } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  /* The stock check could always say the cached figure had drifted from the
     movement ledger, and then offer nothing but "contact support". The ledger
     is the record and the cache is derived from it, so the repair is
     arithmetic rather than a judgement — and it is now a button. */
  const stockFailed = !!(result && result.checks.some(
    (c) => /stock cache/i.test(c.name) && !c.ok));

  const repair = async () => {
    if (!(await confirmDialog({
      title: "Recompute stock from the ledger?",
      message: "Every stock figure is added up again from the movements that produced it.",
      detail: "Nothing in your history changes — the movement ledger is the record and it is only being read. Items kept in batches are left alone, because their batches carry expiry dates the ledger does not hold.",
      confirmLabel: "Recompute stock",
    }))) return;
    setBusy(true);
    try {
      const r = await api.post("/utilities/repair-stock", {});
      toast(r.message || "Stock recomputed");
      setResult(await api.get("/utilities/verify"));
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  return (
    <div className="dk-card">
      <div className="dk-card-head">
        <h3>Health check</h3>
        <button className="dk-sbtn primary" onClick={run} disabled={busy}>
          {busy ? "Checking…" : result ? "Run again" : "Run checks"}
        </button>
      </div>
      {!result ? (
        <Empty icon="✓" title="Nothing checked yet"
               hint="Confirms your books balance, stock matches its ledger, and every invoice adds up." />
      ) : (
        <>
          <div className="dk-checks">
            {result.checks.map((c, i) => (
              <div className={`row ${c.ok ? "ok" : "bad"}`} key={i}>
                <span className="mk" aria-hidden="true">{c.ok ? "\u2713" : "!"}</span>
                <span className="nm">{c.name}</span>
                <span className="dt dk-n">{c.detail}</span>
              </div>
            ))}
          </div>
          <div className={`dk-checks-foot ${result.healthy ? "ok" : "bad"}`}>
            <span>
              {result.healthy
                ? "Everything adds up. Your books balance and your stock matches its ledger."
                : "Something does not add up. The detail beside each failed line says by how much."}
            </span>
            {stockFailed && (
              <button className="dk-sbtn primary" onClick={repair} disabled={busy}>
                Recompute stock from the ledger
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}


/* ── Audit log ────────────────────────────────────────────────────────────
 *
 * Twenty-five places in the server write to `audit_logs` — every void, every
 * price change, every deleted invoice, every restore — and until now nothing
 * displayed a single one of them. A record kept where nobody can read it is
 * not a record. This is the screen for the morning the drawer is short.
 *
 * Read-only by construction: there is no route that edits or deletes an entry,
 * so there is no button here that pretends to.
 */
function AuditLog() {
  const [rows, setRows] = React.useState(null);
  const [meta, setMeta] = React.useState({ total: 0, pages: 1, modules: [] });
  const [q, setQ] = React.useState("");
  const [mod, setMod] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [failed, setFailed] = React.useState(false);
  const paper = React.useRef(null);

  const load = () => {
    const sp = new URLSearchParams({ page: String(page), limit: "100" });
    if (q) sp.set("q", q);
    if (mod) sp.set("module", mod);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    setFailed(false);
    api.get(`/system/audit?${sp}`)
      .then((d) => { setRows(d.rows || []); setMeta({ total: d.total, pages: d.pages, modules: d.modules || [] }); })
      .catch(() => { setRows([]); setFailed(true); });
  };
  React.useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); },
    [page, q, mod, from, to]);
  React.useEffect(() => { setPage(1); }, [q, mod, from, to]);

  const csv = () => {
    const head = ["When", "Who", "Module", "Action", "Reference", "Detail"];
    const body = (rows || []).map((r) => [r.created_at, r.who, r.module, r.action, r.entity_id ?? "", r.detail ?? ""]);
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const text = [head, ...body].map((line) => line.map(esc).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="dk-card flush" ref={paper}>
      <div className="dk-card-head">
        <h3>Audit log</h3>
        <span className="sub" style={{ marginLeft: 10 }}>
          {meta.total ? `${meta.total} recorded action${meta.total === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      <div className="list-filters no-print">
        <input placeholder="Search what was done, or who did it…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="dk-input" style={{ width: 180, height: 38 }} value={mod} onChange={(e) => setMod(e.target.value)}>
          <option value="">Everything</option>
          {meta.modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <DateRangePicker from={from} to={to} align="left" allLabel="All dates"
                         onChange={(r) => { setFrom(r.from); setTo(r.to); }} />
        {(q || mod || from || to) && (
          <button className="btn btn-ghost" onClick={() => { setQ(""); setMod(""); setFrom(""); setTo(""); }}>Clear</button>
        )}
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={csv}><Icon n="download" size={14} /> Export CSV</button>
        <button className="btn btn-ghost" onClick={() => printReportNode(paper.current, {
          title: "Audit log",
          caption: from || to ? `${from || "start"} to ${to || "today"}` : "All dates",
        })}><Icon n="print" size={14} /> Print</button>
      </div>

      <div className="dk-scrollx">
        <table className="dk-table">
          <thead>
            <tr><th>When</th><th>Who</th><th>Module</th><th>Action</th><th>Ref</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {failed ? (
              <tr><td colSpan={6}><Empty icon="!" title="Could not load the audit log"
                    sub="It needs the settings permission." /></td></tr>
            ) : rows === null ? (
              <tr><td colSpan={6} style={{ color: "var(--muted)" }}>Reading the log…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6}><Empty icon="◷" title="Nothing recorded yet"
                    sub="Voids, deletions, price changes and restores appear here as they happen." /></td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{String(r.created_at || "").replace("T", " ")}</td>
                <td>{r.who}</td>
                <td style={{ textTransform: "capitalize" }}>{r.module}</td>
                <td><span className="pill">{r.action}</span></td>
                <td className="num">{r.entity_id ?? "—"}</td>
                <td style={{ color: "var(--faint)" }}>{r.detail || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {meta.pages > 1 && (
        <div className="no-print" style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 18px" }}>
          <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
          <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Page {page} of {meta.pages}</span>
          <button className="btn btn-ghost" disabled={page >= meta.pages} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      )}
    </div>
  );
}
