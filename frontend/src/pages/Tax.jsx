/* ── Tax & URA ─────────────────────────────────────────────────────────────
   What is owed, what would stop a claim, and what has been filed.

   Two things this screen is careful about, because getting either wrong costs
   a shop real money:

   • It does not file anything and does not talk to EFRIS. It records what
     happened elsewhere so the two can be reconciled. Every screen that could
     be mistaken for a submission says so in words.

   • It does not state a legal deadline. The due day is a setting and the
     screen says to check it. Deadlines change; an app that asserts one with
     confidence is the app that gets blamed.
*/
import React, { useEffect, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur, fmtDate as sharedFmtDate } from "../lib/tax.js";
import { Modal, toast, confirmDialog, DateRangePicker } from "../lib/ui.jsx";
import { LoadingRows, useRead, LoadFailed, FailedRows, figure } from "../lib/deckui.jsx";

const money = (v) => `${cur()} ${inr(v)}`;
const fmtDate = sharedFmtDate;

/* ── The period ───────────────────────────────────────────────────────────
   A VAT period is a calendar month and the server takes `period=YYYY-MM`, so
   whatever the shared date control hands back is snapped to the whole month it
   starts in. The control itself is the app-wide preset dropdown rather than a
   bare <select>, so Tax filters the way Sales and Money do. */
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const thisPeriod = () => ym(new Date());
const periodOf = (s) => (typeof s === "string" && /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : "");
/* First and last day of a YYYY-MM, the shape the picker wants. */
function periodBounds(m) {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}` };
}

export default function Tax() {
  const [tab, setTab] = useState("vat");
  /* Default to the period the shop is in. Opening on last month made the
     screen describe a period nobody asked about, and the figures for the
     current month — the ones a shopkeeper is actually watching — were a
     dropdown away. The picker still reaches back as far as anyone needs for
     filing; it just opens on now. */
  const [range, setRange] = useState(() => periodBounds(thisPeriod()));
  const period = periodOf(range.from) || thisPeriod();

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {[["vat", "VAT return"], ["checks", "Before you file"], ["efris", "EFRIS"],
            ["wht", "Withholding"], ["filings", "Filing history"]].map(([id, label]) => (
            <button key={id} className={`dk-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="spacer" />
        {/* months=15, not the default 12: the <select> this control replaced
            listed 15 periods and every one was a single click. Filing questions
            reach back further than a year, so a shorter list would quietly cost
            reach. */}
        {tab !== "filings" && (
          <DateRangePicker from={range.from} to={range.to} align="right" allowAll={false} months={15}
                           onChange={(r) => setRange(periodBounds(periodOf(r.from) || thisPeriod()))} />
        )}
      </div>

      {tab === "vat" && <VatReturn period={period} onChecks={() => setTab("checks")} />}
      {tab === "checks" && <Checks period={period} />}
      {tab === "efris" && <Efris period={period} />}
      {tab === "wht" && <Withholding period={period} />}
      {tab === "filings" && <Filings />}
    </div>
  );
}

