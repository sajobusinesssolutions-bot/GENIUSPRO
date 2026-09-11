/**
 * BulkUpdate.jsx — change many items at once.
 *
 * A full screen rather than a dialog, because §5 of the design review settles
 * that question by shape: this has lines and a running total of what will
 * change, so it is a document. The Record Purchase bug happened because a
 * document was put in a dialog.
 *
 * ── the three things this screen has to get right ──────────────────────────
 *
 * **Nothing is written until Save.** Every edit lives in a draft held here.
 * That is what makes the bulk actions safe to offer at all: "raise these forty
 * by 5%" is a thing you can look at, disagree with, and undo before it reaches
 * the shop's books.
 *
 * **What will change is visible before it changes.** The footer counts edited
 * items, and every edited cell is marked. A screen that can reprice a whole
 * shop in one click must never leave anybody guessing what the click did.
 *
 * **Margin is not money.** The margin column uses `val-good` / `val-watch` /
 * `val-loss`, not the `amt-*` family. Round eight drew that line deliberately:
 * painting a healthy margin `amt-received` asserts that money was received.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api.js";
import { toast, confirmDialog, Field } from "../lib/ui.jsx";
import { DocShell } from "../lib/docshell.jsx";
import { money } from "../lib/deckui.jsx";
import { inr, cur } from "../lib/tax.js";
import { plural } from "../lib/plural.js";
import { Icon } from "../lib/icons.jsx";

/* The four groups, and the columns each one shows.
 *
 * `key` matches a column on `items` (or the synthetic `list_price`, which
 * belongs to a price book rather than the item). One table renders all four —
 * a second implementation would be a fifth item table in a codebase that §1 of
 * the review already found five of. */
const GROUPS = [
  { id: "price", label: "Price list",
    hint: "Purchase and selling prices, and the margin each one earns." },
  { id: "text", label: "Names & descriptions",
    hint: "What each item is called, and what it says on a document." },
  { id: "stock", label: "Stock & units",
    hint: "How it is counted, and when to reorder it." },
  { id: "class", label: "Classification & tax",
    hint: "How it is filed, scanned and taxed." },
];

const COLUMNS = {
  price: [
    { key: "purchase_price", label: "Cost", type: "money", width: 118 },
    { key: "sale_price", label: "Selling", type: "money", width: 118 },
    { key: "list_price", label: "", type: "money", width: 118, listOnly: true },
    { key: "__margin", label: "Margin", type: "derived", width: 84 },
  ],
  text: [
    { key: "name", label: "Name", type: "text", width: 260, required: true },
    { key: "description", label: "Description", type: "text", width: 340 },
  ],
  stock: [
    { key: "unit", label: "Unit", type: "text", width: 92 },
    { key: "secondary_unit", label: "Second unit", type: "text", width: 110 },
    { key: "conversion_rate", label: "Per unit", type: "number", width: 96 },
    { key: "reorder_level", label: "Reorder at", type: "number", width: 104 },
    { key: "__onhand", label: "On hand", type: "derived", width: 96 },
  ],
  class: [
    { key: "item_code", label: "Code", type: "text", width: 120 },
    { key: "barcode", label: "Barcode", type: "text", width: 150 },
    { key: "category_id", label: "Category", type: "select", width: 170, source: "categories" },
    { key: "tax_rate_id", label: "Tax", type: "select", width: 150, source: "taxes" },
    { key: "is_active", label: "Active", type: "bool", width: 78 },
  ],
};

const num = (v) => (v === "" || v === null || v === undefined ? 0 : Number(v));
const marginPct = (cost, sell) => {
  const c = num(cost), s = num(sell);
  if (!(s > 0)) return null;
  return ((s - c) / s) * 100;
};

