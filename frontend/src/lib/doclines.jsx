import React from "react";
import api from "./api.js";
import { ItemCombo, BulkItemPicker } from "./ui.jsx";
import { unitFieldsFromItem, canFlip, flipLine } from "./lineunits.js";
import { inr, cur } from "./tax.js";
import { Icon } from "./icons.jsx";

/* ── DocLines — the item table, once ────────────────────────────────────────
   Five documents had five item tables. The purchase form had a searchable
   combo, a bulk picker, a unit flip and batch/expiry; the estimate, the credit
   note and the challan each had a bare <select> listing every item in the shop
   in insertion order, which is unusable past about forty items and is why a
   quotation took longer to type than the sale it turned into.

   One table, with the columns switched off rather than re-implemented:
     withRate   false on a challan — goods moving, no money
     withBatch  true on a purchase — what arrived, with its expiry
     calc       supplies the Amount column; omit it and the column goes

   The unit flip commits on mousedown, not click: a focused quantity cell blurs
   between the two and its commit overwrites the flip, which sold 1 KG where 50
   was meant. That is the one piece of behaviour here that is not obvious, so
   it is centralised rather than copied. */

export const blankLine = () => ({ item_id: "", description: "", quantity: 1, rate: 0, batch_no: "", expiry_date: "" });

/**
 * The unit a line is priced and counted in.
 *
 * This was a button reading "KG ⇄", which is a toggle wearing the clothes of a
 * label: it says what the unit IS, not that it can be something else, and
 * people read it as a caption and never pressed it. So a shop selling cement
 * by the bag and by the kilo could not, in practice, sell by the kilo on an
 * invoice — the mechanism was there and invisible.
 *
 * A select says both units out loud. Choosing one runs exactly the same flip
 * as the button did, so the money on the line is preserved: switch to a unit
 * fifty times smaller and the price per unit drops fifty times while the
 * quantity rises fifty times.
 *
 * `onMouseDown` on the option is not enough — a select commits on change — so
 * the blur-then-commit problem the button had is handled by reading the value
 * and flipping only when it actually differs.
 */
export function UnitPicker({ line, onChange }) {
  if (!canFlip(line)) return <span className="unit-static">{line.unit || "—"}</span>;
  const base = line.base_unit || line.unit;
  const sec = line.secondary_unit;
  const current = line.use_secondary ? sec : base;
  return (
    <select className="cell-input unit-pick" value={current}
            aria-label="Unit for this line"
            onChange={(e) => { if (e.target.value !== current) onChange(flipLine(line)); }}>
      <option value={base}>{base}</option>
      <option value={sec}>{sec}</option>
    </select>
  );
}

/* ── Choosing which batch leaves the shelf ──────────────────────────────────
   Selling is not purchasing. On a purchase you TYPE a batch, because it is new
   and only you know what is printed on the carton. On a sale you CHOOSE one,
   because the only batches that can leave are the ones already in stock — and
   typing a batch on a sale is a way of selling something that isn't there.

   The default is deliberately not a batch at all but "Auto", which lets the
   stock poster issue earliest-expiry-first. That is the right answer almost
   always; the picker exists for the times it isn't — a customer who wants the
   long-dated box, or a batch being cleared. Choosing a named batch takes the
   `else` arm of postDocument, which is why sale lines now carry `batch_no`.

   The counts and dates are read once per item and cached for the life of the
   form: a fifteen-line invoice would otherwise ask the server fifteen times
   for a list that cannot change while the form is open. */
const batchCache = new Map();

