/**
 * Manufacturing.jsx — bills of materials and production runs.
 *
 * The costing panel is the point of this screen: before committing, you see
 * what the batch will consume, what it will cost, what each finished unit will
 * be worth, and whether the shelf can actually cover it.
 */
import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { Modal, Field, SkeletonRows, Empty, toast, RowMenu, confirmDialog, ItemCombo, StatusChip, CountUp} from "../lib/ui.jsx";
import { inr, cur} from "../lib/tax.js";
import { Icon } from "../lib/icons.jsx";

export default function Manufacturing() {
  const [tab, setTab] = useState("boms");
  const [boms, setBoms] = useState(null);
  const [runs, setRuns] = useState(null);
  const [editor, setEditor] = useState(null);
  const [produce, setProduce] = useState(null);
  const [runDetail, setRunDetail] = useState(null);

  const loadBoms = () => api.get("/manufacturing/boms").then(setBoms).catch(() => setBoms([]));
  const loadRuns = () => api.get("/manufacturing/runs").then(setRuns).catch(() => setRuns([]));
  useEffect(() => { loadBoms(); }, []);
  useEffect(() => { if (tab === "runs") loadRuns(); }, [tab]);

  const removeBom = async (b) => {
    if (!(await confirmDialog({
      title: `Delete "${b.name}"?`,
      body: "If this recipe has been used, it is retired instead of deleted so past production runs still make sense.",
      confirmLabel: "Delete", danger: true,
    }))) return;
    try { const r = await api.delete(`/manufacturing/boms/${b.id}`); toast(r.message); loadBoms(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const toggleActive = async (b) => {
    try { await api.put(`/manufacturing/boms/${b.id}`, { is_active: !b.is_active }); loadBoms(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Manufacturing</h2>
        {can("items", "edit") && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => setProduce({})}>▶ Produce</button>
            <button className="btn btn-primary" onClick={() => setEditor({ mode: "new" })}>+ New recipe</button>
          </div>
        )}
      </div>

      <div className="toolbar">
        {[["boms", "Recipes"], ["runs", "Production runs"]].map(([id, label]) => (
          <button key={id} className={`btn ${tab === id ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "boms" ? (
        <table className="tw">
          <thead><tr><th>Recipe</th><th>Makes</th><th className="amt">Yield</th>
            <th className="amt">Components</th><th className="amt">Labour + overhead</th><th>Status</th><th style={{ width: 44 }} /></tr></thead>
          <tbody>
            {boms === null ? <SkeletonRows cols={7} /> : boms.length === 0 ? (
              <tr><td colSpan={7}>
                <Empty icon="⚒" title="No recipes yet"
                       sub="A recipe says what goes into one batch of something you make." />
              </td></tr>
            ) : boms.map((b) => (
              <tr key={b.id} className={`hl ${b.is_active ? "" : "is-inactive"}`}>
                <td><button className="linkish" onClick={() => setEditor({ mode: "edit", id: b.id })}>{b.name}</button></td>
                <td>{b.item_name}</td>
                <td className="amt num">{b.output_qty} {b.item_unit}</td>
                <td className="amt num">{b.component_count}</td>
                <td className="amt num">{inr((b.labour_cost || 0) + (b.overhead_cost || 0))}</td>
                <td><span className={`pill ${b.is_active ? "pill-ok" : ""}`}>{b.is_active ? "in use" : "retired"}</span></td>
                <td className="row-actions">
                  <RowMenu items={[
                    { icon: <Icon n="play" />, label: "Produce with this", onClick: () => setProduce({ bom_id: b.id }) },
                    { icon: <Icon n="edit" />, label: "Edit", onClick: () => setEditor({ mode: "edit", id: b.id }) },
                    { icon: b.is_active ? "⏸" : "▶", label: b.is_active ? "Retire" : "Put back in use", onClick: () => toggleActive(b) },
                    { icon: <Icon n="trash" />, label: "Delete", danger: true, onClick: () => removeBom(b) },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="tw">
          <thead><tr><th>Ref</th><th>Date</th><th>Made</th><th className="amt">Qty</th>
            <th className="amt">Components</th><th className="amt">Labour+OH</th><th className="amt">Unit cost</th><th>By</th></tr></thead>
          <tbody>
            {runs === null ? <SkeletonRows cols={8} /> : runs.length === 0 ? (
              <tr><td colSpan={8}><Empty icon="⚒" title="Nothing produced yet" sub="Production runs will appear here." /></td></tr>
            ) : runs.map((r) => (
              <tr key={r.id} className="hl">
                <td><button className="linkish" onClick={() => setRunDetail(r.id)}>{r.reference}</button></td>
                <td>{r.run_date}</td><td>{r.item_name}</td>
                <td className="amt num">{r.quantity} {r.item_unit}</td>
                <td className="amt num">{inr(r.cost_components)}</td>
                <td className="amt num">{inr((r.cost_labour || 0) + (r.cost_overhead || 0))}</td>
                <td className="amt num"><b>{inr(r.unit_cost)}</b></td>
                <td style={{ color: "var(--muted)", fontSize: 13.5 }}>{r.who || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editor && <BomEditor init={editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); loadBoms(); }} />}
      {produce && <ProduceModal init={produce} boms={(boms || []).filter((b) => b.is_active)}
                    onClose={() => setProduce(null)}
                    onDone={() => { setProduce(null); loadBoms(); if (tab === "runs") loadRuns(); else setTab("runs"); }} />}
      {runDetail && <RunDetail id={runDetail} onClose={() => setRunDetail(null)} />}
    </div>
  );
}

function BomEditor({ init, onClose, onSaved }) {
  const isEdit = init.mode === "edit";
  const [f, setF] = useState({ name: "", item_id: "", output_qty: 1, labour_cost: 0, overhead_cost: 0, notes: "" });
  const [comps, setComps] = useState([{ item_id: null, description: "", quantity: 1 }]);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get("/items").then((d) => setItems(d.rows || d)).catch(() => {}); }, []);
  useEffect(() => {
    if (!isEdit) return;
    api.get(`/manufacturing/boms/${init.id}`).then((d) => {
      setF({ name: d.name, item_id: d.item_id, output_qty: d.output_qty,
             labour_cost: d.labour_cost, overhead_cost: d.overhead_cost, notes: d.notes || "" });
      setComps(d.lines.map((l) => ({ item_id: l.item_id, description: l.name, quantity: l.per_batch })));
    }).catch(() => {});
  }, [isEdit, init.id]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const upd = (i, patch) => setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const outItem = items.find((i) => i.id === Number(f.item_id));

  /* Rough cost using each component's buy price, so the recipe can be judged
     while it is being written; the real costing uses live stock value. */
  const estimate = useMemo(() => {
    const c = comps.reduce((a, x) => {
      const it = items.find((i) => i.id === x.item_id);
      return a + (Number(x.quantity) || 0) * (Number(it?.purchase_price) || 0);
    }, 0);
    const total = c + (Number(f.labour_cost) || 0) + (Number(f.overhead_cost) || 0);
    const out = Number(f.output_qty) || 1;
    return { components: c, total, unit: total / out };
  }, [comps, items, f.labour_cost, f.overhead_cost, f.output_qty]);

  const save = async () => {
    const clean = comps.filter((c) => c.item_id).map((c) => ({ item_id: c.item_id, quantity: Number(c.quantity) || 0 }));
    if (!f.name.trim()) return toast("Give this recipe a name", "bad");
    if (!f.item_id) return toast("Choose what this recipe makes", "bad");
    if (!clean.length) return toast("Add at least one component", "bad");
    setBusy(true);
    try {
      const body = { ...f, item_id: Number(f.item_id), output_qty: Number(f.output_qty),
                     labour_cost: Number(f.labour_cost) || 0, overhead_cost: Number(f.overhead_cost) || 0,
                     components: clean };
      if (isEdit) await api.put(`/manufacturing/boms/${init.id}`, body);
      else await api.post("/manufacturing/boms", body);
      toast(isEdit ? "Recipe updated" : "Recipe saved");
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={isEdit ? "Edit recipe" : "New recipe"} onClose={onClose} wide>
      <div className="inv-meta">
        <Field label="Recipe name"><input value={f.name} onChange={set("name")} placeholder="e.g. Bread batch" autoFocus /></Field>
        <Field label="Makes">
          <select value={f.item_id} onChange={set("item_id")}>
            <option value="">Choose the finished item…</option>
            {items.filter((i) => i.is_inventory).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </Field>
        <Field label={`How many per batch${outItem ? ` (${outItem.unit})` : ""}`}>
          <input type="number" min="0.001" step="any" value={f.output_qty} onChange={set("output_qty")} />
        </Field>
        <Field label="Labour per batch"><input type="number" value={f.labour_cost} onChange={set("labour_cost")} /></Field>
        <Field label="Overhead per batch"><input type="number" value={f.overhead_cost} onChange={set("overhead_cost")} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={set("notes")} /></Field>
      </div>

      <div className="zoho-card">
        <div className="zc-head">Goes into one batch</div>
        <table className="line-grid">
          <thead><tr><th style={{ width: "58%" }}>Component</th><th style={{ width: "22%" }}>Quantity</th>
            <th className="amt">Est. cost</th><th /></tr></thead>
          <tbody>
            {comps.map((c, i) => {
              const it = items.find((x) => x.id === c.item_id);
              return (
                <tr key={i}>
                  <td>
                    <ItemCombo items={items} value={c.description}
                      onPick={(x) => upd(i, { item_id: x.id, description: x.name })}
                      onText={(t) => upd(i, { description: t, item_id: null })} />
                  </td>
                  <td className="num">
                    <input className="cell-input" type="number" step="any" value={c.quantity} onChange={(e) => upd(i, { quantity: e.target.value })} />
                    {it && <span style={{ fontSize: 11.5, color: "var(--muted)", marginLeft: 6 }}>{it.unit}</span>}
                  </td>
                  <td className="amt num">{inr((Number(c.quantity) || 0) * (Number(it?.purchase_price) || 0))}</td>
                  <td>{comps.length > 1 && <button className="icon-btn" onClick={() => setComps(comps.filter((_, j) => j !== i))}><Icon n="close" size={15} /></button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="zoho-addrow">
        <button className="btn" onClick={() => setComps([...comps, { item_id: null, description: "", quantity: 1 }])}>＋ Add component</button>
        <div style={{ flex: 1 }} />
        <div style={{ alignSelf: "center", fontSize: 13.5, color: "var(--muted)" }}>
          Roughly <b style={{ color: "var(--text)" }}>{cur()} {inr(estimate.total)}</b> a batch ·
          about <b style={{ color: "var(--text)" }}>{cur()} {inr(estimate.unit)}</b> each
        </div>
      </div>
      <div className="ib-hint">Estimated from buy prices. When you produce, components are costed at what your stock is actually worth.</div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save recipe"}</button>
      </div>
    </Modal>
  );
}

function ProduceModal({ init, boms, onClose, onDone }) {
  const [bomId, setBomId] = useState(init.bom_id || "");
  const [batches, setBatches] = useState(1);
  const [cost, setCost] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bomId || !(Number(batches) > 0)) { setCost(null); return; }
    let alive = true;
    api.get(`/manufacturing/costing/${bomId}?batches=${Number(batches)}`)
      .then((c) => alive && setCost(c)).catch(() => alive && setCost(null));
    return () => { alive = false; };
  }, [bomId, batches]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post("/manufacturing/produce", { bom_id: Number(bomId), batches: Number(batches), note: note || null });
      toast(r.message);
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const short = cost?.shortages?.length > 0;
  const bom = boms.find((b) => b.id === Number(bomId));

  return (
    <Modal title="Produce" onClose={onClose} wide>
      <div className="inv-meta">
        <Field label="Recipe">
          <select value={bomId} onChange={(e) => setBomId(e.target.value)} autoFocus>
            <option value="">Choose a recipe…</option>
            {boms.map((b) => <option key={b.id} value={b.id}>{b.name} → {b.output_qty} {b.item_unit} of {b.item_name}</option>)}
          </select>
        </Field>
        <Field label="How many batches"><input type="number" min="1" step="any" value={batches} onChange={(e) => setBatches(e.target.value)} /></Field>
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>

      {cost && (
        <>
          <div className="zoho-card">
            <div className="zc-head">This will use</div>
            <table className="line-grid">
              <thead><tr><th>Component</th><th className="amt">Needed</th><th className="amt">In stock</th>
                <th className="amt">Unit cost</th><th className="amt">Cost</th></tr></thead>
              <tbody>
                {cost.lines.map((l) => (
                  <tr key={l.item_id}>
                    <td>{l.name}</td>
                    <td className="amt num">{l.quantity} {l.unit_name}</td>
                    <td className="amt num">
                      {l.on_hand == null ? "—" :
                        l.short > 0 ? <span className="aging-over">{l.on_hand} (short {l.short})</span> : l.on_hand}
                    </td>
                    <td className="amt num">{inr(l.unit_cost)}</td>
                    <td className="amt num">{inr(l.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="zoho-split" style={{ marginTop: 14 }}>
            <div />
            <div className="zoho-totals">
              <div className="totals-box">
                <div className="totals-row"><span className="lbl">Components</span><span className="num">{cur()} {inr(cost.components)}</span></div>
                {cost.labour > 0 && <div className="totals-row"><span className="lbl">Labour</span><span className="num">{cur()} {inr(cost.labour)}</span></div>}
                {cost.overhead > 0 && <div className="totals-row"><span className="lbl">Overhead</span><span className="num">{cur()} {inr(cost.overhead)}</span></div>}
                <div className="totals-row grand"><span>Total cost</span><span className="num">{cur()} {inr(cost.total)}</span></div>
                <div className="totals-row"><span className="lbl">Produces</span><span className="num">{cost.output} {bom?.item_unit || ""}</span></div>
                <div className="totals-row"><span className="lbl">Cost each</span><span className="num">{cur()} {inr(cost.unit_cost)}</span></div>
              </div>
            </div>
          </div>

          {short && (
            <div className="wiz-note" style={{ color: "var(--bad)" }}>
              Not enough stock: {cost.shortages.map((s) => `${s.name} (short ${s.short} ${s.unit_name})`).join(", ")}.
              Buy or produce the missing components first.
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={run} disabled={busy || !cost || short}>
          {busy ? "Producing…" : cost ? `Produce ${cost.output} ${bom?.item_unit || ""}` : "Produce"}
        </button>
      </div>
    </Modal>
  );
}

function RunDetail({ id, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/manufacturing/runs/${id}`).then(setD).catch(() => setD(false)); }, [id]);
  if (d === null) return <Modal title="Loading…" onClose={onClose}><SkeletonRows cols={3} /></Modal>;
  if (d === false) return <Modal title="Not found" onClose={onClose}><Empty icon="?" title="Run not found" /></Modal>;
  return (
    <Modal title={`${d.reference} — ${d.item_name}`} onClose={onClose} wide>
      <div className="sum-bar" style={{ flexWrap: "wrap" }}>
        <div className="sum-chip"><div className="sc-label">Made</div><div className="sc-value num">{d.quantity} {d.item_unit}</div></div>
        <div className="sum-chip"><div className="sc-label">Components</div><div className="sc-value num">{cur()} <CountUp value={d.cost_components} decimals={2} /></div></div>
        <div className="sum-chip"><div className="sc-label">Labour + overhead</div><div className="sc-value num">{cur()} {inr((d.cost_labour || 0) + (d.cost_overhead || 0))}</div></div>
        <div className="sum-chip sum-total"><div className="sc-label">Cost each</div><div className="sc-value num">{cur()} <CountUp value={d.unit_cost} decimals={2} /></div></div>
      </div>
      {d.note && <div className="wiz-note">{d.note}</div>}
      <h4 style={{ margin: "18px 0 6px" }}>Consumed</h4>
      <table className="tw">
        <thead><tr><th>Component</th><th className="amt">Quantity</th><th className="amt">Unit cost</th><th className="amt">Cost</th></tr></thead>
        <tbody>
          {d.consumed.map((c) => (
            <tr key={c.id}><td>{c.name}</td><td className="amt num">{c.quantity} {c.unit}</td>
              <td className="amt num">{inr(c.unit_cost)}</td><td className="amt num">{inr(c.cost)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="ib-hint" style={{ marginTop: 10 }}>
        Components were costed at what your stock was worth at the time, so the finished goods
        carry a real cost and their margin is honest.
      </div>
    </Modal>
  );
}
