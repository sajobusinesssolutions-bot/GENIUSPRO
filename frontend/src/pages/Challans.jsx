import React, { useEffect, useState } from "react";
import { offerDocPrint } from "../lib/printprompt.jsx";
import api, { can } from "../lib/api.js";
import { Field, PartyCombo, SkeletonRows, StatusPill, Empty, toast } from "../lib/ui.jsx";
import { DocShell, DocSection, DocTop, DocFields, DocParty } from "../lib/docshell.jsx";
import { DocLines, blankLine } from "../lib/doclines.jsx";

export default function Challans() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => api.get("/returns/challans").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const advance = async (c) => {
    const next = c.status === "open" ? "delivered" : "invoiced";
    await api.put(`/returns/challans/${c.id}/status`, { status: next });
    toast(`Challan ${next}`); load();
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Delivery challans</h2>
        {can("sales", "create") && <button className="btn btn-primary" onClick={() => setOpen(true)}>+ New challan</button>}
      </div>
      <table className="tw">
        <thead><tr><th>Challan #</th><th>Party</th><th>Date</th><th>Vehicle</th><th className="amt">Items</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows === null ? <SkeletonRows rows={4} cols={7} /> :
            rows.length === 0 ? <tr><td colSpan={7}><Empty icon="⇨" title="No challans" hint="Create one to accompany goods in transit." /></td></tr> :
            rows.map((c) => (
              <tr key={c.id} className="hl">
                <td className="strong num">{c.challan_no}</td><td>{c.party_name}</td>
                <td className="num">{c.challan_date}</td><td className="num">{c.vehicle_no || "—"}</td>
                <td className="amt">{c.line_count}</td>
                <td><StatusPill status={c.status === "open" ? "pending" : c.status === "delivered" ? "active" : "paid"} /></td>
                <td>{c.status !== "invoiced" && can("sales", "edit") &&
                  <button className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5, fontWeight: 500 }} onClick={() => advance(c)}>
                    {c.status === "open" ? "Mark delivered" : "Mark invoiced"}
                  </button>}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {open && <ChallanModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); toast("Challan created"); }} />}
    </div>
  );
}

const blank = () => blankLine();

/* ── Delivery challan ─────────────────────────────────────────────────────
   Kept under its old export name because pages/Invoices.jsx imports it.

   Full screen (lib/docshell.jsx). There is no money on a challan, so the
   footer counts goods instead of currency — the thing the driver and the
   person receiving both check is how many of what left the shop. */
export function ChallanModal({ onClose, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [f, setF] = useState({
    party_id: "", vehicle_no: "", notes: "", challan_date: today,
    driver: "", return_by: "",
  });
  const [lines, setLines] = useState([blank()]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  useEffect(() => {
    api.get("/parties").then(setParties).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
  }, []);

  const party = parties.find((p) => String(p.id) === String(f.party_id));
  const filled = lines.filter((l) => l.item_id || l.description);
  const totalQty = filled.reduce((a, l) => a + (Number(l.quantity) || 0), 0);

  const save = async () => {
    if (!f.party_id) return toast("Choose a party", "bad");
    if (!filled.length) return toast("Add at least one item", "bad");
    setBusy(true);
    try {
      /* The challans table has no driver and no return-by column, and a
         schema change is not something a form should smuggle in. Both are
         prepended to `notes`, which is the field that prints on the paper the
         driver carries — which is the only place either of them is any use.
         If they are ever worth querying they need real columns. */
      const stamped = [
        f.driver ? `Driver: ${f.driver}` : "",
        f.return_by ? `Return by: ${f.return_by}` : "",
        f.notes || "",
      ].filter(Boolean).join(" · ");
      const saved = await api.post("/returns/challans", {
        party_id: Number(f.party_id), challan_date: f.challan_date || undefined,
        vehicle_no: f.vehicle_no || null, notes: stamped || null,
        lines: filled.map((l) => ({
          item_id: l.item_id ? Number(l.item_id) : null, description: l.description,
          quantity: Number(l.quantity) || 1, unit: l.unit || undefined,
        })),
      });
      onSaved();
      /* The one document that travels with the goods, so it is the one most
         likely to be wanted on paper immediately. */
      offerDocPrint({
        path: `/returns/challans/${saved.id}`, noun: "delivery note",
        number: saved.challan_no, docTitle: "Delivery challan",
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <DocShell
      title="Delivery challan" docNo="Auto: DC-…"
      meta={f.vehicle_no ? `${f.challan_date} · ${f.vehicle_no}` : f.challan_date}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel="Create challan"
      summary={[
        { label: "Lines", value: String(filled.length) },
        { label: "Vehicle", value: f.vehicle_no || "—" },
        f.return_by ? { label: "Return by", value: f.return_by } : null,
      ].filter(Boolean)}
      total={{ label: "Goods out", value: `${+totalQty.toFixed(3)}` }}
      footNote="A challan moves paper, not stock or money. Invoice it afterwards to charge for what was delivered."
    >
      <DocTop>
        <DocSection title="Delivering to">
          <Field label="Party">
            <PartyCombo parties={parties} value={f.party_id} onPick={(id) => setF((v) => ({ ...v, party_id: id }))}
                        autoFocus placeholder="Search name or phone…"
                        onCreated={(p) => setParties((ps) => [p, ...ps])} />
          </Field>
          <DocParty party={party} emptyHint="Pick a party and their number, address and balance appear here." />
        </DocSection>
        <DocSection title="Transport">
          <DocFields>
            <Field label="Challan date">
              <input type="date" value={f.challan_date} onChange={set("challan_date")} />
            </Field>
            <Field label="Vehicle number">
              <input value={f.vehicle_no} onChange={set("vehicle_no")} placeholder="UAX 123A" />
            </Field>
            <Field label="Driver / phone">
              <input value={f.driver} onChange={set("driver")} placeholder="Who is carrying it" />
            </Field>
            {/* Goods sent on approval come back. Written onto the paper the
                driver carries so the shop has a date to chase. */}
            <Field label="Return by (goods on approval)">
              <input type="date" value={f.return_by} onChange={set("return_by")} />
            </Field>
          </DocFields>
          <Field label="Notes">
            <textarea value={f.notes} onChange={set("notes")} placeholder="Where to unload, who to ask for…" />
          </Field>
        </DocSection>
      </DocTop>

      <DocSection>
        <DocLines withRate={false} lines={lines} setLines={setLines} items={items} setItems={setItems}
                  qtyLabel="Quantity" addLabel="＋ Add item" title="What is going out" />
      </DocSection>
    </DocShell>
  );
}
