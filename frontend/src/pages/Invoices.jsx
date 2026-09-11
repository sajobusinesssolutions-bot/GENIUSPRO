import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api, { can } from "../lib/api.js";
import { useAttempt } from "../lib/attempt.jsx";
import { computeInvoice, inr, cur} from "../lib/tax.js";
import { Modal, Field, toast, confirmDialog, RowMenu, ItemCombo, SalesRepPicker, useActiveUsers, BulkItemPicker, Chip, PartyCombo } from "../lib/ui.jsx";
import { unitFieldsFromItem } from "../lib/lineunits.js";
import { UnitPicker, BatchPicker, ExpiryNotice } from "../lib/doclines.jsx";
import { currentUser } from "../lib/api.js";
import { printInvoice } from "../lib/print.js";
import { offerDocPrint } from "../lib/printprompt.jsx";
import { plural } from "../lib/plural.js";
import { effectiveRules } from "../lib/taxrules.js";
import { NoteModal } from "./CreditNotes.jsx";
import { ChallanModal } from "./Challans.jsx";
import { EstimateModal } from "./Estimates.jsx";
import { Icon } from "../lib/icons.jsx";
import { TableCard, Pill, LoadingRows, money, STATUS_TONE, useRead, LoadFailed, FailedRows, figure } from "../lib/deckui.jsx";
import RecurringPanel from "./RecurringPanel.jsx";
import InstalmentsPanel from "./InstalmentsPanel.jsx";
import { PaymentModal } from "./Money.jsx";
import { AccountSelect, defaultAccount, lastAccount, rememberAccount } from "../lib/moneyaccounts.jsx";
import LoyaltyPanel from "./LoyaltyPanel.jsx";

const blankLine = () => ({ item_id: "", description: "", quantity: 1, rate: 0, discount_pct: 0, batch_no: "" });

/* `recurring` turns the builder into a schedule editor: the same document is
   built the same way, and a schedule section is added at the foot. Reusing the
   builder rather than writing a second one means a recurring sale always has
   the same tax, unit and discount behaviour as a one-off — which is the whole
   point of it being recurring. */
