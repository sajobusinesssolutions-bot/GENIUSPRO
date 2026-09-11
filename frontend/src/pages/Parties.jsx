import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur} from "../lib/tax.js";
import { Modal, Field, toast, confirmDialog, RowMenu } from "../lib/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { printInvoice } from "../lib/print.js";
import { PaymentModal } from "./Money.jsx";
import { useRead, LoadFailed } from "../lib/deckui.jsx";
import { SettingRow, settingsIn, MasterList } from "../lib/settingsui.jsx";

/* ── Parties, built to the design deck ─────────────────────────────────────
   Customers and suppliers in one list, because a shop that buys from someone
   it also sells to should not have to remember which drawer they are in.

   Sign convention, set by the posters on the server: a positive balance is
   money owed TO you, a negative one is money you owe. Green and red follow
   that, everywhere on this screen.  */

const money = (v) => `${cur()} ${inr(v)}`;

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2)
    .filter(Boolean).map((w) => w[0].toUpperCase()).join("") || "?";
}

/* Sale, purchase, payment, note — coloured by what each does to the balance
   rather than by which table it came out of. */
const TXN_TONE = {
  "Cash sale": "accent", "Credit sale": "accent", "Debit note": "accent",
  "Purchase": "warn",
  "Payment received": "good", "Payment made": "good",
  "Credit note": "bad",
};

export default function Parties() {
  const [all, setAll] = useState([]);
  const [selId, setSelId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [ov, setOv] = useState(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [editP, setEditP] = useState(null);
  const [payFor, setPayFor] = useState(null);

  const [listFailed, readList] = useRead();
  const [ovFailed, readOv] = useRead();
  const [detailFailed, readDetail] = useRead();

  const load = () => readList(api.get("/parties"), setAll, []);
  const loadOv = () => readOv(api.get("/parties/overview"), setOv, null);
  const loadDetail = () => selId && readDetail(api.get(`/parties/${selId}`), setDetail, null);
  const reloadDetail = loadDetail;

  useEffect(() => { load(); loadOv(); }, []);
  useEffect(() => {
    if (!selId) return setDetail(null);
    readDetail(api.get(`/parties/${selId}`), setDetail, null);
  }, [selId, all]);

  const list = useMemo(() => {
    const t = q.toLowerCase().trim();
    return all
      .filter((p) => kind === "all"
        || (kind === "owing" ? p.balance > 0.005
        : kind === "owed" ? p.balance < -0.005
        : p.party_type === kind || p.party_type === "both"))
      .filter((p) => !t || `${p.name} ${p.phone || ""} ${p.party_no || ""}`.toLowerCase().includes(t));
  }, [all, q, kind]);

  useEffect(() => {
    if (list.some((p) => p.id === selId)) return;
    setSelId(list.length ? list[0].id : null);
  }, [list]);

  return (
    <div className="dk-page">
      {ovFailed ? <div className="dk-card"><LoadFailed what="the balances summary" onRetry={loadOv} compact /></div>
                : <PartiesStrip ov={ov} />}

      <div className="dk-md">
        <div className="dk-card flush">
          <div className="dk-listhead">
            <input className="dk-input" placeholder="Search parties…" value={q} onChange={(e) => setQ(e.target.value)} />
            {can("parties", "create") && <button className="dk-addbtn" onClick={() => setOpen(true)}>+ Add</button>}
            {/* Party settings used to be a Settings page two screens away from
                the parties they describe, and party groups were filed under
                "Units & categories" — one subject split across two pages
                neither of which was this one. Both are here now. */}
            {can("settings", "edit") && (
              <button className="dk-tool" aria-label="Party preferences" title="Preferences"
                      onClick={() => setPrefs(true)}>⚙</button>
            )}
          </div>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", flex: "none" }}>
            <div className="dk-seg2">
              {[["all", "All"], ["customer", "Customers"], ["supplier", "Suppliers"], ["owing", "Owing"]].map(([id, label]) => (
                <button key={id} className={kind === id ? "on" : ""} onClick={() => setKind(id)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="dk-list dk-s">
            {listFailed ? (
              <LoadFailed what="your customers and suppliers" onRetry={() => { load(); loadOv(); }} />
            ) : list.length === 0 ? (
              <div className="dk-empty">{q || kind !== "all" ? "Nobody matches that." : "No customers or suppliers yet."}</div>
            ) : list.map((p) => (
              <div key={p.id} role="button" tabIndex={0}
                   className={`dk-row ${selId === p.id ? "on" : ""}`}
                   onClick={() => setSelId(p.id)}
                   onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelId(p.id); } }}>
                <span className="dk-avatar-sm">{initials(p.name)}</span>
                <div className="main">
                  <div className="nm">{p.name}</div>
                  <div className="mt" style={{ textTransform: "capitalize" }}>{p.party_type}</div>
                </div>
                {/* Amber for anything outstanding, either way round — green here
                    read as "money received". Direction is carried by the sign, not
                    by the colour. */}
                <b className={`bal dk-n ${Math.abs(p.balance) < 0.005 ? "amt-zero" : "amt-owed"}`}
                   title={p.balance > 0.005 ? "Owes you" : p.balance < -0.005 ? "You owe them" : "Settled up"}>
                  {Math.abs(p.balance) < 0.005 ? "—" : `${p.balance < -0.005 ? "− " : ""}${inr(Math.abs(p.balance))}`}
                </b>
              </div>
            ))}
          </div>
        </div>

        <div className="dk-detail dk-s">
          {detailFailed && !detail ? <div className="dk-card"><LoadFailed what="this account" onRetry={loadDetail} /></div>
            : !detail ? <div className="dk-card"><div className="dk-empty">Pick someone on the left to see their account.</div></div> : (
            <>
              <PartyHeader
                d={detail}
                onEdit={() => setEditP(detail)}
                onPay={() => setPayFor(detail)}
                onDeleted={() => { setSelId(null); load(); loadOv(); }}
              />
              <Statement d={detail} onChanged={() => { reloadDetail(); load(); loadOv(); }} />
            </>
          )}
        </div>
      </div>

      {open && <PartyModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); loadOv(); toast("Party saved"); }} />}
      {prefs && <PartyPrefs onClose={() => setPrefs(false)} onSaved={() => { setPrefs(false); load(); }} />}
      {editP && <PartyModal edit={editP} onClose={() => setEditP(null)}
        onSaved={() => { setEditP(null); load(); loadOv(); reloadDetail(); toast("Party updated"); }} />}
      {payFor && (
        <PaymentModal
          preset={{ party_id: String(payFor.id), direction: payFor.balance < 0 ? "out" : "in" }}
          onClose={() => setPayFor(null)}
          onSaved={() => { setPayFor(null); load(); loadOv(); reloadDetail(); }}
        />
      )}
    </div>
  );
}