export default function BulkUpdate({ onClose, onSaved }) {
  const [group, setGroup] = useState("price");
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState({});          // id -> { field: value }
  const [listDraft, setListDraft] = useState({});  // id -> price, for the chosen book
  const [picked, setPicked] = useState({});        // id -> true
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [cats, setCats] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [lists, setLists] = useState([]);
  const [stg, setStg] = useState({});
  const [listId, setListId] = useState("");
  const [listPrices, setListPrices] = useState({});
  const [action, setAction] = useState(null);      // the open bulk-action form
  const searchRef = useRef(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/items"),
      api.get("/settings/categories").catch(() => []),
      api.get("/settings/tax-rules").catch(() => []),
      api.get("/settings").then((d) => d.values || {}).catch(() => ({})),
      api.get("/settings/price-lists").catch(() => []),
    ]).then(([items, c, t, settings, pl]) => {
      if (!alive) return;
      setRows(items || []);
      setCats(c || []);
      /* Only rules that are switched on, and none at all when tax is off —
         this screen had been asking the endpoint straight out and so offered
         rules the owner had already retired. */
      setStg(settings || {});
      setTaxes(settings.taxes_enabled === "0" ? [] : (t || []).filter((r) => r.is_active));
      /* Price lists are the app's real wholesale mechanism — `items.wholesale_price`
         is a column nothing in the interface has ever written. So the wholesale
         column appears when price lists are on and a book is chosen, and is
         absent otherwise rather than sitting there dead. */
      setLists(settings.price_lists_enabled === "0" ? [] : (pl || []));
    }).catch((e) => alive && setErr(e.message || "Could not load items"));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!listId) return setListPrices({});
    api.get(`/settings/price-lists/${listId}/items`)
      .then((r) => setListPrices(Object.fromEntries((r || []).map((x) => [x.item_id, x.price]))))
      .catch(() => setListPrices({}));
    setListDraft({});
  }, [listId]);

  /* The search box takes focus on arrival and on every group change. Somebody
     opening this screen has an item in mind; making them click the box first is
     one interaction between them and the thing they came for. */
  useEffect(() => { searchRef.current?.focus(); }, [group]);

  const columns = useMemo(() => {
    const cols = COLUMNS[group] || [];
    /* A Tax column on a shop with tax switched off is a column that can only
       be filled in wrongly. */
    const taxOff = stg.taxes_enabled === "0";
    return cols.filter((c) => !c.listOnly || listId)
      .filter((c) => !(taxOff && c.key === "tax_rate_id"))
      .map((c) =>
      c.key === "list_price"
        ? { ...c, label: (lists.find((l) => String(l.id) === String(listId)) || {}).name || "List price" }
        : c);
  }, [group, listId, lists, stg]);

  const cellValue = (row, key) => {
    if (key === "list_price") {
      const d = listDraft[row.id];
      return d !== undefined ? d : (listPrices[row.id] ?? "");
    }
    const d = draft[row.id];
    if (d && key in d) return d[key];
    return row[key] ?? "";
  };
  const isEdited = (row, key) =>
    key === "list_price" ? listDraft[row.id] !== undefined : !!(draft[row.id] && key in draft[row.id]);

  const setCell = (row, key, value) => {
    if (key === "list_price") {
      setListDraft((s) => {
        const next = { ...s };
        const original = listPrices[row.id];
        /* Typing a value back to what it was clears the edit rather than
           recording a change of nothing — the footer count then means what it
           says. */
        if (String(value) === String(original ?? "")) delete next[row.id];
        else next[row.id] = value;
        return next;
      });
      return;
    }
    setDraft((s) => {
      const forRow = { ...(s[row.id] || {}) };
      if (String(value) === String(row[key] ?? "")) delete forRow[key];
      else forRow[key] = value;
      const next = { ...s };
      if (Object.keys(forRow).length) next[row.id] = forRow;
      else delete next[row.id];
      return next;
    });
  };

  const visible = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      [r.name, r.item_code, r.barcode, r.description, r.category_name]
        .some((f) => f && String(f).toLowerCase().includes(needle)));
  }, [rows, q]);

  const editedCount = Object.keys(draft).length;
  const priceCount = Object.keys(listDraft).length;
  const pickedIds = Object.keys(picked).filter((k) => picked[k]).map(Number);
  const dirty = editedCount + priceCount > 0;

  /* ── bulk actions ──────────────────────────────────────────────────────
     Every one of these writes into the same draft a hand edit writes into, so
     the result is reviewable, mixable with hand edits, and undone by Cancel.
     None of them touch the server. */
  const applyToPicked = (fn, field = "sale_price") => {
    if (!pickedIds.length) return toast("Tick some rows first", "bad");
    const targets = rows.filter((r) => pickedIds.includes(r.id));
    let n = 0;
    for (const row of targets) {
      const current = num(cellValue(row, field));
      const next = fn(current, row);
      if (next === null || !Number.isFinite(next) || next < 0) continue;
      const rounded = Math.round(next * 100) / 100;
      if (rounded === current) continue;
      setCell(row, field, String(rounded));
      n++;
    }
    setAction(null);
    toast(n ? `${plural(n, "row")} changed — nothing is saved yet` : "Nothing changed");
  };

  const setFieldOnPicked = (field, value) => {
    if (!pickedIds.length) return toast("Tick some rows first", "bad");
    let n = 0;
    for (const row of rows.filter((r) => pickedIds.includes(r.id))) {
      if (String(row[field] ?? "") === String(value ?? "")) continue;
      setCell(row, field, value);
      n++;
    }
    setAction(null);
    toast(n ? `${plural(n, "row")} changed — nothing is saved yet` : "Nothing changed");
  };

  const save = async () => {
    if (!dirty) return;
    const items = Object.entries(draft).map(([id, fields]) => ({ id: Number(id), ...fields }));
    const prices = Object.entries(listDraft).map(([id, price]) => ({ item_id: Number(id), price: Number(price) }));

    /* The confirmation names the count and the single largest move, because
       "34 items" tells you the size of the batch and nothing about its risk.
       A 900% jump hidden among 34 modest ones is exactly what a mistyped
       figure looks like. */
    const moves = [];
    for (const [id, fields] of Object.entries(draft)) {
      const row = rows.find((r) => r.id === Number(id));
      if (!row || fields.sale_price === undefined) continue;
      const before = num(row.sale_price), after = num(fields.sale_price);
      if (before > 0) moves.push({ name: row.name, pct: ((after - before) / before) * 100, before, after });
    }
    moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const worst = moves[0];

    const ok = await confirmDialog({
      title: `Save ${[editedCount && plural(editedCount, "item"), priceCount && plural(priceCount, "price")].filter(Boolean).join(" and ")}?`,
      message: worst
        ? `The biggest change is ${worst.name}: ${money(worst.before)} → ${money(worst.after)} (${worst.pct > 0 ? "+" : ""}${worst.pct.toFixed(0)}%).`
        : "This writes the edits on this screen to every item shown as changed.",
      detail: "All of it is written together, or none of it is. Every change is recorded against the item, with what it was before.",
      confirmLabel: `Save ${editedCount + priceCount} change${editedCount + priceCount === 1 ? "" : "s"}`,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const r = await api.put("/items/bulk", {
        items,
        price_list: listId && prices.length ? { id: Number(listId), prices } : undefined,
      });
      toast(r.message || "Saved");
      onSaved?.();
      onClose?.();
    } catch (e) {
      /* The server refuses the whole batch on the first bad row and names it.
         Staying on the screen with the draft intact is the point — the shop
         fixes that one row rather than retyping forty. */
      toast(e.message, "bad");
      setBusy(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirmDialog({
      title: "Leave without saving?",
      message: `${plural(editedCount + priceCount, "change")} on this screen will be thrown away.`,
      danger: true, confirmLabel: "Discard",
    }))) return;
    onClose?.();
  };

  const allPickedOnScreen = visible.length > 0 && visible.every((r) => picked[r.id]);

  return (
    <DocShell
      fill
      title="Bulk update"
      docNo={rows ? plural(rows.length, "item") : ""}
      meta={(GROUPS.find((g) => g.id === group) || {}).hint}
      onClose={close}
      onSave={save}
      busy={busy}
      saveLabel={dirty ? `Save ${editedCount + priceCount} change${editedCount + priceCount === 1 ? "" : "s"}` : "Nothing to save"}
      summary={[
        { label: "Shown", value: String(visible.length) },
        pickedIds.length ? { label: "Ticked", value: String(pickedIds.length) } : null,
        editedCount ? { label: "Items edited", value: String(editedCount) } : null,
        priceCount ? { label: "Prices edited", value: String(priceCount) } : null,
      ]}
      footNote={dirty ? "Nothing is written until you save." : null}
    >
      <div className="bu-tools">
        <div className="dk-seg2 bu-groups">
          {GROUPS.map((g) => (
            <button key={g.id} className={group === g.id ? "on" : ""}
                    aria-pressed={group === g.id}
                    onClick={() => { setGroup(g.id); setAction(null); }}>{g.label}</button>
          ))}
        </div>

        <div className="bu-find">
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Search by name, code, barcode or category…"
                 aria-label="Find an item to edit" />
          {q && <button className="bu-clear" onClick={() => { setQ(""); searchRef.current?.focus(); }}
                        aria-label="Clear the search">✕</button>}
        </div>

        {group === "price" && lists.length > 0 && (
          <label className="bu-list">
            <span>Price book</span>
            <select value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">— none —</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {pickedIds.length > 0 && (
        <BulkBar
          group={group} count={pickedIds.length} action={action} setAction={setAction}
          cats={cats} taxes={taxes} listId={listId}
          onClear={() => setPicked({})}
          applyToPicked={applyToPicked} setFieldOnPicked={setFieldOnPicked}
        />
      )}

      <div className="bu-tablewrap dk-s">
        {err ? (
          <div className="dk-empty">
            Could not load the items — {err}.<br />
            Nothing has been changed.
          </div>
        ) : !rows ? (
          <div className="dk-empty">Loading items…</div>
        ) : !visible.length ? (
          <div className="dk-empty">
            {rows.length ? `Nothing matches “${q}”.` : "There are no items yet — add one first."}
          </div>
        ) : (
          <table className="dk-table bu-table">
            <thead>
              <tr>
                <th className="bu-tick">
                  <input type="checkbox" checked={allPickedOnScreen}
                         aria-label={allPickedOnScreen ? "Untick every row shown" : "Tick every row shown"}
                         onChange={(e) => {
                           const on = e.target.checked;
                           setPicked((s) => {
                             const next = { ...s };
                             /* Only the rows on screen. Ticking a box while a
                                search is narrowing the list must not silently
                                select the 4,000 items behind it. */
                             for (const r of visible) { if (on) next[r.id] = true; else delete next[r.id]; }
                             return next;
                           });
                         }} />
                </th>
                <th className="bu-name">Item</th>
                {columns.map((c) => (
                  <th key={c.key} style={{ width: c.width }}
                      className={c.type === "money" || c.type === "number" || c.type === "derived" ? "amt" : ""}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <Row key={row.id} row={row} columns={columns}
                     picked={!!picked[row.id]}
                     onPick={(on) => setPicked((s) => { const n = { ...s }; if (on) n[row.id] = true; else delete n[row.id]; return n; })}
                     value={cellValue} edited={isEdited} onChange={setCell}
                     cats={cats} taxes={taxes} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </DocShell>
  );
}

/* One row. Split out so React can skip the 3,999 rows that did not change when
   one cell is typed into — at four thousand items the whole-table re-render is
   the difference between typing and waiting. */
const Row = React.memo(function Row({ row, columns, picked, onPick, value, edited, onChange, cats, taxes }) {
  const cost = value(row, "purchase_price");
  const sell = value(row, "sale_price");
  const m = marginPct(cost, sell);
  return (
    <tr className={picked ? "is-picked" : ""}>
      <td className="bu-tick">
        <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)}
               aria-label={`Select ${row.name}`} />
      </td>
      <th scope="row" className="bu-name" title={row.name}>{row.name}</th>
      {columns.map((c) => {
        if (c.key === "__margin") {
          /* val-*, not amt-* — a margin is a health reading, not money that
             moved. Below cost is a loss, under 10% is thin enough to watch. */
          const tone = m === null ? "val-flat" : m < 0 ? "val-loss" : m < 10 ? "val-watch" : "val-good";
          return <td key={c.key} className={`amt dk-n ${tone}`}>{m === null ? "—" : `${m.toFixed(1)}%`}</td>;
        }
        if (c.key === "__onhand") {
          return <td key={c.key} className="amt dk-n val-flat">{inr(row.on_hand || 0)}</td>;
        }
        return (
          <td key={c.key} className={c.type === "money" || c.type === "number" ? "amt" : ""}>
            <Cell col={c} row={row} value={value(row, c.key)} edited={edited(row, c.key)}
                  onChange={(v) => onChange(row, c.key, v)} cats={cats} taxes={taxes} />
          </td>
        );
      })}
    </tr>
  );
});

function Cell({ col, row, value, edited, onChange, cats, taxes }) {
  const cls = `bu-in ${edited ? "is-edited" : ""}`;
  const label = `${col.label || col.key} for ${row.name}`;
  if (col.type === "bool") {
    return <input type="checkbox" className={cls} aria-label={label}
                  checked={value === 1 || value === "1" || value === true}
                  onChange={(e) => onChange(e.target.checked ? 1 : 0)} />;
  }
  if (col.type === "select") {
    const opts = col.source === "categories" ? cats : taxes;
    return (
      <select className={cls} value={value ?? ""} aria-label={label}
              onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(opts || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    );
  }
  /* `inputMode="decimal"` rather than `type="number"`: a number input swallows
     a stray scroll over the field and silently changes a price, which on this
     screen would change it for every row somebody then bulk-applies from. */
  return (
    <input className={`${cls} ${col.type === "money" || col.type === "number" ? "dk-n bu-num" : ""}`}
           value={value ?? ""} aria-label={label}
           inputMode={col.type === "money" || col.type === "number" ? "decimal" : undefined}
           onChange={(e) => onChange(e.target.value)} />
  );
}

/* ── The bulk-actions bar ──────────────────────────────────────────────────
   Appears only when rows are ticked, so it costs nothing when unused, and
   offers only the actions that make sense for the group on screen. Each one
   opens a small form rather than acting on click: "raise prices" without
   saying by how much is not an action. */
function BulkBar({ group, count, action, setAction, cats, taxes, listId, onClear, applyToPicked, setFieldOnPicked }) {
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("pct");
  const [target, setTarget] = useState("sale_price");
  const [pick, setPick] = useState("");

  const Btn = ({ id, children }) => (
    <button className={`dk-choice ${action === id ? "on" : ""}`}
            aria-expanded={action === id}
            onClick={() => setAction(action === id ? null : id)}>{children}</button>
  );

  const run = () => {
    const n = Number(amount);
    if (!Number.isFinite(n)) return toast("Type a number first", "bad");
    if (action === "raise" || action === "lower") {
      const sign = action === "raise" ? 1 : -1;
      applyToPicked((cur) => mode === "pct" ? cur * (1 + (sign * n) / 100) : cur + sign * n, target);
    } else if (action === "margin") {
      if (n >= 100) return toast("A margin of 100% or more has no selling price", "bad");
      /* Margin on the selling price, not markup on cost — the column beside it
         is computed the same way, and two definitions of "margin" one click
         apart is how a shop prices itself into a loss. */
      applyToPicked((_, row) => {
        const cost = Number(row.purchase_price) || 0;
        return cost > 0 ? cost / (1 - n / 100) : null;
      }, "sale_price");
    } else if (action === "round") {
      if (!(n > 0)) return toast("Round to the nearest what?", "bad");
      applyToPicked((cur) => Math.round(cur / n) * n, target);
    }
  };

  return (
    <div className="bu-bar" role="region" aria-label="Actions for the ticked rows">
      <span className="bu-bar-n">{plural(count, "row")} ticked</span>

      {group === "price" && (
        <>
          <Btn id="raise">Raise</Btn>
          <Btn id="lower">Lower</Btn>
          <Btn id="margin">Set margin</Btn>
          <Btn id="round">Round</Btn>
        </>
      )}
      {group === "class" && (
        <>
          <Btn id="category">Set category</Btn>
          <Btn id="tax">Set tax</Btn>
          <button className="dk-choice" onClick={() => setFieldOnPicked("is_active", 1)}>Activate</button>
          <button className="dk-choice" onClick={() => setFieldOnPicked("is_active", 0)}>Deactivate</button>
        </>
      )}
      {group === "stock" && <Btn id="unit">Set unit</Btn>}

      <div className="bu-bar-sp" />
      <button className="dk-choice" onClick={onClear}>Clear selection</button>

      {(action === "raise" || action === "lower" || action === "round") && (
        <div className="bu-form">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Which price">
            <option value="sale_price">Selling price</option>
            <option value="purchase_price">Cost price</option>
            {listId && <option value="list_price">Price book</option>}
          </select>
          {action !== "round" && (
            <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="By percent or amount">
              <option value="pct">by %</option>
              <option value="abs">by {cur()}</option>
            </select>
          )}
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                 className="dk-n" autoFocus
                 aria-label={action === "round" ? "Round to the nearest" : "How much"}
                 placeholder={action === "round" ? "nearest 100" : mode === "pct" ? "5" : "1000"} />
          <button className="btn btn-primary" onClick={run}>Apply to {count}</button>
        </div>
      )}
      {action === "margin" && (
        <div className="bu-form">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                 className="dk-n" autoFocus placeholder="30" aria-label="Margin percent" />
          <span className="bu-form-note">% of the selling price. Items with no cost are left alone.</span>
          <button className="btn btn-primary" onClick={run}>Apply to {count}</button>
        </div>
      )}
      {(action === "category" || action === "tax" || action === "unit") && (
        <div className="bu-form">
          {action === "unit" ? (
            <input value={pick} onChange={(e) => setPick(e.target.value)} autoFocus
                   placeholder="BAG" aria-label="Unit" />
          ) : (
            <select value={pick} onChange={(e) => setPick(e.target.value)} autoFocus
                    aria-label={action === "category" ? "Category" : "Tax rule"}>
              <option value="">—</option>
              {(action === "category" ? cats : taxes).map((o) =>
                <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <button className="btn btn-primary"
                  onClick={() => setFieldOnPicked(action === "category" ? "category_id" : action === "tax" ? "tax_rate_id" : "unit", pick)}>
            Apply to {count}
          </button>
        </div>
      )}
    </div>
  );
}