export function InvoiceBuilder({ onClose, onSaved, initial, editing, recurring, convertFrom, docType = "sale" }) {
  /* One reference for this attempt at this invoice, so a Save pressed twice
     after the line drops raises one invoice rather than two. The till has had
     this since it was written; the invoice form never did. */
  const attempt = useAttempt(convertFrom ? "invoice-convert" : "invoice");
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [rules, setRules] = useState([]);
  const [stg, setStg] = useState({});
  const [cashAccounts, setCashAccounts] = useState([]);
  const [partyId, setPartyId] = useState(initial ? String(initial.party_id) : "");
  const [lines, setLines] = useState(initial
    ? (initial.lines || []).map((l) => ({ item_id: l.item_id || "", description: l.description, quantity: l.quantity, rate: l.rate, discount_pct: l.discount_pct || 0, batch_no: l.batch_no || "" }))
    : [blankLine()]);
  /* Payment type is no longer asked for — it is what happened, not a choice.
     Settle the whole total and it is a cash sale; leave any of it outstanding
     and it is a credit sale. An untouched form has received nothing, because
     that is what raising an invoice means. */
  /* A converted quotation is a NEW invoice: nothing has been received on it
     yet, so it starts like a blank form rather than like an edit — otherwise
     the paid box opens pre-filled with a figure nobody entered. */
  const [paidTouched, setPaidTouched] = useState(!!initial && !convertFrom);
  const users = useActiveUsers();
  const [salesRep, setSalesRep] = useState(() => (initial && initial.sales_rep_id ? String(initial.sales_rep_id) : (currentUser() ? String(currentUser().id) : "")));
  const [cashCode, setCashCode] = useState("1001");
  const [paid, setPaid] = useState(0);
  const [busy, setBusy] = useState(false);
  const [partyRates, setPartyRates] = useState({});
  /* Which prices this document charges at. Same two-value model as the till:
     `listOverride` is null until somebody picks from the box, so naming a
     customer applies theirs, and a deliberate choice is not thrown away by the
     next thing that touches the party field. Special rates are separate and
     always win — they are an agreement with that customer, not a band. */
  const [priceLists, setPriceLists] = useState([]);
  const [listPrices, setListPrices] = useState({});
  const [listOverride, setListOverride] = useState(null);
  const partyList = React.useMemo(() => {
    const p = parties.find((x) => String(x.id) === String(partyId));
    return (p && p.price_list_id) || 0;
  }, [parties, partyId]);
  const listId = listOverride == null ? partyList : listOverride;
  const rateFor = (it) => partyRates[it.id] ?? listPrices[it.id] ?? it.sale_price;
  const [invNo, setInvNo] = useState(initial ? initial.invoice_no || "" : "");
  const [invDate, setInvDate] = useState(initial ? initial.invoice_date : new Date().toISOString().slice(0, 10));
  const [phone, setPhone] = useState(initial ? initial.party_phone || "" : "");
  const [phoneTouched, setPhoneTouched] = useState(!!initial);
  const [notes, setNotes] = useState(initial ? initial.notes || "" : "");
  /* Schedule fields, only used when `recurring` is set. */
  const [schedName, setSchedName] = useState(initial ? initial.name || "" : "");
  const [freq, setFreq] = useState(initial ? initial.frequency || "monthly" : "monthly");
  const [startDate, setStartDate] = useState(
    initial && initial.start_date ? initial.start_date : new Date().toISOString().slice(0, 10));
  const [schedActive, setSchedActive] = useState(initial ? initial.status !== "paused" : true);
  const [bulkOpen, setBulkOpen] = useState(false);
  /* Off means "this shop takes the money in full, every time" — so the amount
     received is the total and there is no balance to show. Hiding the field
     must therefore also stop a half-typed figure from surviving the switch,
     which is why `paidTouched` is ignored while it is off. */
  const showReceived = stg.show_received_amount !== "0";
  /* Settings → Transactions → "Prices include tax". The client mirrors the
     server's arithmetic so the total does not jump when the sale is saved;
     the server is still what decides. */
  const inclusivePricing = stg.tax_inclusive_default === "1";

  /* A batch column on every sale would be clutter for a shop that sells
     hardware; a shop selling medicine cannot trade without it. The setting
     decides, exactly as it does on the purchase form. */
  const batchesOn = stg.enable_batches !== "0" && stg.stock_maintenance !== "0";
  const qtyStep = useMemo(() => { const d = Number(stg.qty_decimals ?? 2); return d > 0 ? 1 / Math.pow(10, d) : 1; }, [stg]);
  /* Ask the server which promotions this basket earns and write them into the
     ordinary discount column, where the cashier can still override them. */
  const applyOffers = async () => {
    const basket = lines.map((l, index) => ({ index, item_id: l.item_id, quantity: l.quantity, rate: l.rate }))
      .filter((l) => l.item_id && Number(l.quantity) > 0);
    if (!basket.length) return toast("Add some items first", "bad");
    try {
      const r = await api.post("/offers/evaluate", { lines: basket });
      if (!r.applied?.length) return toast("No offer applies to this basket");
      setLines((ls) => ls.map((l, i) => {
        const hit = r.lines.find((x) => x.index === i && x.discount_pct > 0);
        return hit ? { ...l, discount_pct: hit.discount_pct } : l;
      }));
      toast(`Applied: ${r.applied.join(", ")}${r.bill_discount ? ` · bill offer ${cur()} ${inr(r.bill_discount)} — add it as a bill discount` : ""}`);
    } catch (e) { toast(e.message, "bad"); }
  };

  const addBulk = (picks) => setLines((ls) => {
    const base = ls.filter((l) => l.item_id || l.description);
    const added = picks.map(({ id, qty }) => {
      const it = items.find((x) => x.id === id);
      if (!it) return null;
      return { ...blankLine(), item_id: it.id, description: it.name, quantity: qty, rate: rateFor(it), ...unitFieldsFromItem(it) };
    }).filter(Boolean);
    return [...base, ...added].length ? [...base, ...added] : [blankLine()];
  });

  useEffect(() => {
    api.get("/parties").then(setParties).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
    api.get("/settings/tax-rules").then(setRules).catch(() => setRules([]));
    api.get("/settings").then((d) => setStg(d.values || {})).catch(() => setStg({}));
    api.get("/accounting/cash-accounts")
      /* Default to the account this machine last banked into rather than
         whichever one sorts first by code — that is "Cash in Hand" in every
         shop, so a shop taking payment by MoMo had to change it every time and
         eventually stopped noticing when it had not. */
      .then((a) => { setCashAccounts(a); setCashCode((c) => defaultAccount(a, c === "1001" ? lastAccount() : c)); })
      .catch(() => setCashAccounts([{ code: "1001", name: "Cash in Hand" }]));
  }, []);

  /* Escape closes the panel, matching every other overlay in the app. Ignored
     while a confirm dialog, a picker modal or a sheet sits on top — that layer
     takes the key first — so Escape backs out one layer at a time. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".modal-backdrop, .dk-sheet-veil")) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => { api.get("/settings/price-lists").then(setPriceLists).catch(() => setPriceLists([])); }, []);

  useEffect(() => {
    if (!listId) return setListPrices({});
    api.get(`/settings/price-lists/${listId}/items`)
      .then((rows) => setListPrices(Object.fromEntries(rows.map((r) => [r.item_id, r.price]))))
      .catch(() => setListPrices({}));
  }, [listId]);

  useEffect(() => {
    setListOverride(null);
    if (!partyId) return setPartyRates({});
    api.get(`/parties/${partyId}/rates`)
      .then((rs) => setPartyRates(Object.fromEntries(rs.map((r) => [r.item_id, r.rate]))))
      .catch(() => setPartyRates({}));
    /* The party's number is already on file — retyping it is busywork, and a
       mistyped one is worse than none. Only fill a field nobody has edited. */
    if (!phoneTouched) {
      const p = parties.find((x) => String(x.id) === String(partyId));
      if (p && p.phone) setPhone(p.phone);
    }
  }, [partyId, parties]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* Deriving the payment type from the total, while the tax rules can be
     switched per payment type (tax_on_cash / tax_on_credit), is circular:
     type ← paid vs total ← rules ← type. Broken with a provisional pass that
     prices the document as if paid in full, purely to get a figure to compare
     the entered amount against. Where both switches agree — the normal case —
     the second pass is identical to the first. */
  const baseRules = useMemo(
    () => effectiveRules({ rules, settings: stg, doc: "sale", paymentType: "cash" }),
    [rules, stg]);
  const baseCalc = useMemo(
    () => computeInvoice({ lines, rules: baseRules, roundOff: true, pricesIncludeTax: inclusivePricing }), [lines, baseRules, inclusivePricing]);

  /* `null` means "not stated", which the line below reads as paid in full.
     With the received field switched off nothing can state it, so every sale
     is settled in full — which is exactly what a shop that turned the setting
     off is saying about how it trades. A figure typed before the setting was
     changed is deliberately ignored rather than silently kept. */
  /* An untouched invoice has received NOTHING.
   *
   * It used to mean "paid in full": the field showed the grand total in grey
   * and saving without touching it recorded a settled cash sale. That is the
   * right default for a till, where money changes hands as the sale is rung
   * up, and the wrong one here — an invoice is a document you hand somebody so
   * they can pay you later. A shop raising invoices was recording every one of
   * them as already collected, and its debtors ledger said nobody owed it
   * anything.
   *
   * With the received field switched off in Settings the shop has said it only
   * ever sells for cash, and then untouched still means settled in full. */
  const paidEntered = !showReceived ? null : (paidTouched ? (Number(paid) || 0) : 0);
  const paymentType = paidEntered == null || paidEntered >= baseCalc.grand_total - 0.005
    ? "cash" : "credit";

  const effRules = useMemo(
    () => effectiveRules({ rules, settings: stg, doc: "sale", paymentType }),
    [rules, stg, paymentType]);
  const taxActive = effRules.length > 0;
  const calc = useMemo(() => computeInvoice({ lines, rules: effRules, roundOff: true, pricesIncludeTax: inclusivePricing }), [lines, effRules, inclusivePricing]);
  /* Untouched means "settle it all", so it must track the final total. */
  const paidAmount = paidEntered == null ? calc.grand_total : paidEntered;
  const balanceDue = Math.max(0, calc.grand_total - paidAmount);

  /* The chosen party, for the summary card under the picker. Everything shown
     there is already on the record — repeating it saves opening Parties to
     check you picked the right Musoke. */
  const party = useMemo(
    () => parties.find((p) => String(p.id) === String(partyId)) || null, [parties, partyId]);
  const partyWord = docType === "purchase" ? "Supplier" : "Customer";
  const isPurchase = docType === "purchase";

  const updateLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = (i, itemId) => {
    const it = items.find((x) => x.id === Number(itemId));
    if (!it) return updateLine(i, { item_id: "" });
    updateLine(i, { item_id: it.id, description: it.name, rate: rateFor(it), ...unitFieldsFromItem(it) });
  };

  const save = async () => {
    if (!partyId) return toast("Choose a customer", "bad");
    const valid = lines.filter((l) => l.item_id || (l.description && Number(l.rate) > 0));
    if (!valid.length) return toast("Add at least one item", "bad");
    setBusy(true);
    try {
      if (stg.require_sales_rep !== "0" && !salesRep) return toast("Choose a sales rep first", "bad");
      if (cashCode && paidAmount > 0) rememberAccount(cashCode);
      const payload = {
        client_ref: attempt.ref(),
        /* Marking the quotation converted happens inside the invoice's own
           transaction on the server, not as a second request afterwards. */
        convert_estimate_id: convertFrom ? convertFrom.id : undefined,
        sales_rep_id: salesRep ? Number(salesRep) : undefined,
        party_id: Number(partyId), payment_type: paymentType, cash_account_code: cashCode,
        invoice_no: invNo || undefined, invoice_date: invDate, notes: notes || undefined,
        paid_amount: paidAmount,
        lines: valid.map((l) => ({
          item_id: l.item_id ? Number(l.item_id) : null, description: l.description,
          quantity: Number(l.quantity), rate: Number(l.rate), discount_pct: Number(l.discount_pct) || 0,
          unit: l.unit || undefined, use_secondary: l.use_secondary || undefined,
          /* Empty means "whichever expires first" — the stock poster decides.
             A named batch is the operator overriding that on purpose. */
          batch_no: batchesOn && l.batch_no ? l.batch_no : undefined,
        })),
      };
      if (recurring) {
        /* Same document, plus when it should repeat. The schedule owns the
           lines; the first invoice is generated by the schedule, not here. */
        const sched = {
          name: schedName.trim() || (parties.find((p) => p.id === Number(partyId)) || {}).name || "Recurring",
          doc_type: docType,
          party_id: payload.party_id,
          payment_type: payload.payment_type,
          sales_rep_id: payload.sales_rep_id,
          frequency: freq,
          start_date: startDate,
          status: schedActive ? "active" : "paused",
          notes: payload.notes,
          lines: payload.lines,
        };
        if (editing && initial?.id) await api.put(`/recurring/${initial.id}`, sched);
        else await api.post("/recurring", sched);
        onSaved();
        return;
      }

      /* Editing rewrites the same document; anything else is a new one. */
      let saved;
      if (editing && initial?.id) { await api.put(`/sales/${initial.id}`, payload); saved = { id: initial.id, invoice_no: initial.invoice_no }; }
      else saved = await api.post("/sales", payload);
      attempt.done();
      if (saved.replayed) toast(`${saved.invoice_no} had already gone through — this did not raise it twice`);
      else if (convertFrom) toast(`${convertFrom.doc_no} → ${saved.invoice_no}`);
      onSaved();
      /* After onSaved(), deliberately. The list refreshing and the panel closing
         are what the user asked for; the print question is an offer on top, and
         it must not hold either of them up or leave the form open behind a
         dialog if printing is slow. */
      const partyName = (parties.find((pp) => pp.id === Number(partyId)) || {}).name;
      /* The dialog names the party and the line count, not a total. A total
         computed here would be the client's arithmetic before the server's tax
         rules, rounding and offers ran, so it could differ from the figure on
         the paper the user is about to authorise — and a document whose
         confirmation disagreed with itself would be worse than one with no
         figure at all. */
      offerDocPrint({
        path: `/sales/${saved.id}`, noun: "invoice", number: saved.invoice_no,
        party: partyName, context: "invoice",
        detail: [partyName, plural(payload.lines.length, "item")].filter(Boolean).join(" · "),
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    /* No dismiss-on-backdrop: these hold part-built documents, and losing one
     to a stray click is worse than one extra click to leave. Close via the
     X in the header, or Cancel. */
    <div className="slide-veil">
      <div className="slide-panel doc-full" onClick={(e) => e.stopPropagation()}>
        <div className="slide-head">
          <h2>{recurring
            ? (editing ? `Edit schedule — ${initial.name || ""}` : `New recurring ${docType === "purchase" ? "purchase" : "sale"}`)
            : convertFrom ? `${convertFrom.doc_no} → invoice`
            : initial && initial.invoice_no ? `Edit ${initial.invoice_no}` : "Create Invoice"}</h2>
          <button className="icon-btn" onClick={onClose} style={{ fontSize: 19 }}><Icon n="close" size={15} /></button>
        </div>
        <div className="slide-body">
      <div className="invb">

      {/* Who it is for, and what document it is — the two questions asked
          before any line is typed, so they lead, side by side. */}
      <div className="invb-top">
        <section className="invb-sec">
          <div className="invb-h">{isPurchase ? "Bill from" : "Bill to"}</div>
          <Field label={partyWord}>
            <PartyCombo
              parties={parties} value={partyId} onPick={setPartyId} autoFocus
              onCreated={(p) => setParties((ps) => [p, ...ps])}
            />
          </Field>
          {/* Which prices the lines are charged at. Only shown when the shop
              has lists, because a box with one answer is not a question.
              Changing it re-prices nothing already typed: a half-entered
              invoice is somebody's work, and silently rewriting nine lines
              because the tenth wanted a different band is not a courtesy. */}
          {!isPurchase && priceLists.length > 0 && (
            <Field label="Prices">
              <select className="dk-input" value={listId || 0}
                      onChange={(e) => setListOverride(Number(e.target.value))}>
                <option value={0}>Ordinary prices</option>
                {priceLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
                {listOverride == null && partyList
                  ? "From this customer's price list"
                  : "Applies to lines added from here on"}
              </span>
            </Field>
          )}
          {party ? (
            <div className="invb-party">
              <div className="invb-party-name">{party.name}</div>
              <div className="invb-party-meta">
                {[party.party_no, party.billing_address, party.phone].filter(Boolean).join(" · ") || "No address on file"}
              </div>
              <div className="invb-party-foot">
                <span className="invb-tax">{party.gstin ? `Tax no. ${party.gstin}` : "No tax number"}</span>
                <span className={`dk-n ${Number(party.balance) > 0 ? "amt-owed" : Number(party.balance) < 0 ? "amt-received" : "amt-zero"}`}>
                  {Number(party.balance)
                    ? `${cur()} ${inr(Math.abs(party.balance))} ${Number(party.balance) > 0 ? "due" : "in advance"}`
                    : "Nothing outstanding"}
                </span>
              </div>
            </div>
          ) : (
            <div className="invb-party is-empty">
              Pick a {partyWord.toLowerCase()} and their number, address and balance appear here.
            </div>
          )}
        </section>

        <section className="invb-sec">
          <div className="invb-h">{isPurchase ? "Bill details" : "Invoice details"}</div>
          <div className="invb-meta">
            <Field label="Invoice number">
              <input value={invNo} onChange={(e) => setInvNo(e.target.value)} placeholder="Auto: INV-…" />
            </Field>
            <Field label="Invoice date">
              <input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} />
            </Field>
            <SalesRepPicker value={salesRep} onChange={setSalesRep} users={users} required={stg.require_sales_rep !== "0"} />
            <Field label="Phone number">
              <input value={phone} onChange={(e) => { setPhoneTouched(true); setPhone(e.target.value); }} placeholder="Customer phone" />
            </Field>
          </div>
        </section>
      </div>

      {/* One grid for the header and every row: the widths live in the
          colgroup, so a label can never drift off the control beneath it. */}
      <section className="invb-sec invb-items">
        <div className="invb-h">Items</div>
        <ExpiryNotice lines={batchesOn ? lines : []} />
        <div className="dk-scrollx invb-tablewrap">
        <table className="line-grid invb-grid">
          <colgroup>
            <col style={{ width: 40 }} /><col /><col style={{ width: 110 }} />
            <col style={{ width: 104 }} />
            {batchesOn && <col style={{ width: 190 }} />}
            <col style={{ width: 130 }} />
            <col style={{ width: 104 }} /><col style={{ width: 140 }} /><col style={{ width: 44 }} />
          </colgroup>
          <thead><tr>
            <th className="invb-no">#</th>
            <th>Item details</th><th className="r">Quantity</th>
            <th>Unit</th>
            {batchesOn && <th>Batch</th>}
            <th className="r">Rate</th><th className="r">Discount %</th>
            <th className="amt r">Amount</th><th />
          </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="invb-no dk-n">{i + 1}</td>
              <td>
                {items.length ? (
                  <ItemCombo items={items} value={l.item_id} onPick={(id) => pickItem(i, id)}
                             onCreated={(it) => setItems((xs) => [it, ...xs])} />
                ) : <input className="cell-input" placeholder="Description" value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} />}
              </td>
              <td className="num"><input className="cell-input" type="number" step={qtyStep} value={l.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} /></td>
              <td><UnitPicker line={l} onChange={(patch) => updateLine(i, patch)} /></td>
              {batchesOn && <td><BatchPicker line={l} onChange={(patch) => updateLine(i, patch)} /></td>}
              <td className="num"><input className="cell-input" type="number" value={l.rate} onChange={(e) => updateLine(i, { rate: e.target.value })} /></td>
              <td className="num"><input className="cell-input" type="number" value={l.discount_pct} onChange={(e) => updateLine(i, { discount_pct: e.target.value })} /></td>
              <td className="amt num invb-amt">{cur()} {inr((calc.lines[i] || {}).line_total)}</td>
              <td><button className="icon-btn" onClick={() => setLines((ls) => ls.length > 1 ? ls.filter((_, j) => j !== i) : ls)} title="Remove"><Icon n="close" size={15} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="zoho-addrow invb-addrow">
        <button className="btn invb-addline" onClick={() => setLines((l) => [...l, blankLine()])}>＋ New invoice line</button>
        <button className="btn" onClick={() => setBulkOpen(true)}>＋ Add items in bulk</button>
        {stg.mod_offers === "1" && (
          <button className="btn" onClick={applyOffers} title="Fill in the discounts your running promotions give">
            % Apply offers
          </button>
        )}
      </div>
      </section>

      <div className="invb-bottom">
        <section className="invb-sec">
          <div className="invb-h">Notes</div>
          <textarea className="invb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Thanks for your business." />
          <div className="invb-hint">Will be displayed on the invoice</div>
        </section>
        <div className="invb-totals">
          <div className="invb-trow"><span className="lbl">Sub total</span><span className="num dk-n">{cur()} {inr(calc.gross_total)}</span></div>
          {calc.discount_total > 0 && (
            <div className="invb-trow"><span className="lbl">Discount</span><span className="num dk-n amt-paid">−{cur()} {inr(calc.discount_total)}</span></div>
          )}
          {taxActive && (
            <div className="invb-trow"><span className="lbl">Tax</span><span className={`num dk-n ${calc.tax_total < 0 ? "amt-reversal" : ""}`}>{calc.tax_total < 0 ? "−" : "+"}{cur()} {inr(Math.abs(calc.tax_total))}</span></div>
          )}
          {calc.round_off !== 0 && <div className="invb-trow"><span className="lbl">Round off</span><span className="num dk-n">{cur()} {inr(calc.round_off)}</span></div>}
          <div className="invb-trow invb-grand"><span className="lbl">Total</span><span className="num dk-n">{cur()} {inr(calc.grand_total)}</span></div>
          {balanceDue > 0.005 && (
            <div className="invb-trow"><span className="lbl">Balance due</span><span className="num dk-n amt-owed">{cur()} {inr(balanceDue)}</span></div>
          )}
          {taxActive && <div className="invb-hint">Taxes applied in sequence per your Settings → Taxes configuration.</div>}
        </div>
      </div>
      {bulkOpen && <BulkItemPicker items={items} onAdd={addBulk} onClose={() => setBulkOpen(false)} />}

      {/* One payment block. The cash/credit label is a readout of what was
          entered, not another decision to make.
          *
          * Settings → Transactions → "Show received / balance on invoice"
          * takes the two amount fields away for a shop that only ever sells for
          * cash: what is left is where the money went, and the sale settles in
          * full. The setting used to exist and change nothing, which is worse
          * than not offering it — the shop believed it. */}
      <section className="invb-sec invb-pay">
        <div className="invb-h">Payment</div>
        {/* No grid when there is one field: a lone account picker sitting in the
            first third of a three-column grid reads as two missing fields. */}
        <div className={showReceived ? "row3" : ""}>
          <Field label="Received in">
            <AccountSelect accounts={cashAccounts} value={cashCode} onChange={setCashCode}
                           ariaLabel="Account the payment is received in" />
          </Field>
          {showReceived && (
            <Field label="Amount received (Sh)">
              <input
                type="number" min="0" step="0.01" placeholder="0.00"
                value={paidTouched ? paid : ""}
                onChange={(e) => { setPaidTouched(true); setPaid(e.target.value); }}
              />
            </Field>
          )}
          {showReceived && (
            <Field label="Balance due (Sh)">
              <input value={inr(balanceDue)} readOnly />
            </Field>
          )}
        </div>
        <div className="pay-readout">
          <Chip tone={paymentType === "cash" ? "ok" : "warn"} dot>
            {paymentType === "cash" ? "Cash sale — settled in full" : `Credit sale — ${cur()} ${inr(balanceDue)} outstanding`}
          </Chip>
          {/* The one-press way to say "they paid me now", which is the case
              this screen no longer assumes. */}
          {showReceived && balanceDue > 0.005 && (
            <button type="button" className="linkish"
                    onClick={() => { setPaidTouched(true); setPaid(calc.grand_total.toFixed(2)); }}>
              Paid in full now
            </button>
          )}
          {showReceived && paidTouched && (
            <button type="button" className="linkish"
                    onClick={() => { setPaidTouched(true); setPaid(0); }}>
              Nothing received yet
            </button>
          )}
        </div>
      </section>

      {recurring && (
        <div className="dk-sched">
          <div className="dk-sched-head">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 5h14v15H5z" /><path d="M5 10h14" /><path d="M9 3v4" /><path d="M15 3v4" />
            </svg>
            Recurring Schedule
          </div>
          <div className="dk-sched-grid">
            <label className="dk-field">
              <span>Description</span>
              <input className="dk-input" value={schedName} placeholder="What this schedule is for"
                     onChange={(e) => setSchedName(e.target.value)} />
            </label>
            <label className="dk-field">
              <span>Frequency</span>
              <select className="dk-input" value={freq} onChange={(e) => setFreq(e.target.value)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label className="dk-field">
              <span>Start Date</span>
              <input className="dk-input dk-n" type="date" value={startDate}
                     onChange={(e) => setStartDate(e.target.value)} />
            </label>
          </div>
          <div className="dk-sched-toggle">
            <button className={`dk-switch ${schedActive ? "on" : ""}`} role="switch" aria-checked={schedActive}
                    aria-label="Schedule is active" onClick={() => setSchedActive((v) => !v)}><i /></button>
            <span>
              {schedActive
                ? `Schedule is active and will generate ${docType === "purchase" ? "bills" : "sales"}`
                : "Schedule is paused — nothing will be generated until you switch it on"}
            </span>
          </div>
          <div className="dk-sched-note">
            The first {docType === "purchase" ? "bill" : "sale"} is raised on the start date, not now.
            Nothing here touches stock or the books until it runs.
          </div>
        </div>
      )}

      </div>
    </div>
        {/* Outside the scrolling body, so Cancel and Save stay on screen on a
            fifty-line invoice as well as a one-line one. */}
        <div className="slide-foot invb-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…"
              : recurring ? `${editing ? "Save" : "Create"} schedule · ${cur()} ${inr(calc.grand_total)} ${freq}`
              : `Save ${paymentType === "cash" ? "cash" : "credit"} sale · ${cur()} ${inr(calc.grand_total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Sales, built to the design deck ───────────────────────────────────────
   Four document types behind one screen: invoices, estimates and orders,
   credit notes, delivery challans. The deck gives them one table with one
   column set, so they share it here rather than each keeping its own layout.

   The panels above the table describe the whole book, not the page being
   shown, so they come from /sales/overview and do not move when you search.  */

const DOCS = [
  { id: "invoices",  label: "Invoices",          create: "New invoice",  title: "Sales invoices" },
  { id: "estimates", label: "Estimates",         create: "New estimate", title: "Estimates & sale orders" },
  { id: "credit",    label: "Credit notes",      create: "New credit note", title: "Credit notes" },
  { id: "challans",  label: "Delivery challans", create: "New challan",  title: "Delivery challans" },
  { id: "recurring", label: "Recurring",         create: "New schedule", title: "Recurring sales" },
  { id: "instalments", label: "Instalments",    create: "New plan",     title: "Payment plans" },
  { id: "loyalty",   label: "Loyalty",           create: "Redeem",       title: "Loyalty points" },
];

/* Status → pill tone. Anything unrecognised falls through to the neutral
   pill rather than being coloured by guesswork. */

/* An invoice's status column has to say more than the stored status: a bill
   that is open and 30 days past its date is overdue, and the row should say
   so without the reader working out the dates. */
function invoiceStatus(s) {
  if (s.status === "voided") return "voided";
  if ((Number(s.balance_due) || 0) <= 0.005) return "paid";
  const due = new Date(s.due_date || s.invoice_date);
  if (!isNaN(due) && due < new Date(new Date().toDateString())) return "overdue";
  if ((Number(s.paid_amount) || 0) > 0) return "partial";
  return "unpaid";
}

export default function Sales({ initial }) {
  /* `initial` lets the shell open a particular tab — the invoice-builder entry
     on the rail opens the builder, and old Recurring links land on the
     recurring tab rather than nowhere. */
  const [doc, setDoc] = useState(() => (DOCS.some((d) => d.id === initial) ? initial : "invoices"));
  /* Recurring, instalments and loyalty are optional features. A tab for one
     that is switched off is a dead end, so they only appear when the shop has
     turned them on under Settings → Modules. */
  const [mods, setMods] = useState(null);
  useEffect(() => {
    api.get("/settings").then((d) => setMods(d.values || {})).catch(() => setMods({}));
  }, []);
  const tabs = DOCS.filter((d) =>
    (d.id !== "recurring"   || (mods && mods.mod_recurring_sales === "1")) &&
    (d.id !== "instalments" || (mods && mods.mod_installments === "1")) &&
    (d.id !== "loyalty"     || (mods && mods.mod_loyalty === "1")));
  /* The rail's "Invoice builder" entry passes "new"; open the builder rather
     than silently landing on the invoice list. */
  const [newDoc, setNewDoc] = useState(initial === "new");
  /* The date range lives up here rather than inside the list, because the
     figures above the list describe the same period the list is showing.
     Picking "this month" used to leave three all-time figures sitting above
     thirty invoices for March — two sets of numbers on one screen that
     disagree, with nothing saying why. */
  const [range, setRange] = useState({ from: "", to: "" });
  const [ov, setOv] = useState(null);
  /* The panels and the list are two requests against the same book, so they can
     land out of order — a slow first one overwriting the answer to a later,
     fresher one is exactly how the page came to show two invoices while the
     books held six. Every fetch takes a ticket; only the newest ticket may
     write, and a fetch still in flight when the screen unmounts writes nothing. */
  const ovSeq = useRef(0);
  const ovLive = useRef(true);
  useEffect(() => { ovLive.current = true; return () => { ovLive.current = false; }; }, []);
  /* The ticket survives; what changes is that a rejected read now raises a
     flag instead of leaving the panels in their loading skeleton forever,
     which read as "still coming" for a request that was never coming. */
  const [ovFailed, , setOvFailed] = useRead();
  const loadOv = useCallback(() => {
    const my = ++ovSeq.current;
    const sp = new URLSearchParams();
    if (range.from) sp.set("from", range.from);
    if (range.to) sp.set("to", range.to);
    const qs = sp.toString();
    return api.get(`/sales/overview${qs ? `?${qs}` : ""}`)
      .then((d) => { if (ovLive.current && my === ovSeq.current) { setOvFailed(false); setOv(d); } })
      .catch(() => { if (ovLive.current && my === ovSeq.current) { setOvFailed(true); setOv(null); } });
  }, [setOvFailed, range.from, range.to]);
  useEffect(() => { loadOv(); }, [loadOv]);

  const active = DOCS.find((d) => d.id === doc);

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {tabs.map((d) => (
            <button key={d.id} className={`dk-tab ${doc === d.id ? "on" : ""}`} onClick={() => setDoc(d.id)}>
              {d.label}
              {ov && ov.counts[d.id] != null && <span className="n dk-n">{ov.counts[d.id]}</span>}
            </button>
          ))}
        </div>
        <div className="spacer" />
      </div>

      {/* Recurring brings its own two figures — projected and expected — which
          say more about a schedule than "invoiced" and "still owed" would. */}
      {!["recurring", "instalments", "loyalty"].includes(doc) &&
        <SalesStrip doc={doc} ov={ov} failed={ovFailed} onRetry={loadOv} range={range} />}

      {doc === "invoices"  && <InvoiceList title={active.title} createLabel={active.create}
                                           range={range} onRange={setRange} onChanged={loadOv} />}

      {newDoc && <InvoiceBuilder onClose={() => setNewDoc(false)}
        onSaved={() => { setNewDoc(false); loadOv(); toast("Invoice created"); }} />}
      {doc === "estimates" && <EstimateList title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "credit"    && <CreditList   title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "challans"  && <ChallanList  title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "recurring" && <RecurringPanel docType="sale" />}
      {doc === "instalments" && <InstalmentsPanel />}
      {doc === "loyalty" && <LoyaltyPanel />}
    </div>
  );
}

/* ── The three panels ─────────────────────────────────────────────────────
   The left panel changes with the tab, because "collected" means nothing on a
   delivery note. The two on the right follow it. */
function SalesStrip({ doc, ov, failed, onRetry, range }) {
  /* Said in words above the figures. Three numbers with no period attached are
     three numbers somebody has to guess the meaning of. */
  const period = !range || (!range.from && !range.to) ? "all time"
    : range.from && range.to ? `${range.from} to ${range.to}`
    : range.from ? `from ${range.from}` : `up to ${range.to}`;
  /* Never leave the figures as a skeleton for a read that already failed —
     and never print zeroes in their place. */
  if (failed) {
    return (
      <div className="dk-card"><LoadFailed what="today's sales figures" onRetry={onRetry} compact /></div>
    );
  }
  if (!ov) {
    return (
      <div className="dk-stripwrap"><div className="dk-stripcap">Figures for {period}</div>
      <div className="dk-strip">
        <div><div className="l">&nbsp;</div><div className="big">&nbsp;</div></div>
        <div><div className="l">&nbsp;</div><div className="v">&nbsp;</div></div>
        <div><div className="l">&nbsp;</div><div className="v">&nbsp;</div></div>
      </div></div>
    );
  }

  if (doc === "estimates") {
    const e = ov.estimates;
    return (
      <div className="dk-stripwrap"><div className="dk-stripcap">Figures for {period}</div>
      <div className="dk-strip">
        <div>
          <div className="l">Quoted</div>
          <div className="big dk-n">{money(e.total)}</div>
          <div className="s">{e.count} document{e.count === 1 ? "" : "s"} · nothing here touches the books</div>
        </div>
        <div>
          <div className="l">Still open</div>
          <div className="v dk-n amt-owed">{e.open}</div>
          <div className="s">waiting on the customer</div>
        </div>
        <div>
          <div className="l">Won</div>
          <div className="v dk-n amt-received">{e.converted}</div>
          <div className="s">turned into invoices</div>
        </div>
      </div></div>
    );
  }

  if (doc === "credit") {
    const c = ov.credit;
    const pct = ov.invoices.total > 0 ? ((c.total / ov.invoices.total) * 100).toFixed(1) : "0";
    return (
      <div className="dk-stripwrap"><div className="dk-stripcap">Figures for {period}</div>
      <div className="dk-strip">
        <div>
          <div className="l">Credited back</div>
          <div className="big dk-n amt-reversal">{money(c.total)}</div>
          <div className="s">{c.count} note{c.count === 1 ? "" : "s"} · {pct}% of everything invoiced</div>
        </div>
        <div>
          <div className="l">Notes raised</div>
          <div className="v dk-n">{c.count}</div>
          <div className="s">goods back, or a bill corrected</div>
        </div>
        <div>
          <div className="l">Invoiced</div>
          <div className="v dk-n">{money(ov.invoices.total)}</div>
          <div className="s">what the returns are measured against</div>
        </div>
      </div></div>
    );
  }

  if (doc === "challans") {
    const c = ov.challans;
    return (
      <div className="dk-stripwrap"><div className="dk-stripcap">Figures for {period}</div>
      <div className="dk-strip">
        <div>
          <div className="l">Delivery notes</div>
          <div className="big dk-n">{c.count}</div>
          <div className="s">goods sent out · nothing moves until invoiced</div>
        </div>
        <div>
          <div className="l">Still open</div>
          <div className={`v dk-n ${c.open ? "amt-owed" : "amt-zero"}`}>{c.open}</div>
          <div className="s">delivered but not yet billed</div>
        </div>
        <div>
          <div className="l">Invoiced</div>
          <div className="v dk-n amt-received">{c.invoiced}</div>
          <div className="s">closed off against a bill</div>
        </div>
      </div></div>
    );
  }

  const i = ov.invoices;
  const owedPct = 100 - i.collectedPct;
  return (
    <div className="dk-stripwrap"><div className="dk-stripcap">Figures for {period}</div>
    <div className="dk-strip">
      <div>
        <div className="l">Invoiced</div>
        <div className="big dk-n">{money(i.total)}</div>
        <div className={`dk-splitbar ${i.total ? "" : "is-empty"}`}>
          <i className="seg-received" style={{ width: `${i.collectedPct}%` }} />
          <i className="seg-owed"     style={{ width: `${owedPct}%` }} />
        </div>
        <div className="dk-splitlegend">
          {/* Both ends named, not just the good one. The bar's two fills are
              near-identical greys once the hue is gone, so this line is what
              says which share is which; hatched = the outstanding side. */}
          <span>{i.collectedPct}% collected · {owedPct}% still owed</span>
          <span className="dk-n">{i.count} invoice{i.count === 1 ? "" : "s"}{i.voided ? ` · ${i.voided} voided` : ""}</span>
        </div>
      </div>
      <div>
        <div className="l">Received</div>
        <div className="v dk-n amt-received">{money(i.received)}</div>
        <div className="s">{i.settled} bill{i.settled === 1 ? "" : "s"} settled in full</div>
      </div>
      <div>
        <div className="l">Still owed</div>
        <div className={`v dk-n ${i.owed > 0 ? "amt-owed" : "amt-zero"}`}>{money(i.owed)}</div>
        <div className="s">{i.open} open{i.over90 ? ` · ${i.over90} over 90 days` : ""}</div>
      </div>
    </div></div>
  );
}

/* ── Invoices ─────────────────────────────────────────────────────────── */
function InvoiceList({ title, createLabel, onChanged, range, onRange }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ total: 0, pages: 1 });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [open, setOpen] = useState(false);
  const [viewDoc, setViewDoc] = useState(null);
  const [dup, setDup] = useState(null);
  const [edit, setEdit] = useState(null);
  /* The invoice a payment is being taken against, straight from its own row.
     Money almost always arrives *for something* — a customer hands over cash
     and says "this is for invoice 214" — and until now the only way to record
     it was Cash & bank, a customer dropdown, and a server that settled their
     oldest invoice instead. */
  const [payFor, setPayFor] = useState(null);
  const limit = 25;

  /* Two effects fire on mount and every filter change (this one, and the
     page reset below), and a debounced search can leave several /sales requests
     in flight at once. Without a guard the slowest reply wins and the table
     settles on an older page than the one asked for — the stale-list report.
     Each request takes a ticket; a reply that is not the newest, or that arrives
     after unmount, is dropped. */
  const seq = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const [failed, , setFailed] = useRead();
  const load = () => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) p.set("q", q);
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    /* The filter goes to the server, so it narrows the whole book rather than
       sifting the page already loaded, and the count below the table is the
       count for the filter. */
    if (filter !== "all") p.set("status", filter);
    const my = ++seq.current;
    const current = () => live.current && my === seq.current;
    return api.get(`/sales?${p}`)
      .then((d) => { if (current()) { setFailed(false); setRows(d.rows); setMeta({ total: d.total, pages: d.pages }); } })
      /* Was `setRows([])` — which drew "No invoices yet" over a full book. */
      .catch(() => { if (current()) { setFailed(true); setRows(null); setMeta({ total: 0, pages: 1 }); } });
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [page, q, range, filter]);
  useEffect(() => { setPage(1); }, [q, range, filter]);
  /* The panels above are a second read of the same book. Refresh them together
     with the list's first read so the two cannot open on different snapshots. */
  useEffect(() => { onChanged(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps


  /* Another screen — the stock ledger on an item — can ask for a specific
     invoice rather than dumping the user on the list to hunt for it. */
  useEffect(() => {
    const onOpen = async (e) => {
      const { id, mode } = e.detail || {};
      if (!id) return;
      try {
        const d = await api.get(`/sales/${id}`);
        if (mode === "edit") setEdit(d); else setViewDoc(d);
      } catch (err) { toast(err.message, "bad"); }
    };
    window.addEventListener("vy-open-sale", onOpen);
    return () => window.removeEventListener("vy-open-sale", onOpen);
  }, []);

  const doPrint = async (s) => { const full = await api.get(`/sales/${s.id}`); printInvoice(full, s.party_name, "invoice"); };
  const doShare = (s) => {
    const msg = `*Invoice ${s.invoice_no}*%0aDate: ${s.invoice_date}%0aAmount: ${money(s.grand_total)}%0a${s.balance_due > 0 ? `Balance due: ${money(s.balance_due)}` : "Paid in full — thank you!"}`;
    window.open(`https://wa.me/?text=${msg}`, "_blank");
  };
  const refresh = () => { load(); onChanged(); };

  const voidSale = async (s) => {
    if (!(await confirmDialog({
      title: `Void ${s.invoice_no}?`,
      message: `This reverses a sale of ${money(s.grand_total)} to ${s.party_name || "Cash Sale"}.`,
      detail: `Stock goes back on the shelf, the cash or credit is undone, and it appears as voided on today's Z report.${s.paid_amount > 0 ? `\n${money(s.paid_amount)} already taken will be reversed out of the till.` : ""}`,
      danger: true, confirmLabel: "Void this sale",
    }))) return;
    try { await api.delete(`/sales/${s.id}`); toast(`${s.invoice_no} voided`); refresh(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("sales", "create")}
        onCreate={() => setOpen(true)}
        filters={[["all", "All"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["credit", "Credit"]]}
        filter={filter} onFilter={setFilter}
        q={q} onQ={setQ} searchHint="Search invoice, customer or note…"
        range={range} onRange={onRange}
        showing={failed ? "Not loaded" : rows === null ? "Loading…" : `Showing ${rows.length} of ${meta.total}${filter === "all" ? "" : ` ${filter}`}`}
        page={page} pages={meta.pages} onPage={setPage}
      >
        <table className="dk-table">
          <thead>
            <tr>
              <th>Invoice</th><th>Customer</th><th>Date</th><th>Status</th>
              <th className="r">Amount</th><th className="r">Balance</th><th style={{ width: 52 }} />
            </tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={7} what="your invoices" onRetry={refresh} /> :
              rows === null ? <LoadingRows cols={7} /> :
              rows.length === 0 ? <tr><td colSpan={7}><div className="dk-empty">
                {q || range.from || range.to || filter !== "all" ? "Nothing matches those filters." : "No invoices yet — create the first one."}
              </div></td></tr> :
              rows.map((s) => {
                const st = invoiceStatus(s);
                const voided = st === "voided";
                return (
                  <tr key={s.id} className={voided ? "void" : ""}>
                    <td className="dk-n strong">
                      {s.invoice_no}
                      {s.edit_count > 0 && (
                        <span className="dk-edited" title={`Edited ${s.edit_count} time${s.edit_count === 1 ? "" : "s"}${s.edited_at ? ` — last ${String(s.edited_at).slice(0, 10)}` : ""}`}>edited</span>
                      )}
                    </td>
                    <td className="tight">{s.party_name || "Cash Sale"}</td>
                    <td className="tight dk-n dim">{s.invoice_date}</td>
                    <td className="tight"><Pill status={st} /></td>
                    <td className={`tight r dk-n ${voided ? "amt-void" : ""}`}>{money(s.grand_total)}</td>
                    <td className={`r dk-n strong ${voided ? "" : s.balance_due > 0 ? (st === "overdue" ? "amt-overdue" : "amt-owed") : "amt-zero"}`}>
                      {voided ? "—" : s.balance_due > 0 ? money(s.balance_due) : "—"}
                    </td>
                    <td className="tight r">
                      <RowMenu label={`Actions for ${s.invoice_no}`} actions={[
                        { icon: <Icon n="eye" />, label: "View", onClick: async () => setViewDoc(await api.get(`/sales/${s.id}`)) },
                        !voided && can("sales", "edit") &&
                          { icon: <Icon n="edit" />, label: "Edit", onClick: async () => setEdit(await api.get(`/sales/${s.id}`)) },
                        { icon: <Icon n="print" />, label: "Print", onClick: () => doPrint(s) },
                        { icon: <Icon n="copy" />, label: "Duplicate", onClick: async () => setDup(await api.get(`/sales/${s.id}`)) },
                        /* Shown disabled, with the reason, rather than hidden.
                           A menu whose options appear and disappear from row to
                           row cannot be learnt — the cashier who used it on the
                           last invoice looks for it here and concludes the app
                           is broken. The reason is also the answer they need:
                           "already paid in full" ends the question, an absent
                           option does not. Voided is the same, and a walk-in
                           cash sale has no account to settle against at all. */
                        can("payments", "create") && (
                          voided
                            ? { icon: <Icon n="wallet" />, label: "Receive payment", disabled: true,
                                hint: "This sale is voided — there is nothing left to pay." }
                            : !(s.balance_due > 0.005)
                              ? { icon: <Icon n="wallet" />, label: "Receive payment", disabled: true,
                                  hint: "Paid in full — nothing outstanding on this invoice." }
                              : !s.party_id
                                ? { icon: <Icon n="wallet" />, label: "Receive payment", disabled: true,
                                    hint: "A walk-in cash sale has no customer account to settle against." }
                                : { icon: <Icon n="wallet" />, label: "Receive payment",
                                    hint: `${money(s.balance_due)} still due`,
                                    onClick: () => setPayFor(s) }),
                        { icon: <Icon n="send" />, label: "Send on WhatsApp", onClick: () => doShare(s) },
                        !voided && can("sales", "delete") && "-",
                        !voided && can("sales", "delete") &&
                          { icon: <Icon n="ban" />, label: "Void this sale", danger: true, onClick: () => voidSale(s) },
                      ]} />
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </TableCard>

      {/* Opened already pointed at this invoice: the customer filled in, the
          amount defaulted to what this one still owes, and the allocation
          switched to manual on that invoice alone — so the money settles the
          document the customer named rather than their oldest. */}
      {payFor && (
        <PaymentModal
          preset={{ direction: "in", party_id: String(payFor.party_id), amount: String(payFor.balance_due),
                    target_doc_id: payFor.id }}
          onClose={() => setPayFor(null)}
          onSaved={() => { setPayFor(null); refresh(); }} />
      )}

      {open && <InvoiceBuilder onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); toast("Invoice created"); }} />}
      {dup && <InvoiceBuilder initial={dup} onClose={() => setDup(null)} onSaved={() => { setDup(null); refresh(); toast("Invoice duplicated"); }} />}
      {edit && <InvoiceBuilder initial={edit} editing onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); toast("Invoice updated"); }} />}
      {viewDoc && (
        <Modal title={`${viewDoc.invoice_no} — ${viewDoc.party_name || "Cash Sale"}`} onClose={() => setViewDoc(null)}>
          <div style={{ color: "var(--faint)", fontSize: 13.5, marginBottom: 10 }}>{viewDoc.invoice_date} · {viewDoc.payment_type}</div>
          <div className="dk-scrollx">
          <table className="dk-table">
            <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
            <tbody>{(viewDoc.lines || []).map((l, i) => (
              <tr key={i}><td>{l.description}</td><td className="r dk-n">{l.quantity}</td><td className="r dk-n">{inr(l.rate)}</td><td className="r dk-n">{inr(l.line_total)}</td></tr>
            ))}</tbody>
          </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 750, padding: "14px 4px" }}>
            <span>Grand total</span><span className="dk-n">{money(viewDoc.grand_total)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="dk-sbtn primary" onClick={() => printInvoice(viewDoc, viewDoc.party_name || "Customer", "invoice")}>Print</button>
            <button className="dk-sbtn" onClick={() => setViewDoc(null)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ── Estimates and sale orders ────────────────────────────────────────── */
function EstimateList({ title, createLabel, onChanged }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);

  const [failed, read] = useRead();
  const load = () => read(api.get("/estimates"), setRows, null);
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows
      .filter((e) => filter === "all" || (filter === "orders" ? e.doc_type === "order" : e.status === filter))
      .filter((e) => !t || `${e.doc_no} ${e.party_name || ""}`.toLowerCase().includes(t));
  }, [rows, q, filter]);

  const refresh = () => { load(); onChanged(); };

  /* ── Turning a quotation into an invoice ────────────────────────────────
   *
   * This used to be a confirm box and nothing else: press "Create the
   * invoice" and the quote's lines went straight through, exactly as quoted.
   * That is the one case where the answer is never quite right. A quotation is
   * an offer made days ago; by the time it is accepted the customer has taken
   * two of the five, one line is out of stock, and the price of cement has
   * moved. The invoice is what actually happened, and the quote is only where
   * it started.
   *
   * So it opens the ordinary invoice editor, pre-filled from the quote, with
   * every line editable and removable — and the invoice is raised from what is
   * on the screen when Save is pressed. The estimate is marked converted in
   * the SAME transaction as the invoice (see `convert_estimate_id` in
   * sales.routes.js), so the two facts cannot come apart the way they could
   * when this was two requests.
   */
  const [converting, setConverting] = useState(null);
  const convert = async (e) => {
    try {
      const full = await api.get(`/estimates/${e.id}`);
      setConverting({
        estimate: e,
        initial: {
          party_id: full.party_id,
          notes: full.notes || "",
          lines: (full.lines || []).map((l) => ({
            item_id: l.item_id || "", description: l.description,
            quantity: l.quantity, rate: l.rate, discount_pct: l.discount_pct || 0, batch_no: "",
          })),
        },
      });
    } catch (err) { toast(err.message, "bad"); }
  };
  const cancel = async (e) => {
    if (!(await confirmDialog({ title: `Cancel ${e.doc_no}?`, message: "It stays on file, marked cancelled.", danger: true, confirmLabel: "Cancel document" }))) return;
    try { await api.put(`/estimates/${e.id}/status`, { status: "cancelled" }); toast("Cancelled"); refresh(); }
    catch (err) { toast(err.message, "bad"); }
  };

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("sales", "create")}
        onCreate={() => setOpen(true)}
        filters={[["all", "All"], ["open", "Open"], ["orders", "Orders"], ["converted", "Won"]]}
        filter={filter} onFilter={setFilter}
        q={q} onQ={setQ} searchHint="Search document or customer…"
        showing={failed ? "Not loaded" : shown === null ? "Loading…" : `Showing ${shown.length} of ${(rows || []).length}`}
        page={1} pages={1} onPage={() => {}}
      >
        <table className="dk-table">
          <thead>
            <tr><th>Document</th><th>Type</th><th>Customer</th><th>Date</th><th>Status</th><th className="r">Amount</th><th style={{ width: 52 }} /></tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={7} what="your estimates" onRetry={refresh} /> :
              shown === null ? <LoadingRows cols={7} /> :
              shown.length === 0 ? <tr><td colSpan={7}><div className="dk-empty">
                {q || filter !== "all" ? "Nothing matches those filters." : "No estimates yet — quote a customer without touching stock or books."}
              </div></td></tr> :
              shown.map((e) => (
                <tr key={e.id}>
                  <td className="dk-n strong">{e.doc_no}</td>
                  <td className="tight"><span className={`dk-tpill ${e.doc_type === "order" ? "accent" : ""}`}>{e.doc_type === "order" ? "sale order" : "estimate"}</span></td>
                  <td className="tight">{e.party_name}</td>
                  <td className="tight dk-n dim">{e.doc_date}</td>
                  <td className="tight"><Pill status={e.status} /></td>
                  <td className="r dk-n strong">{money(e.grand_total)}</td>
                  <td className="tight r">
                    {e.status === "open" && can("sales", "create") && (
                      <RowMenu label={`Actions for ${e.doc_no}`} actions={[
                        { icon: <Icon n="check" />, label: "Convert to invoice", hint: "Edit the lines first",
                          onClick: () => convert(e) },
                        "-",
                        { icon: <Icon n="ban" />, label: "Cancel", danger: true, onClick: () => cancel(e) },
                      ]} />
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableCard>
      {open && <EstimateModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); toast("Saved"); }} />}
      {converting && (
        <InvoiceBuilder
          initial={converting.initial}
          convertFrom={converting.estimate}
          onClose={() => setConverting(null)}
          onSaved={() => { setConverting(null); refresh(); }} />
      )}
    </>
  );
}

/* ── Credit notes ─────────────────────────────────────────────────────── */
function CreditList({ title, createLabel, onChanged }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);

  const [failed, read] = useRead();
  const load = () => read(api.get("/returns/credit-notes"), setRows, null);
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows
      .filter((r) => filter === "all" || r.refund_mode === filter)
      .filter((r) => !t || `${r.note_no} ${r.party_name || ""} ${r.reason || ""}`.toLowerCase().includes(t));
  }, [rows, q, filter]);

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("sales", "create")}
        onCreate={() => setOpen(true)}
        filters={[["all", "All"], ["adjust", "Against balance"], ["cash", "Cash refund"]]}
        filter={filter} onFilter={setFilter}
        q={q} onQ={setQ} searchHint="Search note, customer or reason…"
        showing={failed ? "Not loaded" : shown === null ? "Loading…" : `Showing ${shown.length} of ${(rows || []).length}`}
        page={1} pages={1} onPage={() => {}}
      >
        <table className="dk-table">
          <thead>
            <tr><th>Note</th><th>Customer</th><th>Date</th><th>Refund</th><th>Reason</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={6} what="your credit notes" onRetry={load} /> :
              shown === null ? <LoadingRows cols={6} /> :
              shown.length === 0 ? <tr><td colSpan={6}><div className="dk-empty">
                {q || filter !== "all" ? "Nothing matches those filters." : "No credit notes yet — raise one when goods come back or a bill was wrong."}
              </div></td></tr> :
              shown.map((r) => (
                <tr key={r.id}>
                  <td className="dk-n strong">{r.note_no}</td>
                  <td className="tight">{r.party_name}</td>
                  <td className="tight dk-n dim">{r.return_date}</td>
                  <td className="tight"><span className={`dk-tpill ${r.refund_mode === "cash" ? "warn" : "accent"}`}>{r.refund_mode === "cash" ? "cash back" : "off the balance"}</span></td>
                  <td className="tight dim">{r.reason || "—"}</td>
                  <td className="r dk-n strong amt-reversal">−{money(r.grand_total)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableCard>
      {open && <NoteModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged(); toast("Credit note raised"); }} />}
    </>
  );
}