/* ── The return ───────────────────────────────────────────────────────── */
function VatReturn({ period, onChecks }) {
  const [d, setD] = useState(null);
  const [fileOpen, setFileOpen] = useState(false);

  /* `setD(false)` drew one flat sentence with no way back. The flag says the
     same thing in the app's words and offers the retry. */
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get(`/tax/vat-return?period=${period}`), setD, null); };
  useEffect(load, [period]);

  if (failed) return <div className="dk-card"><LoadFailed what="this VAT return" onRetry={load} /></div>;

  const filed = d && d.filing && d.filing.filed_date;
  const refund = d && d.direction === "refundable";

  const print = () => {
    if (!d) return;
    const row = (a, b) => `<tr><td>${a}</td><td style="text-align:right">${inr(b)}</td></tr>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>VAT working — ${d.label}</title><style>
      body{font-family:'Inter','Segoe UI',sans-serif;margin:30px}h2{margin:0 0 2px}
      .s{color:#666;font-size:12.5px;margin-bottom:18px}
      table{width:100%;border-collapse:collapse;font-size:13px;max-width:620px}
      td{padding:8px 10px;border-bottom:1px solid #ddd}
      tr.t td{font-weight:700;border-top:2px solid #999}
      .n{color:#666;font-size:11.5px;margin-top:18px;max-width:620px}
      </style></head><body>
      <h2>VAT working — ${d.label}</h2>
      <div class="s">Period ${d.from} to ${d.to} · prepared ${new Date().toLocaleDateString()}</div>
      <table>
        ${row("Sales (excluding VAT)", d.sales.net)}
        ${row("VAT charged on sales", d.sales.vat)}
        ${row("Less credit notes", -d.credits.vat)}
        ${row("Output VAT", d.outputVat)}
        ${row("Purchases with a supplier TIN", d.purchases.net)}
        ${row("Input VAT claimable", d.inputVat)}
        <tr class="t"><td>${refund ? "Refundable by URA" : "VAT payable"}</td>
          <td style="text-align:right">${inr(Math.abs(d.payable))}</td></tr>
      </table>
      <p class="n">A working paper, not a return. ${d.blocked.count > 0
        ? `${inr(d.blocked.vat)} of input VAT on ${d.blocked.count} bill(s) is excluded because no supplier TIN is on file.` : ""}
        File through URA in the usual way and record the acknowledgement in the app.</p></body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  return (
    <>
      <div className="dk-strip four">
        <div>
          <div className="l">{refund ? "Refundable by URA" : "VAT payable"}</div>
          {/* Owed to URA, or owed back by URA — either way it is outstanding,
              not money in the drawer. Amber until it is settled. */}
          <div className={`big dk-n ${d && Math.abs(d.payable) > 0.005 ? "amt-owed" : "amt-zero"}`}>
            {d ? money(Math.abs(d.payable)) : "—"}
          </div>
          <div className="s">
            {d ? `${d.label} · ${filed ? `filed ${fmtDate(d.filing.filed_date)}` : "draft, not yet filed"}` : "\u00a0"}
          </div>
        </div>
        <div>
          <div className="l">Output VAT</div>
          <div className="v dk-n">{d ? money(d.outputVat) : "—"}</div>
          <div className="s">{d ? `on ${money(d.sales.net)} of sales` : "\u00a0"}</div>
        </div>
        <div>
          <div className="l">Input VAT</div>
          {/* Claimable, not yet reclaimed — owed to you. */}
          <div className={`v dk-n ${d && d.inputVat > 0.005 ? "amt-owed" : "amt-zero"}`}>{d ? money(d.inputVat) : "—"}</div>
          <div className="s">{d ? `on ${d.purchases.count} claimable bill${d.purchases.count === 1 ? "" : "s"}` : "\u00a0"}</div>
        </div>
        <div style={{ cursor: d && d.blocked.count ? "pointer" : undefined }}
             onClick={() => d && d.blocked.count && onChecks()}>
          <div className="l">Cannot claim</div>
          <div className={`v dk-n ${d && d.blocked.vat > 0 ? "amt-overdue" : "amt-zero"}`}>
            {d ? (d.blocked.vat > 0 ? money(d.blocked.vat) : "—") : "—"}
          </div>
          <div className="s">
            {d ? (d.blocked.count ? `no supplier TIN on ${d.blocked.count} bill${d.blocked.count === 1 ? "" : "s"}` : "every bill has a TIN") : "\u00a0"}
          </div>
        </div>
      </div>

      <div className="dk-money-grid">
        <div className="dk-card pad">
          <h3 style={{ margin: "0 0 4px", fontSize: 13.5, fontWeight: 650 }}>How that was worked out</h3>
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
            From the documents themselves, at the rate each one carried at the time — not at today's rate.
            {d && d.other_taxes.length > 0 && ` ${d.other_taxes.join(" and ")} ${d.other_taxes.length === 1 ? "is" : "are"} left out; only ${d.vat_rule_matched_name || d.vat_rule_name} counts here.`}
          </p>

          {/* Only when nothing matched. The old banner listed the very tax
              that should have matched and still sent the reader to two
              different Settings pages; there is one place to fix this. */}
          {d && !d.vat_rule && (
            <div className="dk-exc bad" style={{ marginBottom: 16 }}>
              <div className="dk-exc-head">
                <span className="n">!</span>
                <div>
                  <div className="t">
                    {(d.all_taxes || []).length === 0
                      ? "No taxes are set up yet"
                      : `None of your taxes match “${d.vat_rule_name}”`}
                  </div>
                  <div className="s">
                    {(d.all_taxes || []).length === 0
                      ? "That is why this return is empty. Add your VAT rule under Settings → Taxes."
                      : `That is why this return is empty. Under Settings → General, set “Which of your taxes is VAT” to one of: ${(d.all_taxes || []).join(", ")}.`}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="dk-return">
            <div className="dk-return-row">
              <span className="t"><div>Sales, excluding VAT</div><div>{d ? `${d.sales.count} invoices` : ""}</div></span>
              <span className="v dk-n">{d ? money(d.sales.net) : "—"}</span>
            </div>
            <div className="dk-return-row">
              <span className="t"><div>VAT charged</div></span>
              <span className="v dk-n">{d ? money(d.sales.vat) : "—"}</span>
            </div>
            <div className="dk-return-row">
              <span className="t"><div>Less credit notes</div><div>{d ? `${d.credits.count} raised` : ""}</div></span>
              <span className="v dk-n">{d ? `− ${money(d.credits.vat)}` : "—"}</span>
            </div>
            <div className="dk-return-row sub">
              <span className="t"><div>Output VAT</div></span>
              <span className="v dk-n">{d ? money(d.outputVat) : "—"}</span>
            </div>

            <div className="dk-return-row" style={{ marginTop: 8 }}>
              <span className="t"><div>Purchases with a supplier TIN</div><div>{d ? `${d.purchases.count} bills` : ""}</div></span>
              <span className="v dk-n">{d ? money(d.purchases.net) : "—"}</span>
            </div>
            {d && d.blocked.count > 0 && (
              <div className="dk-return-row blocked">
                <span className="t">
                  <div>Excluded — no supplier TIN</div>
                  <div>{d.blocked.count} bill{d.blocked.count === 1 ? "" : "s"} · add the TIN and it counts next time</div>
                </span>
                <span className="v dk-n">{money(d.blocked.vat)}</span>
              </div>
            )}
            <div className="dk-return-row sub">
              <span className="t"><div>Input VAT claimable</div></span>
              <span className="v dk-n">{d ? money(d.inputVat) : "—"}</span>
            </div>
          </div>

          <div className={`dk-answer ${refund ? "refund" : "pay"}`}>
            <div>
              <div className="l">{refund ? "URA owes you" : "To pay URA"}</div>
              <div className="s">
                {d ? `Output ${money(d.outputVat)} less input ${money(d.inputVat)}` : ""}
              </div>
            </div>
            <div className="v dk-n">{d ? money(Math.abs(d.payable)) : "—"}</div>
          </div>
        </div>

        <div className="dk-side dk-s">
          <div className="dk-card pad">
            <h3 style={{ margin: "0 0 14px", fontSize: 13.5, fontWeight: 650 }}>This period</h3>
            <div className="dk-due">
              <div className="dk-duerow">
                <span className="dot" style={{ background: filed ? "var(--good)" : "var(--warnc)" }} />
                <span className="t">
                  {filed ? "Filed" : "Not filed yet"}
                  <small>{d ? (filed ? `${fmtDate(d.filing.filed_date)}${d.filing.reference ? ` · ${d.filing.reference}` : ""}` : `due ${fmtDate(d.due_date)}`) : "…"}</small>
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button className="dk-sbtn" disabled={!d} onClick={print}>Print working</button>
              {can("accounting", "create") && (
                <button className="dk-sbtn primary" disabled={!d} onClick={() => setFileOpen(true)}>
                  {filed ? "Update filing" : "Record as filed"}
                </button>
              )}
            </div>
            <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
              This app does not file anything. Submit through URA in the usual way, then record the
              acknowledgement here so the history is complete.
            </p>
          </div>

          <div className="dk-card pad">
            <h3 style={{ margin: "0 0 10px", fontSize: 13.5, fontWeight: 650 }}>Before you file</h3>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
              {d && d.blocked.count > 0
                ? `${money(d.blocked.vat)} of input VAT is being left on the table because ${d.blocked.count} bill${d.blocked.count === 1 ? " has" : "s have"} no supplier TIN.`
                : "Nothing is blocking a claim from the purchase side."}
            </p>
            <button className="dk-sbtn" style={{ marginTop: 14 }} onClick={onChecks}>Run the checks</button>
          </div>
        </div>
      </div>

      {fileOpen && d && <FileDialog vat={d} onClose={() => setFileOpen(false)}
        onSaved={() => { setFileOpen(false); load(); }} />}
    </>
  );
}

/* ── Before you file ──────────────────────────────────────────────────── */
function Checks({ period }) {
  const [d, setD] = useState(null);
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get(`/tax/exceptions?period=${period}`), setD, null); };
  useEffect(load, [period]);

  /* "Nothing is standing in the way" is the most expensive sentence on this
     screen to get wrong — it is read as clearance to file. */
  if (failed) return <div className="dk-card"><LoadFailed what="the pre-filing checks" onRetry={load} /></div>;
  if (d === null) return <div className="dk-card"><div className="dk-empty">Checking…</div></div>;

  return (
    <div className="dk-card pad">
      <h3 style={{ margin: "0 0 4px", fontSize: 13.5, fontWeight: 650 }}>Before you file</h3>
      <p style={{ margin: "0 0 18px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
        Things that will cost money or come back as a question. Each one names the documents, because a
        count cannot be fixed and a list can.
      </p>

      {!d.firm_tin && (
        <div className="dk-exc bad">
          <div className="dk-exc-head">
            <span className="n">!</span>
            <div>
              <div className="t">Your own TIN is not on file</div>
              <div className="s">
                Nothing can be filed and no invoice you issue is complete without it.
                Add it under Settings → General.
              </div>
            </div>
          </div>
        </div>
      )}

      {d.groups.length === 0 && d.firm_tin ? (
        <div className="dk-clear">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 13l4.5 4.5L19 7" />
          </svg>
          Nothing is standing in the way for this period.
        </div>
      ) : d.groups.map((g) => (
        <div className={`dk-exc ${g.tone}`} key={g.id}>
          <div className="dk-exc-head">
            <span className="n dk-n">{g.rows.length}</span>
            <div>
              <div className="t">{g.title}</div>
              <div className="s">{g.why}</div>
            </div>
          </div>
          <table className="dk-table">
            <thead>
              <tr><th>Document</th><th>Who</th><th>Date</th><th className="r">{g.amountLabel}</th></tr>
            </thead>
            <tbody>
              {g.rows.slice(0, 12).map((r) => (
                <tr key={`${g.id}-${r.id}`}>
                  <td className="dk-n strong">{r.ref}</td>
                  <td className="tight">{r.party}</td>
                  <td className="tight dk-n dim">{fmtDate(r.d)}</td>
                  <td className="r dk-n strong">{money(r.amount)}</td>
                </tr>
              ))}
              {g.rows.length > 12 && (
                <tr><td colSpan={4} className="dim" style={{ fontSize: 12.5, fontWeight: 500 }}>
                  …and {g.rows.length - 12} more.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ── EFRIS ────────────────────────────────────────────────────────────── */
function Efris({ period }) {
  const [d, setD] = useState(null);
  const [mark, setMark] = useState(null);
  const [only, setOnly] = useState("all");

  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get(`/tax/efris?period=${period}`), setD, null); };
  useEffect(load, [period]);

  const rows = d && d.rows ? d.rows.filter((r) => only === "all" || r.efris_status === only) : null;
  const t = failed ? null : d ? d.totals : null;

  return (
    <>
      <div className="dk-strip four">
        <div>
          <div className="l">Fiscalised</div>
          {/* How well fiscalisation is going, not money — the .val-* scale. */}
          <div className={`big dk-n ${t && t.pct === 100 ? "val-good" : "val-watch"}`}>
            {figure(failed, t ? `${t.pct}%` : "—")}
          </div>
          <div className="s">{failed ? "the fiscalisation figures did not load"
            : t ? `${t.sent} of ${t.total - t.exempt} invoices that need it` : "\u00a0"}</div>
          {t && (
            <>
              {/* Fill classes are unscoped now, so the bar and its key take the
                  same .seg-val-* tokens the percentage above uses. Only the
                  widths stay inline, because they are data. */}
              <div className="dk-fiscal">
                <i className="seg-val-good" style={{ width: `${t.pct}%` }} />
                <i className="seg-val-loss" style={{ width: `${t.total ? (t.rejected / Math.max(t.total - t.exempt, 1)) * 100 : 0}%` }} />
              </div>
              <div className="dk-fiscal-key">
                <span><i className="seg-val-good" />sent</span>
                <span><i className="seg-val-loss" />rejected</span>
                <span><i style={{ background: "var(--sunk)" }} />waiting</span>
              </div>
            </>
          )}
        </div>
        <div>
          <div className="l">Waiting</div>
          <div className={`v dk-n ${t && t.pending ? "val-watch" : "val-flat"}`}>{figure(failed, t ? t.pending : "—")}</div>
          <div className="s">{failed ? "not loaded" : "no fiscal number yet"}</div>
        </div>
        <div>
          <div className="l">Rejected</div>
          <div className={`v dk-n ${t && t.rejected ? "val-loss" : "val-flat"}`}>{figure(failed, t ? t.rejected : "—")}</div>
          <div className="s">{failed ? "not loaded" : "needs fixing and sending again"}</div>
        </div>
        <div>
          <div className="l">Not required</div>
          <div className="v dk-n">{figure(failed, t ? t.exempt : "—")}</div>
          <div className="s">{failed ? "not loaded" : "marked as outside EFRIS"}</div>
        </div>
      </div>

      {d && !d.enabled && (
        <div className="dk-card pad" style={{ background: "var(--warn-soft)", borderColor: "transparent" }}>
          <b style={{ color: "var(--warnc)" }}>EFRIS tracking is switched off.</b>
          <div style={{ fontSize: 12.5, color: "var(--soft)", marginTop: 6, lineHeight: 1.6 }}>
            Switch it on under Settings → General to have unfiscalised invoices flagged before you file.
            You can still record fiscal numbers here without it.
          </div>
        </div>
      )}

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>Invoices{d ? ` — ${d.label}` : ""}</h3>
          <div className="dk-seg2">
            {[["all", "All"], ["pending", "Waiting"], ["rejected", "Rejected"], ["sent", "Sent"]].map(([id, label]) => (
              <button key={id} className={only === id ? "on" : ""} onClick={() => setOnly(id)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr><th>Invoice</th><th>Customer</th><th>TIN</th><th>Date</th><th className="r">Amount</th><th>Fiscal number</th><th style={{ width: 100 }} /></tr>
            </thead>
            <tbody>
              {/* Without the flag this table sat in its loading skeleton for
                  ever on a read that had already been refused. */}
              {failed ? <FailedRows cols={7} what="this period's invoices" onRetry={load} />
                : rows === null ? <LoadingRows cols={7} />
                : rows.length === 0 ? (
                  <tr><td colSpan={7}><div className="dk-empty">
                    {only === "all" ? "No invoices in this period." : `Nothing is ${only}.`}
                  </div></td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id}>
                    <td className="dk-n strong">{r.invoice_no}</td>
                    <td className="tight">{r.party_name}</td>
                    <td className="tight dk-n dim">{r.party_tin || "—"}</td>
                    <td className="tight dk-n dim">{fmtDate(r.invoice_date)}</td>
                    <td className="r dk-n">{money(r.grand_total)}</td>
                    <td className="tight">
                      {r.efris_fdn
                        ? <span className="dk-n strong">{r.efris_fdn}</span>
                        : <span className={`dk-tpill ${r.efris_status === "rejected" ? "bad" : r.efris_status === "exempt" ? "" : "warn"}`}>
                            {r.efris_status === "exempt" ? "not required" : r.efris_status === "rejected" ? "rejected" : "waiting"}
                          </span>}
                      {r.efris_note && <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>{r.efris_note}</div>}
                    </td>
                    <td className="r">
                      {can("sales", "edit") && (
                        <button className="dk-minibtn ghost" onClick={() => setMark(r)}>Record</button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="dk-pagefoot">
          <span className="count">
            This app does not send to EFRIS. Record what happened there and the gaps show up here.
          </span>
        </div>
      </div>

      {mark && <EfrisDialog invoice={mark} onClose={() => setMark(null)}
        onSaved={() => { setMark(null); load(); }} />}
    </>
  );
}

function EfrisDialog({ invoice, onClose, onSaved }) {
  const [status, setStatus] = useState(invoice.efris_status === "pending" ? "sent" : invoice.efris_status || "sent");
  const [fdn, setFdn] = useState(invoice.efris_fdn || "");
  const [note, setNote] = useState(invoice.efris_note || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put(`/tax/efris/${invoice.id}`, { status, fdn, note });
      toast(r.message || "Saved");
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`EFRIS — ${invoice.invoice_no}`} onClose={onClose}>
      <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5, lineHeight: 1.6 }}>
        Recording what EFRIS did with this invoice. Nothing is sent from here.
      </p>
      <label className="dk-field">
        <span>What happened</span>
        <select className="dk-input" value={status} onChange={(e) => setStatus(e.target.value)} autoFocus>
          <option value="sent">Accepted — I have the fiscal number</option>
          <option value="rejected">Rejected</option>
          <option value="pending">Still to send</option>
          <option value="exempt">Does not need EFRIS</option>
        </select>
      </label>
      {status === "sent" && (
        <label className="dk-field" style={{ marginTop: 14 }}>
          <span>Fiscal document number</span>
          <input className="dk-input dk-n" value={fdn} onChange={(e) => setFdn(e.target.value)}
                 placeholder="From the EFRIS receipt" />
          <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
            Without it there is nothing to reconcile against later, so it is required.
          </span>
        </label>
      )}
      {(status === "rejected" || status === "exempt") && (
        <label className="dk-field" style={{ marginTop: 14 }}>
          <span>{status === "rejected" ? "What URA said" : "Why it is exempt"}</span>
          <input className="dk-input" value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder={status === "rejected" ? "Buyer TIN invalid" : "Zero-rated export"} />
        </label>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

/* ── Withholding ──────────────────────────────────────────────────────── */
function Withholding({ period }) {
  const [d, setD] = useState(null);
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get(`/tax/withholding?period=${period}`), setD, null); };
  useEffect(load, [period]);
  const t = d ? d.totals : null;

  return (
    <>
      <div className="dk-recstats">
        <div className="dk-recstat" style={{ background: "var(--warn-soft)", borderColor: "transparent" }}>
          <span className="l" style={{ color: "var(--warnc)" }}>
            You withheld and owe URA:
          </span>
          {/* What you owe URA is not zero because the request dropped. */}
          <b className="v dk-n amt-owed">{figure(failed, t ? money(t.owed) : "—")}</b>
        </div>
        <div className="dk-recstat tint">
          <span className="l">Withheld from you, already paid on your behalf:</span>
          <b className="v dk-n">{figure(failed, t ? money(t.suffered) : "—")}</b>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>Withholding{d ? ` — ${d.label}` : ""}</h3>
          <div className="spacer" />
          {d && <span style={{ fontSize: 12.5, color: "var(--faint)" }}>Rate {d.rate}% · set under Settings → General</span>}
        </div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr><th>Payment</th><th>Party</th><th>TIN</th><th>Date</th><th>Direction</th><th className="r">Payment</th><th className="r">Withheld</th></tr>
            </thead>
            <tbody>
              {failed ? <FailedRows cols={7} what="the withholding figures" onRetry={load} />
                : d === null ? <LoadingRows cols={7} />
                : d.rows.length === 0 ? (
                  <tr><td colSpan={7}><div className="dk-empty">
                    Nothing was withheld in this period. Withholding is entered on a payment, in the
                    "tax deducted" box.
                  </div></td></tr>
                ) : d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="dk-n strong">{r.payment_no}</td>
                    <td className="tight">{r.party_name || "—"}</td>
                    <td className="tight dk-n dim">{r.party_tin || <span style={{ color: "var(--danger)" }}>missing</span>}</td>
                    <td className="tight dk-n dim">{fmtDate(r.payment_date)}</td>
                    <td className="tight">
                      <span className={`dk-tpill ${r.direction === "out" ? "warn" : "accent"}`}>
                        {r.direction === "out" ? "you withheld" : "withheld from you"}
                      </span>
                    </td>
                    <td className="r dk-n dim">{money(r.amount)}</td>
                    <td className="r dk-n strong">{money(r.tax_deducted)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="dk-pagefoot">
          <span className="count">
            A supplier you withheld from is owed a certificate. A TIN marked missing cannot be certified.
          </span>
        </div>
      </div>
    </>
  );
}

/* ── Filing history ───────────────────────────────────────────────────── */
function Filings() {
  const [d, setD] = useState(null);
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get("/tax/filings"), setD, null); };
  useEffect(load, []);
  const t = d ? d.totals : null;

  const remove = async (r) => {
    if (!(await confirmDialog({
      title: `Remove the ${r.label} filing record?`,
      message: "This only removes the record kept here. Nothing changes at URA.",
      danger: true, confirmLabel: "Remove rule",
    }))) return;
    try { await api.delete(`/tax/filings/${r.id}`); toast("Removed"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const dot = (s) => s === "on time" ? "var(--good)" : s === "late" ? "var(--warnc)"
    : s === "overdue" ? "var(--danger)" : "var(--faint)";

  return (
    <>
      <div className="dk-strip four">
        <div>
          <div className="l">Paid to URA this year</div>
          <div className="big dk-n">{figure(failed, t ? money(t.paidThisYear) : "—")}</div>
          <div className="s">{failed ? "the register did not load"
            : t ? `${t.filed} filing${t.filed === 1 ? "" : "s"} recorded` : "\u00a0"}</div>
        </div>
        <div>
          <div className="l">On time</div>
          {/* Filing punctuality is a performance figure, not money. */}
          <div className="v dk-n val-good">{figure(failed, t ? `${t.onTime} of ${t.filed}` : "—")}</div>
          <div className="s">{failed ? "the register did not load"
            : t && t.late ? `${t.late} filed late` : "against your own due dates"}</div>
        </div>
        <div>
          <div className="l">Overdue</div>
          <div className={`v dk-n ${t && t.overdue ? "val-loss" : "val-good"}`}>
            {figure(failed, t ? t.overdue : "—")}
          </div>
          {/* "nothing outstanding" on a read that failed is the worst of these:
              it says you are clear with URA when nobody has checked. */}
          <div className="s">{failed ? "the register did not load"
            : t && t.overdue ? "past the due date, not recorded as filed" : "nothing outstanding"}</div>
        </div>
        <div>
          <div className="l">Next due</div>
          <div className="v dk-n">{figure(failed, t && t.next ? fmtDate(t.next.due_date) : "—")}</div>
          <div className="s">{failed ? "the register did not load" : t && t.next ? `${t.next.label} VAT` : "\u00a0"}</div>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead"><h3>What has been filed</h3></div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr><th>Period</th><th>Tax</th><th>Due</th><th>Filed</th><th>Reference</th><th className="r">Amount</th><th>Status</th><th style={{ width: 60 }} /></tr>
            </thead>
            <tbody>
              {failed ? <FailedRows cols={8} what="the filing register" onRetry={load} />
                : d === null ? <LoadingRows cols={8} />
                : d.rows.length === 0 ? (
                  <tr><td colSpan={8}><div className="dk-empty">Nothing has been recorded as filed yet.</div></td></tr>
                ) : d.rows.map((r, i) => (
                  <tr key={`${r.tax_type}-${r.period}-${i}`}>
                    <td className="strong">{r.label}</td>
                    <td className="tight dim" style={{ textTransform: "uppercase", fontSize: 12.5, fontWeight: 500 }}>{r.tax_type}</td>
                    <td className="tight dk-n dim">{fmtDate(r.due_date)}</td>
                    <td className="tight dk-n">{r.filed_date ? fmtDate(r.filed_date) : "—"}</td>
                    <td className="tight dk-n dim">{r.reference || "—"}</td>
                    <td className="r dk-n strong">{r.amount != null ? money(r.amount) : "—"}</td>
                    <td className="tight">
                      <span className="dk-cal-status" style={{ color: dot(r.status) }}>
                        <i className="dot" style={{ background: dot(r.status) }} />{r.status}
                      </span>
                    </td>
                    <td className="r">
                      {r.id && can("accounting", "delete") && (
                        <button className="dk-iconbtn danger" aria-label={`Remove ${r.label}`} onClick={() => remove(r)}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="dk-pagefoot">
          <span className="count">
            Due dates come from the day you set under Settings → General. Check it against the current
            URA deadline — this is a reminder, not a ruling.
          </span>
        </div>
      </div>
    </>
  );
}

/* ── Recording a filing ───────────────────────────────────────────────── */
function FileDialog({ vat, onClose, onSaved }) {
  const f = vat.filing || {};
  const [filed, setFiled] = useState(f.filed_date || new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(f.amount != null ? String(f.amount) : String(Math.abs(vat.payable)));
  const [reference, setReference] = useState(f.reference || "");
  const [note, setNote] = useState(f.note || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post("/tax/filings", {
        tax_type: "vat", period: vat.period, due_date: vat.due_date,
        filed_date: filed, amount: Number(amount) || 0, reference, note,
      });
      toast(r.message || "Recorded");
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`Record the ${vat.label} filing`} onClose={onClose}>
      <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5, lineHeight: 1.6 }}>
        For a return already submitted to URA. This records it here so the history is complete — it does
        not submit anything.
      </p>
      <div className="dk-r2">
        <label className="dk-field">
          <span>Date filed</span>
          <input className="dk-input dk-n" type="date" value={filed} onChange={(e) => setFiled(e.target.value)} autoFocus />
        </label>
        <label className="dk-field">
          <span>Amount</span>
          <input className="dk-input dk-n" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="dk-field" style={{ marginTop: 14 }}>
        <span>URA acknowledgement</span>
        <input className="dk-input dk-n" value={reference} onChange={(e) => setReference(e.target.value)}
               placeholder="Reference from the receipt" />
      </label>
      <label className="dk-field" style={{ marginTop: 14 }}>
        <span>Note</span>
        <input className="dk-input" value={note} onChange={(e) => setNote(e.target.value)}
               placeholder="Anything worth remembering about this one" />
      </label>
      <div className="dk-after" style={{ marginTop: 16 }}>
        <span>Due date for this period</span>
        <b className="dk-n">{fmtDate(vat.due_date)}</b>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy || !filed} onClick={save}>
          {busy ? "Saving…" : "Record as filed"}
        </button>
      </div>
    </Modal>
  );
}
