import React, { useEffect, useMemo, useState } from "react";
import { offerDocPrint, offerVoucherPrint } from "../lib/printprompt.jsx";
import { printReportNode } from "../lib/print.js";
import api, { can } from "../lib/api.js";
import { useAttempt, attemptRef, attemptDone } from "../lib/attempt.jsx";
import { computeInvoice, inr, cur} from "../lib/tax.js";
import { Modal, Field, toast, RowMenu, SalesRepPicker, useActiveUsers, PartyCombo, confirmDialog } from "../lib/ui.jsx";
import { currentUser } from "../lib/api.js";
import { useTaxRules } from "../lib/taxrules.js";
import { Icon } from "../lib/icons.jsx";
import { TableCard, Pill, LoadingRows, money, useRead, LoadFailed, FailedRows } from "../lib/deckui.jsx";
import { plural } from "../lib/plural.js";
import RecurringPanel from "./RecurringPanel.jsx";
import { DocShell, DocSection, DocTop, DocFields, DocParty, DocTotals, docSummary } from "../lib/docshell.jsx";
import { DocLines } from "../lib/doclines.jsx";
import { AccountSelect, defaultAccount, lastAccount, rememberAccount } from "../lib/moneyaccounts.jsx";

const blank = () => ({ item_id: "", description: "", quantity: 1, rate: 0, batch_no: "", expiry_date: "" });

/* ── Purchases, built to the design deck ───────────────────────────────────
   The mirror of Sales: four document types behind one screen, sharing the
   deck's table chrome from lib/deckui.jsx so the two cannot drift apart.

   Bills, purchase orders, debit notes, expenses. The panels above describe
   the whole book rather than the page on screen.  */

const DOCS = [
  { id: "bills",    label: "Bills",           create: "New bill",      title: "Purchase bills" },
  { id: "orders",   label: "Purchase orders", create: "New order",     title: "Orders placed" },
  { id: "returns",  label: "Debit notes",     create: "New debit note", title: "Debit notes" },
  { id: "expenses", label: "Expenses",        create: "New expense",   title: "Expenses" },
  { id: "recurring", label: "Recurring",      create: "New schedule",  title: "Recurring purchases" },
];

/* A bill's status is worked out the same way the server filters on it, so the
   pill beside a row and the filter above it can never disagree. */
function billStatus(b) {
  /* A voided bill has balance_due zeroed, so without this it read as "paid" —
     the one status it certainly is not. */
  if (b.status === "voided") return "voided";
  if ((Number(b.balance_due) || 0) <= 0.005) return "paid";
  const due = new Date(b.due_date || b.bill_date);
  if (!isNaN(due) && due < new Date(new Date().toDateString())) return "overdue";
  if ((Number(b.paid_amount) || 0) > 0) return "partial";
  return "unpaid";
}

export default function Purchases({ initial }) {
  const [doc, setDoc] = useState(() => (DOCS.some((d) => d.id === initial) ? initial : "bills"));
  /* Recurring purchases only appear when that module is switched on. */
  const [mods, setMods] = useState(null);
  useEffect(() => { api.get("/settings").then((d) => setMods(d.values || {})).catch(() => setMods({})); }, []);
  const tabs = DOCS.filter((d) => d.id !== "recurring" || (mods && mods.mod_recurring_purchases === "1"));
  const [ov, setOv] = useState(null);
  const [ovFailed, readOv] = useRead();
  const loadOv = () => readOv(api.get("/purchases/overview"), setOv, null);
  useEffect(() => { loadOv(); }, []);

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

      {/* Recurring brings its own figures — projected and expected — rather
          than borrowing ones about bills that already exist. */}
      {doc !== "recurring" && (ovFailed
        ? <div className="dk-card"><LoadFailed what="the purchase figures" onRetry={loadOv} compact /></div>
        : <PurchStrip doc={doc} ov={ov} />)}

      {doc === "bills"    && <BillList     title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "orders"   && <OrderList    title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "returns"  && <DebitList    title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "expenses" && <ExpenseList  title={active.title} createLabel={active.create} onChanged={loadOv} />}
      {doc === "recurring" && <RecurringPanel docType="purchase" />}
    </div>
  );
}