/* ── The three panels ─────────────────────────────────────────────────── */
function PartiesStrip({ ov }) {
  const net = ov ? ov.net : 0;
  const positive = net >= 0;
  return (
    <div className="dk-strip">
      <div>
        <div className="l">Net position</div>
        <div className="big dk-n amt-neutral">
          {ov ? `${positive ? "+" : "−"} ${money(Math.abs(net))}` : "—"}
        </div>
        <div className="s">owed to you, minus what you owe</div>
      </div>
      <div>
        <div className="l">Customers owe</div>
        <div className={`v dk-n ${ov && ov.owedToYou > 0 ? "amt-owed" : "amt-zero"}`}>{ov ? money(ov.owedToYou) : "—"}</div>
        <div className="s">{ov ? `${ov.owingCount} with a balance` : "\u00a0"}</div>
      </div>
      <div>
        <div className="l">You owe suppliers</div>
        <div className={`v dk-n ${ov && ov.youOwe > 0 ? "amt-owed" : "amt-zero"}`}>
          {ov ? money(ov.youOwe) : "—"}
        </div>
        <div className="s">
          {!ov ? "\u00a0"
            : ov.dueThisWeek.count > 0
              ? `${ov.dueThisWeek.count} bill${ov.dueThisWeek.count === 1 ? "" : "s"} due this week`
              : "nothing falls due this week"}
        </div>
      </div>
    </div>
  );
}