/* ── Delivery challans ────────────────────────────────────────────────── */
function ChallanList({ title, createLabel, onChanged }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);

  const [failed, read] = useRead();
  const load = () => read(api.get("/returns/challans"), setRows, null);
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows
      .filter((c) => filter === "all" || c.status === filter)
      .filter((c) => !t || `${c.challan_no} ${c.party_name || ""} ${c.vehicle_no || ""}`.toLowerCase().includes(t));
  }, [rows, q, filter]);

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("sales", "create")}
        onCreate={() => setOpen(true)}
        filters={[["all", "All"], ["open", "Open"], ["delivered", "Delivered"], ["invoiced", "Invoiced"]]}
        filter={filter} onFilter={setFilter}
        q={q} onQ={setQ} searchHint="Search challan, customer or vehicle…"
        showing={failed ? "Not loaded" : shown === null ? "Loading…" : `Showing ${shown.length} of ${(rows || []).length}`}
        page={1} pages={1} onPage={() => {}}
      >
        <table className="dk-table">
          <thead>
            <tr><th>Challan</th><th>Customer</th><th>Date</th><th>Vehicle</th><th>Status</th><th className="r">Lines</th></tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={6} what="your delivery notes" onRetry={load} /> :
              shown === null ? <LoadingRows cols={6} /> :
              shown.length === 0 ? <tr><td colSpan={6}><div className="dk-empty">
                {q || filter !== "all" ? "Nothing matches those filters." : "No delivery notes yet — send goods out before the bill is raised."}
              </div></td></tr> :
              shown.map((c) => (
                <tr key={c.id}>
                  <td className="dk-n strong">{c.challan_no}</td>
                  <td className="tight">{c.party_name}</td>
                  <td className="tight dk-n dim">{c.challan_date}</td>
                  <td className="tight dk-n dim">{c.vehicle_no || "—"}</td>
                  <td className="tight"><Pill status={c.status} /></td>
                  <td className="r dk-n">{c.line_count ?? "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableCard>
      {open && <ChallanModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged(); toast("Delivery note saved"); }} />}
    </>
  );
}