/* ── The three panels ─────────────────────────────────────────────────── */
function PurchStrip({ doc, ov }) {
  if (!ov) {
    return (
      <div className="dk-strip">
        <div><div className="l">&nbsp;</div><div className="big">&nbsp;</div></div>
        <div><div className="l">&nbsp;</div><div className="v">&nbsp;</div></div>
        <div><div className="l">&nbsp;</div><div className="v">&nbsp;</div></div>
      </div>
    );
  }

  if (doc === "expenses") {
    const e = ov.expenses;
    return (
      <div className="dk-strip">
        <div>
          <div className="l">Spent on expenses</div>
          <div className="big dk-n">{money(e.total)}</div>
          <div className="s">{e.count} entr{e.count === 1 ? "y" : "ies"} · running costs, not stock</div>
        </div>
        <div>
          <div className="l">This month</div>
          <div className="v dk-n">{money(e.thisMonth)}</div>
          <div className="s">so far</div>
        </div>
        <div>
          <div className="l">Bills owed</div>
          <div className={`v dk-n ${ov.bills.owed > 0 ? "amt-owed" : "amt-zero"}`}>
            {money(ov.bills.owed)}
          </div>
          <div className="s">to suppliers, separately</div>
        </div>
      </div>
    );
  }

  if (doc === "returns") {
    const r = ov.returns;
    const pct = ov.bills.total > 0 ? ((r.total / ov.bills.total) * 100).toFixed(1) : "0";
    return (
      <div className="dk-strip">
        <div>
          <div className="l">Sent back</div>
          <div className="big dk-n amt-reversal">{money(r.total)}</div>
          <div className="s">{r.count} note{r.count === 1 ? "" : "s"} · {pct}% of everything bought</div>
        </div>
        <div>
          <div className="l">Notes raised</div>
          <div className="v dk-n">{r.count}</div>
          <div className="s">goods returned, or a bill corrected</div>
        </div>
        <div>
          <div className="l">Bought</div>
          <div className="v dk-n">{money(ov.bills.total)}</div>
          <div className="s">what the returns are measured against</div>
        </div>
      </div>
    );
  }

  if (doc === "orders") {
    const o = ov.orders;
    return (
      <div className="dk-strip">
        <div>
          <div className="l">On order</div>
          <div className="big dk-n">{money(o.onOrder)}</div>
          <div className="s">{o.open} order{o.open === 1 ? "" : "s"} placed and not yet received</div>
        </div>
        <div>
          <div className="l">Orders raised</div>
          <div className="v dk-n">{o.count}</div>
          <div className="s">{money(o.total)} all told</div>
        </div>
        <div>
          <div className="l">You owe</div>
          <div className={`v dk-n ${ov.bills.owed > 0 ? "amt-owed" : "amt-zero"}`}>
            {money(ov.bills.owed)}
          </div>
          <div className="s">on bills already received</div>
        </div>
      </div>
    );
  }

  const b = ov.bills;
  const unsettled = 100 - b.settledPct;
  return (
    <div className="dk-strip">
      <div>
        <div className="l">Bought</div>
        <div className="big dk-n">{money(b.total)}</div>
        <div className={`dk-splitbar ${b.total ? "" : "is-empty"}`}>
          <i className="seg-received" style={{ width: `${b.settledPct}%` }} />
          <i className="seg-owed"     style={{ width: `${unsettled}%` }} />
        </div>
        <div className="dk-splitlegend">
          {/* Both ends named — the two fills are near-identical greys with the
              hue gone, so this line says which share is which. */}
          <span>{b.settledPct}% settled · {unsettled}% still to pay</span>
          <span className="dk-n">{b.count} bill{b.count === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div>
        <div className="l">You owe</div>
        <div className={`v dk-n ${b.owed > 0 ? "amt-owed" : "amt-zero"}`}>{money(b.owed)}</div>
        <div className="s">
          {b.dueThisWeek.count > 0
            ? `${b.dueThisWeek.count} bill${b.dueThisWeek.count === 1 ? "" : "s"} due this week`
            : "nothing falls due this week"}
          {b.overdue > 0 ? ` · ${b.overdue} overdue` : ""}
        </div>
      </div>
      <div>
        <div className="l">Awaiting delivery</div>
        <div className="v dk-n">{ov.orders.open} order{ov.orders.open === 1 ? "" : "s"}</div>
        <div className="s dk-n">{money(ov.orders.onOrder)} on order</div>
      </div>
    </div>
  );
}

/* ── Bills ────────────────────────────────────────────────────────────── */
function BillList({ title, createLabel, onChanged }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ total: 0, pages: 1 });
  const [q, setQ] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [viewDoc, setViewDoc] = useState(null);
  const limit = 25;

  const [failed, read] = useRead();
  const load = () => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) p.set("q", q);
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    if (filter !== "all") p.set("status", filter);
    read(api.get(`/purchases?${p}`),
      (d) => { if (d) { setRows(d.rows); setMeta({ total: d.total, pages: d.pages }); } else { setRows(null); setMeta({ total: 0, pages: 1 }); } },
      null);
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [page, q, range, filter]);
  useEffect(() => { setPage(1); }, [q, range, filter]);

  const refresh = () => { load(); onChanged(); };

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("purchases", "create")}
        onCreate={() => setOpen(true)}
        filters={[["all", "All"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"]]}
        filter={filter} onFilter={setFilter}
        q={q} onQ={setQ} searchHint="Search supplier, bill number or amount…"
        range={range} onRange={setRange}
        showing={failed ? "Not loaded" : rows === null ? "Loading…" : `Showing ${rows.length} of ${meta.total}${filter === "all" ? "" : ` ${filter}`}`}
        page={page} pages={meta.pages} onPage={setPage}
      >
        <table className="dk-table">
          <thead>
            <tr>
              <th>Bill</th><th>Supplier</th><th>Date</th><th>Status</th>
              <th className="r">Amount</th><th className="r">Balance</th><th style={{ width: 52 }} />
            </tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={7} what="your bills" onRetry={refresh} /> :
              rows === null ? <LoadingRows cols={7} /> :
              rows.length === 0 ? <tr><td colSpan={7}><div className="dk-empty">
                {q || range.from || range.to || filter !== "all" ? "Nothing matches those filters." : "No bills yet — record what you have bought."}
              </div></td></tr> :
              rows.map((b) => {
                const st = billStatus(b);
                return (
                  <tr key={b.id} className={b.status === "voided" ? "void" : ""}>
                    <td className="dk-n strong">{b.bill_no}</td>
                    <td className="tight">{b.party_name}</td>
                    <td className="tight dk-n dim">{b.bill_date}</td>
                    <td className="tight"><Pill status={st} /></td>
                    <td className="tight r dk-n">{money(b.grand_total)}</td>
                    <td className={`r dk-n strong ${b.balance_due > 0 ? (st === "overdue" ? "amt-overdue" : "amt-owed") : "amt-zero"}`}>
                      {b.balance_due > 0 ? money(b.balance_due) : "—"}
                    </td>
                    <td className="tight r">
                      <RowMenu label={`Actions for ${b.bill_no}`} actions={[
                        { icon: <Icon n="eye" />, label: "View bill", onClick: async () => setViewDoc(await api.get(`/purchases/${b.id}`)) },
                        ...(can("purchases", "delete") ? [{
                          icon: <Icon n="trash" />, label: "Void bill", danger: true,
                          disabled: b.status === "voided",
                          hint: b.status === "voided" ? "already voided" : undefined,
                          onClick: async () => {
                            if (!(await confirmDialog({
                              title: `Void ${b.bill_no}?`,
                              message: `${money(b.grand_total)} from ${b.party_name}. What it delivered comes back off the shelf, the ledger entries are reversed and the supplier is no longer owed for it. If any of the goods have already been sold this will be refused rather than driving the stock negative.`,
                              danger: true, confirmLabel: "Void bill",
                            }))) return;
                            try { const r = await api.delete(`/purchases/${b.id}`); toast(r.message || "Voided"); refresh(); }
                            catch (e) { toast(e.message, "bad"); }
                          },
                        }] : []),
                      ]} />
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </TableCard>

      {open && <PurchaseForm onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); toast("Bill recorded"); }} />}
      {viewDoc && (
        <Modal title={`${viewDoc.bill_no} — ${viewDoc.party_name}`} onClose={() => setViewDoc(null)}>
          <div style={{ color: "var(--faint)", fontSize: 13.5, marginBottom: 10 }}>
            {viewDoc.bill_date}{viewDoc.due_date ? ` · due ${viewDoc.due_date}` : ""}
          </div>
          <div className="dk-scrollx">
          <table className="dk-table">
            <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
            <tbody>{(viewDoc.lines || []).map((l, i) => (
              <tr key={i}><td>{l.description}</td><td className="r dk-n">{l.quantity}</td>
                <td className="r dk-n">{inr(l.rate)}</td><td className="r dk-n">{inr(l.line_total)}</td></tr>
            ))}</tbody>
          </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 750, padding: "14px 4px" }}>
            <span>Grand total</span><span className="dk-n">{money(viewDoc.grand_total)}</span>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ── Purchase orders ──────────────────────────────────────────────────────
   The reorder suggestions sit above the list, because what to buy next is the
   reason anyone opens this tab. */
function OrderList({ title, createLabel, onChanged }) {
  const [sug, setSug] = useState(null);
  const [rows, setRows] = useState(null);
  const [openPo, setOpenPo] = useState(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  /* There was no way to raise an order the reorder algorithm had not
     suggested — the create button was switched off. */
  const [open, setOpen] = useState(false);

  /* Two reads, two flags: a dead suggestions call must not be drawn as
     "nothing needs reordering", and a dead order list must not be drawn as
     "no orders yet". */
  const [sugFailed, readSug] = useRead();
  const [failed, read] = useRead();
  const load = () => {
    readSug(api.get("/purchase-orders/suggestions"), setSug, null);
    read(api.get("/purchase-orders"), setRows, null);
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows
      .filter((o) => filter === "all"
        || (filter === "awaiting" ? ["draft", "sent", "partial"].includes(o.status) : o.status === filter))
      .filter((o) => !t || `${o.po_no} ${o.party_name || ""}`.toLowerCase().includes(t));
  }, [rows, q, filter]);

  const createFrom = async (g) => {
    setBusy(true);
    try {
      const r = await api.post("/purchase-orders", {
        party_id: g.supplier_id,
        lines: g.items.map((i) => ({ item_id: i.item_id, quantity: i.suggested_qty, rate: i.rate })),
      });
      toast(r.message || "Order created");
      load(); onChanged();
      offerDocPrint({ path: `/purchase-orders/${r.id}`, noun: "order", number: r.po_no,
                      context: "purchase", docTitle: "Purchase order" });
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const share = (po) => {
    const lines = (po.lines || []).map((l) => `• ${l.name} — ${l.quantity} ${l.unit}`).join("%0a");
    const msg = `*Order ${po.po_no}*%0a${po.order_date}%0a%0a${lines}%0a%0aPlease confirm availability and delivery date.`;
    window.open(`https://wa.me/${(po.party_phone || "").replace(/^0/, "256")}?text=${msg}`, "_blank");
  };

  if (openPo) return <OrderView po={openPo} onBack={() => { setOpenPo(null); load(); onChanged(); }} onShare={share} />;

  return (
    <>
      {sugFailed && (
        <div className="dk-card"><LoadFailed what="the reorder suggestions" onRetry={load} compact /></div>
      )}
      {sug && sug.count > 0 && (
        <div className="dk-card">
          <div className="dk-card-head">
            <h3>What to reorder</h3>
            <button className="dk-linkbtn" onClick={load}>↻ Recalculate</button>
          </div>
          <div style={{ padding: "14px 24px 4px", fontSize: 12.5, color: "var(--faint)" }}>
            From sales over the last {sug.days} days, keeping {sug.cover} days of stock. Change that under Settings → Item.
          </div>
          {sug.groups.map((g) => (
            <div key={g.supplier_id || "none"} style={{ borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 24px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{g.supplier_name}</b>
                  <div style={{ color: "var(--faint)", fontSize: 12.5, fontWeight: 500 }}>
                    {g.items.length} item{g.items.length === 1 ? "" : "s"} · about {money(g.value)}
                  </div>
                </div>
                <button className="dk-minibtn" disabled={busy || !g.supplier_id} onClick={() => createFrom(g)}
                        title={g.supplier_id ? "" : "No usual supplier on these items — buy them manually"}>
                  Create order
                </button>
              </div>
              <div className="dk-scrollx">
              <table className="dk-table">
                <thead>
                  <tr><th>Item</th><th className="r">On hand</th><th className="r">Sells/day</th>
                    <th className="r">Days left</th><th className="r">Order</th><th>Why</th></tr>
                </thead>
                <tbody>
                  {g.items.map((i) => (
                    <tr key={i.item_id}>
                      <td className="strong">{i.name}</td>
                      <td className="r dk-n">{i.on_hand} {i.unit}</td>
                      <td className="r dk-n dim">{i.per_day}</td>
                      <td className={`r dk-n ${i.days_left != null && i.days_left < 7 ? "val-loss" : ""}`}>
                        {i.days_left ?? "—"}
                      </td>
                      <td className="r dk-n strong">{i.suggested_qty}</td>
                      <td className="dim" style={{ fontSize: 12.5, fontWeight: 500 }}>{i.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          ))}
        </div>
      )}

      <TableCard
        title={title} createLabel={createLabel} canCreate={can("purchases", "create")}
        onCreate={() => setOpen(true)}
        filters={[["all", "All"], ["awaiting", "Awaiting"], ["received", "Received"], ["cancelled", "Cancelled"]]}
        filter={filter} onFilter={setFilter}
        q={q} onQ={setQ} searchHint="Search order or supplier…"
        showing={failed ? "Not loaded" : shown === null ? "Loading…" : `Showing ${shown.length} of ${(rows || []).length}`}
        page={1} pages={1} onPage={() => {}}
      >
        <table className="dk-table">
          <thead>
            <tr><th>Order</th><th>Supplier</th><th>Date</th><th className="r">Value</th>
              <th>Received</th><th>Status</th><th style={{ width: 52 }} /></tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={7} what="your purchase orders" onRetry={() => { load(); onChanged(); }} /> :
              shown === null ? <LoadingRows cols={7} /> :
              shown.length === 0 ? <tr><td colSpan={7}><div className="dk-empty">
                {q || filter !== "all" ? "Nothing matches those filters."
                  : sug && sug.count > 0 ? "No orders yet — create one from the suggestions above."
                  : sugFailed ? "No orders yet. What to reorder could not be worked out — that read failed."
                  : "No orders yet, and nothing currently needs reordering."}
              </div></td></tr> :
              shown.map((o) => (
                <tr key={o.id}>
                  <td className="dk-n strong">{o.po_no}</td>
                  <td className="tight">{o.party_name}</td>
                  <td className="tight dk-n dim">{o.order_date}</td>
                  <td className="tight r dk-n">{money(o.total)}</td>
                  <td className="tight dk-n dim">{o.done_count}/{o.line_count}</td>
                  <td className="tight"><Pill status={o.status} /></td>
                  <td className="tight r">
                    <RowMenu label={`Actions for ${o.po_no}`} actions={[
                      { icon: <Icon n="box" />, label: "Open & receive", onClick: async () => setOpenPo(await api.get(`/purchase-orders/${o.id}`)) },
                      { icon: <Icon n="send" />, label: "Send on WhatsApp", onClick: async () => share(await api.get(`/purchase-orders/${o.id}`)) },
                    ]} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableCard>
      {open && <OrderForm onClose={() => setOpen(false)}
        onSaved={() => { setOpen(false); load(); onChanged(); toast("Order created"); }} />}
    </>
  );
}

/* ── Debit notes ──────────────────────────────────────────────────────── */
function DebitList({ title, createLabel, onChanged }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const [failed, read] = useRead();
  const load = () => read(api.get("/returns/debit-notes"), setRows, null);
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows.filter((r) => !t || `${r.note_no} ${r.party_name || ""} ${r.reason || ""}`.toLowerCase().includes(t));
  }, [rows, q]);

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("purchases", "create")}
        onCreate={() => setOpen(true)}
        q={q} onQ={setQ} searchHint="Search note, supplier or reason…"
        showing={failed ? "Not loaded" : shown === null ? "Loading…" : `Showing ${shown.length} of ${(rows || []).length}`}
        page={1} pages={1} onPage={() => {}}
      >
        <table className="dk-table">
          <thead>
            <tr><th>Note</th><th>Supplier</th><th>Date</th><th>Reason</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={5} what="your debit notes" onRetry={load} /> :
              shown === null ? <LoadingRows cols={5} /> :
              shown.length === 0 ? <tr><td colSpan={5}><div className="dk-empty">
                {q ? "Nothing matches that." : "No debit notes yet — raise one when goods go back to a supplier."}
              </div></td></tr> :
              shown.map((r) => (
                <tr key={r.id}>
                  <td className="dk-n strong">{r.note_no}</td>
                  <td className="tight">{r.party_name}</td>
                  <td className="tight dk-n dim">{r.return_date}</td>
                  <td className="tight dim">{r.reason || "—"}</td>
                  <td className="r dk-n strong amt-reversal">−{money(r.grand_total)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableCard>
      {open && <DebitNoteForm onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged(); toast("Debit note raised"); }} />}
    </>
  );
}

/* ── Expenses ─────────────────────────────────────────────────────────────
   Running costs, kept apart from bills: rent and fuel are money out, but they
   are not stock and they are not owed to a supplier. */
function ExpenseList({ title, createLabel, onChanged }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ total: 0, pages: 1, sums: {} });
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const limit = 25;

  const [failed, read] = useRead();
  const load = () => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) p.set("q", q);
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    read(api.get(`/expenses?${p}`),
      (d) => { if (d) { setRows(d.rows); setMeta({ total: d.total, pages: d.pages, sums: d.sums || {} }); }
               else { setRows(null); setMeta({ total: 0, pages: 1, sums: {} }); } },
      null);
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [page, q, range]);
  useEffect(() => { setPage(1); }, [q, range]);
  useEffect(() => { api.get("/expenses/categories").then(setCats).catch(() => setCats([])); }, []);

  return (
    <>
      <TableCard
        title={title} createLabel={createLabel} canCreate={can("expenses", "create")}
        onCreate={() => setOpen(true)}
        q={q} onQ={setQ} searchHint="Search category, note or supplier…"
        range={range} onRange={setRange}
        showing={failed ? "Not loaded" : rows === null ? "Loading…"
          : `Showing ${rows.length} of ${meta.total}${meta.sums.amount != null ? ` · ${money(meta.sums.amount)} on this filter` : ""}`}
        page={page} pages={meta.pages} onPage={setPage}
      >
        <table className="dk-table">
          <thead>
            <tr><th>Ref</th><th>Category</th><th>Date</th><th>Paid to</th><th>Note</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={6} what="your expenses" onRetry={() => { load(); onChanged(); }} /> :
              rows === null ? <LoadingRows cols={6} /> :
              rows.length === 0 ? <tr><td colSpan={6}><div className="dk-empty">
                {q || range.from || range.to ? "Nothing matches those filters." : "No expenses recorded yet."}
              </div></td></tr> :
              rows.map((e) => (
                <tr key={e.id}>
                  <td className="dk-n strong">{e.expense_no}</td>
                  <td className="tight"><span className="dk-tpill">{e.category}</span></td>
                  <td className="tight dk-n dim">{e.expense_date}</td>
                  <td className="tight">{e.party_name || "—"}</td>
                  <td className="tight dim">{e.notes || "—"}</td>
                  <td className="r dk-n strong">{money(e.amount)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableCard>
      {open && <ExpenseForm cats={cats} onClose={() => setOpen(false)}
        onSaved={() => { setOpen(false); load(); onChanged(); toast("Expense recorded"); }} />}
    </>
  );
}

/* ── The four purchase-side editors ───────────────────────────────────────
   All four are DocShell (lib/docshell.jsx): full screen, a body that scrolls
   on its own, and a footer carrying the running total. They were dialogs, and
   the Total row on a purchase was being drawn below the bottom edge of the
   screen — see the header of the block appended to deck.css for why. */

function PurchaseForm({ onClose, onSaved }) {
  /* One reference for this bill until it is actually posted. */
  const attempt = useAttempt("purchase-bill");
  const today = new Date().toISOString().slice(0, 10);
  const [extras, setExtras] = useState([]);   // transport, loading, clearing…
  const [openPos, setOpenPos] = useState([]); // orders still awaiting delivery
  const [poId, setPoId] = useState("");
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [cashAccounts, setCashAccounts] = useState([]);
  const { rules, settings, taxActive } = useTaxRules("purchase");
  /* Defaults to on, because that is what this form has always done. A setting
     that silently took a column away from every shop on upgrade would be a
     worse fault than the one it fixes. */
  const batchesOn = settings.enable_batches !== "0";
  const inclusivePricing = settings.tax_inclusive_default === "1";
  const users = useActiveUsers();
  const [salesRep, setSalesRep] = useState(() => (currentUser() ? String(currentUser().id) : ""));
  const [partyId, setPartyId] = useState("");
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [paymentType, setPaymentType] = useState("credit");
  const [paidNow, setPaidNow] = useState("");
  const [cashCode, setCashCode] = useState("");
  const [lines, setLines] = useState([blank()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/purchase-orders/open").then(setOpenPos).catch(() => setOpenPos([]));
    api.get("/parties").then((p) => setParties(p.filter((x) => x.party_type !== "customer"))).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
    api.get("/accounting/cash-accounts")
      .then((a) => { setCashAccounts(a); setCashCode((c) => c || defaultAccount(a, lastAccount())); })
      .catch(() => setCashAccounts([]));
  }, []);

  const calc = useMemo(() => computeInvoice({ lines, rules, roundOff: true, pricesIncludeTax: inclusivePricing }), [lines, rules, inclusivePricing]);
  const party = parties.find((p) => String(p.id) === String(partyId));
  const paid = paymentType === "cash" ? calc.grand_total : Math.min(Number(paidNow) || 0, calc.grand_total);
  const balance = +(calc.grand_total - paid).toFixed(2);
  const extrasTotal = extras.reduce((a, x) => a + (Number(x.amount) || 0), 0);

  const save = async () => {
    if (!partyId) return toast("Choose a supplier", "bad");
    const valid = lines.filter((l) => l.item_id || (l.description && Number(l.rate) > 0));
    if (!valid.length) return toast("Add at least one item", "bad");
    if (settings.require_sales_rep !== "0" && !salesRep) return toast("Choose a sales rep first", "bad");
    setBusy(true);
    try {
      const saved = await api.post("/purchases", {
        /* Same reference on every press of Save for this bill, so a retry after
           a dropped line cannot put the delivery on the shelf twice. */
        client_ref: attempt.ref(),
        party_id: Number(partyId), bill_no: billNo || undefined, payment_type: paymentType,
        bill_date: billDate || undefined, due_date: dueDate || undefined,
        /* Only meaningful on a credit bill — a cash bill is settled in full by
           definition, and the server ignores it there. */
        paid_amount: paymentType === "credit" && Number(paidNow) > 0 ? Number(paidNow) : undefined,
        cash_account_code: cashCode || undefined,
        sales_rep_id: salesRep ? Number(salesRep) : undefined,
        landed_costs: extras.filter((x) => x.label && Number(x.amount) > 0),
        po_id: poId || undefined,
        lines: valid.map((l) => ({ item_id: l.item_id ? Number(l.item_id) : null, description: l.description, quantity: Number(l.quantity), rate: Number(l.rate), unit: l.unit || undefined, use_secondary: l.use_secondary || undefined, batch_no: l.batch_no || "", expiry_date: l.expiry_date || null })),
      });
      attempt.done();
      if (cashCode) rememberAccount(cashCode);
      if (saved.replayed) toast(`${saved.bill_no} had already gone through — this did not record it twice`);
      onSaved();
      offerDocPrint({
        path: `/purchases/${saved.id}`, noun: "purchase bill", number: saved.bill_no,
        context: "purchase", docTitle: "Purchase bill",
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <DocShell
      title="Record purchase" docNo={billNo || "Auto: PUR-…"}
      meta={`${paymentType === "cash" ? "Cash" : "Credit"} purchase · ${billDate}`}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel={`Save ${paymentType} purchase · ${cur()} ${inr(calc.grand_total)}`}
      summary={[
        ...docSummary(calc, taxActive),
        extrasTotal > 0 ? { label: "Extra costs", value: `${cur()} ${inr(extrasTotal)}` } : null,
        balance > 0.005 ? { label: "Balance due", value: `${cur()} ${inr(balance)}`, tone: "amt-owed" } : null,
      ].filter(Boolean)}
      total={{ label: "Total", value: `${cur()} ${inr(calc.grand_total)}` }}
    >
      {openPos.length > 0 && (
        <DocSection title="Against an order"
          hint={poId ? "Lines filled with what's still outstanding — change any quantity to record a part delivery. The order updates itself when you save." : null}>
          <Field label="Is this delivery against an order?">
            <select value={poId} onChange={(e) => {
              const id = e.target.value; setPoId(id);
              const po = openPos.find((p) => String(p.id) === String(id));
              if (po) {
                setPartyId(String(po.party_id || ""));
                setLines(po.lines.map((l) => ({
                  item_id: l.item_id, description: l.name,
                  quantity: +(l.quantity - l.received_qty).toFixed(3), rate: l.rate,
                  batch_no: "", expiry_date: "",
                })));
              }
            }}>
              <option value="">No — this is an ordinary purchase</option>
              {openPos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.po_no} · {p.party_name} · {plural(p.lines.length, "item")} outstanding
                </option>
              ))}
            </select>
          </Field>
        </DocSection>
      )}

      <DocTop>
        <DocSection title="Bought from">
          <Field label="Supplier">
            <PartyCombo
              parties={parties} value={partyId} onPick={setPartyId} autoFocus
              kind="supplier" placeholder="Search supplier name or phone…"
              onCreated={(p) => setParties((ps) => [p, ...ps])}
            />
          </Field>
          <DocParty party={party} emptyHint="Pick a supplier and their number, address and balance appear here." />
        </DocSection>
        <DocSection title="Bill details">
          <DocFields>
            <Field label="Purchase type">
              <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                <option value="credit">Credit purchase</option>
                <option value="cash">Cash purchase</option>
              </select>
            </Field>
            <Field label="Supplier bill # (optional)">
              <input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="Auto: PUR-…" />
            </Field>
            {/* The bill date was fixed to today. A delivery note keyed in on
                Monday for goods that arrived on Friday landed in the wrong
                week of every purchase report. */}
            <Field label="Bill date">
              <input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
            </Field>
            {/* Without this every credit bill counted as overdue the day it
                was entered: the list falls back to the bill date when there is
                no due date. */}
            <Field label={paymentType === "credit" ? "Payment due" : "Payment due (optional)"}>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <SalesRepPicker value={salesRep} onChange={setSalesRep} users={users}
                            required={settings.require_sales_rep !== "0"} label="Purchased by" />
            {paymentType === "credit" && (
              <Field label="Paid now (optional)">
                <input type="number" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} placeholder="0" />
              </Field>
            )}
            {/* Shown whenever money actually leaves, even in a shop with one
                account: seeing "paid from the drawer" before saving is how a
                bill paid by bank transfer stops being posted to the till. */}
            {cashAccounts.length > 0 && (paymentType === "cash" || Number(paidNow) > 0) && (
              <Field label="Paid from">
                <AccountSelect accounts={cashAccounts} value={cashCode} onChange={setCashCode}
                               ariaLabel="Account the bill is paid from" />
              </Field>
            )}
          </DocFields>
        </DocSection>
      </DocTop>

      <DocSection>
        {/* Settings → Items → "Batch / expiry tracking".
            *
            * The batch machinery has always worked — purchases store a batch
            * and an expiry, stock is consumed earliest-expiry-first, and the
            * receipt can print both. What never existed was the switch: these
            * two columns were on for everybody, including the shops that sell
            * nothing with a shelf life and had two more boxes to skip past on
            * every line. */}
        <DocLines withBatch={batchesOn} lines={lines} setLines={setLines} items={items} setItems={setItems}
                  calc={calc} ratePick={(it) => it.purchase_price || it.sale_price} />
      </DocSection>

      <DocSection>
        <div className="doc-secbar">
          <b>Extra costs to get these goods here</b>
          <button className="btn btn-ghost" onClick={() => setExtras((e) => [...e, { label: "", amount: "" }])}>+ Add cost</button>
        </div>
        {extras.length === 0 ? (
          <p className="doc-sec-hint">
            Transport, loading, clearing… Adding them here spreads the cost across the items by value,
            so your stock cost — and every margin you see later — is the real one.
          </p>
        ) : (
          <>
            {extras.map((x, i) => (
              <div className="doc-extra-row" key={i}>
                <input placeholder="e.g. Transport from Kampala" value={x.label}
                       onChange={(e) => setExtras((a) => a.map((v, j) => j === i ? { ...v, label: e.target.value } : v))} />
                <input type="number" placeholder="0" value={x.amount}
                       onChange={(e) => setExtras((a) => a.map((v, j) => j === i ? { ...v, amount: e.target.value } : v))} />
                <button className="icon-btn" aria-label="Remove cost"
                        onClick={() => setExtras((a) => a.filter((_, j) => j !== i))}><Icon n="close" size={15} /></button>
              </div>
            ))}
            {extrasTotal > 0 && calc.gross_total > 0 && (
              <div className="doc-extra-sum">
                {cur()} {inr(extrasTotal)} spread across {plural(lines.filter((l) => l.item_id).length, "line")} — that's
                <b> {((extrasTotal / calc.gross_total) * 100).toFixed(1)}%</b> on top of cost.
              </div>
            )}
          </>
        )}
      </DocSection>

      <DocTotals calc={calc} taxActive={taxActive} note={balance > 0.005 ? `${cur()} ${inr(balance)} will be owed to this supplier.` : null} />
    </DocShell>
  );
}

/* ── Purchase order ───────────────────────────────────────────────────────
   There was no editor for one at all: an order could only be created from the
   reorder suggestions, so a shop that wanted to order something the algorithm
   had not flagged had no way to raise the paperwork. */
function OrderForm({ onClose, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [orderDate, setOrderDate] = useState(today);
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([blank()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/parties").then((p) => setParties(p.filter((x) => x.party_type !== "customer"))).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
  }, []);

  /* No tax rules: an order is not a tax document, and the server stores a
     plain quantity × rate total. Showing a tax line here would promise a
     figure the saved order does not carry. */
  const calc = useMemo(() => computeInvoice({ lines, rules: [], roundOff: false }), [lines]);
  const party = parties.find((p) => String(p.id) === String(partyId));

  const save = async () => {
    if (!partyId) return toast("Choose a supplier", "bad");
    const valid = lines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (!valid.length) return toast("Add at least one item to order", "bad");
    setBusy(true);
    try {
      const saved = await api.post("/purchase-orders", {
        party_id: Number(partyId), order_date: orderDate || undefined,
        expected_date: expected || null, note: note || null,
        lines: valid.map((l) => ({ item_id: Number(l.item_id), quantity: Number(l.quantity), rate: Number(l.rate) || 0 })),
      });
      onSaved();
      /* An order is the document most often sent to somebody else, so it is
         worth offering even though nothing has moved in the books yet. */
      offerDocPrint({
        path: `/purchase-orders/${saved.id}`, noun: "order", number: saved.po_no,
        context: "purchase", docTitle: "Purchase order",
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <DocShell
      title="Purchase order" docNo="Auto: PO-…"
      meta={expected ? `Ordered ${orderDate} · expected ${expected}` : `Ordered ${orderDate}`}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel={`Create order · ${cur()} ${inr(calc.grand_total)}`}
      summary={[{ label: "Lines", value: String(lines.filter((l) => l.item_id).length) }]}
      total={{ label: "On order", value: `${cur()} ${inr(calc.grand_total)}` }}
      footNote="An order changes nothing: no stock, no books, nothing owed. It becomes real when the goods arrive and you record the bill against it."
    >
      <DocTop>
        <DocSection title="Order to">
          <Field label="Supplier">
            <PartyCombo parties={parties} value={partyId} onPick={setPartyId} autoFocus
                        kind="supplier" placeholder="Search supplier name or phone…"
                        onCreated={(p) => setParties((ps) => [p, ...ps])} />
          </Field>
          <DocParty party={party} emptyHint="Pick a supplier and their number, address and balance appear here." />
        </DocSection>
        <DocSection title="Order details">
          <DocFields>
            <Field label="Order date">
              <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
            </Field>
            {/* Stored, and the only thing that lets "awaiting delivery" mean
                anything more precise than "not here yet". */}
            <Field label="Expected delivery">
              <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
          </DocFields>
          <Field label="Note to the supplier">
            <textarea value={note} onChange={(e) => setNote(e.target.value)}
                      placeholder="Delivery instructions, agreed terms…" />
          </Field>
        </DocSection>
      </DocTop>

      <DocSection>
        <DocLines lines={lines} setLines={setLines} items={items} setItems={setItems} calc={calc}
                  ratePick={(it) => it.purchase_price || it.sale_price}
                  qtyLabel="Order qty" addLabel="＋ Add item to order" title="What to order" />
      </DocSection>

      <DocTotals calc={calc} taxActive={taxActive} note="Rates are what you expect to pay. What is actually charged is settled on the bill." />
    </DocShell>
  );
}

/* ── Debit note ───────────────────────────────────────────────────────────
   This form crashed on open: it carried a copy of the purchase form's
   "extra costs" block referring to `extras` and `setExtras`, which exist only
   in the purchase form. React threw a ReferenceError the moment it rendered,
   so "New debit note" opened a blank screen. The block is gone rather than
   fixed — landed costs are not a thing you spread over goods going back, and
   /returns/debit-notes does not accept them. */
function DebitNoteForm({ onClose, onSaved }) {
  const noteAttempt = useAttempt("debit-note");
  const today = new Date().toISOString().slice(0, 10);
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [bills, setBills] = useState([]);
  const { rules, taxActive } = useTaxRules("purchase");
  const [partyId, setPartyId] = useState("");
  const [billId, setBillId] = useState("");
  const [returnDate, setReturnDate] = useState(today);
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState([blank()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/parties").then((p) => setParties(p.filter((x) => x.party_type !== "customer"))).catch(() => {});
    api.get("/items").then(setItems).catch(() => {});
    api.get("/purchases?page=1&limit=100").then((d) => setBills(d.rows || [])).catch(() => setBills([]));
  }, []);

  /* Picking the bill is the whole point of a debit note: it is a correction to
     a specific purchase, the server stores which one, and nothing in the old
     form ever sent it — every note was filed against no bill at all. */
  const pickBill = async (id) => {
    setBillId(id);
    if (!id) return;
    try {
      const bill = await api.get(`/purchases/${id}`);
      setPartyId(String(bill.party_id));
      setLines((bill.lines || []).map((l) => ({
        item_id: l.item_id || "", description: l.description || "",
        quantity: l.quantity, rate: l.rate, batch_no: "", expiry_date: "",
      })));
    } catch (e) { toast(e.message, "bad"); }
  };

  const calc = useMemo(() => computeInvoice({ lines, rules, roundOff: false }), [lines, rules]);
  const party = parties.find((p) => String(p.id) === String(partyId));

  const save = async () => {
    if (!partyId) return toast("Choose a supplier", "bad");
    const valid = lines.filter((l) => l.item_id || (l.description && Number(l.rate) > 0));
    if (!valid.length) return toast("Add at least one item", "bad");
    setBusy(true);
    try {
      const saved = await api.post("/returns/debit-notes", {
        client_ref: noteAttempt.ref(),
        party_id: Number(partyId), bill_id: billId ? Number(billId) : null,
        return_date: returnDate || undefined, reason,
        lines: valid.map((l) => ({ item_id: l.item_id ? Number(l.item_id) : null, description: l.description, quantity: Number(l.quantity), rate: Number(l.rate), unit: l.unit || undefined, use_secondary: l.use_secondary || undefined })),
      });
      noteAttempt.done();
      if (saved.replayed) toast(`${saved.note_no} had already gone through — this did not record it twice`);
      onSaved();
      /* Goods going back to a supplier travel with paper, and the supplier's
         copy is the evidence the credit was claimed. */
      offerDocPrint({
        path: `/returns/debit-notes/${saved.id}`, noun: "debit note",
        number: saved.note_no, context: "purchase", docTitle: "Debit note",
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <DocShell
      title="Debit note" docNo="Auto: DN-…" meta={`Goods back to the supplier · ${returnDate}`}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel={`Issue debit note · ${cur()} ${inr(calc.grand_total)}`}
      summary={docSummary(calc)}
      total={{ label: "Credit due", value: `${cur()} ${inr(calc.grand_total)}` }}
      footNote="Stock goes out and the supplier is owed this much less, the moment you save."
    >
      <DocTop>
        <DocSection title="Sent back to">
          <Field label="Original purchase (prefills the lines)">
            <select value={billId} onChange={(e) => pickBill(e.target.value)}>
              <option value="">None — a note on its own</option>
              {bills.map((b) => (
                <option key={b.id} value={b.id}>{b.bill_no} · {b.party_name} · {cur()} {inr(b.grand_total)}</option>
              ))}
            </select>
          </Field>
          <Field label="Supplier">
            <PartyCombo parties={parties} value={partyId} onPick={setPartyId}
                        kind="supplier" placeholder="Search supplier name or phone…"
                        onCreated={(p) => setParties((ps) => [p, ...ps])} />
          </Field>
          <DocParty party={party} emptyHint="Pick the bill or the supplier and their details appear here." />
        </DocSection>
        <DocSection title="Note details">
          <DocFields>
            <Field label="Return date">
              <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
            </Field>
            <Field label="Reason">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong batch, damaged…" />
            </Field>
          </DocFields>
        </DocSection>
      </DocTop>

      <DocSection>
        <DocLines lines={lines} setLines={setLines} items={items} setItems={setItems} calc={calc}
                  ratePick={(it) => it.purchase_price || it.sale_price}
                  qtyLabel="Qty returned" addLabel="＋ Add returned item" title="What went back" />
      </DocSection>

      <DocTotals calc={calc} />
    </DocShell>
  );
}

/* ── Expense ──────────────────────────────────────────────────────────────
   The dialog this replaces sent four fields. The table behind it has ten, and
   four of the missing ones matter: the date (every expense was stamped today,
   so last week's rent landed in this week's figures), who it was paid to, the
   tax on it, and which cash or bank account it came out of.

   Exported because Cash & bank records expenses too, and used to do it through
   its own four-field dialog — the same expense saved from two screens wrote
   two different rows. */
/**
 * Recording what a shop spent.
 *
 * One form, several lines. A single trip to the market is fuel, and porters,
 * and lunch for the loaders — three categories, one payment, one afternoon —
 * and the form took one of them at a time, which meant opening it three times
 * and choosing the same date, the same payment method and the same account
 * three times. Nobody does that; they add the three together under
 * "Miscellaneous" and the expense report stops meaning anything.
 *
 * So the date, how it was paid and who it was paid to are asked once, and the
 * lines under them are what the money went on. Each line is saved as its own
 * expense, because that is what they are — the form is what is shared, not the
 * record.
 */
/* ── Recording an expense ──────────────────────────────────────────────────
 *
 * Rebuilt. The old form opened on a five-column table — Category, Amount, Of
 * which tax, What for, and a delete button — for what is, nine times out of
 * ten, one line: paid the landlord 400,000 in cash. A grid is the right shape
 * for a purchase bill, where lines are the point; for an expense it made the
 * common case do the work of the rare one, and buried the amount, which is the
 * only figure anybody is actually thinking about, in the second column of a
 * table.
 *
 * So: the amount is the first and largest thing on the screen. The category is
 * a set of tiles rather than a dropdown, because there are ten of them and a
 * shop uses the same three — they are worth being able to hit without opening
 * anything. The date offers Today and Yesterday, which is nearly every expense
 * anybody types. Splitting across several categories is still here, one click
 * away, for the day a single payment covers three things.
 *
 * And it can now repeat. Rent, wages and power are the same amount on the same
 * day every month, and the month somebody is too busy to type them is the
 * month the books show a profit the shop did not make.
 */
export function ExpenseForm({ cats, onClose, onSaved }) {
  /* An expense records tax the shop was charged, not tax it applies — but a
     shop with tax switched off has no use for the field, and one that fills it
     in gets a figure no report will read. */
  const { taxActive } = useTaxRules("purchase");
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [parties, setParties] = useState([]);
  const [cashAccounts, setCashAccounts] = useState([]);
  const [f, setF] = useState({
    mode: "cash", notes: "", expense_date: today, party_id: "", cash_account_code: "",
  });
  const blankRow = () => ({ category: (cats && cats[0]) || "Miscellaneous", amount: "", tax_amount: "", note: "" });
  const [rows, setRows] = useState([blankRow()]);
  /* Split off by default. One line is the overwhelming majority of expenses,
     and a table of one row with a delete button beside it is a form asking a
     question nobody was asking. */
  const [split, setSplit] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [rep, setRep] = useState({ name: "", frequency: "monthly", interval_n: 1, end_until: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => Number(r.amount) > 0);

  useEffect(() => {
    api.get("/parties").then(setParties).catch(() => {});
    api.get("/accounting/cash-accounts")
      .then((a) => { setCashAccounts(a); setF((x) => (x.cash_account_code ? x : { ...x, cash_account_code: defaultAccount(a, lastAccount()) })); })
      .catch(() => setCashAccounts([]));
  }, []);

  const amount = filled.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const tax = filled.reduce((a, r) => a + (Number(r.tax_amount) || 0), 0);

  /* Collapsing a split back to one line must not silently throw away three
     amounts somebody typed. It only offers to collapse when there is nothing
     to lose. */
  const closeSplit = () => {
    setRows((rs) => (rs.filter((r) => Number(r.amount) > 0).length > 1 ? rs : [rs[0] || blankRow()]));
    setSplit(false);
  };

  const save = async () => {
    if (!filled.length) return toast("Enter an amount", "bad");
    setBusy(true);
    try {
      /* One request per line, in order, stopping at the first refusal. A
         partial save is reported honestly rather than rolled back: the lines
         that went through are real expenses that really happened, and quietly
         deleting them because the fourth had a bad category would be worse
         than saying which ones landed. */
      const saved = [];
      for (let i = 0; i < filled.length; i++) {
        const r = filled[i];
        try {
          const one = await api.post("/expenses", {
            /* A reference PER LINE, not per form. This loop stops at the first
               refusal and reports what landed, so a connection that drops on
               line four leaves three real expenses behind — and pressing Save
               again has to recognise those three rather than double them. */
            client_ref: `${attemptRef("expense-batch")}-${i}`,
            category: r.category, amount: Number(r.amount) || 0,
            tax_amount: Number(r.tax_amount) || 0, mode: f.mode,
            notes: [r.note, f.notes].filter(Boolean).join(" — ") || null,
            expense_date: f.expense_date || undefined,
            party_id: f.party_id ? Number(f.party_id) : null,
            cash_account_code: f.cash_account_code || undefined,
          });
          saved.push({ ...one, category: r.category, amount: Number(r.amount) || 0 });
        } catch (err) {
          if (saved.length) {
            toast(`${saved.length} of ${filled.length} saved — "${r.category}" was refused: ${err.message}`, "bad");
            onSaved();
            return;
          }
          throw err;
        }
      }
      attemptDone("expense-batch");
      if (f.cash_account_code) rememberAccount(f.cash_account_code);

      /* The schedule is created after the expense it was set up from, and its
         failure is reported without losing the expense — the money went out
         either way, and the schedule is a convenience. */
      if (repeat && filled.length === 1) {
        try {
          await api.post("/expenses/recurring", {
            name: rep.name.trim() || filled[0].category,
            category: filled[0].category,
            amount: Number(filled[0].amount) || 0,
            tax_amount: Number(filled[0].tax_amount) || 0,
            mode: f.mode,
            cash_account_code: f.cash_account_code || undefined,
            party_id: f.party_id ? Number(f.party_id) : null,
            notes: f.notes || null,
            frequency: rep.frequency,
            interval_n: Number(rep.interval_n) || 1,
            /* Starts at the NEXT one, not this one — this one has just been
               recorded, and a schedule starting today would raise it twice. */
            start_date: nextAfter(f.expense_date || today, rep.frequency, Number(rep.interval_n) || 1),
            end_until: rep.end_until || null,
          });
          toast("Saved, and set to repeat");
        } catch (e) { toast(`Expense saved, but the repeat was not set up: ${e.message}`, "bad"); }
      }

      onSaved();
      offerVoucherPrint({
        noun: "voucher", title: "Payment voucher",
        number: saved.length === 1 ? saved[0].expense_no : `${saved[0].expense_no} +${saved.length - 1}`,
        direction: "Paid to",
        party: f.party_id ? (parties.find((x) => x.id === Number(f.party_id)) || {}).name : (saved[0] || {}).category,
        amount,
        rows: [
          ["Date", f.expense_date || new Date().toISOString().slice(0, 10)],
          ["Method", f.mode],
          /* Every line on the voucher, because a lump of 180,000 with no
             breakdown is exactly what the split form exists to stop. */
          ...saved.map((x) => [x.category, `${cur()} ${inr(x.amount)}`]),
          ["Tax", tax ? String(tax) : ""],
        ],
        note: f.notes || null,
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const MODES = [["cash", "Cash"], ["upi", "Mobile money"], ["card", "Card"], ["bank", "Bank"]];

  return (
    <DocShell
      title="Record an expense" docNo="Auto: EXP-…"
      meta={split ? `${filled.length || 1} line${filled.length === 1 ? "" : "s"} · ${f.expense_date}` : f.expense_date}
      onClose={onClose} onSave={save} busy={busy}
      saveLabel={`Save expense · ${cur()} ${inr(amount)}`}
      summary={tax > 0 ? [{ label: "Of which tax", value: `${cur()} ${inr(tax)}` }] : []}
      total={{ label: "Amount", value: `${cur()} ${inr(amount)}` }}
      footNote="A running cost, not stock: nothing here touches what is on the shelf."
    >
      <DocTop>
        {!split ? (
          <>
            {/* ── The amount, first and largest ────────────────────────────
                It is the only figure anybody is thinking about when they open
                this form, and it used to be the second column of a table. */}
            <DocSection title="How much">
              <div className="exp-amount">
                <span className="cur">{cur()}</span>
                <input className="dk-n" type="number" inputMode="decimal" autoFocus
                       value={rows[0].amount} placeholder="0"
                       onChange={(e) => setRow(0, { amount: e.target.value })} />
              </div>
              {taxActive && (
                <div className="exp-taxline">
                  <label htmlFor="exp-tax">Of which tax the shop was charged</label>
                  <input id="exp-tax" className="dk-input dk-n" type="number" value={rows[0].tax_amount}
                         placeholder="0" onChange={(e) => setRow(0, { tax_amount: e.target.value })} />
                </div>
              )}
            </DocSection>

            {/* ── The category, as tiles ───────────────────────────────────
                Ten of them, and a shop uses the same three all week. Worth
                being able to hit without opening a dropdown first. */}
            <DocSection title="What it was for">
              <div className="exp-cats" role="radiogroup" aria-label="Expense category">
                {(cats || []).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={rows[0].category === c}
                          className={`exp-cat ${rows[0].category === c ? "on" : ""}`}
                          onClick={() => setRow(0, { category: c })}>{c}</button>
                ))}
              </div>
              <Field label="Note (optional)">
                <input className="dk-input" value={rows[0].note} placeholder="Which month's rent, whose wages…"
                       onChange={(e) => setRow(0, { note: e.target.value })} />
              </Field>
              <button className="dk-sbtn" style={{ marginTop: 10 }} onClick={() => setSplit(true)}>
                This payment covers several things
              </button>
            </DocSection>
          </>
        ) : (
          <DocSection title="What was spent">
            <table className="dk-table exp-lines">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="amt">Amount ({cur()})</th>
                  {taxActive && <th className="amt">Of which tax</th>}
                  <th>What for</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <select className="cell-input" value={r.category}
                              onChange={(e) => setRow(i, { category: e.target.value })}>
                        {(cats || []).map((c) => <option key={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="amt">
                      <input className="cell-input dk-n" type="number" value={r.amount} autoFocus={i === 0}
                             placeholder="0" onChange={(e) => setRow(i, { amount: e.target.value })} />
                    </td>
                    {taxActive && (
                      <td className="amt">
                        <input className="cell-input dk-n" type="number" value={r.tax_amount}
                               placeholder="0" onChange={(e) => setRow(i, { tax_amount: e.target.value })} />
                      </td>
                    )}
                    <td>
                      <input className="cell-input" value={r.note} placeholder="Optional"
                             onChange={(e) => setRow(i, { note: e.target.value })} />
                    </td>
                    <td>
                      <button className="icon-btn" title="Remove this line"
                              onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="dk-sbtn" onClick={() => setRows((rs) => [...rs, blankRow()])}>+ Another line</button>
              <button className="dk-sbtn" onClick={closeSplit}>Back to one amount</button>
            </div>
          </DocSection>
        )}

        <DocSection title="When, and how it was paid">
          {/* Today and yesterday cover nearly every expense anybody types.
              The date box stays for the rest. */}
          <div className="exp-when">
            <button type="button" className={`exp-day ${f.expense_date === today ? "on" : ""}`}
                    onClick={() => setF((v) => ({ ...v, expense_date: today }))}>Today</button>
            <button type="button" className={`exp-day ${f.expense_date === yesterday ? "on" : ""}`}
                    onClick={() => setF((v) => ({ ...v, expense_date: yesterday }))}>Yesterday</button>
            <input className="dk-input" type="date" value={f.expense_date} onChange={set("expense_date")}
                   aria-label="Date of the expense" />
          </div>

          <div className="exp-modes" role="radiogroup" aria-label="How it was paid">
            {MODES.map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={f.mode === id}
                      className={`exp-mode ${f.mode === id ? "on" : ""}`}
                      onClick={() => setF((v) => ({ ...v, mode: id }))}>{label}</button>
            ))}
          </div>

          <DocFields>
            {cashAccounts.length > 0 && (
              <Field label="Out of">
                <AccountSelect accounts={cashAccounts} value={f.cash_account_code}
                               ariaLabel="Account the expense is paid out of"
                               onChange={(v) => setF((x) => ({ ...x, cash_account_code: v }))} />
              </Field>
            )}
            <Field label="Paid to (optional)">
              <select value={f.party_id} onChange={set("party_id")}>
                <option value="">— nobody on file —</option>
                {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </DocFields>
          <Field label="Note on the whole payment">
            <textarea value={f.notes} onChange={set("notes")} placeholder="What this was for" />
          </Field>
        </DocSection>

        {/* ── Repeating ────────────────────────────────────────────────────
            Offered only on a single-line expense: a schedule that raises three
            categories at once is a different thing, and pretending one switch
            covers both would produce a monthly entry nobody could read. */}
        {!split && (
          <DocSection title="Does this happen every month?">
            <label className="exp-repeat">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
              <span>
                <b>Set this up to repeat</b>
                <em>Rent, wages, power — recorded on its own from now on, so a busy month
                    does not leave the books showing a profit the shop did not make.</em>
              </span>
            </label>

            {repeat && (
              <DocFields>
                <Field label="Call it">
                  <input value={rep.name} placeholder={rows[0].category || "Shop rent"}
                         onChange={(e) => setRep((v) => ({ ...v, name: e.target.value }))} />
                </Field>
                <Field label="How often">
                  <select value={rep.frequency} onChange={(e) => setRep((v) => ({ ...v, frequency: e.target.value }))}>
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                    <option value="monthly">Every month</option>
                    <option value="yearly">Every year</option>
                  </select>
                </Field>
                <Field label="Every">
                  <input type="number" min="1" value={rep.interval_n}
                         onChange={(e) => setRep((v) => ({ ...v, interval_n: e.target.value }))} />
                </Field>
                <Field label="Stop after (optional)">
                  <input type="date" value={rep.end_until}
                         onChange={(e) => setRep((v) => ({ ...v, end_until: e.target.value }))} />
                </Field>
              </DocFields>
            )}
            {repeat && (
              <p className="exp-repeat-note">
                The next one falls due on <b>{nextAfter(f.expense_date || today, rep.frequency, Number(rep.interval_n) || 1)}</b>.
                Today's is being recorded now, so the schedule starts from the one after it.
                You can pause or change it under Cash &amp; bank → Expenses → Repeating.
              </p>
            )}
          </DocSection>
        )}
      </DocTop>
    </DocShell>
  );
}

/* The date one period on. Kept in step with `advance()` on the server — month
   arithmetic is done on the calendar rather than by adding 30 days, and a
   schedule that starts on the 31st lands on the last day of a short month
   rather than skidding into the next one. */
function nextAfter(from, freq, n) {
  const step = Math.max(1, Number(n) || 1);
  const d = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return from;
  if (freq === "daily") d.setUTCDate(d.getUTCDate() + step);
  else if (freq === "weekly") d.setUTCDate(d.getUTCDate() + 7 * step);
  else if (freq === "yearly") d.setUTCFullYear(d.getUTCFullYear() + step);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + step);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

/* One order, and how much of it has actually turned up. */
function OrderView({ po, onBack, onShare }) {
  const value = (po.lines || []).reduce((a, l) => a + Number(l.quantity) * Number(l.rate), 0);
  const outstanding = (po.lines || []).reduce(
    (a, l) => a + Math.max(Number(l.quantity) - Number(l.received_qty || 0), 0) * Number(l.rate), 0);

  const paper = React.useRef(null);

  return (
    <div className="dk-card dk-tablecard" ref={paper}>
      <div className="dk-tablehead">
        <button className="dk-mbtn" style={{ height: 38 }} onClick={onBack}>← Back</button>
        <h3 style={{ marginLeft: 6 }}>{po.po_no} — {po.party_name || "No supplier"}</h3>
        <Pill status={po.status} />
        <div className="spacer" />
        <button className="dk-sbtn" onClick={() => onShare(po)}>Send on WhatsApp</button>
        <button className="dk-sbtn" onClick={() => printReportNode(paper.current, {
          title: `Purchase order ${po.po_no}`,
          caption: `${po.party_name || "No supplier"} · ordered ${po.order_date}`,
        })}>Print</button>
      </div>

      <div style={{ padding: "14px 24px", color: "var(--faint)", fontSize: 13.5 }}>
        Ordered {po.order_date}{po.expected_date ? ` · expected ${po.expected_date}` : ""}
        {" · "}<b className="dk-n" style={{ color: "var(--ink)" }}>{money(value)}</b> ordered
        {outstanding > 0.005 && <> · <b className="dk-n amt-owed">{money(outstanding)}</b> still to come</>}
      </div>

      <div className="dk-tablewrap dk-s">
        <table className="dk-table">
          <thead>
            <tr><th>Item</th><th className="r">Ordered</th><th className="r">Received</th>
              <th className="r">Outstanding</th><th className="r">Rate</th><th className="r">Value</th></tr>
          </thead>
          <tbody>
            {(po.lines || []).map((l) => {
              const out = Math.max(Number(l.quantity) - Number(l.received_qty || 0), 0);
              return (
                <tr key={l.id}>
                  <td className="strong">{l.name}</td>
                  <td className="r dk-n">{l.quantity} {l.unit}</td>
                  <td className="r dk-n dim">{l.received_qty || 0}</td>
                  <td className={`r dk-n strong ${out > 0 ? "amt-owed" : "amt-zero"}`}>{out}</td>
                  <td className="r dk-n">{money(l.rate)}</td>
                  <td className="r dk-n">{money(l.quantity * l.rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="dk-pagefoot">
        <span className="count">
          Record the delivery as a normal bill — then mark what arrived here, so the outstanding column stays honest.
        </span>
      </div>
    </div>
  );
}
