/* ── Instalments ───────────────────────────────────────────────────────────
   Goods taken today, paid for over weeks. A tab inside Sales, because a
   payment plan is a sale — one that happens to be collected in pieces.

   The three sub-views match Recurring — what needs chasing, everything, and
   what has actually come in — and, like Recurring, they are a segmented filter
   in the card head rather than a third row of tabs.

   One thing worth knowing about the shape of this: an instalment is not paid
   as its own document. Money lands on the invoice, and the schedule is worked
   out from what the invoice has been paid in total, earliest instalment
   first. So "record a payment" here is the ordinary payment screen pointed at
   the right customer — there is no second way to take money, which is exactly
   why the plan can never disagree with the books.
*/
import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur, fmtDate as sharedFmtDate } from "../lib/tax.js";
import { Modal, toast, confirmDialog, RowMenu } from "../lib/ui.jsx";
import { LoadingRows, TableCard } from "../lib/deckui.jsx";
import { Icon } from "../lib/icons.jsx";
import { PaymentModal } from "./Money.jsx";

const money = (v) => `${cur()} ${inr(v)}`;
const FREQ = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
/* Was hand-rolled here and rendered the literal "Invalid Date" for unparseable
   values. Now uses the shared formatter, which guards and honours the
   date_format setting. */
const fmtDate = sharedFmtDate;

/* How late, said the way a person would say it. */
function lateness(dueDate, status) {
  if (status === "paid") return { text: "Settled", tone: "ok" };
  const today = new Date(new Date().toDateString());
  const days = Math.round((new Date(dueDate) - today) / 86400000);
  if (days < 0) return { text: `${-days} day${days === -1 ? "" : "s"} overdue`, tone: "late" };
  if (days === 0) return { text: "Due today", tone: "late" };
  if (days <= 7) return { text: `${days} day${days === 1 ? "" : "s"} left`, tone: "soon" };
  return { text: `${days} days left`, tone: "ok" };
}

