import React, { useEffect, useMemo, useState } from "react";
import { offerDocPrint } from "../lib/printprompt.jsx";
import api, { can } from "../lib/api.js";
import { useAttempt } from "../lib/attempt.jsx";
import { computeInvoice, inr, cur} from "../lib/tax.js";
import { Field, PartyCombo, SkeletonRows, Empty, toast, confirmDialog, RowMenu } from "../lib/ui.jsx";
import { useTaxRules } from "../lib/taxrules.js";
import { Icon } from "../lib/icons.jsx";
import { DocShell, DocSection, DocTop, DocFields, DocParty, DocTotals, docSummary } from "../lib/docshell.jsx";
import { DocLines, blankLine } from "../lib/doclines.jsx";

export default function Estimates() {
  const [edit, setEdit] = useState(null);
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => api.get("/estimates").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const convert = async (e) => {
    if (!(await confirmDialog({ message: `Convert ${e.doc_no} into a real invoice? Stock and books will be updated.`, danger: false, confirmLabel: "Convert to invoice" }))) return;
    try {
      const full = await api.get(`/estimates/${e.id}`);
      const inv = await api.post("/sales", {
        party_id: full.party_id, payment_type: "credit",
        lines: full.lines.map((l) => ({ item_id: l.item_id, description: l.description, quantity: l.quantity, rate: l.rate })),
      });
      await api.put(`/estimates/${e.id}/status`, { status: "converted", invoice_id: inv.id });
      toast(`${e.doc_no} → ${inv.invoice_no}`);
      load();
      offerDocPrint({ path: `/sales/${inv.id}`, noun: "invoice", number: inv.invoice_no,
                      party: e.party_name, context: "invoice", detail: e.party_name });
    } catch (err) { toast(err.message, "bad"); }
  };
  const cancel = async (e) => {
    await api.put(`/estimates/${e.id}/status`, { status: "cancelled" });
    toast("Cancelled"); load();
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Estimates & sale orders</h2>
        {can("sales", "create") && <button className="btn btn-primary" onClick={() => setOpen(true)}>+ New estimate / order</button>}
      </div>
      <table className="tw">
        <thead><tr><th>Doc #</th><th>Type</th><th>Party</th><th>Date</th><th className="amt">Amount</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows === null ? <SkeletonRows rows={4} cols={7} /> :
            rows.length === 0 ? <tr><td colSpan={7}><Empty icon="✎" title="No estimates yet" hint="Quote a customer without touching stock or books." /></td></tr> :
            rows.map((e) => (
              <tr key={e.id} className="hl">
                <td className="strong num">{e.doc_no}</td>
                <td><span className={`pill ${e.doc_type === "order" ? "pill-info" : "pill-warn"}`}>{e.doc_type === "order" ? "Sale order" : "Estimate"}</span></td>
                <td>{e.party_name}</td>
                <td className="num">{e.doc_date}</td>
                <td className="amt num">{cur()} {inr(e.grand_total)}</td>
                <td><span className={`pill ${e.status === "converted" ? "pill-ok" : e.status === "cancelled" ? "pill-bad" : "pill-info"}`}>{e.status}</span></td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {e.status === "open" && can("sales", "create") && (
                    <button className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5, fontWeight: 500 }} onClick={() => convert(e)}>→ Invoice</button>
                  )}
                  <RowMenu label={`Actions for ${e.doc_no}`} actions={[
                    ...(e.status !== "converted" && can("sales", "edit") ? [{
                      icon: <Icon n="edit" />, label: "Edit", onClick: () => setEdit(e),
                    }] : []),
                    ...(e.status === "open" && can("sales", "edit") ? [{
                      icon: <Icon n="close" />, label: "Mark cancelled", onClick: () => cancel(e),
                    }] : []),
                    ...(can("sales", "delete") ? [{
                      icon: <Icon n="trash" />, label: "Delete", danger: true,
                      disabled: e.status === "converted",
                      hint: e.status === "converted" ? "it became an invoice" : undefined,
                      onClick: async () => {
                        if (!(await confirmDialog({
                          title: `Delete ${e.doc_no}?`,
                          message: "A quotation posts nothing to the books and holds no stock, so this removes it outright. Nothing else changes.",
                          danger: true, confirmLabel: "Delete",
                        }))) return;
                        try { const x = await api.delete(`/estimates/${e.id}`); toast(x.message || "Deleted"); load(); }
                        catch (err) { toast(err.message, "bad"); }
                      },
                    }] : []),
                  ]} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {open && <EstimateModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); toast("Saved"); }} />}
      {edit && <EstimateModal edit={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

const blank = () => blankLine();

/* ── Estimate / quotation / sale order ────────────────────────────────────
   Kept under its old export name because pages/Invoices.jsx imports it —
   the Sales screen's Estimates tab and this page now open the same editor.

   Full screen (lib/docshell.jsx) rather than a 760px dialog: a quotation is a
   document with as many lines as the customer asks for, and its total is the
   number being negotiated, so it may never be off-screen.  */
export function EstimateModal({ edit, onClose, onSaved }) {
  const attempt = useAttempt("estimate");
  const today = new Date().toISOString().slice(0, 10);
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const { rules, taxActive } = useTaxRules("estimate");
  const [docType, setDocType] = useState((edit && edit.doc_type) || "estimate");
  const [partyId, setPartyId] = useState(edit ? String(edit.party_id || "") : "");
  const [docDate, setDocDate] = useState((edit && String(edit.doc_date || "").slice(0, 10)) || today);
  const [validUntil, setValidUntil] = useState((edit && edit.valid_until) || "");
  const [notes, setNotes] = useState((edit && edit.notes) || "");
  const [lines, setLines] = useState([blank()]);
  const [partyRates, setPartyRates] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/parties").then(setParties).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
    /* The list this was opened from carries the header only, so the lines are
       fetched — editing a quotation with an empty grid would look like the
       lines had been lost. */
    if (edit) {
      api.get(`/estimates/${edit.id}`).then((d) => {
        if (Array.isArray(d.lines) && d.lines.length) {
          setLines(d.lines.map((l) => ({ ...blank(), item_id: l.item_id || "", description: l.description || "",
            quantity: l.quantity, rate: l.rate })));
        }
      }).catch(() => toast("Could not read this quotation's lines", "bad"));
    }
  }, []);
  useEffect(() => {
    if (!partyId) return setPartyRates({});
    api.get(`/parties/${partyId}/rates`)
      .then((rs) => setPartyRates(Object.fromEntries(rs.map((r) => [r.item_id, r.rate])))).catch(() => {});
  }, [partyId]);

  const calc = useMemo(() => computeInvoice({ lines, rules, roundOff: true }), [lines, rules]);
  const party = parties.find((p) => String(p.id) === String(partyId));
  const isOrder = docType === "order";

  const save = async () => {
    if (!partyId) return toast("Choose a party", "bad");
    const valid = lines.filter((l) => l.item_id || (l.description && Number(l.rate) > 0));
    if (!valid.length) return toast("Add at least one item", "bad");
    setBusy(true);
    const payload = {
      doc_type: docType, party_id: Number(partyId),
      doc_date: docDate || undefined, valid_until: validUntil || null,
      notes: notes || null,
      lines: valid.map((l) => ({ item_id: l.item_id ? Number(l.item_id) : null, description: l.description, quantity: Number(l.quantity), rate: Number(l.rate) })),
    };
    try {
      if (edit) {
        const r = await api.put(`/estimates/${edit.id}`, payload);
        toast(r.message || `${edit.doc_no} updated`);
        onSaved();
        return;
      }
      const saved = await api.post("/estimates", { ...payload, client_ref: attempt.ref() });
      attempt.done();
      if (saved.replayed) toast(`${saved.doc_no} had already gone through — this did not create it twice`);
      onSaved();
      /* An estimate exists to be handed to the customer, so this is the one
         document where the paper is the entire point of creating it. */
      offerDocPrint({
        path: `/estimates/${saved.id}`,
        noun: docType === "proforma" ? "proforma" : "quotation",
        number: saved.doc_no,
        docTitle: docType === "proforma" ? "Proforma invoice" : "Quotation",
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <DocShell
      title={edit ? `Edit ${edit.doc_no}` : isOrder ? "Sale order" : "Estimate / quotation"}
      docNo={edit ? edit.doc_no : isOrder ? "Auto: SO-…" : "Auto: EST-…"}
      meta={validUntil ? `${docDate} · valid until ${validUntil}` : docDate}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel={`${edit ? "Save changes" : `Save ${isOrder ? "order" : "estimate"}`} · ${cur()} ${inr(calc.grand_total)}`}
      summary={docSummary(calc, taxActive)}
      total={{ label: "Quoted", value: `${cur()} ${inr(calc.grand_total)}` }}
      footNote="Paper only: no stock moves and nothing is posted until this is turned into an invoice from the list."
    >
      <DocSection title="Document">
        <div className="doc-typeswitch">
          {[["estimate", "Estimate / quotation"], ["order", "Sale order"]].map(([v, label]) => (
            <button key={v} onClick={() => setDocType(v)}
                    className={`btn ${docType === v ? "btn-primary" : "btn-ghost"}`}>{label}</button>
          ))}
        </div>
      </DocSection>

      <DocTop>
        <DocSection title="Quoted to">
          <Field label="Customer">
            <PartyCombo parties={parties} value={partyId} onPick={setPartyId} autoFocus
                        placeholder="Search name or phone…"
                        onCreated={(p) => setParties((ps) => [p, ...ps])} />
          </Field>
          <DocParty party={party} emptyHint="Pick a customer and their number, address and balance appear here." />
        </DocSection>
        <DocSection title={isOrder ? "Order details" : "Quotation details"}>
          <DocFields>
            <Field label="Date">
              <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
            </Field>
            {/* A quotation with no expiry is a price you have promised for
                ever. The column exists; nothing was ever prompting for it
                beyond an optional box people skipped, so it is now filled in
                for you and can be cleared. */}
            <Field label="Valid until">
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </Field>
          </DocFields>
          <Field label="Notes for the customer">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
                      placeholder="Terms, lead time, what the price includes…" />
          </Field>
        </DocSection>
      </DocTop>

      <DocSection>
        <DocLines lines={lines} setLines={setLines} items={items} setItems={setItems} calc={calc}
                  ratePick={(it) => partyRates[it.id] ?? it.sale_price}
                  qtyLabel="Quantity" addLabel="＋ Add line" title="What is being quoted" />
      </DocSection>

      <DocTotals calc={calc} taxActive={taxActive} />
    </DocShell>
  );
}