/* ── Who they are, and where the account stands ───────────────────────── */
function PartyHeader({ d, onEdit, onPay, onDeleted }) {
  const owed = Number(d.balance) || 0;
  const owesYou = owed > 0.005;
  const youOwe = owed < -0.005;
  const settled = !owesYou && !youOwe;

  /* How they pay, from their record rather than a note someone typed. */
  const behaviour = d.overdue_count > 0
    ? { label: `${d.overdue_count} bill${d.overdue_count === 1 ? "" : "s"} overdue`, tone: "bad" }
    : owesYou ? { label: "Nothing overdue", tone: "good" }
    : null;

  const wa = d.phone
    ? `https://wa.me/${String(d.phone).replace(/\D/g, "").replace(/^0/, "256")}?text=${encodeURIComponent(
        `Hello ${d.name}, your balance with us is ${money(Math.abs(owed))}.`)}`
    : null;

  const remove = async () => {
    if (!(await confirmDialog({
      title: `Delete ${d.name}?`,
      message: settled ? "Their trading history stays on past invoices."
        : `Their account shows ${money(Math.abs(owed))} ${owesYou ? "owed to you" : "owed to them"}.`,
      detail: "This cannot be undone.",
      danger: true, confirmLabel: "Delete party",
    }))) return;
    try { await api.delete(`/parties/${d.id}`); toast("Party deleted"); onDeleted(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="dk-card pad">
      <div className="dk-party-head">
        <div className="dk-party-id">
          <span className="dk-avatar-lg">{initials(d.name)}</span>
          <div style={{ minWidth: 0 }}>
            <h2>{d.name}</h2>
            <div className="meta" style={{ textTransform: "capitalize" }}>
              {[d.party_type, d.phone, d.gstin ? `TIN ${d.gstin}` : null].filter(Boolean).join(" · ")}
            </div>
            <div className="dk-chips">
              {d.price_list_name && <span className="dk-chip">{d.price_list_name} price list</span>}
              {d.credit_limit > 0 && <span className="dk-chip">Credit limit {money(d.credit_limit)}</span>}
              {d.credit_days > 0 && <span className="dk-chip">{d.credit_days} days to pay</span>}
              {behaviour && <span className={`dk-chip ${behaviour.tone}`}>{behaviour.label}</span>}
            </div>
          </div>
        </div>

        <div className="dk-party-bal">
          {/* The figure below turns red when something is past due. Red was
              the only thing saying so, so the label says it too — the reader
              who cannot see the difference between this and an ordinary
              outstanding balance gets it in words, directly above the number.
              The "N bills overdue" chip beside the name carries the count. */}
          <div className="l">
            {owesYou ? (d.overdue_count > 0 ? "Owes you · overdue" : "Owes you") : youOwe ? "You owe" : "Settled up"}
          </div>
          <div className={`v dk-n ${settled ? "amt-zero" : owesYou && d.overdue_count > 0 ? "amt-overdue" : "amt-owed"}`}>
            {settled ? "—" : money(Math.abs(owed))}
          </div>
          <div className="dk-dacts">
            {wa && <a className="dk-sbtn" href={wa} target="_blank" rel="noreferrer"
                     style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              Remind on WhatsApp
            </a>}
            {can("parties", "edit") && <button className="dk-sbtn" onClick={onEdit}>Edit</button>}
            {can("parties", "delete") && <button className="dk-sbtn" onClick={remove}>Delete</button>}
            {!settled && <button className="dk-sbtn primary" onClick={onPay}>Record payment</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Statement ────────────────────────────────────────────────────────────
   A running balance read from the top down, worked backwards from where the
   account stands now. Each row answers "and what did they owe after this?",
   which is the question a statement is for. */
/* Where a statement line lives, what it is called there, and whether the app
   can undo it. One table rather than five branches at the call site: the day a
   sixth document type appears, it is a row here. */
const TXN_HOME = {
  sale:            { page: "invoices", noun: "invoice",     canVoid: true },
  purchase:        { page: "purchases", noun: "bill",       canVoid: false },
  sale_return:     { page: "invoices", sub: "credit", noun: "credit note",  canVoid: false },
  purchase_return: { page: "purchases", noun: "debit note", canVoid: false },
  payment:         { page: "money", noun: "payment",        canVoid: false },
};

function Statement({ d, onChanged }) {
  const txns = d.transactions || [];
  let running = Number(d.balance) || 0;
  const rows = txns.map((t) => {
    const row = { ...t, balance: running };
    running -= (t.sign || 0) * (Number(t.amount) || 0);
    return row;
  });

  const print = () => {
    const body = rows.map((r) => `<tr><td>${r.type}</td><td>${r.ref || ""}</td><td>${String(r.d).slice(0, 10)}</td>
      <td style="text-align:right">${r.sign < 0 ? "−" : ""}${inr(r.amount)}</td>
      <td style="text-align:right">${inr(Math.abs(r.balance))}</td></tr>`).join("");
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Statement — ${d.name}</title><style>
      body{font-family:'Inter','Segoe UI',sans-serif;margin:30px}h2{margin:0 0 4px}
      .sub{color:#666;font-size:13px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{padding:7px 10px;border-bottom:1px solid #ddd;text-align:left}
      th{background:#F1F3F7;text-transform:uppercase;font-size:11px}</style></head><body>
      <h2>${d.name}</h2>
      <div class="sub">Statement to ${new Date().toLocaleDateString()} · balance ${cur()} ${inr(Math.abs(d.balance))}
        ${d.balance > 0 ? "owed to us" : d.balance < 0 ? "owed to them" : ""}</div>
      <table><tr><th>Type</th><th>Ref</th><th>Date</th><th style="text-align:right">Amount</th><th style="text-align:right">Balance</th></tr>${body}</table></body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  return (
    <div className="dk-card">
      <div className="dk-card-head">
        <h3>Statement</h3>
        <button className="dk-linkbtn" onClick={print}>Print statement ▸</button>
      </div>
      <div className="dk-scrollx">
      <table className="dk-table">
        <thead>
          <tr><th>Type</th><th>Ref</th><th>Date</th><th className="r">Amount</th><th className="r">Balance</th><th /></tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={6}><div className="dk-empty">Nothing has been traded with them yet.</div></td></tr>
          ) : rows.map((t, i) => (
            <tr key={i}>
              <td><span className={`dk-tpill ${TXN_TONE[t.type] || ""}`}>{t.type}</span></td>
              <td className="tight dk-n">{t.ref || "—"}</td>
              <td className="tight dk-n dim">{String(t.d).slice(0, 10)}</td>
              <td className={`tight r dk-n ${t.sign < 0 ? "amt-received" : ""}`}>
                {t.sign < 0 ? "− " : ""}{money(t.amount)}
              </td>
              <td className="r dk-n strong">{Math.abs(t.balance) < 0.005 ? "—" : inr(Math.abs(t.balance))}</td>
              <td className="r"><TxnMenu t={t} party={d} onChanged={onChanged} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/* The price list and the special-prices table used to be two cards here.
   Both are gone.
   
   Special prices were per customer AND per item: a shop giving twelve traders
   the same wholesale rates set the same prices twelve times, and the day a
   price moved, remembered all twelve. A price list does that job once and
   shares it, which is what a price list is for — so there is now one place a
   price can come from, and it is not this screen.
   
   Which list a customer is on is part of who they are, so it is asked where
   the rest of that is asked: on the customer's own form. */

/* What you can do with a line on a statement.
 *
 * The statement was read-only, which is not how anybody uses one: the reason
 * to look somebody up is usually to reprint their invoice, or to open the one
 * they are arguing about. Each row now offers Open, Print and — where the app
 * can actually undo the document — Void.
 *
 * Only what the row's own screen supports is offered. A credit note has no
 * void, so it does not appear greyed out with a tooltip; it is simply not
 * there, because a disabled item you can never enable is a promise the app
 * does not keep. */
function TxnMenu({ t, party, onChanged }) {
  const home = TXN_HOME[t.kind] || {};
  const go = () => window.dispatchEvent(new CustomEvent("vy-nav", {
    detail: { page: home.page || "invoices", sub: home.sub || null } }));

  const print = async () => {
    try {
      if (t.kind === "sale") {
        const full = await api.get(`/sales/${t.id}`);
        printInvoice(full, party.name, "invoice");
        return;
      }
      if (t.kind === "purchase") {
        const full = await api.get(`/purchases/${t.id}`);
        printInvoice(full, party.name, "purchase");
        return;
      }
      /* Payments and notes have their own slips on their own screens; sending
         them through the invoice template would print a document with an
         empty item table and a total that came from nowhere. */
      toast(`Open the ${home.noun || "document"} to print it`, "bad");
      go();
    } catch (e) { toast(e.message, "bad"); }
  };

  const voidIt = async () => {
    if (!(await confirmDialog({
      title: `Void ${t.ref}?`,
      message: `${money(t.amount)} is reversed out of the books.`,
      detail: "Stock goes back, the balance is undone, and it stays on the record as voided.",
      danger: true, confirmLabel: "Void payment",
    }))) return;
    try {
      /* The same route the Sales screen uses. There is no /void — a delete on
         a sale IS the void, and it is the reversal that keeps the record. */
      await api.delete(`/sales/${t.id}`);
      toast(`${t.ref} voided`);
      onChanged && onChanged();
    } catch (e) { toast(e.message, "bad"); }
  };

  return (
    <RowMenu label={`Actions for ${t.ref || t.type}`} actions={[
      { icon: <Icon n="eye" />, label: `Open in ${home.page === "money" ? "Cash & bank" : home.page === "purchases" ? "Purchases" : "Sales"}`, onClick: go },
      { icon: <Icon n="print" />, label: "Print", onClick: print },
      home.canVoid && can("sales", "delete") &&
        { icon: <Icon n="trash" />, label: "Void", danger: true, onClick: voidIt },
    ]} />
  );
}

function PartyModal({ onClose, onSaved, edit }) {
  const [groups, setGroups] = useState([]);
  const [f, setF] = useState(edit
    ? { name: edit.name, party_type: edit.party_type, phone: edit.phone || "", email: edit.email || "", gstin: edit.gstin || "", group_id: edit.group_id || "", opening_balance: edit.opening_balance || 0, credit_limit: edit.credit_limit || 0, billing_address: edit.billing_address || "", account_code: edit.account_code || "", price_list_id: edit.price_list_id || "" }
    : { name: "", party_type: "customer", phone: "", email: "", gstin: "", group_id: "", opening_balance: 0, credit_limit: 0, billing_address: "", account_code: "", price_list_id: "" });
  const [accts, setAccts] = useState([]);
  useEffect(() => { api.get("/accounting/accounts").then((a) => setAccts(a.filter((x) => x.status !== "disabled"))).catch(() => {}); }, []);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/settings/party-groups").then(setGroups).catch(() => {}); }, []);
  /* Which price list this customer buys on. Asked here because it is part of
     who they are, and because the moment somebody enters a wholesale customer
     is the moment they know which prices that customer gets — not later, on a
     different screen, after the first invoice has gone out at retail. */
  const [lists, setLists] = useState([]);
  useEffect(() => { api.get("/settings/price-lists").then(setLists).catch(() => setLists([])); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (!f.name.trim()) return toast("Enter a name", "bad");
    setBusy(true);
    try {
      const body = { ...f, group_id: f.group_id || null };
      /* The price list is its own route — the party route does not take it —
         so it is saved second, and only when it changed. */
      const listId = f.price_list_id ? Number(f.price_list_id) : null;
      delete body.price_list_id;
      if (edit) {
        await api.put(`/parties/${edit.id}`, body);
        if (listId !== (edit.price_list_id || null)) {
          await api.put(`/parties/${edit.id}/price-list`, { price_list_id: listId });
        }
      } else {
        const made = await api.post("/parties", body);
        const newId = made && (made.id || made.party_id);
        if (listId && newId) {
          try { await api.put(`/parties/${newId}/price-list`, { price_list_id: listId }); }
          catch (err) { toast(`${f.name} was saved, but the price list was not: ${err.message}`, "bad"); }
        }
      }
      onSaved();
    }
    catch (e) { toast(e.message, "bad"); setBusy(false); }
  };
  return (
    <Modal title={edit ? `Edit ${edit.name}` : "Add party"} onClose={onClose}>
      <Field label="Name"><input value={f.name} onChange={set("name")} autoFocus /></Field>
      <div className="row2">
        <Field label="Type"><select value={f.party_type} onChange={set("party_type")}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Both</option></select></Field>
        <Field label="Group"><select value={f.group_id} onChange={set("group_id")}><option value="">—</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
      </div>
      <div className="row2">
        <Field label="Phone"><input value={f.phone} onChange={set("phone")} placeholder="07xx xxx xxx" /></Field>
        <Field label="TIN"><input value={f.gstin} onChange={set("gstin")} placeholder="Optional" /></Field>
      </div>
      <div className="row2">
        <Field label="Opening balance (Sh)"><input type="number" value={f.opening_balance} onChange={set("opening_balance")} /></Field>
        <Field label="Credit limit (Sh)"><input type="number" value={f.credit_limit} onChange={set("credit_limit")} /></Field>
      </div>
      {f.party_type !== "supplier" && (
        <Field label="Price list">
          <select value={f.price_list_id} onChange={set("price_list_id")}>
            <option value="">Ordinary prices</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <em style={{ fontSize: 11.5, color: "var(--faint)", fontStyle: "normal" }}>
            {lists.length
              ? "Applies to everything they buy, at the till and on invoices."
              : "No price lists yet — make one under Settings → Price lists."}
          </em>
        </Field>
      )}
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 13.5 }}>Advanced — accounting account (optional)</summary>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "8px 0" }}>
          Leave blank to use the default control account ({f.party_type === "supplier" ? "Creditors" : "Debtors"}).
        </p>
        <Field label="Account">
          <select value={f.account_code} onChange={set("account_code")}>
            <option value="">Default — {f.party_type === "supplier" ? "Creditors" : "Debtors"}</option>
            {accts.filter((a) => a.type === (f.party_type === "supplier" ? "liability" : "asset")).map((a) => (
              <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
            ))}
          </select>
        </Field>
      </details>
      <div style={{ display: "none" }}>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save party"}</button>
      </div>
    </Modal>
  );
}


/* ── Parties → Preferences ────────────────────────────────────────────────
 *
 * The catalogue fields for parties, plus the party-group list. Both used to be
 * in Settings, and not even on the same page as each other: the groups were
 * filed under "Units & categories" while the page describing itself as "credit
 * limits, groups and statement wording" held only the fields.
 *
 * Two of the four catalogue settings that used to render here are read by no
 * code anywhere in the app; they are not shown. See the session-3 report.
 */
function PartyPrefs({ onClose, onSaved }) {
  const [catalog, setCatalog] = useState(null);
  const [v, setV] = useState({});
  const [dirty, setDirty] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/settings")
      .then((d) => { setCatalog(d.catalog || []); setV(d.values || {}); })
      .catch(() => setCatalog([]));
  }, []);

  const setVal = (k, val) => { setV((s) => ({ ...s, [k]: val })); setDirty((d) => ({ ...d, [k]: true })); };
  const n = Object.keys(dirty).length;
  const save = async () => {
    setBusy(true);
    try {
      await api.put("/settings", Object.fromEntries(Object.keys(dirty).map((k) => [k, v[k]])));
      toast(`Saved ${n} change${n === 1 ? "" : "s"}`);
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const rows = settingsIn(catalog || [], "party");
  return (
    <Modal title="Parties — Preferences" onClose={onClose} wide>
      {catalog === null ? <div className="dk-empty">Loading…</div> : (
        <>
          <div className="dk-setsec" style={{ border: 0, padding: 0, background: "none" }}>
            <div className="rows">
              {rows.map((c) => <SettingRow key={c.key} c={c} values={v} setVal={setVal} dirty={dirty} />)}
            </div>
          </div>
          <MasterList title="Party groups" endpoint="/settings/party-groups"
                      note="Group customers and suppliers — wholesale, retail, staff — for reporting and price lists." />
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 16 }}>
        {n > 0 && <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--faint)" }}>
          {n} unsaved change{n === 1 ? "" : "s"}
        </span>}
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !n}>
          {busy ? "Saving…" : n ? `Save ${n} change${n === 1 ? "" : "s"}` : "Nothing to save"}
        </button>
      </div>
    </Modal>
  );
}