export default function InstalmentsPanel() {
  const [view, setView] = useState("all");
  const [data, setData] = useState(null);
  const [due, setDue] = useState(null);
  const [history, setHistory] = useState(null);
  const [sum, setSum] = useState(null);
  const [q, setQ] = useState("");
  const [builder, setBuilder] = useState(false);
  const [detail, setDetail] = useState(null);
  const [payFor, setPayFor] = useState(null);

  const load = () => {
    api.get("/installments").then(setData).catch(() => setData({ rows: [], totals: {} }));
    api.get("/installments/summary").then(setSum).catch(() => setSum(null));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (view === "due") { setDue(null); api.get("/installments/due/list").then((d) => setDue(d.rows || d)).catch(() => setDue([])); }
    if (view === "history") { setHistory(null); api.get("/installments/history").then(setHistory).catch(() => setHistory({ rows: [], totals: {} })); }
  }, [view]);

  const match = (t, ...fields) => !t || fields.filter(Boolean).join(" ").toLowerCase().includes(t);
  const t = q.toLowerCase().trim();

  const plans = useMemo(() => (data ? data.rows.filter((p) => match(t, p.invoice_no, p.party_name)) : null), [data, t]);
  const dueRows = useMemo(() => (due ? due.filter((r) => match(t, r.invoice_no, r.party_name, r.label)) : null), [due, t]);
  const histRows = useMemo(() => (history ? history.rows.filter((r) => match(t, r.payment_no, r.invoice_no, r.party_name)) : null), [history, t]);

  const cancel = async (p) => {
    if (!(await confirmDialog({
      title: `Cancel the plan on ${p.invoice_no}?`,
      message: `${p.party_name} still owes ${money(p.remaining)} on this plan.`,
      detail: "The invoice and everything paid so far stay exactly as they are — only the schedule stops. The balance becomes an ordinary debt on their account.",
      danger: true, confirmLabel: "Cancel plan",
    }))) return;
    try { await api.post(`/installments/${p.id}/cancel`, {}); toast("Plan cancelled"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  /* The same three figures the banner pills carried — still to collect,
     expected this month, and what is already late — in the strip the other
     Sales tabs open with. Overdue no longer has to repaint a whole pill to say
     so: the colour rule does it. */
  const arrears = sum && sum.arrears > 0.005;
  const strip = (
    <div className="dk-strip">
      <div>
        <div className="l">Still to collect</div>
        <div className="big dk-n">{sum ? money(sum.remaining) : "—"}</div>
        <div className="s">
          {sum ? `${sum.active} running · ${sum.completed} settled` : "\u00a0"}
        </div>
      </div>
      <div>
        <div className="l">Expected this month</div>
        <div className="v dk-n amt-owed">{sum ? money(sum.expectedThisMonth) : "—"}</div>
        <div className="s">falls due before month end</div>
      </div>
      <div>
        <div className="l">Overdue right now</div>
        <div className={`v dk-n ${arrears ? "amt-overdue" : "amt-zero"}`}>
          {sum ? money(sum.arrears) : "—"}
        </div>
        <div className="s">{sum ? `${sum.dueSoon} plan${sum.dueSoon === 1 ? "" : "s"} in arrears` : "\u00a0"}</div>
      </div>
    </div>
  );

  const showing = view === "history"
    ? histRows === null ? "Loading…" : `Showing ${histRows.length} of ${((history || {}).rows || []).length}`
    : view === "due"
      ? dueRows === null ? "Loading…" : `Showing ${dueRows.length} of ${(due || []).length}`
      : plans === null ? "Loading…" : `Showing ${plans.length} of ${((data || {}).rows || []).length}`;

  return (
    <>
      {strip}

      <TableCard
        title="Payment plans"
        createLabel="New payment plan"
        canCreate={can("sales", "create")}
        onCreate={() => setBuilder(true)}
        filters={[
          ["due", `Due soon${sum && sum.dueSoon > 0 ? ` (${sum.dueSoon})` : ""}`],
          ["all", "All plans"],
          ["history", "History"],
        ]}
        filter={view} onFilter={setView}
        q={q} onQ={setQ} searchHint="Search invoice, customer or payment…"
        showing={showing}
      >
        {view === "history" ? (
            <table className="dk-table">
              <thead>
                <tr><th>Payment</th><th>Customer</th><th>Against</th><th>Date</th><th>How</th><th className="r">Amount</th></tr>
              </thead>
              <tbody>
                {histRows === null ? <LoadingRows cols={6} />
                  : histRows.length === 0 ? (
                    <tr><td colSpan={6}><div className="dk-empty">
                      {q ? "Nothing matches that." : "Nothing has been paid against a plan yet."}
                    </div></td></tr>
                  ) : histRows.map((r) => (
                    <tr key={r.id}>
                      <td className="dk-n strong">{r.payment_no}</td>
                      <td className="tight">{r.party_name}</td>
                      <td className="tight dk-n dim">{r.invoice_no}</td>
                      <td className="tight dk-n dim">{fmtDate(r.payment_date)}</td>
                      <td className="tight"><span className="dk-tpill">{r.mode || "cash"}</span></td>
                      <td className="r dk-n strong amt-received">{money(r.amount)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : view === "due" ? (
            <table className="dk-table">
              <thead>
                <tr><th>Customer</th><th>Invoice</th><th>Instalment</th><th>Due</th><th>Status</th><th className="r">Outstanding</th><th style={{ width: 52 }} /></tr>
              </thead>
              <tbody>
                {dueRows === null ? <LoadingRows cols={7} />
                  : dueRows.length === 0 ? (
                    <tr><td colSpan={7}><div className="dk-empty">
                      {q ? "Nothing matches that." : "Nothing is due — every plan is up to date."}
                    </div></td></tr>
                  ) : dueRows.map((r, i) => {
                    const late = lateness(r.due_date, r.status);
                    return (
                      <tr key={i}>
                        <td className="strong">{r.party_name}
                          {r.phone && <div className="dim dk-n" style={{ fontSize: 11.5, fontWeight: 500 }}>{r.phone}</div>}
                        </td>
                        <td className="tight dk-n dim">{r.invoice_no}</td>
                        <td className="tight">{r.label}</td>
                        <td className="tight dk-n">{fmtDate(r.due_date)}</td>
                        <td className="tight"><span className={`dk-due ${late.tone}`}>{late.text}</span></td>
                        <td className={`r dk-n strong ${late.tone === "late" ? "amt-overdue" : "amt-owed"}`}>
                          {money(r.outstanding)}
                        </td>
                        <td className="tight r">
                          <RowMenu actions={[
                            can("payments", "create") &&
                              { icon: <Icon n="plus" />, label: "Take payment",
                                onClick: () => setPayFor({ name: r.party_name, invoice_no: r.invoice_no, plan_id: r.plan_id }) },
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          ) : (
            <table className="dk-table">
              <thead>
                <tr>
                  <th>Invoice</th><th>Customer</th><th>Plan</th><th className="r">Total</th>
                  <th className="r">Paid</th><th>Next due</th><th>Status</th><th style={{ width: 52 }} />
                </tr>
              </thead>
              <tbody>
                {plans === null ? <LoadingRows cols={8} />
                  : plans.length === 0 ? (
                    <tr><td colSpan={8}><div className="dk-empty">
                      {q ? "Nothing matches that."
                        : "No payment plans yet. Set one up on a credit invoice to spread it over weeks or months."}
                    </div></td></tr>
                  ) : plans.map((p) => {
                    const paid = p.plan_total - p.remaining;
                    const pct = p.plan_total > 0 ? Math.round((paid / p.plan_total) * 100) : 0;
                    return (
                      <tr key={p.id}>
                        <td className="dk-n strong">{p.invoice_no}</td>
                        <td className="tight">{p.party_name}</td>
                        <td className="tight dim">
                          {p.count_n} × {FREQ[p.frequency] || p.frequency}
                          {p.down_payment > 0 ? ` · ${money(p.down_payment)} down` : ""}
                        </td>
                        <td className="r dk-n">{money(p.plan_total)}</td>
                        <td className={`r dk-n strong ${paid > 0.005 ? "amt-received" : "amt-zero"}`}>
                          {money(paid)}
                          <div className="dim dk-n" style={{ fontSize: 11.5, fontWeight: 500 }}>{pct}%</div>
                        </td>
                        <td className="tight dk-n">{p.completed ? "—" : fmtDate(p.next_due)}</td>
                        <td className="tight">
                          <span className={`dk-tpill ${p.completed ? "good" : p.status !== "active" ? "" : p.arrears > 0.005 ? "bad" : "warn"}`}>
                            {p.completed ? "settled" : p.status !== "active" ? p.status : p.arrears > 0.005 ? "in arrears" : "on track"}
                          </span>
                        </td>
                        <td className="tight r">
                          <RowMenu actions={[
                            { icon: <Icon n="eye" />, label: "View schedule", onClick: () => setDetail(p.id) },
                            !p.completed && p.status === "active" && can("sales", "edit") &&
                              { icon: <Icon n="ban" />, label: "Cancel plan", danger: true, onClick: () => cancel(p) },
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
      </TableCard>

      {builder && <PlanBuilder onClose={() => setBuilder(false)}
        onSaved={() => { setBuilder(false); load(); toast("Payment plan created"); }} />}
      {detail && <PlanSchedule id={detail} onClose={() => setDetail(null)} />}
      {payFor && (
        <PaymentModal
          preset={{ direction: "in" }}
          onClose={() => setPayFor(null)}
          onSaved={() => { setPayFor(null); load(); if (view === "due") api.get("/installments/due/list").then((d) => setDue(d.rows || d)).catch(() => {}); }}
        />
      )}
    </>
  );
}

/* ── Building a plan ──────────────────────────────────────────────────────
   Pick an unpaid credit invoice, say how it should be spread, and check the
   dates before committing. The preview comes from the server, so what you
   approve is what gets written. */
function PlanBuilder({ onClose, onSaved }) {
  const [eligible, setEligible] = useState(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [down, setDown] = useState("");
  const [count, setCount] = useState(4);
  const [frequency, setFrequency] = useState("monthly");
  const [interval, setInterval] = useState(1);
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get("/installments/eligible").then(setEligible).catch(() => setEligible([])); }, []);

  const inv = (eligible || []).find((e) => String(e.id) === String(invoiceId));
  const total = inv ? Number(inv.balance_due) || 0 : 0;

  useEffect(() => {
    if (!inv || !(count > 0)) return setPreview(null);
    setErr("");
    api.post("/installments/preview", {
      plan_total: total, down_payment: Number(down) || 0, count_n: Number(count),
      frequency, interval_n: Number(interval) || 1, start_date: start,
    }).then(setPreview).catch((e) => { setPreview(null); setErr(e.message); });
  }, [invoiceId, down, count, frequency, interval, start]);

  const save = async () => {
    setBusy(true);
    try {
      await api.post("/installments", {
        invoice_id: Number(invoiceId), down_payment: Number(down) || 0, count_n: Number(count),
        frequency, interval_n: Number(interval) || 1, start_date: start,
      });
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const each = preview ? preview.filter((l) => l.seq > 0) : [];

  return (
    <Modal title="New payment plan" onClose={onClose} wide>
      <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5, lineHeight: 1.6 }}>
        A plan spreads what is already owed on a credit invoice. It does not create a new sale and does not
        change what the customer owes in total — it sets out when each part falls due.
      </p>

      <label className="dk-field" style={{ marginBottom: 14 }}>
        <span>Invoice to spread</span>
        <select className="dk-input" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} autoFocus>
          <option value="">Choose an unpaid credit invoice…</option>
          {(eligible || []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.invoice_no} · {e.party_name} · {money(e.balance_due)} owing
            </option>
          ))}
        </select>
        {eligible && eligible.length === 0 && (
          <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
            No invoice qualifies — a plan needs a credit sale with a balance still owing and no plan already on it.
          </span>
        )}
      </label>

      {inv && (
        <>
          <div className="dk-r3" style={{ marginBottom: 14 }}>
            <label className="dk-field">
              <span>Paid today</span>
              <input className="dk-input dk-n" type="number" value={down} placeholder="0"
                     onChange={(e) => setDown(e.target.value)} />
            </label>
            <label className="dk-field">
              <span>Number of instalments</span>
              <input className="dk-input dk-n" type="number" min="1" value={count}
                     onChange={(e) => setCount(e.target.value)} />
            </label>
            <label className="dk-field">
              <span>How often</span>
              <select className="dk-input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="daily">Daily</option>
              </select>
            </label>
          </div>
          <div className="dk-r2" style={{ marginBottom: 14 }}>
            <label className="dk-field">
              <span>Every</span>
              <input className="dk-input dk-n" type="number" min="1" value={interval}
                     onChange={(e) => setInterval(e.target.value)} />
              <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
                2 with "weekly" means a payment every fortnight
              </span>
            </label>
            <label className="dk-field">
              <span>First due date</span>
              <input className="dk-input dk-n" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
          </div>

          {err && <div className="dk-login-err" style={{ marginBottom: 14 }}>{err}</div>}

          {preview && (
            <div className="dk-card flush" style={{ marginBottom: 4 }}>
              <div className="dk-card-head">
                <h3>The schedule</h3>
                <span className="n dk-n">
                  {each.length} × {money(each.length ? each[0].amount : 0)}
                </span>
              </div>
              <div style={{ maxHeight: 220, overflow: "auto" }}>
                <table className="dk-table">
                  <thead><tr><th>#</th><th>Falls due</th><th className="r">Amount</th></tr></thead>
                  <tbody>
                    {preview.map((l) => (
                      <tr key={l.seq}>
                        <td className="dim">{l.label}</td>
                        <td className="dk-n">{fmtDate(l.due_date)}</td>
                        <td className="r dk-n strong">{money(l.amount)}</td>
                      </tr>
                    ))}
                    <tr className="total">
                      <td>Total</td><td />
                      <td className="r dk-n">{money(preview.reduce((a, l) => a + l.amount, 0))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy || !preview} onClick={save}>
          {busy ? "Creating…" : "Create plan"}
        </button>
      </div>
    </Modal>
  );
}

/* ── One plan's schedule ──────────────────────────────────────────────── */
function PlanSchedule({ id, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/installments/${id}`).then(setD).catch(() => setD(false)); }, [id]);

  return (
    <Modal title={d ? `${d.invoice_no} — ${d.party_name}` : "Payment plan"} onClose={onClose} wide>
      {d === null ? <div className="dk-empty">Loading…</div>
        : d === false ? <div className="dk-empty">Could not read this plan.</div> : (
        <>
          <div className="dk-twoup" style={{ marginBottom: 16 }}>
            <div className="dk-figbox">
              <div className="l">Still owing</div>
              <div className={`v dk-n ${d.remaining > 0.005 ? "amt-owed" : "amt-zero"}`}>{money(d.remaining)}</div>
            </div>
            <div className="dk-figbox" style={d.arrears > 0.005 ? { background: "var(--danger-soft)" } : undefined}>
              <div className="l" style={d.arrears > 0.005 ? { color: "var(--danger)" } : undefined}>Overdue</div>
              <div className={`v dk-n ${d.arrears > 0.005 ? "amt-overdue" : "amt-zero"}`}>
                {d.arrears > 0.005 ? money(d.arrears) : "—"}
              </div>
            </div>
          </div>
          <div className="dk-scrollx">
          <table className="dk-table">
            <thead>
              <tr><th>Instalment</th><th>Due</th><th className="r">Amount</th><th className="r">Paid</th><th>Status</th></tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.seq}>
                  <td className="strong">{l.label}</td>
                  <td className="tight dk-n dim">{fmtDate(l.due_date)}</td>
                  <td className="r dk-n">{money(l.amount)}</td>
                  <td className={`r dk-n ${l.paid > 0 ? "amt-received" : "amt-zero"}`}>
                    {l.paid > 0 ? money(l.paid) : "—"}
                  </td>
                  <td className="tight">
                    <span className={`dk-tpill ${l.status === "paid" ? "good" : l.status === "overdue" ? "bad" : l.status === "partial" ? "warn" : ""}`}>
                      {l.status}{l.days_late ? ` · ${l.days_late}d` : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
            Payments are recorded against the invoice in the ordinary way — the earliest unpaid instalment
            is settled first, so the schedule and the books can never tell different stories.
          </p>
        </>
      )}
    </Modal>
  );
}
