import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, dualQty, cur} from "../lib/tax.js";
import { Modal, Field, Empty, toast, confirmDialog, RowMenu, StatusChip, SkeletonRows } from "../lib/ui.jsx";
import { code128Svg } from "../lib/barcode.js";
import { printInvoice } from "../lib/print.js";
/* Lazy, because it is a screen most days never open, and it pulls in the whole
   item list plus four column sets. */
const BulkUpdate = React.lazy(() => import("./BulkUpdate.jsx"));
import { SettingRow, settingsIn } from "../lib/settingsui.jsx";
import { Icon } from "../lib/icons.jsx";
import { plural } from "../lib/plural.js";
import { useRead, LoadFailed, FailedRows, figure } from "../lib/deckui.jsx";

/**
 * Items — master-detail with an Aronium toolbar, per-transaction ⋮ menu,
 * and a slide-in tabbed editor (Details · Price & tax · Stock control · Image & color).
 */
const COLORS = ["#2F9BDB", "#2EBD7F", "#E0A03C", "#E05B5B", "#8E6FD8", "#D86FB2", "#4CBCC7", "#7A8296"];

function Switch({ checked, onChange, label, note }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw-track" />
      <span>{label}{note ? <span className="sw-note">{note}</span> : null}</span>
    </label>
  );
}

/* ── Items, built to the design deck ────────────────────────────────────────
   Four tabs; products and services are master-detail, units and categories are
   a table beside a form. The layout is the deck's; every modal it opens —
   the editor, adjust, repack, ledger, serials, tags, bulk activate — is the
   one that was already here, because the deck redrew the screen, not the work
   it does.

   The three figures above the list are catalogue-wide, so they come from
   /items/overview rather than being summed from the loaded page.  */

const CAT_COLORS = ["#2EBD7F", "#2F9BDB", "#8E6FD8", "#E0A03C", "#E05B5B", "#D86FB2", "#4CBCC7", "#7A8296"];

/* A category with no colour chosen still needs one, and it must be the same
   colour every time the screen is drawn. */
