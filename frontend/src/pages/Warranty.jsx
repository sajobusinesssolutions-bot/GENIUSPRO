/**
 * Warranty.jsx — warranty cover and claims.
 *
 * The serial lookup is first because that is how this gets used: a customer
 * walks in holding the thing, and you need to know in seconds whether it is
 * still covered.
 */
import React, { useEffect, useState } from "react";
import api, { can } from "../lib/api.js";
import { Modal, Field, SkeletonRows, Empty, toast, RowMenu, ItemCombo, StatusChip, CountUp} from "../lib/ui.jsx";
import { inr } from "../lib/tax.js";
import { Icon } from "../lib/icons.jsx";

const statePill = (s) =>
  s === "in cover" ? "pill-ok" : s === "ending soon" ? "pill-warn" : s === "void" ? "" : "pill-bad";

export default function Warranty() {
  const [tab, setTab] = useState("cover");
  const [data, setData] = useState(null);
  const [claims, setClaims] = useState(null);
  const [serial, setSerial] = useState("");
  const [found, setFound] = useState(null);
  const [detail, setDetail] = useState(null);
  const [register, setRegister] = useState(false);

  const load = () => api.get("/warranty").then(setData).catch(() => setData({ rows: [], totals: {} }));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab === "claims") api.get("/warranty/claims/all").then(setClaims).catch(() => setClaims({ rows: [] })); }, [tab]);

  const lookup = async () => {
    if (!serial.trim()) return;
    try { const r = await api.get(`/warranty/lookup?serial=${encodeURIComponent(serial.trim())}`); setFound(r); }
    catch (e) { toast(e.message, "bad"); }
  };

  const t = data?.totals || {};

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Warranty</h2>
        {can("sales", "create") && <button className="btn btn-primary" onClick={() => setRegister(true)}>+ Register cover</button>}
      </div>

      <div className="wiz-drop" style={{ padding: "16px 18px", textAlign: "left", marginBottom: 14 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>Check a serial number</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={serial} onChange={(e) => setSerial(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && lookup()}
                 placeholder="Scan or type the serial from the unit" style={{ flex: 1, minWidth: 220 }} />
          <button className="btn btn-primary" onClick={lookup}>Check</button>
        </div>
        {found && (
          found.found ? (
            <div style={{ marginTop: 12 }}>
              <span className={`pill ${statePill(found.warranty.state)}`}>{found.warranty.state}</span>
              <span style={{ marginLeft: 10 }}>
                <b>{found.warranty.item_name}</b> · {found.warranty.party_name || "walk-in"} ·
                cover to {found.warranty.expires_on}
                {found.warranty.state === "in cover" && <> ({found.warranty.days_left} days left)</>}
              </span>
              <button className="btn btn-ghost" style={{ marginLeft: 10 }} onClick={() => setDetail(found.warranty.id)}>Open</button>
            </div>
          ) : (
            <div className="wiz-note" style={{ marginTop: 10 }}>No cover on file for “{found.serial}”.</div>
          )
        )}
      </div>

      {data && (
        <div className="sum-bar">
          <div className="sum-chip"><div className="sc-label">In cover</div><div className="sc-value num"><CountUp value={t.in_cover || 0} /></div></div>
          <div className="sum-chip"><div className="sc-label">Ending within a month</div><div className="sc-value num"><CountUp value={t.ending_soon || 0} /></div></div>
          <div className="sum-chip" style={{ borderColor: t.open_claims ? "var(--bad)" : undefined }}>
            <div className="sc-label">Open claims</div><div className="sc-value num"><CountUp value={t.open_claims || 0} /></div>
          </div>
        </div>
      )}

      <div className="toolbar">
        {[["cover", "Cover"], ["claims", "Claims"]].map(([id, label]) => (
          <button key={id} className={`btn ${tab === id ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "cover" ? (
        <table className="tw">
          <thead><tr><th>Item</th><th>Serial</th><th>Customer</th><th>Invoice</th>
            <th>Cover until</th><th>Status</th><th className="amt">Claims</th><th style={{ width: 44 }} /></tr></thead>
          <tbody>
            {data === null ? <SkeletonRows cols={8} /> : data.rows.length === 0 ? (
              <tr><td colSpan={8}>
                <Empty icon="⛨" title="No cover on file"
                       sub="Set a warranty period on an item and selling it will register cover automatically." />
              </td></tr>
            ) : data.rows.map((w) => (
              <tr key={w.id} className="hl">
                <td><button className="linkish" onClick={() => setDetail(w.id)}>{w.item_name}</button></td>
                <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 500 }}>{w.serial || "—"}</td>
                <td>{w.party_name || "walk-in"}</td>
                <td>{w.invoice_no || "—"}</td>
                <td>{w.expires_on}</td>
                <td>
                  <span className={`pill ${statePill(w.state)}`}>{w.state}</span>
                  {w.state === "ending soon" && <span style={{ fontSize: 12.5, color: "var(--muted)", marginLeft: 6 }}>{w.days_left}d</span>}
                </td>
                <td className="amt num">{w.claim_count || 0}{w.open_claims ? <span className="aging-over"> ({w.open_claims} open)</span> : null}</td>
                <td className="row-actions"><RowMenu label={`Actions for warranty ${w.id}`} items={[{ icon: <Icon n="eye" />, label: "Open", onClick: () => setDetail(w.id) }]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="tw">
          <thead><tr><th>Date</th><th>Item</th><th>Serial</th><th>Customer</th>
            <th>Fault</th><th>Outcome</th><th className="amt">Cost</th></tr></thead>
          <tbody>
            {claims === null ? <SkeletonRows cols={7} /> : claims.rows.length === 0 ? (
              <tr><td colSpan={7}><Empty icon="⛨" title="No claims" sub="Nothing has come back yet." /></td></tr>
            ) : claims.rows.map((c) => (
              <tr key={c.id} className="hl">
                <td>{c.claim_date}</td><td>{c.item_name}</td>
                <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 500 }}>{c.serial || "—"}</td>
                <td>{c.party_name || "walk-in"}</td>
                <td style={{ fontSize: 13.5 }}>{c.fault}</td>
                <td>
                  {c.status === "open"
                    ? <span className="pill pill-warn">open</span>
                    : <span className="pill pill-ok">{c.outcome}</span>}
                </td>
                <td className="amt num">{c.cost ? inr(c.cost) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && <CoverDetail id={detail} onClose={() => setDetail(null)}
                   onChanged={() => { load(); if (tab === "claims") api.get("/warranty/claims/all").then(setClaims); }} />}
      {register && <RegisterCover onClose={() => setRegister(false)} onSaved={() => { setRegister(false); load(); }} />}
    </div>
  );
}

function CoverDetail({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [fault, setFault] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/warranty/${id}`).then(setD).catch(() => setD(false));
  useEffect(() => { load(); }, [id]);

  if (d === null) return <Modal title="Loading…" onClose={onClose}><SkeletonRows cols={3} /></Modal>;
  if (d === false) return <Modal title="Not found" onClose={onClose}><Empty icon="?" title="Cover not found" /></Modal>;

  const logClaim = async () => {
    if (!fault.trim()) return toast("Describe the fault", "bad");
    setBusy(true);
    try { await api.post(`/warranty/${d.id}/claims`, { fault }); toast("Claim logged"); setFault(""); load(); onChanged(); }
    catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  const close = async (c, outcome) => {
    const cost = outcome === "repaired" || outcome === "replaced"
      ? Number(prompt("What did settling it cost? (0 if nothing)", "0")) || 0 : 0;
    try { await api.post(`/warranty/claims/${c.id}/close`, { outcome, cost }); toast(`Claim closed — ${outcome}`); load(); onChanged(); }
    catch (e) { toast(e.message, "bad"); }
  };
  const voidCover = async () => {
    const note = prompt("Why is this cover being voided?");
    if (!note) return;
    try { await api.post(`/warranty/${d.id}/void`, { note }); toast("Cover voided"); load(); onChanged(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <Modal title={`${d.item_name}${d.serial ? ` · ${d.serial}` : ""}`} onClose={onClose} wide>
      <div className="sum-bar" style={{ flexWrap: "wrap" }}>
        <div className="sum-chip"><div className="sc-label">Status</div>
          <div className="sc-value"><span className={`pill ${statePill(d.state)}`}>{d.state}</span></div></div>
        <div className="sum-chip"><div className="sc-label">Customer</div><div className="sc-value">{d.party_name || "walk-in"}</div></div>
        <div className="sum-chip"><div className="sc-label">Sold on</div><div className="sc-value">{d.starts_on}</div></div>
        <div className="sum-chip sum-total"><div className="sc-label">Cover until</div><div className="sc-value">{d.expires_on}</div></div>
      </div>
      {d.notes && <div className="wiz-note">{d.notes}</div>}

      {d.state !== "void" && d.state !== "expired" && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <input value={fault} onChange={(e) => setFault(e.target.value)} placeholder="What is wrong with it?" style={{ flex: 1, minWidth: 220 }} />
          <button className="btn btn-primary" onClick={logClaim} disabled={busy}>Log a claim</button>
        </div>
      )}

      <h4 style={{ margin: "18px 0 6px" }}>Claims</h4>
      {d.claims.length === 0 ? (
        <Empty icon="⛨" title="No claims on this one" />
      ) : (
        <table className="tw">
          <thead><tr><th>Date</th><th>Fault</th><th>Status</th><th className="amt">Cost</th><th /></tr></thead>
          <tbody>
            {d.claims.map((c) => (
              <tr key={c.id}>
                <td>{c.claim_date}</td><td style={{ fontSize: 13.5 }}>{c.fault}</td>
                <td>{c.status === "open" ? <span className="pill pill-warn">open</span> : <span className="pill pill-ok">{c.outcome}</span>}</td>
                <td className="amt num">{c.cost ? inr(c.cost) : "—"}</td>
                <td>
                  {c.status === "open" && (
                    <RowMenu items={["repaired", "replaced", "refunded", "rejected"].map((o) => ({
                      icon: <Icon n="check" />, label: `Close — ${o}`, onClick: () => close(c, o),
                    }))} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {d.state !== "void" && (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={voidCover}>Void this cover</button>
        </div>
      )}
    </Modal>
  );
}

function RegisterCover({ onClose, onSaved }) {
  const [items, setItems] = useState([]);
  const [parties, setParties] = useState([]);
  const [f, setF] = useState({ item_id: "", item_name: "", serial: "", party_id: "", months: 12,
                               starts_on: new Date().toISOString().slice(0, 10), notes: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/items").then((d) => setItems(d.rows || d)).catch(() => {});
    api.get("/parties").then(setParties).catch(() => {});
  }, []);
  const save = async () => {
    if (!f.item_id) return toast("Choose the item", "bad");
    setBusy(true);
    try {
      const r = await api.post("/warranty", { ...f, item_id: Number(f.item_id),
        party_id: f.party_id ? Number(f.party_id) : null, months: Number(f.months) });
      toast(r.message); onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };
  return (
    <Modal title="Register cover" onClose={onClose}>
      <div className="ib-hint" style={{ marginBottom: 10 }}>
        For goods sold before this was switched on. New sales register cover by themselves.
      </div>
      <Field label="Item">
        <ItemCombo items={items} value={f.item_name}
          onPick={(it) => setF({ ...f, item_id: it.id, item_name: it.name, months: it.warranty_months || f.months })}
          onText={(t) => setF({ ...f, item_name: t, item_id: "" })} />
      </Field>
      <Field label="Serial number (if it has one)"><input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} /></Field>
      <Field label="Customer">
        <select value={f.party_id} onChange={(e) => setF({ ...f, party_id: e.target.value })}>
          <option value="">Walk-in / unknown</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Sold on"><input type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
      <Field label="Months of cover"><input type="number" min="1" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Register"}</button>
      </div>
    </Modal>
  );
}
