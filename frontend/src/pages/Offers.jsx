/**
 * Offers.jsx — offers & promotions.
 *
 * Offers turn into ordinary line discounts at billing, so nothing here invents
 * a second kind of money off. The tester lets you check a basket before a rule
 * goes anywhere near a customer.
 */
import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { Modal, Field, SkeletonRows, Empty, toast, RowMenu, confirmDialog, ItemCombo, StatusChip, CountUp} from "../lib/ui.jsx";
import { inr, cur} from "../lib/tax.js";
import { Icon } from "../lib/icons.jsx";

const TYPES = [
  ["percent", "Percentage off"],
  ["amount", "Amount off each unit"],
  ["bxgy", "Buy X get Y free"],
];

export default function Offers() {
  const [rows, setRows] = useState(null);
  const [editor, setEditor] = useState(null);
  const [tester, setTester] = useState(false);

  const load = () => api.get("/offers").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const toggle = async (o) => {
    try { await api.put(`/offers/${o.id}`, { is_active: !o.is_active }); load(); }
    catch (e) { toast(e.message, "bad"); }
  };
  const remove = async (o) => {
    if (!(await confirmDialog({
      title: `Delete "${o.name}"?`,
      body: "Bills already raised keep the discount they were given — only future billing changes.",
      confirmLabel: "Delete", danger: true,
    }))) return;
    try { await api.delete(`/offers/${o.id}`); toast("Offer deleted"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const live = (rows || []).filter((o) => o.live).length;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Offers &amp; promotions</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => setTester(true)}>⚖ Test a basket</button>
          {can("sales", "create") && <button className="btn btn-primary" onClick={() => setEditor({ mode: "new" })}>+ New offer</button>}
        </div>
      </div>

      {rows && rows.length > 0 && (
        <div className="sum-bar">
          <div className="sum-chip"><div className="sc-label">Running now</div><div className="sc-value num"><CountUp value={live} /></div></div>
          <div className="sum-chip"><div className="sc-label">Total offers</div><div className="sc-value num"><CountUp value={rows.length} /></div></div>
        </div>
      )}

      <table className="tw">
        <thead><tr><th>Offer</th><th>Applies to</th><th>Deal</th><th>Runs</th><th>Status</th><th style={{ width: 44 }} /></tr></thead>
        <tbody>
          {rows === null ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tr><td colSpan={6}>
              <Empty icon="%" title="No offers yet"
                     sub="Set up a discount rule and it will be offered automatically at billing." />
            </td></tr>
          ) : rows.map((o) => (
            <tr key={o.id} className={`hl ${o.is_active ? "" : "is-inactive"}`}>
              <td><button className="linkish" onClick={() => setEditor({ mode: "edit", offer: o })}>{o.name}</button></td>
              <td>
                {o.scope === "bill" ? "Whole bill"
                  : o.item_name ? o.item_name
                  : o.category ? `Category: ${o.category}` : "Any item"}
                {o.min_qty > 0 && <span style={{ color: "var(--muted)", fontSize: 12.5, fontWeight: 500 }}> · min {o.min_qty}</span>}
                {o.min_amount > 0 && <span style={{ color: "var(--muted)", fontSize: 12.5, fontWeight: 500 }}> · over {cur()} {inr(o.min_amount)}</span>}
              </td>
              <td>{o.summary}</td>
              <td style={{ color: "var(--muted)", fontSize: 13.5 }}>
                {o.starts_on || "any time"}{o.ends_on ? ` → ${o.ends_on}` : ""}
              </td>
              <td>
                <span className={`pill ${o.live ? "pill-ok" : o.expired ? "pill-bad" : o.pending ? "pill-warn" : ""}`}>
                  {!o.is_active ? "off" : o.expired ? "expired" : o.pending ? "not started" : "running"}
                </span>
              </td>
              <td className="row-actions">
                <RowMenu items={[
                  { icon: <Icon n="edit" />, label: "Edit", onClick: () => setEditor({ mode: "edit", offer: o }) },
                  { icon: o.is_active ? "⏸" : "▶", label: o.is_active ? "Switch off" : "Switch on", onClick: () => toggle(o) },
                  { icon: <Icon n="trash" />, label: "Delete", danger: true, onClick: () => remove(o) },
                ]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editor && <OfferEditor init={editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); load(); }} />}
      {tester && <BasketTester onClose={() => setTester(false)} />}
    </div>
  );
}

function OfferEditor({ init, onClose, onSaved }) {
  const isEdit = init.mode === "edit";
  const o = init.offer || {};
  const [f, setF] = useState({
    name: o.name || "", scope: o.scope || "item", offer_type: o.offer_type || "percent",
    value: o.value ?? 10, item_id: o.item_id || "", item_name: o.item_name || "", category: o.category || "",
    min_qty: o.min_qty || 0, min_amount: o.min_amount || 0,
    buy_qty: o.buy_qty || 3, get_qty: o.get_qty || 1,
    starts_on: o.starts_on || "", ends_on: o.ends_on || "", priority: o.priority || 0, notes: o.notes || "",
  });
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/items").then((d) => setItems(d.rows || d)).catch(() => {}); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim()) return toast("Give this offer a name", "bad");
    setBusy(true);
    try {
      const body = { ...f, item_id: f.item_id ? Number(f.item_id) : null,
                     value: Number(f.value) || 0, min_qty: Number(f.min_qty) || 0,
                     min_amount: Number(f.min_amount) || 0,
                     buy_qty: Number(f.buy_qty) || null, get_qty: Number(f.get_qty) || null,
                     priority: Number(f.priority) || 0,
                     starts_on: f.starts_on || null, ends_on: f.ends_on || null };
      if (isEdit) await api.put(`/offers/${o.id}`, body);
      else await api.post("/offers", body);
      toast(isEdit ? "Offer updated" : "Offer saved");
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={isEdit ? "Edit offer" : "New offer"} onClose={onClose} wide>
      <div className="inv-meta">
        <Field label="Offer name"><input value={f.name} onChange={set("name")} placeholder="e.g. Festive season 10% off" autoFocus /></Field>
        <Field label="Applies to">
          <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, offer_type: e.target.value === "bill" && f.offer_type === "bxgy" ? "percent" : f.offer_type })}>
            <option value="item">A particular item or category</option>
            <option value="bill">The whole bill</option>
          </select>
        </Field>
        <Field label="Deal type">
          <select value={f.offer_type} onChange={set("offer_type")}>
            {TYPES.filter(([id]) => f.scope !== "bill" || id !== "bxgy").map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </Field>

        {f.offer_type === "bxgy" ? (
          <>
            <Field label="Buy"><input type="number" min="1" value={f.buy_qty} onChange={set("buy_qty")} /></Field>
            <Field label="Get free"><input type="number" min="1" value={f.get_qty} onChange={set("get_qty")} /></Field>
          </>
        ) : (
          <Field label={f.offer_type === "percent" ? "Percentage off" : "Shillings off each unit"}>
            <input type="number" value={f.value} onChange={set("value")} />
          </Field>
        )}

        {f.scope === "item" && (
          <>
            <Field label="Which item (leave blank for any)">
              <ItemCombo items={items} value={f.item_name}
                onPick={(it) => setF({ ...f, item_id: it.id, item_name: it.name, category: "" })}
                onText={(t) => setF({ ...f, item_name: t, item_id: t ? f.item_id : "" })} />
            </Field>
            <Field label="…or a whole category">
              <input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, item_id: "", item_name: "" })} />
            </Field>
            <Field label="Only when buying at least"><input type="number" value={f.min_qty} onChange={set("min_qty")} /></Field>
          </>
        )}
        <Field label={f.scope === "bill" ? "Only on bills over" : "Only when the line is over"}>
          <input type="number" value={f.min_amount} onChange={set("min_amount")} />
        </Field>
        <Field label="Starts"><input type="date" value={f.starts_on} onChange={set("starts_on")} /></Field>
        <Field label="Ends"><input type="date" value={f.ends_on} onChange={set("ends_on")} /></Field>
        <Field label="Priority (lower wins a clash)"><input type="number" value={f.priority} onChange={set("priority")} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={set("notes")} /></Field>
      </div>

      <div className="wiz-note">
        When two item offers could apply to the same line, only the better one is used — offers never
        stack into a loss. A whole-bill offer then applies to what is left.
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save offer"}</button>
      </div>
    </Modal>
  );
}