export function useBatches(itemId) {
  const [rows, setRows] = React.useState(() => batchCache.get(itemId) || null);
  React.useEffect(() => {
    if (!itemId) return setRows(null);
    const hit = batchCache.get(itemId);
    if (hit) return setRows(hit);
    let live = true;
    api.get(`/items/${itemId}/batches`)
      .then((d) => { batchCache.set(itemId, d.rows || []); if (live) setRows(d.rows || []); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [itemId]);
  return rows;
}

export function forgetBatches() { batchCache.clear(); }

const batchLabel = (b) => {
  const name = b.batch_no || "(no batch)";
  const qty = `${b.quantity}`;
  if (b.days_left == null) return `${name} — ${qty} in stock`;
  if (b.days_left < 0) return `${name} — ${qty}, EXPIRED ${-b.days_left}d ago`;
  return `${name} — ${qty}, expires ${b.expiry_date} (${b.days_left}d)`;
};

export function BatchPicker({ line, onChange, warnDays = 30 }) {
  const rows = useBatches(line.item_id || null);
  if (!line.item_id) return <span className="unit-static">—</span>;
  if (rows === null) return <span className="unit-static">…</span>;
  if (!rows.length) return <span className="unit-static" title="Nothing in stock for this item">—</span>;

  const chosen = rows.find((r) => (r.batch_no || "") === (line.batch_no || ""));
  const soon = chosen && chosen.days_left != null && chosen.days_left < warnDays;
  return (
    <div className={`batch-pick${soon ? (chosen.days_left < 0 ? " is-expired" : " is-soon") : ""}`}>
      <select className="cell-input" value={line.batch_no || ""}
              aria-label="Batch for this line"
              onChange={(e) => onChange({ batch_no: e.target.value })}>
        <option value="">Auto — soonest expiry</option>
        {rows.map((b) => (
          <option key={b.batch_no || "_"} value={b.batch_no || ""}>{batchLabel(b)}</option>
        ))}
      </select>
      {soon && (
        <span className="batch-warn" title={chosen.days_left < 0 ? "This batch is past its expiry date" : "This batch expires soon"}>
          {chosen.days_left < 0 ? "expired" : `${chosen.days_left}d`}
        </span>
      )}
    </div>
  );
}

/**
 * The line that says, above the table, that something on it is out of date.
 * A per-line chip is easy to miss when the row is scrolled sideways; a banner
 * at the top of the item table is not.
 */
export function ExpiryNotice({ lines, warnDays = 30 }) {
  const ids = (lines || []).map((l) => l.item_id).filter(Boolean);
  const bad = [];
  for (const l of lines || []) {
    const rows = l.item_id ? batchCache.get(l.item_id) : null;
    if (!rows || !l.batch_no) continue;
    const b = rows.find((r) => (r.batch_no || "") === l.batch_no);
    if (b && b.days_left != null && b.days_left < warnDays) bad.push({ ...b, name: l.description });
  }
  if (!ids.length || !bad.length) return null;
  const expired = bad.filter((b) => b.days_left < 0);
  return (
    <div className={`expiry-notice${expired.length ? " is-expired" : ""}`}>
      <Icon n="alert" size={14} />
      <span>
        {expired.length
          ? `${expired.length} line${expired.length > 1 ? "s use" : " uses"} an EXPIRED batch — ${expired.map((b) => `${b.name} (${b.batch_no})`).join(", ")}`
          : `${bad.length} line${bad.length > 1 ? "s" : ""} use a batch expiring soon — ${bad.map((b) => `${b.name} (${b.batch_no}, ${b.days_left}d)`).join(", ")}`}
      </span>
    </div>
  );
}

export function DocLines({
  lines, setLines, items, setItems, calc, ratePick,
  withBatch = false, withRate = true, bulk = true,
  qtyLabel = "Quantity", addLabel = "＋ Add New Row", title = "Item Table",
}) {
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const upd = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i, id) => {
    const it = items.find((x) => x.id === Number(id));
    if (!it) return upd(i, { item_id: "", description: "" });
    upd(i, {
      item_id: it.id, description: it.name,
      ...(withRate ? { rate: ratePick ? ratePick(it) : it.sale_price } : {}),
      ...unitFieldsFromItem(it),
    });
  };
  const cols = 3 + (withRate ? 3 : 0) + (withBatch ? 2 : 0);

  return (
    <>
      <div className="zoho-card doc-lines">
        <div className="zc-head">{title}</div>
        <div className="dk-scrollx">
          <table className="line-grid doc-linegrid">
            <thead>
              <tr>
                <th>Item details</th>
                <th style={{ width: 84 }}>{qtyLabel}</th>
                <th style={{ width: 74 }}>Unit</th>
                {withRate && <>
                  <th style={{ width: 100 }}>Rate</th>
                  <th style={{ width: 84 }}>Discount %</th>
                </>}
                {withBatch && <>
                  <th style={{ width: 96 }}>Batch</th>
                  <th style={{ width: 140 }}>Expiry</th>
                </>}
                {withRate && <th className="amt" style={{ width: 118, textAlign: "right" }}>Amount</th>}
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <ItemCombo items={items} value={l.item_id} onPick={(id) => pick(i, id)}
                               onCreated={(it) => setItems && setItems((xs) => [it, ...xs])} />
                  </td>
                  <td className="num">
                    <input className="cell-input" type="number" value={l.quantity}
                           onChange={(e) => upd(i, { quantity: e.target.value })} />
                  </td>
                  <td><UnitPicker line={l} onChange={(patch) => upd(i, patch)} /></td>
                  {withRate && <>
                    <td className="num">
                      <input className="cell-input" type="number" value={l.rate}
                             onChange={(e) => upd(i, { rate: e.target.value })} />
                    </td>
                    <td className="num">
                      <input className="cell-input" type="number" value={l.discount_pct ?? ""} placeholder="0"
                             onChange={(e) => upd(i, { discount_pct: e.target.value })} />
                    </td>
                  </>}
                  {withBatch && <>
                    <td><input className="cell-input" placeholder="LOT-1" value={l.batch_no || ""}
                               onChange={(e) => upd(i, { batch_no: e.target.value })} /></td>
                    <td><input className="cell-input" type="date" value={l.expiry_date || ""}
                               onChange={(e) => upd(i, { expiry_date: e.target.value })} /></td>
                  </>}
                  {withRate && (
                    <td className="amt num" style={{ fontWeight: 650 }}>
                      {cur()} {inr(((calc && calc.lines[i]) || {}).line_total)}
                    </td>
                  )}
                  <td>
                    <button className="icon-btn" aria-label="Remove line"
                            onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))}>
                      <Icon n="close" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={cols} className="doc-linesempty">No lines yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="zoho-addrow doc-addrow">
        <button className="btn" onClick={() => setLines((l) => [...l, blankLine()])}>{addLabel}</button>
        {bulk && <button className="btn" onClick={() => setBulkOpen(true)}>＋ Add Items in Bulk</button>}
      </div>
      {bulkOpen && (
        <BulkItemPicker items={items} onClose={() => setBulkOpen(false)}
          onAdd={(picks) => setLines((ls) => {
            const base = ls.filter((l) => l.item_id || l.description);
            const added = picks.map(({ id, qty }) => {
              const it = items.find((x) => x.id === id);
              if (!it) return null;
              return {
                ...blankLine(), item_id: it.id, description: it.name, quantity: qty,
                ...(withRate ? { rate: ratePick ? ratePick(it) : it.sale_price } : {}),
                ...unitFieldsFromItem(it),
              };
            }).filter(Boolean);
            return [...base, ...added].length ? [...base, ...added] : [blankLine()];
          })} />
      )}
    </>
  );
}
