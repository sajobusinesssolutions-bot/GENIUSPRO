import React, { useEffect, useMemo, useState } from "react";
import { offerDocPrint } from "../lib/printprompt.jsx";
import api, { can } from "../lib/api.js";
import { computeInvoice, inr, cur} from "../lib/tax.js";
import { Field, PartyCombo, SkeletonRows, Empty, toast, RowMenu, confirmDialog } from "../lib/ui.jsx";
import { useTaxRules } from "../lib/taxrules.js";
import { DocShell, DocSection, DocTop, DocFields, DocParty, DocTotals, docSummary } from "../lib/docshell.jsx";
import { DocLines, blankLine } from "../lib/doclines.jsx";
import { AccountSelect, defaultAccount, lastAccount, rememberAccount } from "../lib/moneyaccounts.jsx";
import { Icon } from "../lib/icons.jsx";

export default function CreditNotes() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => api.get("/returns/credit-notes").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Credit notes (sale returns)</h2>
        {can("sales", "create") && <button className="btn btn-primary" onClick={() => setOpen(true)}>+ Issue credit note</button>}
      </div>
      <table className="tw">
        <thead><tr><th>Note #</th><th>Customer</th><th>Against</th><th>Date</th><th>Mode</th><th className="amt">Amount</th><th /></tr></thead>
        <tbody>
          {rows === null ? <SkeletonRows rows={4} cols={7} /> :
            rows.length === 0 ? <tr><td colSpan={7}><Empty icon="↩" title="No credit notes" hint="Issue one when a customer returns goods." /></td></tr> :
            rows.map((r) => {
              const dead = r.status === "voided";
              return (
              <tr key={r.id} className={`hl ${dead ? "void" : ""}`}>
                <td className="strong num">{r.note_no}</td><td>{r.party_name}</td>
                <td className="num">{r.invoice_no || "—"}</td><td className="num">{r.return_date}</td>
                <td>
                  <span className={`pill ${r.refund_mode === "cash" ? "pill-warn" : "pill-info"}`}>{r.refund_mode}</span>
                  {dead && <span className="pill" style={{ marginLeft: 6 }}>voided</span>}
                </td>
                <td className={`amt ${dead ? "amt-void" : ""}`} style={{ fontWeight: 650, color: dead ? undefined : "var(--bad)" }}>−{cur()} {inr(r.grand_total)}</td>
                <td style={{ textAlign: "right" }}>
                  {can("sales", "delete") && (
                    <RowMenu label={`Actions for ${r.note_no}`} actions={[{
                      icon: <Icon n="trash" />, label: "Void", danger: true, disabled: dead,
                      hint: dead ? "already voided" : undefined,
                      onClick: async () => {
                        if (!(await confirmDialog({
                          title: `Void ${r.note_no}?`,
                          message: `A credit note is itself a correction, so voiding one undoes that correction: the goods it put back come off the shelf again, the ledger entry is reversed${r.refund_mode === "cash" ? "" : ", and the customer's balance returns to what it was"}.`,
                          danger: true, confirmLabel: "Void credit note",
                        }))) return;
                        try { const x = await api.delete(`/returns/credit-notes/${r.id}`); toast(x.message || "Voided"); load(); }
                        catch (e) { toast(e.message, "bad"); }
                      },
                    }]} />
                  )}
                </td>
              </tr>
              );
            })}
        </tbody>
      </table>
      {open && <NoteModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); toast("Credit note issued"); }} />}
    </div>
  );
}

const blank = () => blankLine();

/* ── Credit note (sale return) ────────────────────────────────────────────
   Kept under its old export name because pages/Invoices.jsx imports it, so
   the Sales screen's Credit notes tab and this page open the same editor.

   Full screen (lib/docshell.jsx): a refund is money going back out of the
   till, and the figure that decides how much was previously below the fold. */