/** Try a basket against the live rules without touching a real sale. */
function BasketTester({ onClose }) {
  const [items, setItems] = useState([]);
  const [lines, setLines] = useState([{ item_id: null, description: "", quantity: 1, rate: 0 }]);
  const [result, setResult] = useState(null);
  useEffect(() => { api.get("/items").then((d) => setItems(d.rows || d)).catch(() => {}); }, []);

  const upd = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const gross = lines.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0);

  useEffect(() => {
    const clean = lines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (!clean.length) { setResult(null); return; }
    let alive = true;
    api.post("/offers/evaluate", { lines: clean })
      .then((r) => alive && setResult(r)).catch(() => alive && setResult(null));
    return () => { alive = false; };
  }, [lines]);

  return (
    <Modal title="Test a basket" onClose={onClose} wide>
      <div className="zoho-card">
        <div className="zc-head">Pretend basket</div>
        <table className="line-grid">
          <thead><tr><th style={{ width: "48%" }}>Item</th><th style={{ width: "16%" }}>Qty</th>
            <th style={{ width: "18%" }}>Rate</th><th className="amt">Discount</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const r = result?.lines?.find((x) => x.index === i);
              return (
                <tr key={i}>
                  <td>
                    <ItemCombo items={items} value={l.description}
                      onPick={(it) => upd(i, { item_id: it.id, description: it.name, rate: it.sale_price })}
                      onText={(t) => upd(i, { description: t, item_id: null })} />
                  </td>
                  <td className="num"><input className="cell-input" type="number" value={l.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} /></td>
                  <td className="num"><input className="cell-input" type="number" value={l.rate} onChange={(e) => upd(i, { rate: e.target.value })} /></td>
                  <td className="amt num">
                    {r && r.discount_pct > 0
                      ? <><b>{r.discount_pct}%</b><div style={{ fontSize: 11.5, color: "var(--muted)" }}>{r.applied?.offer_name}</div></>
                      : "—"}
                  </td>
                  <td>{lines.length > 1 && <button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon n="close" size={15} /></button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="zoho-addrow">
        <button className="btn" onClick={() => setLines([...lines, { item_id: null, description: "", quantity: 1, rate: 0 }])}>＋ Add line</button>
      </div>

      <div className="zoho-split" style={{ marginTop: 12 }}>
        <div>
          {result?.applied?.length > 0 ? (
            <div className="wiz-note" style={{ marginTop: 0 }}>
              Applied: {result.applied.join(", ")}
            </div>
          ) : (
            <div className="wiz-note" style={{ marginTop: 0 }}>No offer applies to this basket.</div>
          )}
        </div>
        <div className="zoho-totals">
          <div className="totals-box">
            <div className="totals-row"><span className="lbl">Before offers</span><span className="num">{cur()} {inr(gross)}</span></div>
            <div className="totals-row"><span className="lbl">Item offers</span><span className="num">−{cur()} {inr(result?.item_discount || 0)}</span></div>
            <div className="totals-row"><span className="lbl">Bill offer</span><span className="num">−{cur()} {inr(result?.bill_discount || 0)}</span></div>
            <div className="totals-row grand"><span>Customer pays</span><span className="num">{cur()} {inr(gross - (result?.total_discount || 0))}</span></div>
          </div>
        </div>
      </div>
      <div className="ib-hint">Before tax — the tax rules in Settings still apply on top of this.</div>
    </Modal>
  );
}