function catColor(c) {
  if (c.color) return c.color;
  let h = 0;
  for (const ch of String(c.name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAT_COLORS[h % CAT_COLORS.length];
}

const n0 = (v) => Math.round(Number(v) || 0).toLocaleString("en-UG");

/* Green while there is plenty, amber as it approaches the reorder level, red
   at or under it. Items with no reorder level set are never "low".
   Returns a stock-health tone name from the `.val-` family: `val-<tone>`
   writes a figure in it, `seg-val-<tone>` fills a bar with it. Stock health,
   never money — a full shelf is not income. */
function stockTone(it) {
  const q = Number(it.on_hand) || 0;
  const re = Number(it.reorder_level) || 0;
  if (q < 0) return "loss";
  if (!re) return "good";
  if (q <= re) return "loss";
  if (q <= re * 1.8) return "watch";
  return "good";
}

const MOVE_TONE = {
  purchases: "good", purchase_returns: "accent",
  sales: "", sale_returns: "accent",
  adjustment: "warn", stock_take: "warn", repack: "warn", production: "good",
};

export default function Items({ initial }) {
  /* Another screen can ask for a particular tab — Settings sends people here
     for units and categories rather than keeping a second, thinner editor. */
  const [tab, setTab] = useState(() =>
    ["product", "service", "units", "categories"].includes(initial) ? initial : "product");
  const [all, setAll] = useState([]);
  const [selId, setSelId] = useState(null);
  const [svcId, setSvcId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [q, setQ] = useState("");
  /* Opens in the order the items were entered, not A–Z.
   *
   * A shop enters its items in the order it walks the shelves — the fast
   * movers first, then the rest — and that order carries real information
   * about the shop. Sorting it away by default meant the list you got back
   * after an import bore no relation to the file you imported, and finding
   * "the twelve I added this morning" was impossible. A–Z is still one click
   * away, and is the right answer when you are looking something up rather
   * than reading down. */
  const [sort, setSort] = useState("entry");
  /* Deactivated items are out of the list by default. An item is deactivated
     to get it off the shelf, and leaving it in the list marked "inactive" is
     leaving it on the shelf with a label on it. The toggle is here rather than
     buried in a menu because the first question anybody has after deactivating
     something is "where did it go". */
  const [showInactive, setShowInactive] = useState(false);
  const [overview, setOverview] = useState(null);
  const [cats, setCats] = useState([]);
  const [units, setUnits] = useState([]);
  const [toolOpen, setToolOpen] = useState(false);

  const [editor, setEditor] = useState(null);
  const [adjust, setAdjust] = useState(false);
  const [ledgerFor, setLedgerFor] = useState(null);
  const [repackFrom, setRepackFrom] = useState(null);
  const [serialsFor, setSerialsFor] = useState(null);
  const [ageing, setAgeing] = useState(false);
  const [tagsFor, setTagsFor] = useState(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [bulkActive, setBulkActive] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [stg, setStg] = useState({});

  /* Each of these four surfaces — the figures strip, the item list, the
     categories tab, the units tab — can fail on its own, so each carries its
     own flag rather than one page-wide "something broke". */
  const [ovFailed, readOv] = useRead();
  const [listFailed, readList] = useRead();
  const [catsFailed, readCats] = useRead();
  const [unitsFailed, readUnits] = useRead();

  const loadStg = () => api.get("/settings").then((d) => setStg(d.values || {})).catch(() => {});
  const loadOverview = () => readOv(api.get("/items/overview"), setOverview, null);
  const loadCats = () => readCats(api.get("/items/categories-summary"), setCats, []);
  const loadUnits = () => readUnits(api.get("/items/units-summary"), setUnits, []);
  const load = () => readList(api.get("/items"), setAll, []);

  useEffect(() => { loadStg(); load(); loadOverview(); }, []);
  useEffect(() => { if (tab === "categories") loadCats(); if (tab === "units") loadUnits(); }, [tab]);

  const isSvc = tab === "service";
  const activeId = isSvc ? svcId : selId;
  const setActiveId = isSvc ? setSvcId : setSelId;

  const rows = useMemo(() => {
    const t = q.toLowerCase().trim();
    const out = all
      .filter((i) => (isSvc ? i.item_type === "service" : (i.item_type || "product") === "product"))
      .filter((i) => showInactive || i.is_active !== 0)
      .filter((i) => {
        if (!t) return true;
        const hay = `${i.name} ${i.item_code || ""} ${i.barcode || ""}`.toLowerCase();
        return stg.enhanced_item_search === "1" ? t.split(/\s+/).every((w) => hay.includes(w)) : hay.includes(t);
      });
    const by = {
      quantity: (a, b) => (b.on_hand || 0) - (a.on_hand || 0),
      value: (a, b) => (b.on_hand || 0) * (b.purchase_price || 0) - (a.on_hand || 0) * (a.purchase_price || 0),
      recent: (a, b) => b.id - a.id,
      /* The order they went in. `id` is the insert order, which is also the
         row order of an imported file. */
      entry: (a, b) => a.id - b.id,
      lowest: (a, b) => (a.on_hand || 0) - (b.on_hand || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      name_desc: (a, b) => b.name.localeCompare(a.name),
      price_asc: (a, b) => (a.sale_price || 0) - (b.sale_price || 0),
      price_desc: (a, b) => (b.sale_price || 0) - (a.sale_price || 0),
    };
    return out.sort(by[sort] || by.entry);
  }, [all, isSvc, q, sort, stg, showInactive]);

  /* Keep a selection that exists. Changing tab or filtering the current pick
     away should land on something, not on an empty panel. */
  useEffect(() => {
    if (tab !== "product" && tab !== "service") return;
    if (rows.some((r) => r.id === activeId)) return;
    setActiveId(rows.length ? rows[0].id : null);
  }, [rows, tab]);

  useEffect(() => {
    if (!activeId) return setDetail(null);
    api.get(`/items/${activeId}`).then(setDetail).catch(() => setDetail(null));
  }, [activeId, all]);

  /* The toolbar ⋯ still needs its own dismissal; row menus close themselves. */
  useEffect(() => {
    if (!toolOpen) return;
    const close = () => setToolOpen(false);
    const key = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [toolOpen]);

  const doExport = () => {
    fetch("/api/utilities/export-items", { headers: { Authorization: `Bearer ${localStorage.getItem("vy_token")}` } })
      .then((r) => r.blob()).then((b) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = "items.csv"; a.click();
        toast("items.csv downloaded");
      }).catch(() => toast("Export failed", "bad"));
  };
  const printList = () => {
    const body = rows.map((i, ix) => `<tr><td>${ix + 1}</td><td>${i.name}</td><td>${i.unit}</td>
      <td style="text-align:right">${inr(i.sale_price)}</td><td style="text-align:right">${i.on_hand}</td></tr>`).join("");
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Price list</title><style>
      body{font-family:'Inter','Segoe UI',sans-serif;margin:30px}h2{margin:0 0 12px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{padding:7px 10px;border-bottom:1px solid #ddd;text-align:left}
      th{background:#F1F3F7;text-transform:uppercase;font-size:11px}</style></head><body>
      <h2>Price list — ${new Date().toLocaleDateString()}</h2>
      <table><tr><th>#</th><th>Item</th><th>Unit</th><th style="text-align:right">Price (${cur()})</th><th style="text-align:right">Stock</th></tr>${body}</table></body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  const counts = useMemo(() => ({
    product: listFailed ? null : all.filter((i) => (i.item_type || "product") === "product").length,
    service: listFailed ? null : all.filter((i) => i.item_type === "service").length,
    units: units.length || null,
    categories: cats.length || null,
  }), [all, units, cats, listFailed]);

  const createLabel = { product: "New product", service: "New service", units: "New unit", categories: "New category" }[tab];

  const removeItem = async (i) => {
    if (!(await confirmDialog({
      title: `Delete "${i.name}"?`,
      message: "If it already appears on documents it will be marked inactive instead, so history stays intact.",
      danger: true, confirmLabel: "Delete",
    }))) return;
    try {
      const r = await api.delete(`/items/${i.id}`);
      toast(r.deleted ? "Item deleted" : "Item had history — marked inactive");
      if (activeId === i.id) setActiveId(null);
      load(); loadOverview();
    } catch (e) { toast(e.message, "bad"); }
  };
  const toggleActive = async (i) => {
    try {
      await api.put(`/items/${i.id}`, { ...i, is_active: i.is_active === 0 ? 1 : 0 });
      toast(i.is_active === 0 ? `${i.name} is active` : `${i.name} is inactive`);
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {[["product", "Products"], ["service", "Services"], ["units", "Units"], ["categories", "Categories"]].map(([id, label]) => (
            <button key={id} className={`dk-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
              {label}{counts[id] != null && <span className="n dk-n">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {can("items", "create") && (
          <button className="dk-create" onClick={() => {
            if (tab === "product" || tab === "service") setEditor({ mode: "new", kind: tab });
            else document.getElementById(tab === "units" ? "dk-unit-name" : "dk-cat-name")?.focus();
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
            {createLabel}
          </button>
        )}
        <button className={`dk-tool ${toolOpen ? "on" : ""}`} aria-label="More" aria-expanded={toolOpen}
                onMouseDown={(e) => e.stopPropagation()} onClick={() => setToolOpen((v) => !v)}>⋯</button>

        {toolOpen && (
          <div className="dk-menu" onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => { setToolOpen(false); window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "utilities" } })); }}>Import from Excel</button>
            <button onClick={() => { setToolOpen(false); doExport(); }}>Export item list</button>
            <button onClick={() => { setToolOpen(false); printList(); }}>Print price list</button>
            <button onClick={() => { setToolOpen(false); detail ? setTagsFor(detail) : toast("Select an item first", "bad"); }}>Print barcode labels</button>
            <div className="rule" />
            <button onClick={() => { setToolOpen(false); setBulkOpen(true); }}>Bulk update…</button>
            <button onClick={() => { setToolOpen(false); setBulkActive(true); }}>Bulk activate / deactivate</button>
            <button onClick={() => { setToolOpen(false); setAgeing(true); }}>Stock ageing</button>
            <button onClick={() => { setToolOpen(false); setPrefsOpen(true); }}>Item preferences</button>
            <button onClick={() => { setToolOpen(false); load(); loadOverview(); toast("Refreshed"); }}>Refresh list</button>
          </div>
        )}
      </div>

      {(tab === "product" || tab === "service") && (
        <>
          {isSvc ? (
            <div className="dk-strip">
              <div>
                <div className="l">Service revenue</div>
                <div className="big dk-n">{figure(ovFailed, `${cur()} ${n0(overview?.services.revenue)}`)}</div>
                <div className="s">{ovFailed ? "figures did not load" : `${overview?.services.count ?? 0} services · ${overview?.services.salesSharePct ?? 0}% of sales · no stock held`}</div>
              </div>
              <div>
                <div className="l">Bookings</div>
                <div className="v dk-n">{figure(ovFailed, n0(overview?.services.bookings))}</div>
                <div className="s">{ovFailed ? "figures did not load" : "this month"}</div>
              </div>
              <div>
                <div className="l">Margin</div>
                <div className="v dk-n val-good">{figure(ovFailed, `${overview?.services.marginPct ?? 0}%`)}</div>
                <div className="s">{ovFailed ? "figures did not load" : "labour cost only"}</div>
              </div>
            </div>
          ) : (
            <div className="dk-strip">
              <div>
                <div className="l">Stock value at cost</div>
                {/* Never `Sh 0` off a failed read — a zero here reads as a
                    fact about the shelves. */}
                <div className="big dk-n">{figure(ovFailed, `${cur()} ${n0(overview?.products.stockValue)}`)}</div>
                <div className="s">
                  {ovFailed ? "figures did not load — retry above the list" : <>
                    {plural(overview?.products.count ?? 0, "product")} · {plural(overview?.products.categories ?? 0, "category", "categories")}
                    {overview?.products.dual ? ` · ${overview.products.dual} dual-unit item${overview.products.dual === 1 ? "" : "s"}` : ""}
                  </>}
                </div>
              </div>
              <div>
                <div className="l">Running out</div>
                <div className={`v dk-n ${!ovFailed && overview?.lowStock.count ? "val-loss" : "val-good"}`}>
                  {figure(ovFailed, `${overview?.lowStock.count ?? 0} items`)}
                </div>
                <div className="s">
                  {/* Two names, not three: the sub-line is a single clipped row
                      at the compact strip size. */}
                  {ovFailed ? "figures did not load"
                    : overview?.lowStock.count
                    ? `${overview.lowStock.names.slice(0, 2).join(" · ")}${overview.lowStock.count > 2 ? ` +${overview.lowStock.count - 2} more` : ""}`
                    : "nothing under its reorder level"}
                </div>
              </div>
              <div style={{ cursor: "pointer" }} onClick={() => setAgeing(true)} title="See how long this stock has been sitting">
                <div className="l">Dead stock 60d</div>
                <div className="v dk-n val-watch">{figure(ovFailed, `${cur()} ${n0(overview?.deadStock.value)}`)}</div>
                <div className="s">{ovFailed ? "figures did not load" : `${plural(overview?.deadStock.count ?? 0, "item")} unsold · 60 days or more`}</div>
              </div>
            </div>
          )}

          <div className="dk-md">
            <div className="dk-card flush">
              <div className="dk-search">
                <input className="dk-input" placeholder={isSvc ? "Search services…" : "Search items or scan…"}
                       value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {/* Sorting used to live three clicks away under ⋯, which is where
                  a setting goes, not where a way of reading a list goes. */}
              <div className="dk-listbar">
                <select className="dk-input dk-sortsel" value={sort} onChange={(e) => setSort(e.target.value)}
                        aria-label="Sort the list">
                  <option value="entry">As entered</option>
                  <option value="recent">Newest first</option>
                  <option value="name">A – Z</option>
                  <option value="name_desc">Z – A</option>
                  <option value="quantity">Most stock first</option>
                  <option value="value">Highest value first</option>
                  {!isSvc && <option value="lowest">Least stock first</option>}
                </select>
                <label className="dk-inactive-toggle" title="Deactivated items are hidden until you ask for them">
                  <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                  <span>Show deactivated</span>
                </label>
              </div>
              <div className="dk-list dk-s">
                {listFailed ? (
                  <LoadFailed what={isSvc ? "your services" : "your products"} onRetry={() => { load(); loadOverview(); }} />
                ) : rows.length === 0 ? (
                  <div className="dk-empty">{q ? "Nothing matches that search." : `No ${isSvc ? "services" : "products"} yet — add the first one.`}</div>
                ) : rows.map((i) => (
                  <div key={i.id} role="button" tabIndex={0}
                       className={`dk-row ${activeId === i.id ? "on" : ""}`}
                       onClick={() => setActiveId(i.id)}
                       onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveId(i.id); } }}>
                    <div className="main">
                      <div className="nm">{i.name}{i.is_active === 0 ? " · inactive" : ""}</div>
                      <div className="mt">
                        {[i.category_name, i.secondary_unit && i.conversion_rate > 0 ? `${i.unit} ⇄ ${i.secondary_unit}` : i.unit]
                          .filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="right">
                      <div className="pr dk-n">{cur()} {inr(i.sale_price)}</div>
                      <div className={`st dk-n ${isSvc ? "val-flat" : `val-${stockTone(i)}`}`}>
                        {isSvc ? i.item_code || `#${i.id}` : dualQty(i.on_hand, i.unit, i.secondary_unit, i.conversion_rate)}
                      </div>
                    </div>
                    {can("items", "edit") && (
                      <RowMenu label={`Actions for ${i.name}`} actions={[
                        { icon: <Icon n="edit" />, label: "Edit item", onClick: () => setEditor({ mode: "edit", item: i }) },
                        i.is_inventory === 1 && { icon: <Icon n="box" />, label: "Adjust stock", onClick: () => { setActiveId(i.id); setAdjust(true); } },
                        i.is_inventory === 1 && { icon: <Icon n="split" />, label: "Repack into smaller unit", onClick: () => setRepackFrom(i) },
                        { icon: <Icon n="list" />, label: "Stock ledger", onClick: () => setLedgerFor(i) },
                        { icon: <Icon n="tag" />, label: "Print barcode label", onClick: () => setTagsFor(i) },
                        { icon: <Icon n="eye" />, label: i.is_active === 0 ? "Mark active" : "Mark inactive", onClick: () => toggleActive(i) },
                        "-",
                        { icon: <Icon n="trash" />, label: "Delete item", danger: true, onClick: () => removeItem(i) },
                      ]} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="dk-detail dk-s">
              {listFailed && !detail ? <div className="dk-card"><LoadFailed what="this item" onRetry={load} /></div>
                : !detail ? <div className="dk-card"><div className="dk-empty">Pick something on the left to see it here.</div></div>
                : isSvc ? <ServiceDetail d={detail} onEdit={() => setEditor({ mode: "edit", item: detail })} />
                : <ProductDetail
                    d={detail}
                    onEdit={() => setEditor({ mode: "edit", item: detail })}
                    onAdjust={() => setAdjust(true)}
                    onRepack={() => setRepackFrom(detail)}
                    onLabel={() => setTagsFor(detail)}
                    onLedger={() => setLedgerFor(detail)}
                    onChanged={() => { load(); loadOverview(); }}
                  />}
            </div>
          </div>
        </>
      )}

      {tab === "units" && (unitsFailed
        ? <div className="dk-card"><LoadFailed what="your units" onRetry={loadUnits} /></div>
        : <UnitsTab units={units} onChanged={loadUnits} />)}
      {tab === "categories" && (catsFailed
        ? <div className="dk-card"><LoadFailed what="your categories" onRetry={loadCats} /></div>
        : <CategoriesTab cats={cats} onChanged={loadCats} />)}

      {editor && <SlideEditor edit={editor.mode === "edit" ? editor.item : null} kind={editor.kind}
        stg={stg}
        onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); load(); loadOverview(); toast("Item saved"); }} />}
      {tagsFor && <TagsPanel item={tagsFor} onClose={() => setTagsFor(null)} />}
      {/* Was `items={items}` — no such variable in this scope, so opening bulk
          activate threw. The list is `all`. */}
      {bulkActive && <BulkActivate items={all} onClose={() => setBulkActive(false)} onDone={() => { setBulkActive(false); load(); }} />}
      {bulkOpen && (
        <React.Suspense fallback={null}>
          {/* Reloads the list and the overview strip on the way out — a bulk
              reprice moves stock value, and leaving the figure behind it stale
              is the class of bug round nine spent a round on. */}
          <BulkUpdate onClose={() => setBulkOpen(false)}
                      onSaved={() => { load(); loadOverview(); }} />
        </React.Suspense>
      )}
      {prefsOpen && <ItemPrefs values={stg} onClose={() => setPrefsOpen(false)} onSaved={() => { setPrefsOpen(false); loadStg(); }} />}
      {serialsFor && <SerialsModal item={serialsFor} onClose={() => setSerialsFor(null)} />}
      {ageing && <AgeingModal onClose={() => setAgeing(false)} />}
      {repackFrom && <RepackModal from={repackFrom} items={all} onClose={() => setRepackFrom(null)} onDone={() => { setRepackFrom(null); load(); loadOverview(); }} />}
      {ledgerFor && <LedgerModal item={ledgerFor} onClose={() => setLedgerFor(null)} />}
      {adjust && detail && <AdjustModal item={detail} onClose={() => setAdjust(false)}
        onSaved={() => { setAdjust(false); load(); loadOverview(); toast("Stock adjusted"); }} />}
    </div>
  );
}

/* ── Product detail ───────────────────────────────────────────────────────
   The stock panel is the part the deck works hardest at: for a dual-unit item
   it draws one chip per whole base unit, part-filling the one that has been
   opened, so "9 bags and 20 loose kilos" is legible at a glance instead of
   being a number you have to decode. */
function ProductDetail({ d, onEdit, onAdjust, onRepack, onLabel, onLedger, onChanged }) {
  const conv = Number(d.conversion_rate) || 0;
  const dual = !!(d.secondary_unit && conv > 0);
  const onHand = Number(d.on_hand) || 0;
  const reorder = Number(d.reorder_level) || 0;
  const cost = Number(d.purchase_price) || 0;
  const sale = Number(d.sale_price) || 0;

  const whole = Math.floor(Math.max(0, onHand));
  const loose = dual ? Math.round((Math.max(0, onHand) - whole) * conv) : 0;
  const totalSec = dual ? onHand * conv : 0;

  /* The deck's own scale: enough room for the reorder level plus headroom.
     `cap` is the top of the scale in real units — it must track actual stock,
     because the label under the bar prints it. The chip count is capped
     separately at fourteen (more than that and they stop being countable), so
     one chip can stand for several units. These two used to be the same number,
     which is why 80 BAG on hand still read "14 BAG · 700 KG". */
  const cap = Math.max(Math.ceil(reorder * 1.6), Math.ceil(onHand) + 3, 8);
  const chipCount = Math.min(14, cap);
  const perChip = cap / chipCount;
  const chips = [];
  for (let k = 0; k < chipCount; k++) {
    const chipStart = k * perChip;
    const covered = Math.max(0, Math.min(perChip, onHand - chipStart));
    chips.push({ filled: covered >= perChip, partial: covered >= perChip ? 0 : covered / perChip });
  }
  const pct = Math.min(100, (onHand / cap) * 100).toFixed(1) + "%";
  const rePct = Math.min(100, (reorder / cap) * 100).toFixed(1) + "%";

  const margin = sale > 0 ? Math.round(((sale - cost) / sale) * 100) : 0;
  const markup = cost > 0 ? Math.round(((sale - cost) / cost) * 100) : 0;
  const tone = stockTone(d);

  /* Balance runs backwards from what is on the shelf now. */
  let running = onHand;
  const moves = (d.transactions || []).map((m) => {
    const sign = m.direction === "in" ? 1 : -1;
    const row = { ...m, balance: running, sign };
    running -= sign * (Number(m.quantity) || 0);
    return row;
  });

  return (
    <>
      <div className="dk-card">
        <div className="dk-dhead">
          <div style={{ minWidth: 0 }}>
            <h2>{d.name}</h2>
            <div className="dk-chips">
              <span className="dk-chip">{d.item_code || `#${d.id}`}</span>
              {d.category_name && <span className="dk-chip">{d.category_name}</span>}
              <span className="dk-chip">{dual ? `1 ${d.unit} = ${conv} ${d.secondary_unit}` : d.unit}</span>
              {d.price_change_allowed === 0 && <span className="dk-chip warn">🔒 fixed price</span>}
              {d.is_active === 0 && <span className="dk-chip bad">inactive</span>}
            </div>
          </div>
          {can("items", "edit") && (
            <div className="dk-dacts">
              {d.is_inventory === 1 && <button className="dk-sbtn" onClick={onAdjust}>Adjust</button>}
              {d.is_inventory === 1 && <button className="dk-sbtn" onClick={onRepack}>Repack</button>}
              <button className="dk-sbtn" onClick={onLabel}>Label</button>
              <button className="dk-sbtn primary" onClick={onEdit}>Edit item</button>
            </div>
          )}
        </div>

        <div className="dk-metrics">
          <div>
            <div className="l">Sale price</div>
            <div className="v dk-n">{cur()} {inr(sale)}</div>
            <div className="s">{dual && d.secondary_price ? `${d.secondary_unit} @ ${inr(d.secondary_price)}` : `per ${d.unit}`}</div>
          </div>
          <div>
            <div className="l">Cost</div>
            <div className="v dk-n">{cur()} {inr(cost)}</div>
            <div className="s">{dual ? `${inr(cost / conv)} per ${d.secondary_unit}` : "weighted average"}</div>
          </div>
          <div>
            <div className="l">Margin</div>
            <div className={`v dk-n ${margin >= 0 ? "val-good" : "val-loss"}`}>{margin}%</div>
            <div className="s">markup {markup}%</div>
          </div>
          <div>
            <div className="l">Stock value</div>
            <div className="v dk-n">{cur()} {inr(d.stock_value)}</div>
            {/* Base units, the same measure the dashboard's best sellers now
                use — the two were quoted in different units. */}
            <div className="s">{n0(d.sold_this_month)}{d.unit ? ` ${d.unit}` : ""} sold this month</div>
          </div>
        </div>
      </div>

      {d.is_inventory === 1 && (
        <div className="dk-card pad">
          <div className="dk-stock-top">
            <div>
              <div className="l" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)" }}>In stock</div>
              <div className="dk-stock-qty">
                <span className={`base dk-n val-${tone}`}>{dualQty(onHand, d.unit, null, 0)}</span>
                {dual && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <span className="swap">⇄</span>
                    <span className="sec dk-n">{n0(totalSec)} {d.secondary_unit}</span>
                  </span>
                )}
              </div>
            </div>
            {dual && (
              <div className="dk-pills">
                <span className="dk-pill accent">1 {d.unit} = {conv} {d.secondary_unit}</span>
                <span className="dk-pill">{loose > 0 ? `${n0(loose)} ${d.secondary_unit} loose` : "nothing opened"}</span>
                <span className="dk-pill">sell in either unit</span>
              </div>
            )}
          </div>

          {dual ? (
            <>
              <div className="dk-chipbar">
                {chips.map((c, k) => (
                  <div key={k} className="dk-unitchip"
                       style={{ borderColor: c.filled || c.partial ? "var(--accent)" : "var(--line)",
                                background: c.partial ? "var(--accent-soft)" : "var(--sunk)" }}>
                    <div className="fill" style={{ height: c.filled ? "100%" : c.partial ? `${Math.round(c.partial * 100)}%` : "0%" }} />
                  </div>
                ))}
              </div>
              <div className="dk-track">
                <div className="bar" style={{ width: pct }} />
                {reorder > 0 && <div className="mark" style={{ left: rePct }} />}
              </div>
              <div className="dk-scale">
                <span className="dk-n">0 {d.unit}</span>
                {reorder > 0 && <span className="re">↑ reorder at {n0(reorder)} {d.unit}</span>}
                <span className="dk-n">{cap} {d.unit} · {n0(cap * conv)} {d.secondary_unit}</span>
              </div>
              <div className="dk-tiles">
                <div className="dk-tile">
                  <div className="l">Whole {String(d.unit).toLowerCase()}s</div>
                  <div className="v dk-n">{n0(whole)} {d.unit}</div>
                  <div className="s">sealed, priced at {cur()} {inr(sale)}</div>
                </div>
                <div className="dk-tile">
                  <div className="l">Loose {String(d.secondary_unit).toLowerCase()}</div>
                  <div className={`v dk-n ${loose > 0 ? "val-watch" : "val-flat"}`}>{n0(loose)} {d.secondary_unit}</div>
                  <div className="s">opened {String(d.unit).toLowerCase()}s{d.secondary_price ? `, ${cur()} ${inr(d.secondary_price)} each` : ""}</div>
                </div>
                <div className="dk-tile">
                  <div className="l">If sold loose</div>
                  <div className="v dk-n val-good">{cur()} {inr(totalSec * (Number(d.secondary_price) || 0))}</div>
                  <div className="s">vs {cur()} {inr(onHand * sale)} by the {String(d.unit).toLowerCase()}</div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="dk-bar">
                <div className={`fill seg-val-${tone}`} style={{ width: pct }} />
                {reorder > 0 && <div className="mark" style={{ left: rePct }} />}
              </div>
              <div className="dk-scale">
                <span className="dk-n">0 {d.unit}</span>
                {reorder > 0 && <span className="re">↑ reorder at {n0(reorder)} {d.unit}</span>}
                <span className="dk-n">{cap} {d.unit}</span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="dk-card">
        <div className="dk-card-head">
          <h3>Movements</h3>
          <button className="dk-linkbtn" onClick={onLedger}>Full ledger ▸</button>
        </div>
        <div className="dk-scrollx">
        <table className="dk-table">
          <thead>
            <tr>
              <th>Type</th><th>Ref</th><th>Date</th>
              <th className="r">Qty</th><th className="r">Rate</th><th className="r">Balance</th>
              <th style={{ width: 52 }} />
            </tr>
          </thead>
          <tbody>
            {moves.length === 0 ? (
              <tr><td colSpan={7}><div className="dk-empty">Nothing has moved yet.</div></td></tr>
            ) : moves.map((m, i) => (
              <tr key={i}>
                <td><span className={`dk-tpill ${MOVE_TONE[m.source_module] || ""}`}>{String(m.source_module || "").replace(/_/g, " ")}</span></td>
                <td className="dk-n">{m.ref || "—"}</td>
                <td className="dk-n dim">{String(m.d).slice(0, 10)}</td>
                <td className={`r dk-n strong ${m.sign > 0 ? "val-good" : "val-loss"}`}>
                  {m.sign > 0 ? "+" : "−"}{n0(Math.abs(m.quantity))} {d.unit}
                </td>
                <td className="r dk-n">{cur()} {inr(m.unit_cost)}</td>
                <td className="r dk-n dim">{dualQty(m.balance, d.unit, null, 0)}</td>
                <td className="r"><TxnDots txn={m} item={d} onChanged={onChanged} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}

/* ── Service detail ───────────────────────────────────────────────────────
   A service holds no stock, so where a product shows shelf quantity this
   shows what has been booked. */
function ServiceDetail({ d, onEdit }) {
  const rate = Number(d.sale_price) || 0;
  const cost = Number(d.purchase_price) || 0;
  const margin = rate > 0 ? Math.round(((rate - cost) / rate) * 100) : 0;
  const bookings = d.bookings || [];

  return (
    <>
      <div className="dk-card">
        <div className="dk-dhead">
          <div style={{ minWidth: 0 }}>
            <h2>{d.name}</h2>
            <div className="dk-chips">
              <span className="dk-chip">{d.item_code || `#${d.id}`}</span>
              {d.category_name && <span className="dk-chip">{d.category_name}</span>}
              <span className="dk-chip">per {d.unit}</span>
              {d.is_active === 0 && <span className="dk-chip bad">inactive</span>}
            </div>
          </div>
          {can("items", "edit") && (
            <div className="dk-dacts">
              <button className="dk-sbtn primary" onClick={onEdit}>Edit service</button>
            </div>
          )}
        </div>
        <div className="dk-metrics">
          <div>
            <div className="l">Rate</div>
            <div className="v dk-n">{cur()} {inr(rate)}</div>
            <div className="s">per {d.unit}</div>
          </div>
          <div>
            <div className="l">Cost</div>
            <div className="v dk-n">{cur()} {inr(cost)}</div>
            <div className="s">labour and materials</div>
          </div>
          <div>
            <div className="l">Margin</div>
            <div className={`v dk-n ${margin >= 0 ? "val-good" : "val-loss"}`}>{margin}%</div>
            <div className="s">no stock is held</div>
          </div>
          <div>
            <div className="l">Booked</div>
            <div className="v dk-n">{cur()} {inr(d.booked_total)}</div>
            <div className="s">{bookings.length} booking{bookings.length === 1 ? "" : "s"} on file</div>
          </div>
        </div>
      </div>

      <div className="dk-card">
        <div className="dk-card-head"><h3>Bookings</h3></div>
        <table className="dk-table">
          <thead>
            <tr><th>Ref</th><th>Customer</th><th>Date</th><th>Staff</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            {bookings.length === 0 ? (
              <tr><td colSpan={5}><div className="dk-empty">Nothing booked yet.</div></td></tr>
            ) : bookings.map((b, i) => (
              <tr key={i}>
                <td className="dk-n strong">{b.ref}</td>
                <td>{b.party}</td>
                <td className="dk-n dim">{String(b.d).slice(0, 10)}</td>
                <td className="dim">{b.staff || "—"}</td>
                <td className="r dk-n strong">{cur()} {inr(b.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Units ────────────────────────────────────────────────────────────────
   A unit is not a conversion on its own; an item is what links two of them.
   The table reports the pairings items have actually set up. */
function UnitsTab({ units, onChanged }) {
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [busy, setBusy] = useState(false);
  const pairs = units.filter((u) => u.conv).length;

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post("/settings/units", { name: name.trim(), short: (short || name).trim().toUpperCase() });
      setName(""); setShort(""); onChanged(); toast("Unit added");
    } catch (e) { toast(e.message, "bad"); } finally { setBusy(false); }
  };

  return (
    <div className="dk-md wide">
      <div className="dk-card flush">
        <div className="dk-card-head">
          <h3>Units of measure</h3>
          <span className="n">{units.length} units · {pairs} conversion pair{pairs === 1 ? "" : "s"} in use</span>
        </div>
        <div className="dk-list dk-s">
          <table className="dk-table">
            <thead><tr><th>Unit</th><th>Short</th><th>Converts to</th><th className="r">Items</th></tr></thead>
            <tbody>
              {units.length === 0 ? <tr><td colSpan={4}><div className="dk-empty">No units yet.</div></td></tr>
                : units.map((u) => (
                <tr key={u.id}>
                  <td className="strong">{u.name}</td>
                  <td className="dk-n dim">{u.short}</td>
                  <td>{u.conv ? <span className="dk-tpill accent">{u.conv}</span> : <span className="dim">—</span>}</td>
                  <td className="r dk-n">{u.items}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dk-card pad" style={{ alignSelf: "start" }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>Add a unit</h3>
        <p className="note" style={{ margin: "0 0 20px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>
          A unit becomes a conversion pair only when an item links two of them — set that on the item, not here.
        </p>
        <div className="dk-form">
          <label className="dk-field">
            <span>Full name</span>
            <input id="dk-unit-name" className="dk-input" placeholder="Bag" value={name}
                   onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          <label className="dk-field">
            <span>Short code</span>
            <input className="dk-input" placeholder="BAG" value={short}
                   onChange={(e) => setShort(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          <button className="dk-save" onClick={save} disabled={busy || !name.trim()}>Save unit</button>
        </div>
      </div>
    </div>
  );
}

/* ── Categories ───────────────────────────────────────────────────────── */
function CategoriesTab({ cats, onChanged }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(CAT_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const totalItems = cats.reduce((a, c) => a + c.items, 0);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post("/settings/categories", { name: name.trim() });
      const fresh = await api.get("/items/categories-summary");
      const made = fresh.find((c) => c.name === name.trim());
      if (made) await api.put(`/settings/categories/${made.id}`, { color });
      setName(""); onChanged(); toast("Category added");
    } catch (e) { toast(e.message, "bad"); } finally { setBusy(false); }
  };

  const recolour = async (c, hex) => {
    try { await api.put(`/settings/categories/${c.id}`, { color: hex }); onChanged(); }
    catch (e) { toast(e.message, "bad"); }
  };
  const remove = async (c) => {
    if (!(await confirmDialog({
      title: `Delete "${c.name}"?`,
      message: `${c.items} item${c.items === 1 ? "" : "s"} will keep their details and simply lose this grouping.`,
      danger: true, confirmLabel: "Delete",
    }))) return;
    try { await api.delete(`/settings/categories/${c.id}`); onChanged(); toast("Category removed"); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="dk-md wide">
      <div className="dk-card flush">
        <div className="dk-card-head">
          <h3>Item categories</h3>
          <span className="n">{cats.length} categories · {totalItems} products</span>
        </div>
        <div className="dk-list dk-s">
          <table className="dk-table">
            <thead>
              <tr>
                <th>Category</th><th className="r">Items</th><th className="r">Stock value</th>
                <th className="r">Sold</th><th className="r">Margin</th><th style={{ width: 52 }} />
              </tr>
            </thead>
            <tbody>
              {cats.length === 0 ? <tr><td colSpan={6}><div className="dk-empty">No categories yet.</div></td></tr>
                : cats.map((c) => (
                <tr key={c.id}>
                  <td className="strong">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                      <i className="dk-catdot" style={{ background: catColor(c) }} />{c.name}
                    </span>
                  </td>
                  <td className="r dk-n">{c.items}</td>
                  <td className="r dk-n strong">{cur()} {inr(c.stockValue)}</td>
                  <td className="r dk-n dim">{n0(c.sold)}</td>
                  <td className={`r dk-n strong ${c.marginPct == null ? "val-flat" : "val-good"}`}>
                    {c.marginPct == null ? "—" : `${c.marginPct}%`}
                  </td>
                  <td className="r">
                    <RowMenu label={`Actions for ${c.name}`} width={214} actions={[
                      { custom: (close) => (
                        <>
                          <div className="dkm-cap">Colour</div>
                          <div className="dk-swatchrow" style={{ padding: "2px 7px 6px" }}>
                            {CAT_COLORS.map((hex) => (
                              <button key={hex} className={`dk-catswatch ${catColor(c) === hex ? "on" : ""}`}
                                      style={{ background: hex }} aria-label={`Colour ${hex}`}
                                      onClick={() => { close(); recolour(c, hex); }} />
                            ))}
                          </div>
                        </>
                      ) },
                      "-",
                      { icon: <Icon n="trash" />, label: "Delete category", danger: true, onClick: () => remove(c) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dk-card pad" style={{ alignSelf: "start" }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>Add a category</h3>
        <p className="note" style={{ margin: "0 0 20px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>
          Categories group items on the till and in reports. The colour is what marks the row here and the button at the till.
        </p>
        <div className="dk-form">
          <label className="dk-field">
            <span>Name</span>
            <input id="dk-cat-name" className="dk-input" placeholder="Groceries" value={name}
                   onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          <div className="dk-field">
            <span>Colour</span>
            <div className="dk-swatchrow">
              {CAT_COLORS.map((hex) => (
                <button key={hex} className={`dk-catswatch ${color === hex ? "on" : ""}`}
                        style={{ background: hex }} aria-label={hex} onClick={() => setColor(hex)} />
              ))}
            </div>
          </div>
          <button className="dk-save" onClick={save} disabled={busy || !name.trim()}>Save category</button>
        </div>
      </div>
    </div>
  );
}

/* ── ⋮ menu per transaction: preview/print the source doc, reverse adjustments ── */
function TxnDots({ txn, item, onChanged }) {

  const preview = async () => {
    if (txn.source_module === "sales" && txn.source_id) {
      try {
        const inv = await api.get(`/sales/${txn.source_id}`);
        printInvoice(inv, inv.party_name || "Customer");
      } catch (e) { toast(e.message, "bad"); }
    } else if (txn.source_module === "purchases") {
      window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "purchases" } }));
    } else if (txn.source_module === "sale_returns" || txn.source_module === "purchase_returns") {
      window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "invoices" } }));
    } else toast("Opening stock / adjustment — nothing to print");
  };
  const reverse = async () => {
    if (!(await confirmDialog({ message: `Reverse this adjustment (${txn.direction === "in" ? "+" : "−"}${txn.quantity} ${item.unit})?`, danger: false, confirmLabel: "Reverse adjustment" }))) return;
    try {
      await api.post(`/items/${item.id}/adjust`, {
        direction: txn.direction === "in" ? "out" : "in",
        quantity: txn.quantity, note: "Reversal of earlier adjustment",
      });
      toast("Adjustment reversed"); onChanged();
    } catch (e) { toast(e.message, "bad"); }
  };
  /* Uses the shared RowMenu, which renders the menu into <body> at fixed
     coordinates and flips it upwards near the bottom of the window. The menu
     here used to be absolutely positioned inside the scrolling panel, so it was
     cut off at the panel edge — the last rows in the list were unusable. */
  /* A stock movement is not editable in itself — it is the shadow of whatever
     document produced it. So "edit" opens that document where it can be
     changed properly, and "delete" reverses it through the same route the
     document's own screen would use. Adjustments have no document, so they
     reverse directly. */
  const openSource = (mode) => {
    if (txn.source_module === "sales" && txn.source_id) {
      window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "invoices" } }));
      /* After the page has mounted its listener. */
      setTimeout(() => window.dispatchEvent(
        new CustomEvent("vy-open-sale", { detail: { id: txn.source_id, mode } })), 60);
    } else if (txn.source_module === "purchases") {
      window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "purchases" } }));
      toast("Opened Purchases — find the bill to change it");
    } else {
      toast("This movement has no document behind it");
    }
  };

  const voidSource = async () => {
    if (txn.source_module !== "sales" || !txn.source_id) {
      return toast("Only sales can be voided from here", "bad");
    }
    if (!(await confirmDialog({
      title: "Void the sale behind this movement?",
      message: `This reverses the whole document, not just the ${item.name} line.`,
      detail: "Stock goes back on the shelf and the cash or credit is undone. The sale stays on record as voided.",
      danger: true, confirmLabel: "Void the sale",
    }))) return;
    try {
      await api.delete(`/sales/${txn.source_id}`);
      toast("Sale voided"); onChanged();
    } catch (e) { toast(e.message, "bad"); }
  };

  const isDoc = txn.source_module === "sales" || txn.source_module === "purchases";

  return (
    <RowMenu label={`Actions for this movement`} actions={[
      { icon: <Icon n="eye" />, label: "View / print", onClick: preview },
      isDoc && can("sales", "edit") &&
        { icon: <Icon n="edit" />, label: "Edit the document", onClick: () => openSource("edit") },
      txn.source_module === "sales" && can("sales", "delete") &&
        { icon: <Icon n="trash" />, label: "Void the sale", danger: true, onClick: voidSource },
      txn.source_module === "adjustment" && can("items", "edit") &&
        { icon: <Icon n="undo" />, label: "Reverse adjustment", danger: true, onClick: reverse },
    ]} />
  );
}

/* ── slide-in tabbed editor: Details · Price & tax · Stock control · Image & color ── */
/* `kind` is the tab the create button was pressed on — a new service should
   open as a service, which the old form ignored. */
function SlideEditor({ edit, kind, stg = {}, onClose, onSaved }) {
  const [units, setUnits] = useState([]);
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [barcodes, setBarcodes] = useState(edit ? (edit.barcodes || []).slice(1) : []);
  const [bcInput, setBcInput] = useState("");
  const [f, setF] = useState(edit ? {
    name: edit.name, item_code: edit.item_code || "", item_type: edit.item_type, unit: edit.unit, secondary_unit: edit.secondary_unit || "",
    conversion_rate: edit.conversion_rate || "", secondary_price: edit.secondary_price || "", sale_price: edit.sale_price, purchase_price: edit.purchase_price,
    category_id: edit.category_id || "", opening_stock: "", reorder_level: edit.reorder_level || "",
    markup_pct: edit.markup_pct || "", price_change_allowed: edit.price_change_allowed !== 0,
    is_active: edit.is_active !== 0, color: edit.color || "", default_qty: edit.default_qty || 1,
    sales_account_code: edit.sales_account_code || "", cogs_account_code: edit.cogs_account_code || "",
    track_serials: edit.track_serials === 1, image: edit.image || "", serials_text: "",
    is_inventory: edit.is_inventory !== 0,
  } : {
    name: "", item_code: "", item_type: kind === "service" ? "service" : "product",
    /* Settings → Items → "Default unit". A shop that sells everything by the
       bag was retyping BAG on every new item while a setting saying exactly
       that sat there doing nothing. */
    unit: (stg.default_unit || "PCS").toUpperCase(),
    secondary_unit: "", conversion_rate: "", secondary_price: "",
    sale_price: "", purchase_price: "", category_id: "", opening_stock: "", reorder_level: "",
    markup_pct: "", price_change_allowed: true, is_active: true, color: "", default_qty: 1,
    sales_account_code: "", cogs_account_code: "", track_serials: false, image: "", serials_text: "",
    is_inventory: kind !== "service",
  });
  const [accts, setAccts] = useState([]);
  /* "New unit" and "New category" without leaving a half-typed item behind.
     Both used to mean closing this form, crossing to another tab, making the
     thing, and starting the item again — so people typed the wrong unit
     instead. The popup makes it, reloads the list and selects it. */
  const [quick, setQuick] = useState(null);
  useEffect(() => { api.get("/accounting/accounts").then((a) => setAccts(a.filter((x) => x.status !== "disabled"))).catch(() => {}); }, []);

  /* A code, issued rather than typed.
   *
   * Typed by hand a thousand times, the same shelf ends up with HW-002, HW-2,
   * hw-002 and HW-02 — after which no search matches and no import lines up.
   * The server issues the next free one, because only the server can see every
   * item: two counters entering stock at once would otherwise be handed the
   * same code and the second would find out at save time.
   *
   * Only for a new item, and only while the box is untouched — somebody who
   * has typed their own code has said what they want. */
  const [codeAuto, setCodeAuto] = useState(!edit);
  useEffect(() => {
    if (edit || !codeAuto) return;
    api.get(`/items/next-code?type=${f.item_type === "service" ? "service" : "product"}`)
      .then((r) => r && r.code && setF((cur) => ({ ...cur, item_code: r.code })))
      .catch(() => {});
  }, [f.item_type, codeAuto, edit]);

  useEffect(() => {
    api.get("/settings/units").then(setUnits).catch(() => {});
    api.get("/settings/categories").then(setCats).catch(() => {});
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  /* ── cost, price and markup: any two give the third ──────────────────────
   *
   * The rule used to be one-directional — typing a cost recalculated the price
   * from a markup, and typing a price recalculated the markup from a cost —
   * with one gap that people actually hit: enter the selling price first, then
   * the cost, and the markup stayed empty, because changing the cost only ever
   * looked at the markup box.
   *
   * Which is the wrong way round. A shopkeeper knows two of these three and
   * wants to be told the third, and which two they know depends on the day:
   * "it cost me 35 and I sell it at 42, what am I making?" is the same
   * question as "it cost me 35 and I want 20%, what do I charge?".
   *
   * So each box fills in whatever it now can. The one being typed into is
   * never overwritten — that is the rule that stops the three fields chasing
   * each other while somebody is still typing.
   */
  const pct = (cost, sale) => (cost > 0 ? +((sale / cost - 1) * 100).toFixed(1) : "");
  const priceFrom = (cost, mk) => (cost > 0 ? +(cost * (1 + mk / 100)).toFixed(2) : "");

  const setCost = (e) => {
    const raw = e.target.value;
    const cost = Number(raw) || 0;
    const sale = Number(f.sale_price) || 0;
    const mk = Number(f.markup_pct) || 0;
    /* A price already on the form is what the shop charges; it is a fact, and
       the markup is what follows from it. Only when there is no price yet does
       the markup get to decide one. */
    if (sale > 0) return setF({ ...f, purchase_price: raw, markup_pct: pct(cost, sale) });
    if (mk) return setF({ ...f, purchase_price: raw, sale_price: priceFrom(cost, mk) });
    setF({ ...f, purchase_price: raw });
  };
  const setSale = (e) => {
    const raw = e.target.value;
    const sale = Number(raw) || 0, cost = Number(f.purchase_price) || 0;
    setF({ ...f, sale_price: raw, markup_pct: cost > 0 && sale > 0 ? pct(cost, sale) : f.markup_pct });
  };
  const setMarkup = (e) => {
    const raw = e.target.value;
    const mk = Number(raw) || 0, cost = Number(f.purchase_price) || 0;
    setF({ ...f, markup_pct: raw, sale_price: cost > 0 ? priceFrom(cost, mk) : f.sale_price });
  };
  const genBc = () => {
    const d = new Date();
    const base = ("20" + String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") + String(d.getHours()).padStart(2, "0") +
      String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0")).slice(0, 12);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
    const code = base + ((10 - (sum % 10)) % 10);
    if (!barcodes.includes(code)) setBarcodes([...barcodes, code]);
  };
  const addBc = () => {
    const c = bcInput.trim();
    if (!c) return;
    if (barcodes.includes(c)) return toast("Already added", "bad");
    setBarcodes([...barcodes, c]); setBcInput("");
  };



  const isService = f.item_type === "service";
  const conv = Number(f.conversion_rate) || 0;
  const dual = !!(f.secondary_unit && conv > 0);
  const stock = Number(f.opening_stock) || 0;

  /* Save and immediately start another — the difference between entering ten
     items and entering one item ten times. */
  const saveAnd = async (again) => {
    if (!f.name.trim()) return toast("Give it a name first", "bad");
    setBusy(true);
    try {
      /* `serials_text` belongs to the serials table, not to the item row. It
         is stripped here rather than left for the server to ignore, because a
         field the server silently drops is one nobody notices has stopped
         working. */
      const { serials_text, ...rest } = f;
      const body = { ...rest, category_id: f.category_id || null,
        price_change_allowed: f.price_change_allowed ? 1 : 0,
        is_active: f.is_active ? 1 : 0, barcodes };
      let itemId = edit ? edit.id : null;
      if (edit) {
        await api.put(`/items/${edit.id}`, body);
        for (const c of barcodes.filter((x) => !(edit.barcodes || []).includes(x))) {
          try { await api.post(`/items/${edit.id}/barcodes`, { barcode: c }); } catch (err) { toast(err.message, "bad"); }
        }
      } else {
        const made = await api.post("/items", body);
        itemId = made && (made.id || made.item_id);
      }

      /* The serials come second and are allowed to fail on their own: the item
         exists either way, and losing the item because one IMEI was typed
         twice would be the wrong trade. */
      const serials = String(serials_text || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      if (serials.length && itemId) {
        try {
          const r = await api.post("/serials/receive", { item_id: itemId, serials });
          toast(r.message || `${serials.length} serial numbers recorded`);
        } catch (err) {
          toast(`${f.name} was saved, but the serials were not: ${err.message}`, "bad");
        }
      }

      if (again) {
        toast(`${f.name} saved — next one`);
        /* Keep the settings that were just chosen; clear only what identifies
           this particular item. Entering a shelf of stock means the same
           category and unit over and over. */
        setF((s2) => ({ ...s2, name: "", item_code: "", sale_price: "", purchase_price: "", opening_stock: "", image: "", serials_text: "",
          opening_batch_no: "", opening_expiry_date: "" }));
        setBarcodes([]);
        setBusy(false);
        document.getElementById("dk-item-name")?.focus();
        return;
      }
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <>
    <div className="dk-form-veil">
      {/* No dismiss-on-backdrop: a part-filled item is worth more than one
          fewer click, and losing it to a stray click is the worse outcome. */}
      <div className="scrim" />
      <div className={`dk-formbox dk-s ${isService ? "service" : ""}`} role="dialog" aria-modal="true">
        <div className="dk-formhead">
          <div style={{ minWidth: 0 }}>
            <h2>{edit ? `Edit — ${edit.name}` : isService ? "New service" : "New product"}</h2>
            <div className="sub">
              {isService ? "Charged work — no stock is held" : "Stock-tracked item — set units and conversion below"}
            </div>
          </div>
          <button className="dk-mx" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="dk-formbody">
          <div className="dk-r2">
            <label className="dk-field">
              <span>{isService ? "Service name" : "Item name"}</span>
              <input id="dk-item-name" className="dk-input" value={f.name} onChange={set("name")} autoFocus
                     placeholder={isService ? "Name of the service" : "Name of the item"} />
            </label>
            <label className="dk-field">
              <span>{isService ? "Service code" : "Item code"}</span>
              <input className="dk-input" value={f.item_code || ""}
                     onChange={(e) => { setCodeAuto(false); setF({ ...f, item_code: e.target.value }); }}
                     placeholder="Left blank, one is chosen for you" />
              {codeAuto && !edit && f.item_code
                ? <small className="dk-hint">Chosen for you — type over it if your shelf uses its own codes.</small>
                : null}
            </label>
          </div>

          <div className="dk-r2">
            <label className="dk-field">
              <span>Category</span>
              <div className="dk-pickrow">
                <select className="dk-input" value={f.category_id} onChange={set("category_id")}>
                  <option value="">No category</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" className="dk-sbtn" onClick={() => setQuick("category")}>+ New</button>
              </div>
            </label>
            {/* The Type box only exists when the answer is still open.
                Pressing "New service" and then being asked whether this is a
                service is the app not listening — and on an item that already
                has stock, changing its type is not a decision a dropdown
                should make quietly. So: shown while editing something with no
                stock behind it, and never on the way in. */}
            {edit && !Number(edit.stock) ? (
              <label className="dk-field">
                <span>Type</span>
                <select className="dk-input" value={f.item_type}
                        onChange={(e) => setF({ ...f, item_type: e.target.value,
                          /* A service never holds stock; a product usually does. */
                          is_inventory: e.target.value === "service" ? false : true })}>
                  <option value="product">Product — something you stock and sell</option>
                  <option value="service">Service — work you charge for</option>
                </select>
              </label>
            ) : <div />}
          </div>

          {/* "Count it / do not count it" used to be asked here. It is the
              same question as "is this a product or a service", asked a second
              time in different words: a product is a thing on a shelf and the
              whole reason for recording one is to know how many are left. The
              answer follows from the type now, and is set with it. */}

          {!isService && (
          <label className="dk-field">
            <span>Barcodes</span>
            <div className="dk-bcrow">
              <input className="dk-input dk-n" value={bcInput} onChange={(e) => setBcInput(e.target.value)}
                     placeholder="Scan or type, then press Enter"
                     onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBc(); } }} />
              <button type="button" className="dk-sbtn" onClick={addBc}>Add</button>
              <button type="button" className="dk-sbtn" onClick={genBc} title="Generate a valid EAN-13">Generate</button>
            </div>
            <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
              Add several to group flavours that share a price — any of them rings up this item.
            </span>
            {barcodes.length > 0 && (
              <div className="dk-bcchips">
                {barcodes.map((c) => (
                  <span key={c} className="dk-bcchip">{c}
                    <button type="button" aria-label={`Remove ${c}`} onClick={async () => {
                      setBarcodes(barcodes.filter((x) => x !== c));
                      if (edit && (edit.barcodes || []).includes(c)) { try { await api.delete(`/items/${edit.id}/barcodes/${c}`); } catch {} }
                    }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </label>
          )}

          {!isService && f.is_inventory && (
            <div className="dk-unitbox">
              <div className="dk-unitbox-head">
                <div>
                  <div className="t">Units &amp; conversion</div>
                  <div className="s">Link a second unit to sell the same stock loose</div>
                </div>
                <span className={`dk-tpill ${dual ? "accent" : ""}`}>{dual ? "dual unit on" : "single unit"}</span>
              </div>

              <div className="dk-unitpair">
                <label className="dk-field">
                  <span>Base unit</span>
                  <div className="dk-pickrow">
                    <select className="dk-input" value={f.unit} onChange={set("unit")}>
                      {units.map((u) => <option key={u.id} value={u.short}>{u.name} ({u.short})</option>)}
                      {!units.some((u) => u.short === f.unit) && <option value={f.unit}>{f.unit}</option>}
                    </select>
                    <button type="button" className="dk-sbtn" onClick={() => setQuick("unit")}>+ New</button>
                  </div>
                </label>
                <div className="swap">⇄</div>
                <label className="dk-field">
                  <span>Secondary unit</span>
                  <div className="dk-pickrow">
                    <select className="dk-input" value={f.secondary_unit}
                            onChange={(e) => setF({ ...f, secondary_unit: e.target.value,
                              ...(e.target.value ? {} : { conversion_rate: "", secondary_price: "" }) })}>
                      <option value="">None — sell by the {f.unit} only</option>
                      {units.filter((u) => u.short !== f.unit).map((u) => <option key={u.id} value={u.short}>{u.name} ({u.short})</option>)}
                    </select>
                    <button type="button" className="dk-sbtn" onClick={() => setQuick("unit2")}>+ New</button>
                  </div>
                </label>
              </div>

              {f.secondary_unit && (
                <>
                  <div className="dk-r2" style={{ marginTop: 14 }}>
                    <label className="dk-field">
                      <span>1 {f.unit} equals</span>
                      <input className="dk-input dk-n" type="number" value={f.conversion_rate}
                             onChange={set("conversion_rate")} placeholder="0" />
                    </label>
                    <label className="dk-field">
                      <span>Price per {f.secondary_unit || "unit"}</span>
                      <input className="dk-input dk-n" type="number" value={f.secondary_price}
                             onChange={set("secondary_price")} placeholder="0" />
                    </label>
                  </div>
                  {dual && (
                    <div className="dk-unitecho">
                      <span className="eq dk-n">1 {f.unit} = {conv} {f.secondary_unit}</span>
                      <span>
                        Stock will read <b className="dk-n">{stock} {f.unit}
                        {stock ? ` · ${+(stock * conv).toFixed(2)} ${f.secondary_unit}` : ""}</b> and you can sell,
                        buy or adjust in either unit.
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="dk-r3">
            <label className="dk-field">
              <span>{isService ? "Rate" : "Sale price"}</span>
              <input className="dk-input dk-n" type="number" value={f.sale_price} onChange={setSale} placeholder="0" />
            </label>
            <label className="dk-field">
              <span>{isService ? "Labour cost" : "Purchase price"}</span>
              <input className="dk-input dk-n" type="number" value={f.purchase_price} onChange={setCost} placeholder="0" />
            </label>
            <label className="dk-field">
              <span>Markup %</span>
              <input className="dk-input dk-n" type="number" value={f.markup_pct} onChange={setMarkup} placeholder="0" />
            </label>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: -6 }}>
            Price, cost and markup follow each other — change any one and the others catch up.
            {stg.taxes_enabled === "0"
              ? " Tax is switched off in Settings → Taxes, so nothing here is taxed."
              : " Tax comes from Settings → Taxes and applies on every sale automatically."}
          </div>

          {!isService && f.is_inventory && (
            <div className="dk-r2">
              {!edit && (
                <label className="dk-field">
                  <span>Opening stock</span>
                  <input className="dk-input dk-n" type="number" value={f.opening_stock} onChange={set("opening_stock")} placeholder="0" />
                </label>
              )}
              {/* The batch and date already printed on what is on the shelf.
                  Without them the first sale has nothing to sort by, so
                  earliest-expiry-first cannot begin until the second delivery. */}
              {!edit && stg.enable_batches !== "0" && Number(f.opening_stock) > 0 && (
                <>
                  <label className="dk-field">
                    <span>Opening batch</span>
                    <input className="dk-input" value={f.opening_batch_no || ""} onChange={set("opening_batch_no")} placeholder="Batch number" />
                  </label>
                  <label className="dk-field">
                    <span>Expires</span>
                    <input className="dk-input" type="date" value={f.opening_expiry_date || ""} onChange={set("opening_expiry_date")} />
                  </label>
                </>
              )}
              <label className="dk-field">
                <span>Reorder level</span>
                <input className="dk-input dk-n" type="number" value={f.reorder_level} onChange={set("reorder_level")} placeholder="10" />
                <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
                  Warns on the dashboard at or below this
                </span>
              </label>
            </div>
          )}

          <div className="dk-checks">
            <label className="dk-check">
              <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />
              <span className="box" /><span>Active — can be sold</span>
            </label>
            <label className="dk-check">
              <input type="checkbox" checked={!f.price_change_allowed}
                     onChange={(e) => setF({ ...f, price_change_allowed: !e.target.checked })} />
              <span className="box" /><span>Lock the price at the till</span>
            </label>
            {!isService && f.is_inventory && (
              <label className="dk-check">
                <input type="checkbox" checked={f.track_serials}
                       onChange={(e) => setF({ ...f, track_serials: e.target.checked })} />
                <span className="box" /><span>Track serial numbers / IMEI</span>
              </label>
            )}
            <label className="dk-check">
              <input type="checkbox" checked={!!f.use_default_qty || Number(f.default_qty) > 1}
                     onChange={(e) => setF({ ...f, use_default_qty: e.target.checked, default_qty: e.target.checked ? f.default_qty || 1 : 1 })} />
              <span className="box" /><span>Pre-fill a quantity at the till</span>
            </label>
          </div>

          {/* Ticking "track IMEI" and being given nowhere to put one is the
              box doing nothing anybody can see. The numbers themselves are
              per-unit and arrive with a purchase, but a shop switching this on
              already has phones on the shelf — so the ones already held go in
              here, and after that the purchase screen collects them. */}
          {!isService && f.is_inventory && f.track_serials && (
            <label className="dk-field">
              <span>{edit ? "Add serial numbers / IMEIs you hold" : "Serial numbers / IMEIs you already hold"}</span>
              <textarea className="dk-input" rows={3} value={f.serials_text}
                        onChange={(e) => setF({ ...f, serials_text: e.target.value })}
                        placeholder="One serial number or IMEI per line" />
              <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
                One per line, or scan them straight in — the scanner types the number and presses Enter.
                {edit ? " The full list, and which have sold, is under Serials." : ""}
              </span>
            </label>
          )}

          {(f.use_default_qty || Number(f.default_qty) > 1) && (
            <label className="dk-field" style={{ maxWidth: 200 }}>
              <span>Default quantity</span>
              <input className="dk-input dk-n" type="number" min="1" value={f.default_qty}
                     onChange={(e) => setF({ ...f, default_qty: e.target.value })} />
            </label>
          )}

          <details className="dk-adv">
            <summary>Photo, colour and accounting</summary>
            <div className="inner">
              <div className="dk-imgrow">
                <div className="dk-imgbox">
                  {f.image ? <img src={f.image} alt="" /> : <span>No photo</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <label className="dk-sbtn" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
                      {f.image ? "Change photo" : "Add photo"}
                      <input type="file" accept="image/*" style={{ display: "none" }} onChange={async (e) => {
                        const file = e.target.files[0]; if (!file) return;
                        try { setF((s2) => ({ ...s2, image: "" })); const data = await shrinkImage(file); setF((s2) => ({ ...s2, image: data })); }
                        catch { toast("Couldn't read that image", "bad"); }
                      }} />
                    </label>
                    {f.image && <button type="button" className="dk-sbtn" onClick={() => setF((s2) => ({ ...s2, image: "" }))}>Remove</button>}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 8 }}>
                    Shown on the till buttons — staff pick by sight, which is faster than reading.
                  </div>
                </div>
              </div>

              <div className="dk-field">
                <span>Colour on the list and the till</span>
                <div className="dk-swatchpick">
                  <button type="button" className={`dk-catswatch ${!f.color ? "on" : ""}`} style={{ background: "#3A4763" }}
                          onClick={() => setF({ ...f, color: "" })} title="Default" aria-label="Default colour" />
                  {COLORS.map((c) => (
                    <button key={c} type="button" className={`dk-catswatch ${f.color === c ? "on" : ""}`}
                            style={{ background: c }} onClick={() => setF({ ...f, color: c })} aria-label={c} />
                  ))}
                </div>
              </div>

              <div className="dk-r2">
                <label className="dk-field">
                  <span>Sales account</span>
                  <select className="dk-input" value={f.sales_account_code} onChange={set("sales_account_code")}>
                    <option value="">Default — Sales</option>
                    {accts.filter((a) => a.type === "income").map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </label>
                <label className="dk-field">
                  <span>Cost of goods account</span>
                  <select className="dk-input" value={f.cogs_account_code} onChange={set("cogs_account_code")}>
                    <option value="">Default — Cost of goods sold</option>
                    {accts.filter((a) => a.type === "expense").map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--faint)" }}>
                Leave the accounts blank unless this item should post somewhere of its own.
              </div>
            </div>
          </details>
        </div>

        <div className="dk-formfoot">
          {!edit && (
            <button className="dk-mbtn spread" disabled={busy} onClick={() => saveAnd(true)}>Save &amp; add another</button>
          )}
          <button className="dk-mbtn" style={edit ? { marginLeft: "auto" } : undefined} onClick={onClose}>Cancel</button>
          <button className="dk-mbtn go" onClick={() => saveAnd(false)} disabled={busy}>
            {busy ? "Saving…" : edit ? "Save changes" : "Save"}
          </button>
        </div>
      </div>
    </div>

      {/* Outside the veil on purpose. Nested inside it, the dialog would be
          trapped in the veil's stacking context and open underneath the form
          that raised it, whatever its own z-index said. */}
      {quick && (
        <QuickAdd
          kind={quick === "category" ? "category" : "unit"}
          onClose={() => setQuick(null)}
          onMade={(made) => {
            setQuick(null);
            if (quick === "category") {
              api.get("/settings/categories").then((list) => {
                setCats(list);
                const hit = list.find((c) => c.name === made.name) || made;
                if (hit && hit.id) setF((cur) => ({ ...cur, category_id: String(hit.id) }));
              }).catch(() => {});
            } else {
              api.get("/settings/units").then((list) => {
                setUnits(list);
                const short = (made.short || "").toUpperCase();
                if (short) setF((cur) => (quick === "unit2"
                  ? { ...cur, secondary_unit: short }
                  : { ...cur, unit: short }));
              }).catch(() => {});
            }
          }} />
      )}
    </>
  );
}

/* Make a unit or a category without abandoning the item being typed.
   Sits above the item editor rather than replacing it, so the half-filled
   form is still there when this closes. */
function QuickAdd({ kind, onClose, onMade }) {
  const isUnit = kind === "unit";
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return toast(isUnit ? "Give the unit a name" : "Give the category a name", "bad");
    setBusy(true);
    try {
      if (isUnit) {
        const body = { name: name.trim(), short: (short || name).trim().toUpperCase() };
        await api.post("/settings/units", body);
        toast(`${body.name} added`);
        onMade(body);
      } else {
        const body = { name: name.trim() };
        await api.post("/settings/categories", body);
        toast(`${body.name} added`);
        onMade(body);
      }
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={isUnit ? "New unit" : "New category"} onClose={onClose} dismissible>
      <div className="dk-quickadd">
        <Field label={isUnit ? "Unit name" : "Category name"}>
          <input className="dk-input" autoFocus value={name}
                 onChange={(e) => setName(e.target.value)}
                 placeholder={isUnit ? "Kilogram" : "Name of the category"}
                 onKeyDown={(e) => { if (e.key === "Enter" && !busy) save(); }} />
        </Field>
        {isUnit && (
          <Field label="Short form">
            <input className="dk-input" value={short}
                   onChange={(e) => setShort(e.target.value.toUpperCase())}
                   placeholder="KG"
                   onKeyDown={(e) => { if (e.key === "Enter" && !busy) save(); }} />
          </Field>
        )}
        <div className="dk-quickadd-foot">
          <button className="dk-mbtn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="dk-mbtn go" onClick={save} disabled={busy}>{busy ? "Adding…" : "Add"}</button>
        </div>
      </div>
    </Modal>
  );
}


function AdjustModal({ item, onClose, onSaved }) {
  const [past, setPast] = useState(null);
  const loadPast = React.useCallback(() => {
    api.get(`/items/${item.id}/adjustments`).then(setPast).catch(() => setPast([]));
  }, [item.id]);
  useEffect(() => { loadPast(); }, [loadPast]);
  const [f, setF] = useState({ direction: "in", quantity: "", note: "" });
  const [uSec, setUSec] = useState(false);
  const hasSec = !!(item.secondary_unit && item.conversion_rate > 0);
  const save = async () => {
    const raw = Number(f.quantity);
    if (!(raw > 0)) return toast("Enter a quantity", "bad");
    const baseQty = uSec ? raw / item.conversion_rate : raw;
    try { await api.post(`/items/${item.id}/adjust`, { ...f, quantity: baseQty }); onSaved(); }
    catch (e) { toast(e.message, "bad"); }
  };
  return (
    <Modal title={`Adjust stock — ${item.name}`} onClose={onClose}>
      <div style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 12 }}>
        Current stock: <b style={{ color: "var(--text)" }}>{dualQty(item.on_hand, item.unit, item.secondary_unit, item.conversion_rate)}</b>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["in", "Add stock"], ["out", "Reduce stock"]].map(([v, label]) => (
          <button key={v} onClick={() => setF({ ...f, direction: v })} className={`btn ${f.direction === v ? "btn-primary" : "btn-ghost"}`} style={{ flex: 1, justifyContent: "center" }}>{label}</button>
        ))}
      </div>
      <div className="row2">
        <Field label="Quantity">
          <input type="number" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} autoFocus />
        </Field>
        <Field label="Unit">
          {hasSec ? (
            <select value={uSec ? "sec" : "base"} onChange={(e) => setUSec(e.target.value === "sec")}>
              <option value="base">{item.unit}</option>
              <option value="sec">{item.secondary_unit} (1 {item.unit} = {item.conversion_rate})</option>
            </select>
          ) : <input value={item.unit} readOnly />}
        </Field>
      </div>
      {hasSec && uSec && Number(f.quantity) > 0 && (
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: -6 }}>
          = {(Number(f.quantity) / item.conversion_rate).toFixed(3)} {item.unit} in base stock
        </p>
      )}
      <Field label="Reason"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Recount, damage, gift…" /></Field>

      {/* The adjustments already made to this item, so a wrong one can be
          taken back rather than papered over with an opposite one. Two
          adjustments cancelling out and a genuine loss-then-find look
          identical in a ledger; a reversal says which it was. */}
      {past === null ? null : past.length === 0 ? null : (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 8 }}>Adjustments made before</div>
          <div className="dk-scrollx" style={{ maxHeight: 190 }}>
            <table className="dk-table">
              <tbody>
                {past.map((a) => (
                  <tr key={a.id}>
                    <td className="dk-n dim" style={{ whiteSpace: "nowrap" }}>{String(a.move_date || "").slice(0, 10)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <span className={`pill ${a.direction === "in" ? "pill-ok" : "pill-warn"}`}>
                        {a.direction === "in" ? "+" : "−"}{a.quantity} {item.unit}
                      </span>
                    </td>
                    <td className="dim" style={{ fontSize: 12 }}>{a.by_name || ""}</td>
                    <td className="r">
                      {a.reversed
                        ? <span className="dim" style={{ fontSize: 11.5 }}>taken back</span>
                        : (
                          <button className="btn btn-ghost" style={{ padding: "3px 9px", fontSize: 12 }}
                                  onClick={async () => {
                                    if (!(await confirmDialog({
                                      title: "Take this adjustment back?",
                                      message: `${a.direction === "in" ? "Adds" : "Removes"} ${a.quantity} ${item.unit} — this puts the shelf and the books back to where they were before it.`,
                                      confirmLabel: "Reverse adjustment",
                                    }))) return;
                                    try {
                                      const r = await api.post(`/items/adjustments/${a.id}/reverse`, {});
                                      toast(r.message || "Taken back");
                                      loadPast(); onSaved();
                                    } catch (e) { toast(e.message, "bad"); }
                                  }}>Take back</button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Adjust</button>
      </div>
    </Modal>
  );
}

/* ── Price tags designer — Aronium-style layout & display settings, live preview ── */
const TAG_DEFAULTS = {
  paper: "a4", copies: 12, columns: 3,
  show_name: true, show_price: true, show_code: true, show_barcode: true, borders: true,
  name_size: 12, price_size: 16, bc_height: 44,
};
function loadTagPrefs() {
  try { return { ...TAG_DEFAULTS, ...JSON.parse(localStorage.getItem("vy_tag_prefs") || "{}") }; }
  catch { return { ...TAG_DEFAULTS }; }
}

function tagHtml(item, p) {
  const code = (item.barcodes && item.barcodes[0]) || item.item_code || `ITEM-${String(item.id).padStart(4, "0")}`;
  const bc = p.show_barcode ? code128Svg(String(code), { height: p.bc_height, scale: 2 }) : "";
  const w = p.paper === "a4" ? `${(190 / p.columns).toFixed(1)}mm` : (p.paper === "roll80" ? "72mm" : "46mm");
  return `<div style="display:inline-block;vertical-align:top;box-sizing:border-box;width:${w};text-align:center;
      padding:8px 6px;margin:${p.paper === "a4" ? "2mm" : "0 0 3mm 0"};
      ${p.borders ? "border:1px dashed #999;border-radius:5px;" : ""}">
    ${p.show_name ? `<div style="font:700 ${p.name_size}px 'Segoe UI',sans-serif;overflow:hidden">${item.name}</div>` : ""}
    ${bc}
    ${p.show_code ? `<div style="font:11px 'Consolas',monospace;color:#444">${code}</div>` : ""}
    ${p.show_price ? `<div style="font:800 ${p.price_size}px 'Segoe UI',sans-serif">${cur()} ${inr(item.sale_price)}</div>` : ""}
  </div>`;
}

function TagsPanel({ item, onClose }) {
  const [p, setP] = useState(loadTagPrefs());
  const set = (k, v) => { const np = { ...p, [k]: v }; setP(np); localStorage.setItem("vy_tag_prefs", JSON.stringify(np)); };
  const previewCount = Math.min(p.paper === "a4" ? p.columns * 2 : 2, p.copies);
  const sheetW = p.paper === "a4" ? 520 : (p.paper === "roll80" ? 300 : 210);

  const doPrint = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    const body = tagHtml(item, p).repeat(p.copies);
    w.document.write(`<html><head><title>Price tags — ${item.name}</title>
      <style>@page{margin:${p.paper === "a4" ? "8mm" : "2mm"}}body{margin:0;${p.paper !== "a4" ? "width:" + (p.paper === "roll80" ? "76mm" : "50mm") + ";" : ""}}</style>
      </head><body>${body}</body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={onClose}>← Back</button>
        <h2>Price tags — {item.name}</h2>
      </div>
      <div className="tags-layout">
        <div className="tags-side">
          <h3>Layout</h3>
          <Field label="Paper">
            <div className="seg">
              {[["a4", "A4 sheet"], ["roll80", "Roll 80mm"], ["roll50", "Roll 50mm"]].map(([v, label]) => (
                <button key={v} className={p.paper === v ? "on" : ""} onClick={() => set("paper", v)}>{label}</button>
              ))}
            </div>
          </Field>
          {p.paper === "a4" && (
            <div className="rng-row">
              <div className="rl"><span>Columns</span><b>{p.columns}</b></div>
              <input className="rng" type="range" min="2" max="6" value={p.columns} onChange={(e) => set("columns", Number(e.target.value))} />
            </div>
          )}
          <div className="rng-row">
            <div className="rl"><span>Number of tags</span><b>{p.copies}</b></div>
            <input className="rng" type="range" min="1" max="60" value={p.copies} onChange={(e) => set("copies", Number(e.target.value))} />
          </div>

          <h3>Display</h3>
          <Switch checked={p.show_name} onChange={(v) => set("show_name", v)} label="Product name" />
          <Switch checked={p.show_price} onChange={(v) => set("show_price", v)} label="Price" />
          <Switch checked={p.show_code} onChange={(v) => set("show_code", v)} label="Code (SKU / barcode number)" />
          <Switch checked={p.show_barcode} onChange={(v) => set("show_barcode", v)} label="Barcode" note="Code 128 — scans on any reader" />
          <Switch checked={p.borders} onChange={(v) => set("borders", v)} label="Borders" note="Dashed cutting guides" />

          <h3>Sizes</h3>
          <div className="rng-row">
            <div className="rl"><span>Product name size</span><b>{p.name_size}px</b></div>
            <input className="rng" type="range" min="9" max="20" value={p.name_size} onChange={(e) => set("name_size", Number(e.target.value))} />
          </div>
          <div className="rng-row">
            <div className="rl"><span>Price size</span><b>{p.price_size}px</b></div>
            <input className="rng" type="range" min="11" max="28" value={p.price_size} onChange={(e) => set("price_size", Number(e.target.value))} />
          </div>
          <div className="rng-row">
            <div className="rl"><span>Barcode height</span><b>{p.bc_height}px</b></div>
            <input className="rng" type="range" min="22" max="80" value={p.bc_height} onChange={(e) => set("bc_height", Number(e.target.value))} />
          </div>
        </div>
        <div className="tags-preview">
          <div className="tags-sheet" style={{ width: sheetW, padding: 14 }}
               dangerouslySetInnerHTML={{ __html: tagHtml(item, p).repeat(previewCount) }} />
        </div>
      </div>
      <div className="p-foot">
        <span style={{ marginRight: "auto", color: "#8B94A6", fontSize: 12.5, alignSelf: "center" }}>
          Settings are remembered for next time.
        </span>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={doPrint}><Icon n="print" size={15} /> Print {p.copies} tag{p.copies > 1 ? "s" : ""}</button>
      </div>
    </div>
  );
}


/* Every movement for one item, with the running balance. */
function LedgerModal({ item, onClose }) {
  const [d, setD] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [failed, read] = useRead();
  const load = () => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    setD(null);
    read(api.get(`/items/${item.id}/ledger?${p}`), setD, null);
  };
  useEffect(() => { load(); }, [item.id, from, to]);

  const SRC = { opening: "Opening stock", purchases: "Purchase", sales: "Sale", adjustment: "Adjustment",
                stocktake: "Stock count", void: "Voided sale", returns: "Return" };

  return (
    <Modal title={`Stock ledger — ${item.name}`} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, color: "var(--muted)" }}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ fontSize: 12.5, color: "var(--muted)" }}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(from || to) && <button className="btn btn-ghost" onClick={() => { setFrom(""); setTo(""); }}>Clear</button>}
      </div>
      {failed ? <LoadFailed what="this stock ledger" onRetry={load} /> : !d ? <span className="sk" style={{ width: "50%" }} /> : (
        <>
          <div style={{ display: "flex", gap: 20, marginBottom: 10, fontSize: 13.5 }}>
            <span>Opening <b className="num">{d.opening}</b></span>
            <span>Closing <b className="num">{d.closing} {d.item.unit}</b></span>
            <span style={{ color: "var(--muted)" }}>{d.rows.length} movement(s)</span>
          </div>
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            <table className="tw">
              <thead><tr><th>When</th><th>What</th><th className="amt">In</th><th className="amt">Out</th><th className="amt">Balance</th><th className="amt">Cost</th><th>By</th></tr></thead>
              <tbody>
                {d.rows.length === 0 ? (
                  <tr><td colSpan={7}><Empty icon="▤" title="No movements in this period" /></td></tr>
                ) : d.rows.map((r) => (
                  <tr key={r.id} className="hl">
                    <td className="num">{String(r.move_date || "").slice(0, 16).replace("T", " ")}</td>
                    <td>{SRC[r.source_module] || r.source_module}{r.batch_no ? <span style={{ color: "var(--muted)" }}> · {r.batch_no}</span> : null}</td>
                    <td className={`amt num ${r.in_qty ? "val-good" : "val-flat"}`}>{r.in_qty || ""}</td>
                    <td className={`amt num ${r.out_qty ? "val-loss" : "val-flat"}`}>{r.out_qty || ""}</td>
                    <td className="amt num strong">{r.balance}</td>
                    <td className="amt num" style={{ color: "var(--muted)" }}>{r.unit_cost ? inr(r.unit_cost) : ""}</td>
                    <td style={{ color: "var(--muted)", fontSize: 12.5, fontWeight: 500 }}>{r.who || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}


/* Break a big unit down into smaller ones — a sack into 1kg bags — carrying the cost across. */
function RepackModal({ from, items, onClose, onDone }) {
  const [src, setSrc] = useState(null);
  const [toId, setToId] = useState("");
  const [fromQty, setFromQty] = useState(1);
  const [toQty, setToQty] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);

  const [srcFailed, readSrc] = useRead();
  useEffect(() => { readSrc(api.get(`/repacks/cost/${from.id}`), setSrc, null); }, [from.id]);

  const target = items.find((i) => String(i.id) === String(toId));
  const consumed = src ? (Number(fromQty) || 0) * src.unit_cost : 0;
  const total = consumed + (Number(extra) || 0);
  const perUnit = Number(toQty) > 0 ? total / Number(toQty) : 0;

  const save = async () => {
    if (!toId) return toast("Choose what you're making", "bad");
    if (!(Number(toQty) > 0)) return toast("How many units does it make?", "bad");
    setBusy(true);
    try {
      const r = await api.post("/repacks", {
        from_item_id: from.id, from_qty: Number(fromQty),
        to_item_id: Number(toId), to_qty: Number(toQty),
        extra_cost: Number(extra) || 0,
      });
      toast(r.message || "Repacked");
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`Repack ${from.name}`} onClose={onClose}>
      <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>
        Break this down into another item — a sack into 1kg bags, a carton into singles.
        The cost follows the goods, so the smaller units are priced correctly.
      </p>
      <div className="row2">
        <Field label={`How many ${from.unit} to break down`}>
          <input type="number" value={fromQty} onChange={(e) => setFromQty(e.target.value)} autoFocus />
        </Field>
        <Field label="In stock now">
          {/* Without the cost read there is no unit cost, so the repack cost
              below is unknown rather than zero — say so instead of printing it. */}
          <input value={srcFailed ? "Could not load the current cost" : src ? `${src.on_hand} ${from.unit} at ${cur()} ${inr(src.unit_cost)} each` : "…"} disabled />
        </Field>
      </div>
      <Field label="What does it become?">
        <select value={toId} onChange={(e) => setToId(e.target.value)}>
          <option value="">Choose an item…</option>
          {items.filter((i) => i.id !== from.id && i.is_inventory === 1).map((i) => (
            <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
          ))}
        </select>
      </Field>
      <div className="row2">
        <Field label={`How many ${target ? target.unit : "units"} does that make`}>
          <input type="number" value={toQty} onChange={(e) => setToQty(e.target.value)} />
        </Field>
        <Field label="Packing cost (optional)">
          <input type="number" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="bags, labour…" />
        </Field>
      </div>

      {Number(toQty) > 0 && src && (
        <div className="repack-sum">
          <div><span>Stock used</span><b>{cur()} {inr(consumed)}</b></div>
          {Number(extra) > 0 && <div><span>Packing</span><b>{cur()} {inr(Number(extra))}</b></div>}
          <div className="big"><span>Each {target ? target.unit : "unit"} will cost</span><b>{cur()} {inr(perUnit)}</b></div>
          {target && target.sale_price > 0 && (
            <div className={perUnit >= target.sale_price ? "val-loss" : "val-flat"} style={{ fontSize: 12.5, fontWeight: 500 }}>
              {perUnit >= target.sale_price
                ? `⚠ That's at or above the ${target.name} selling price of ${cur()} ${inr(target.sale_price)}`
                : `Selling at ${cur()} ${inr(target.sale_price)} leaves ${Math.round((1 - perUnit / target.sale_price) * 100)}% margin`}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Working…" : "Repack"}</button>
      </div>
    </Modal>
  );
}

/* Shrink a photo in the browser so the database stays small. */
function shrinkImage(file, max = 320) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(max / img.width, max / img.height, 1);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* Serial / IMEI register for one item. */
function SerialsModal({ item, onClose }) {
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState("");
  const [q, setQ] = useState("");
  const [failed, read] = useRead();
  const load = () => read(api.get(`/serials/item/${item.id}`), setD, null);
  useEffect(() => { load(); }, [item.id]);

  const add = async () => {
    const list = adding.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) return toast("Paste or type the serials, one per line", "bad");
    try {
      const r = await api.post("/serials/receive", { item_id: item.id, serials: list });
      toast(r.message);
      setAdding(""); load();
    } catch (e) { toast(e.message, "bad"); }
  };

  const rows = (d?.rows || []).filter((r) => !q || r.serial.toLowerCase().includes(q.toLowerCase()));

  return (
    <Modal title={`Serials — ${item.name}`} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 18, fontSize: 13.5, marginBottom: 12 }}>
        <span>In stock <b className="num">{figure(failed, d?.counts?.in_stock || 0)}</b></span>
        <span>Sold <b className="num">{figure(failed, d?.counts?.sold || 0)}</b></span>
      </div>
      <div className="row2">
        <Field label="Add serials that arrived (one per line)">
          <textarea rows={3} value={adding} onChange={(e) => setAdding(e.target.value)}
                    placeholder="One serial number or IMEI per line" />
        </Field>
        <div style={{ alignSelf: "end", paddingBottom: 10 }}>
          <button className="btn btn-primary" onClick={add}>Record serials</button>
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 7 }}>
            Scan them straight in — the scanner types the number and presses Enter.
          </p>
        </div>
      </div>
      <input placeholder="Find a serial…" value={q} onChange={(e) => setQ(e.target.value)}
             style={{ width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 10, margin: "8px 0" }} />
      <div style={{ maxHeight: 320, overflow: "auto" }}>
        <table className="tw">
          <thead><tr><th>Serial / IMEI</th><th>Status</th><th>Bill</th><th>Sold on</th><th>Customer</th></tr></thead>
          <tbody>
            {failed ? <FailedRows cols={5} what="the serial register" onRetry={load} />
              : !d ? <SkeletonRows rows={3} cols={5} /> : rows.length === 0 ? (
              <tr><td colSpan={5}><Empty icon="▦" title="No serials recorded yet" /></td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="hl">
                <td className="num strong">{r.serial}</td>
                <td><span className={`pill ${r.status === "sold" ? "pill-muted" : "pill-ok"}`}>{r.status.replace("_", " ")}</span></td>
                <td className="num">{r.bill_no || "—"}</td>
                <td className="num">{r.sold_at ? String(r.sold_at).slice(0, 10) : "—"}</td>
                <td>{r.party_name || "—"}{r.invoice_no ? <span style={{ color: "var(--muted)" }}> · {r.invoice_no}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/* Where capital is sitting still. */
function AgeingModal({ onClose }) {
  const [d, setD] = useState(null);
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get("/items/reports/ageing"), setD, null); };
  useEffect(() => { load(); }, []);
  /* A four-step ramp: fresh stock is healthy, the older it gets the worse.
     Three steps are the stock-health tones; 61–90 needs a fourth of its own,
     because collapsing it onto `.val-watch` or `.val-loss` would merge two
     adjacent buckets into one block — exactly the bucket a reader is looking
     for. `.amt-age3` already is that tone: the "late" step of the receivables
     ageing ramp, on a figure that is money like the rest of this row. */
  const B = [["0-30", "Under a month", "val-good"], ["31-60", "1–2 months", "val-watch"],
             ["61-90", "2–3 months", "amt-age3"], ["90+", "Over 3 months", "val-loss"]];
  return (
    <Modal title="Stock ageing — where the money is sitting" onClose={onClose} wide>
      {failed ? <LoadFailed what="the ageing report" onRetry={load} /> : !d ? <span className="sk" style={{ width: "50%" }} /> : (
        <>
          <div className="items-stats" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 14 }}>
            {B.map(([k, label, cls]) => (
              <div className="istat" key={k}>
                <div className="l">{label}</div>
                <div className={`v ${cls}`}>{cur()} {inr(d.buckets[k] || 0)}</div>
              </div>
            ))}
          </div>
          {d.dead_count > 0 && (
            <div className="health-banner bad" style={{ marginBottom: 14 }}>
              <span className="hb-icon">!</span>
              <div>
                <b>{cur()} {inr(d.dead_value)} hasn't sold in {d.dead_days} days</b>
                <div style={{ fontSize: 12.5, opacity: .85 }}>
                  {plural(d.dead_count, "item")}. That's cash on a shelf — consider discounting or returning it.
                </div>
              </div>
            </div>
          )}
          <div style={{ maxHeight: 380, overflow: "auto" }}>
            <table className="tw">
              <thead><tr><th>Item</th><th className="amt">On hand</th><th className="amt">Value</th><th className="amt">Age</th><th className="amt">Last sold</th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.item_id} className="hl">
                    <td className="strong">{r.name}</td>
                    <td className="amt num">{r.on_hand} {r.unit}</td>
                    <td className="amt num">{cur()} {inr(r.value)}</td>
                    <td className="amt num">{r.age_days == null ? "—" : `${r.age_days}d`}</td>
                    <td className={`amt num ${r.idle_days == null || r.idle_days >= d.dead_days ? "val-loss" : ""}`}>
                      {r.idle_days == null ? "never" : `${r.idle_days}d ago`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}


/**
 * BulkActivate — switch many items on or off in one pass.
 *
 * Doing this one row at a time through each item's menu is fine for two items
 * and miserable for fifty, which is the case that actually comes up: a season
 * ends, or a supplier is dropped.
 */
function BulkActivate({ items, onClose, onDone }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState("all");   // all | active | inactive

  const list = items.filter((i) => {
    if (show === "active" && i.is_active === 0) return false;
    if (show === "inactive" && i.is_active !== 0) return false;
    const t = q.trim().toLowerCase();
    return !t || i.name.toLowerCase().includes(t) || (i.item_code || "").toLowerCase().includes(t);
  });

  const toggle = (id) => setSel((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const allShown = list.length > 0 && list.every((i) => sel.has(i.id));

  const run = async (makeActive) => {
    if (!sel.size) return toast("Tick some items first", "bad");
    setBusy(true);
    try {
      /* One request for the whole selection. Looping a PUT per item meant a
         thousand round trips, each rewriting an entire row to flip one flag. */
      const r = await api.post("/items/bulk-active", {
        ids: [...sel], is_active: makeActive ? 1 : 0,
      });
      toast(r?.message || `${plural(r?.updated ?? sel.size, "item")} updated`, "ok");
      onDone();
    } catch (e) {
      toast(e.message, "bad");
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Activate or deactivate items" onClose={onClose} wide>
      <div className="row2" style={{ alignItems: "end" }}>
        <Field label="Search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" autoFocus />
        </Field>
        <Field label="Showing">
          <select value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="all">All items</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
        </Field>
      </div>

      <label className="inline-check">
        <input type="checkbox" checked={allShown}
               onChange={() => setSel((s) => {
                 const n = new Set(s);
                 if (allShown) list.forEach((i) => n.delete(i.id));
                 else list.forEach((i) => n.add(i.id));
                 return n;
               })} />
        Select all {list.length} shown
      </label>

      <div className="bulk-list">
        {list.length === 0 ? <Empty title="Nothing matches" /> : list.map((i) => (
          <label key={i.id} className="bulk-row">
            <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} />
            <span className="bl-name">{i.name}</span>
            <span className="bl-code">{i.item_code || `#${i.id}`}</span>
            <StatusChip status={i.is_active === 0 ? "inactive" : "active"} />
          </label>
        ))}
      </div>

      <div className="modal-foot">
        <span className="bulk-count">{sel.size} selected</span>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-ghost" onClick={() => run(false)} disabled={busy || !sel.size}>
          {busy ? "Working…" : "Mark inactive"}
        </button>
        <button className="btn btn-primary" onClick={() => run(true)} disabled={busy || !sel.size}>
          {busy ? "Working…" : "Mark active"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Zoho-style ⋯ menu with hover submenus (Sort by / Import / Export …) ── */
function ItemsMenu({ sort, onSort, onImport, onExport, onPrint, onPrefs, onRefresh, onReset, onTags, onBulkActive }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(null); // 'sort' | 'import' | 'export'
  const ref = React.useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setSub(null); } };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const close = () => { setOpen(false); setSub(null); };
  const Item = ({ icon, label, onClick, sub: subId, children }) => (
    <div className={`zdd-item ${sub === subId && subId ? "open" : ""}`}
         onMouseEnter={() => setSub(subId || null)}
         onClick={subId ? undefined : () => { onClick && onClick(); close(); }}>
      <span className="zi"><span className="ic">{icon}</span>{label}</span>
      {subId && <span className="car">▶</span>}
      {subId && sub === subId && <div className="zdd-sub" onMouseLeave={() => setSub(null)}>{children}</div>}
    </div>
  );
  const SortOpt = ({ id, label }) => (
    <div className="zdd-item" onClick={() => { onSort(id); close(); }}>
      <span className="zi">{label}</span>{sort === id && <span className="chk">✓</span>}
    </div>
  );
  return (
    <div className="zdd" ref={ref}>
      <button className="iconbtn-grey" title="More options" onClick={() => { setOpen((o) => !o); setSub(null); }}>⋯</button>
      {open && (
        <div className="zdd-menu">
          <Item icon="⇅" label="Sort by" sub="sort">
            {/* These ids used to be name_asc / stock_asc / stock_desc, none
                of which is a key in the sort table this list actually uses —
                so four of the six silently fell through to A–Z. They are the
                real keys now, and the same set the dropdown offers. */}
            <SortOpt id="entry" label="As entered" />
            <SortOpt id="recent" label="Newest first" />
            <SortOpt id="name" label="Name A → Z" />
            <SortOpt id="name_desc" label="Name Z → A" />
            <SortOpt id="price_asc" label="Price — low to high" />
            <SortOpt id="price_desc" label="Price — high to low" />
            <SortOpt id="lowest" label="Stock — low to high" />
            <SortOpt id="quantity" label="Stock — high to low" />
          </Item>
          <Item icon="⤓" label="Import" sub="import">
            <div className="zdd-item" onClick={() => { onImport(); close(); }}><span className="zi">Items (CSV)</span></div>
          </Item>
          <Item icon="⤒" label="Export" sub="export">
            <div className="zdd-item" onClick={() => { onExport(); close(); }}><span className="zi">Items (CSV)</span></div>
            <div className="zdd-item" onClick={() => { onPrint(); close(); }}><span className="zi">Print list</span></div>
          </Item>
          <div className="zdd-sep" />
          <Item icon={<Icon n="check" size={14} />} label="Bulk activate / deactivate"
                onClick={() => onBulkActive && onBulkActive()} />
          <div className="zdd-sep" />
          <Item icon="⚙" label="Preferences" onClick={onPrefs} />
          <Item icon="▌" label="Price tags" onClick={onTags} />
          <div className="zdd-sep" />
          <Item icon="⟳" label="Refresh List" onClick={onRefresh} />
          <Item icon="↺" label="Reset Column Width" onClick={onReset} />
        </div>
      )}
    </div>
  );
}

/* ── Items → Preferences (Zoho Books layout) ── */
/* ── Items → Preferences ──────────────────────────────────────────────────
 *
 * Every item setting, in the one place. This screen used to show six of them
 * while Settings → Item defaults showed seventeen — the same six among them —
 * so a shop had two places to change one setting and no way to tell which one
 * it had last used. The Settings page is gone; this is where they live, next
 * to the items they describe.
 *
 * The rows are the shared `SettingRow`, so a setting reads and behaves exactly
 * as it does on Settings. The ten shown are every live item setting; seven
 * more exist in the catalogue that nothing in the app reads, and those are not
 * rendered anywhere — see the session-3 report.
 */
function ItemPrefs({ values, onClose, onSaved }) {
  const [catalog, setCatalog] = useState(null);
  const [v, setV] = useState(values || {});
  const [dirty, setDirty] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/settings")
      .then((d) => { setCatalog(d.catalog || []); setV(d.values || {}); })
      .catch(() => setCatalog([]));
  }, []);

  const setVal = (k, val) => { setV((s) => ({ ...s, [k]: val })); setDirty((d) => ({ ...d, [k]: true })); };
  const n = Object.keys(dirty).length;

  const save = async () => {
    setBusy(true);
    try {
      /* Only what changed. Posting the whole values object back would let a
         stale read on this screen overwrite something changed elsewhere. */
      await api.put("/settings", Object.fromEntries(Object.keys(dirty).map((k) => [k, v[k]])));
      toast(`Saved ${n} change${n === 1 ? "" : "s"}`);
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const rows = settingsIn(catalog || [], "item");
  return (
    <Modal title="Items — Preferences" onClose={onClose} wide>
      {catalog === null ? (
        <div className="dk-empty">Loading…</div>
      ) : !rows.length ? (
        <div className="dk-empty">These settings could not be loaded. Nothing has been changed.</div>
      ) : (
        <div className="dk-setsec" style={{ border: 0, padding: 0, background: "none", marginBottom: 0 }}>
          <div className="rows">
            {rows.map((c) => <SettingRow key={c.key} c={c} values={v} setVal={setVal} dirty={dirty} />)}
          </div>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 16 }}>
        {n > 0 && <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--faint)" }}>
          {n} unsaved change{n === 1 ? "" : "s"}
        </span>}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !n}>
          {busy ? "Saving…" : n ? `Save ${n} change${n === 1 ? "" : "s"}` : "Nothing to save"}
        </button>
      </div>
    </Modal>
  );
}