export function NoteModal({ onClose, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  // credit notes follow the global tax switch, like the server does
  const { rules, taxActive } = useTaxRules("credit_note");
  const [invoices, setInvoices] = useState([]);
  const [cashAccounts, setCashAccounts] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [returnDate, setReturnDate] = useState(today);
  const [refundMode, setRefundMode] = useState("adjust");
  const [cashCode, setCashCode] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState([blank()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/parties").then(setParties).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
    api.get("/sales").then((d) => setInvoices(Array.isArray(d) ? d : (d.rows || []))).catch(() => {});
    api.get("/accounting/cash-accounts")
      .then((a) => { setCashAccounts(a); setCashCode((c) => c || defaultAccount(a, lastAccount())); })
      .catch(() => setCashAccounts([]));
  }, []);

  /* The original invoice is what a credit note is *against*. It was already
     being sent; what it was missing was any way to find one among hundreds
     other than scrolling a bare <select>. */
  const pickInvoice = async (id) => {
    setInvoiceId(id);
    if (!id) return;
    try {
      const inv = await api.get(`/sales/${id}`);
      setPartyId(String(inv.party_id));
      setLines((inv.lines || []).map((l) => ({
        item_id: l.item_id || "", description: l.description || "",
        quantity: l.quantity, rate: l.rate, batch_no: "", expiry_date: "",
      })));
    } catch (e) { toast(e.message, "bad"); }
  };

  const calc = useMemo(() => computeInvoice({ lines, rules, roundOff: false }), [lines, rules]);
  const party = parties.find((p) => String(p.id) === String(partyId));

  const save = async () => {
    if (!partyId) return toast("Choose a customer", "bad");
    const valid = lines.filter((l) => l.item_id || (l.description && Number(l.rate) > 0));
    if (!valid.length) return toast("Add at least one item", "bad");
    setBusy(true);
    try {
      const saved = await api.post("/returns/credit-notes", {
        party_id: Number(partyId), invoice_id: invoiceId ? Number(invoiceId) : null,
        return_date: returnDate || undefined,
        refund_mode: refundMode, reason,
        cash_account_code: refundMode === "cash" && cashCode ? cashCode : undefined,
        lines: valid.map((l) => ({ item_id: l.item_id ? Number(l.item_id) : null, description: l.description, quantity: Number(l.quantity), rate: Number(l.rate) })),
      });
      onSaved();
      /* Named "Credit note" on the paper, never "Invoice" — see the docTitle
         note in print.js. A customer handed a credit note headed INVOICE has
         been handed a demand for money they are owed. */
      offerDocPrint({
        path: `/returns/credit-notes/${saved.id}`, noun: "credit note",
        number: saved.note_no, docTitle: "Credit note",
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <DocShell
      title="Credit note" docNo="Auto: CN-…"
      meta={`${refundMode === "cash" ? "Cash refund" : "Adjusted against balance"} · ${returnDate}`}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel={`Issue credit note · ${cur()} ${inr(calc.grand_total)}`}
      summary={docSummary(calc, taxActive)}
      total={{ label: refundMode === "cash" ? "To refund" : "To credit", value: `${cur()} ${inr(calc.grand_total)}` }}
      footNote="Goods come back into stock and the sale is reversed in the books, the moment you save."
    >
      <DocTop>
        <DocSection title="Returned by">
          <Field label="Against invoice (prefills the lines)">
            <select value={invoiceId} onChange={(e) => pickInvoice(e.target.value)} autoFocus>
              <option value="">None — a note on its own</option>
              {invoices.map((s) => (
                <option key={s.id} value={s.id}>{s.invoice_no} · {s.party_name} · {cur()} {inr(s.grand_total)}</option>
              ))}
            </select>
          </Field>
          <Field label="Customer">
            <PartyCombo parties={parties} value={partyId} onPick={setPartyId}
                        placeholder="Search name or phone…"
                        onCreated={(p) => setParties((ps) => [p, ...ps])} />
          </Field>
          <DocParty party={party} emptyHint="Pick the invoice or the customer and their details appear here." />
        </DocSection>
        <DocSection title="Note details">
          <DocFields>
            <Field label="Return date">
              <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
            </Field>
            <Field label="Refund by">
              <select value={refundMode} onChange={(e) => setRefundMode(e.target.value)}>
                <option value="adjust">Adjust against balance</option>
                <option value="cash">Cash refund</option>
              </select>
            </Field>
            {/* Shown whenever a refund is being paid out, not only when the
                shop has two accounts to choose between: money leaving the till
                and money leaving the MoMo float are different reconciliations,
                and the operator has to be able to see which one this is. */}
            {refundMode === "cash" && cashAccounts.length > 0 && (
              <Field label="Refunded from">
                <AccountSelect accounts={cashAccounts} value={cashCode} onChange={setCashCode}
                               ariaLabel="Account the refund is paid out of" />
              </Field>
            )}
            <Field label="Reason">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged, wrong item…" />
            </Field>
          </DocFields>
        </DocSection>
      </DocTop>

      <DocSection>
        <DocLines lines={lines} setLines={setLines} items={items} setItems={setItems} calc={calc}
                  ratePick={(it) => it.sale_price}
                  qtyLabel="Qty returned" addLabel="＋ Add returned item" title="What came back" />
      </DocSection>

      <DocTotals calc={calc} taxActive={taxActive} />
    </DocShell>
  );
}
