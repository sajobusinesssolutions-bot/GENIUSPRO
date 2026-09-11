/* ── Till administrator ────────────────────────────────────────────────────
   The drawer behind the Administrator button on the till bar, and the six
   dialogs it opens. Kept out of Pos.jsx so the sale itself stays readable.

   Everything here is management work done without leaving the till: moving
   cash, collecting a debt, reprinting a slip, and closing the shift.  */
import React, { useEffect, useMemo, useState } from "react";
import { offerVoucherPrint } from "../lib/printprompt.jsx";
import api, { can, currentUser } from "../lib/api.js";
import { inr, cur } from "../lib/tax.js";
import { toast, confirmDialog } from "../lib/ui.jsx";
import { printInvoice } from "../lib/print.js";

const money = (v) => `${cur()} ${inr(v)}`;
const n2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function Ic({ d, size = 21, stroke = "var(--accent)" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

/* ── The drawer ──────────────────────────────────────────────────────────── */
export function AdminDrawer({ onClose, onPick, onDash, onSignOut }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const Item = ({ id, icon, label, hint }) => (
    <button className="dk-drawer-item" onClick={() => onPick(id)}>
      <Ic d={icon} />
      <span>{label}{hint && <span className="sub"> — {hint}</span>}</span>
    </button>
  );

  return (
    <div className="dk-drawer-veil">
      <div className="scrim" onClick={onClose} />
      <div className="dk-drawer dk-s" role="dialog" aria-modal="true" aria-label="Till administrator">
        <div className="dk-drawer-head">
          <h2>Till — Administrator</h2>
          <button className="dk-mx" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="dk-drawer-cap">Drawer &amp; payments</div>
        <Item id="cash" label="Cash in / out"
              icon="M3 6h18v12H3z|M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5|M6 10v.01|M18 14v.01" />
        <Item id="credit" label="Credit payments" hint="collect debts"
              icon="M6 3h8l4 4v14H6z|M14 3v5h4|M9 13h6|M9 17h4" />
        <Item id="find" label="Find receipt" hint="scan barcode"
              icon="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14|M20 20l-3.5-3.5" />
        <Item id="prev" label="Previous sales" hint="view & reprint"
              icon="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 7v5l3.5 2" />

        <div className="dk-drawer-cap">Reports</div>
        <Item id="x" label="X report" hint="today so far"
              icon="M5 19V9|M10 19V5|M15 19v-7|M20 19v-4" />
        <Item id="endday" label="End of day"
              icon="M14 4h5v16h-5|M4 12h11|M11 8l4 4-4 4" />

        <div className="dk-drawer-cap">User</div>
        <button className="dk-drawer-item" onClick={onDash}>
          <Ic d="M4 11l8-6.5 8 6.5|M6 10v10h12V10" /><span>Back to dashboard</span>
        </button>
        {/* Sign out ends the session — kept off the navigation list above with its
            own power icon and a destructive tone so it is not read as a peer of
            "Back to dashboard". */}
        <button className="dk-drawer-item" onClick={onSignOut}
                style={{ borderTop: "1px solid var(--line)", marginTop: 6, color: "var(--danger)" }}>
          <Ic d="M12 4v8|M7.8 6.6a7.5 7.5 0 1 0 8.4 0" stroke="var(--danger)" /><span>Sign out</span>
        </button>

        <div className="dk-drawer-foot">
          <span className="dk-n">{new Date().toLocaleDateString()}</span>
          <span>Genius POS</span>
        </div>
      </div>
    </div>
  );
}

/* ── Shared modal shell ──────────────────────────────────────────────────── */
function TillModal({ title, sub, width, onClose, children, foot, note }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="dk-mveil">
      <div className="scrim" onClick={onClose} />
      <div className={`dk-modal dk-s ${width || ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dk-mhead">
          <div>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="dk-mx" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {/* Only the middle scrolls. The head and foot used to be `position:
            sticky` inside a dialog that scrolled as a whole, which meant a
            field could come to rest half under the title bar or half under the
            Save row — the same fault the Settings header was reported for, and
            unrecoverable in the same way, because a pinned bar travels with
            the scroll. Making this the scrollport puts the bars outside it. */}
        <div className="dk-mscroll">
          {children}
          {note && <div className="dk-mnote">{note}</div>}
        </div>
        {foot && <div className="dk-mfoot">{foot}</div>}
      </div>
    </div>
  );
}

/* ── Cash in / out ────────────────────────────────────────────────────────
   Reasons come from the server, so a movement cannot be filed under
   something the books do not recognise. */
export function CashDlg({ expected, onClose, onDone }) {
  const [dir, setDir] = useState("in");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [reasons, setReasons] = useState({ in: [], out: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get("/pos/cash-reasons").then(setReasons).catch(() => {}); }, []);
  useEffect(() => { setReason(""); }, [dir]);

  const amt = Number(amount) || 0;
  const after = expected == null ? null : n2(expected + (dir === "in" ? amt : -amt));

  const save = async () => {
    setBusy(true);
    try {
      const mv = await api.post("/pos/cash-movement", { direction: dir, amount: amt, reason, note: note || null });
      toast(`${dir === "in" ? "Cash in" : "Cash out"} — ${money(amt)} recorded`);
      onDone();
      /* A paid-out slip is the whole point of making somebody give a reason.
         The drawer is counted against the day book at close, and a movement
         with no paper behind it is the one that cannot be explained. */
      offerVoucherPrint({
        noun: "slip", title: dir === "in" ? "Cash in slip" : "Cash out slip",
        number: (mv && (mv.reference || mv.movement_no)) || "",
        direction: dir === "in" ? "Put in by" : "Taken out by",
        party: reason, amount: amt,
        rows: [["Date", new Date().toISOString().slice(0, 10)], ["Reason", reason]],
        note: note || null,
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <TillModal title="Cash in / out" sub="Every drawer movement needs a reason and lands in the day book"
               width="w560" onClose={onClose}
               foot={<>
                 <button className="dk-mbtn" onClick={onClose}>Cancel</button>
                 <button className="dk-mbtn go" disabled={busy || !(amt > 0) || !reason} onClick={save}>
                   {busy ? "Recording…" : "Record movement"}
                 </button>
               </>}>
      <div className="dk-mbody">
        <div className="dk-inout">
          <button className={`in ${dir === "in" ? "on" : ""}`} onClick={() => setDir("in")}>Cash in</button>
          <button className={`out ${dir === "out" ? "on" : ""}`} onClick={() => setDir("out")}>Cash out</button>
        </div>

        <label className="dk-field">
          <span>Amount</span>
          <input className="dk-input dk-n" inputMode="decimal" placeholder="300,000" value={amount}
                 onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} autoFocus />
        </label>

        <label className="dk-field">
          <span>Reason</span>
          <select className="dk-input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason…</option>
            {(reasons[dir] || []).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>

        <label className="dk-field">
          <span>Note</span>
          <input className="dk-input" placeholder="Optional detail for the day book"
                 value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {after != null && (
          <div className="dk-after">
            <span>Drawer after this</span>
            <b className="dk-n" style={{ color: after < 0 ? "var(--danger)" : undefined }}>{money(after)}</b>
          </div>
        )}
      </div>
    </TillModal>
  );
}

/* ── X report ─────────────────────────────────────────────────────────────
   Where the till stands right now. Nothing is closed and nothing is written;
   it is the figure to hand over on at a shift change. */
export function XReportDlg({ onClose }) {
  const [d, setD] = useState(null);
  const [moves, setMoves] = useState([]);

  useEffect(() => {
    api.get("/pos/day-close/preview").then(setD).catch(() => setD(false));
    api.get("/pos/cash-movements").then(setMoves).catch(() => {});
  }, []);

  const rows = (d && d.rows) || [];
  const taken = rows.filter((r) => !/credit \(unpaid\)/i.test(r.mode)).reduce((a, r) => a + (+r.total || 0), 0);
  const bills = rows.reduce((a, r) => a + (+r.bills || 0), 0);
  const cashIn = moves.filter((m) => m.direction === "in").reduce((a, m) => a + (+m.amount || 0), 0);
  const cashOut = moves.filter((m) => m.direction === "out").reduce((a, m) => a + (+m.amount || 0), 0);

  const print = () => {
    const body = rows.map((r) => `<tr><td>${r.mode}</td><td style="text-align:right">${r.bills}</td>
      <td style="text-align:right">${inr(r.total)}</td></tr>`).join("");
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>X report</title><style>
      body{font-family:'Inter','Segoe UI',sans-serif;margin:28px}h2{margin:0 0 4px}
      .s{color:#666;font-size:12px;margin-bottom:14px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{padding:7px 10px;border-bottom:1px solid #ddd;text-align:left}
      th{background:#F1F3F7;text-transform:uppercase;font-size:11px}
      tfoot td{font-weight:700}</style></head><body>
      <h2>X report — till so far</h2>
      <div class="s">${new Date().toLocaleString()} · nothing has been closed</div>
      <table><thead><tr><th>Tender</th><th style="text-align:right">Bills</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Takings so far</td><td style="text-align:right">${bills}</td><td style="text-align:right">${inr(taken)}</td></tr></tfoot></table></body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  return (
    <TillModal title="X report" sub="Where the till stands right now — nothing is closed"
               width="w600" onClose={onClose}
               note={d === false ? null : "Print this for a mid-shift handover without closing the day."}
               foot={<>
                 <button className="dk-mbtn" onClick={onClose}>Close</button>
                 <button className="dk-mbtn go" disabled={!d} onClick={print}>Print X report</button>
               </>}>
      {d === null ? <div className="dk-empty">Reading the till…</div>
        : d === false ? <div className="dk-empty">Could not read the till just now.</div> : (
        <div className="dk-scrollx">
        <table className="dk-table">
          <thead>
            <tr><th>Tender</th><th className="r">Bills</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="strong" style={{ textTransform: "capitalize" }}>{r.mode}</td>
                <td className="r dk-n">{r.bills}</td>
                <td className="r dk-n">{inr(r.total)}</td>
              </tr>
            ))}
            {d.totals.refunds > 0 && (
              <tr>
                <td className="strong">Refunds</td>
                <td className="r dk-n">{d.totals.refunds}</td>
                <td className="r dk-n" style={{ color: "var(--danger)" }}>({inr(d.totals.refund_total)})</td>
              </tr>
            )}
            {cashIn > 0 && <tr><td className="strong">Cash in by hand</td><td className="r dk-n">{moves.filter((m) => m.direction === "in").length}</td><td className="r dk-n">{inr(cashIn)}</td></tr>}
            {cashOut > 0 && <tr><td className="strong">Cash out by hand</td><td className="r dk-n">{moves.filter((m) => m.direction === "out").length}</td><td className="r dk-n" style={{ color: "var(--danger)" }}>({inr(cashOut)})</td></tr>}
            <tr style={{ background: "var(--sunk)" }}>
              <td className="strong">Takings so far</td>
              <td className="r dk-n strong">{bills}</td>
              <td className="r dk-n strong">{inr(taken)}</td>
            </tr>
          </tbody>
        </table>
        </div>
      )}
    </TillModal>
  );
}

/* ── End of day ───────────────────────────────────────────────────────────
   Count the drawer, then close the shift. The count is entered by
   denomination because that is how cash is actually counted, and a total
   typed straight in is a total nobody checked. */
const DENOMS = [50000, 20000, 10000, 5000, 2000, 1000, 500];

export function EndDayDlg({ onClose, onClosed }) {
  const [shift, setShift] = useState(null);
  const [counts, setCounts] = useState({});
  const [coins, setCoins] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/shifts/preview").then(setShift).catch(() => setShift(false));
  }, []);

  const counted = useMemo(() => {
    const notes = DENOMS.reduce((a, d) => a + d * (Number(counts[d]) || 0), 0);
    return n2(notes + (Number(coins) || 0));
  }, [counts, coins]);

  const expected = shift ? Number(shift.expected_cash) || 0 : 0;
  const diff = n2(counted - expected);
  const state = Math.abs(diff) < 0.005 ? "exact" : diff < 0 ? "short" : "over";
  const needsWhy = state !== "exact";

  const close = async () => {
    if (!(await confirmDialog({
      title: "Close the shift?",
      message: state === "exact"
        ? `The drawer counts exactly to ${money(counted)}.`
        : `The drawer is ${state} by ${money(Math.abs(diff))}.`,
      detail: "The shift is closed and the Z report is written. Sales carry on under a new shift.",
      danger: state !== "exact", confirmLabel: "Close shift",
    }))) return;

    setBusy(true);
    try {
      await api.post("/shifts/close", { counted_cash: counted, close_note: why || null });
      await api.post("/pos/day-close", { scope: "close_register" });
      toast("Shift closed");
      onClosed();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  if (shift === false) {
    return (
      <TillModal title="End of day" sub="Count the drawer, then close the shift" width="w600" onClose={onClose}
                 foot={<button className="dk-mbtn" onClick={onClose}>Close</button>}>
        <div className="dk-mbody">
          <div className="dk-empty">
            There is no open shift on this till, so there is nothing to close.
            Start one from Shifts before selling if you want the drawer counted.
          </div>
        </div>
      </TillModal>
    );
  }

  return (
    <TillModal title="End of day" sub="Count the drawer, then close the shift" width="w600" onClose={onClose}
               foot={<>
                 <span className="spread">{shift ? `Open since ${String(shift.opened_at).slice(11, 16)}` : ""}</span>
                 <button className="dk-mbtn" onClick={onClose}>Keep till open</button>
                 <button className="dk-mbtn danger" disabled={busy || !shift || (needsWhy && !why.trim())} onClick={close}>
                   {busy ? "Closing…" : "Close shift & print Z"}
                 </button>
               </>}>
      <div className="dk-mbody">
        <div className="dk-twoup">
          <div className="dk-figbox">
            <div className="l">Expected in drawer</div>
            <div className="v dk-n">{shift ? money(expected) : "…"}</div>
          </div>
          <div className="dk-figbox">
            <div className="l">Counted</div>
            <div className="v dk-n">{money(counted)}</div>
          </div>
        </div>

        <div>
          <div className="l" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 10 }}>
            Count by denomination
          </div>
          {/* eod-denom, not dk-denom: the old grid stacked the label above a
              bare <input>, and a bare input's intrinsic width is ~227px, which
              a `1fr` column cannot shrink below. Four of those came to 938px
              inside a 598px dialog, and .dk-modal clips horizontally — so
              5,000 down to Coins were drawn off the right edge where nobody
              could count them, and the labels that were visible had drifted
              away from their boxes. A cashier who cannot enter the notes she is
              holding either closes the shift short or does not close it at all.
              Label and input now sit on one line inside one box, so no layout
              accident can ever separate them again. */}
          <div className="eod-denoms">
            {DENOMS.map((d) => (
              <label className="eod-denom" key={d}>
                <span className="dk-n">{d.toLocaleString()} ×</span>
                <input className="dk-n" inputMode="numeric" aria-label={`${d.toLocaleString()} notes`}
                       value={counts[d] ?? ""}
                       onChange={(e) => setCounts({ ...counts, [d]: e.target.value.replace(/[^\d]/g, "") })} />
              </label>
            ))}
            <label className="eod-denom">
              <span>Coins</span>
              <input className="dk-n" inputMode="decimal" aria-label="Coins"
                     value={coins}
                     onChange={(e) => setCoins(e.target.value.replace(/[^\d.]/g, ""))} />
            </label>
          </div>
        </div>

        <div className={`dk-variance ${state}`}>
          <span className="l" style={{ color: state === "short" ? "var(--danger)" : state === "over" ? "var(--warnc)" : "var(--good)" }}>
            {state === "exact" ? "Counts exactly" : state === "short" ? "Short by" : "Over by"}
          </span>
          <b className="dk-n" style={{ color: state === "short" ? "var(--danger)" : state === "over" ? "var(--warnc)" : "var(--good)" }}>
            {state === "exact" ? "—" : money(Math.abs(diff))}
          </b>
        </div>

        {needsWhy && (
          <label className="dk-field">
            <span>Explain the difference</span>
            <input className="dk-input" placeholder="Required before the shift can close"
                   value={why} onChange={(e) => setWhy(e.target.value)} />
          </label>
        )}
      </div>
    </TillModal>
  );
}

/* ── Credit payments ─────────────────────────────────────────────────────── */
export function CreditDlg({ onClose, onTaken }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [amounts, setAmounts] = useState({});
  const [mode, setMode] = useState("cash");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.get("/pos/credit-customers").then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows.filter((r) => !t || `${r.name} ${r.phone || ""}`.toLowerCase().includes(t));
  }, [rows, q]);

  const take = async (r) => {
    const amt = Number(amounts[r.id]) || 0;
    if (!(amt > 0)) return toast("Type what they are paying", "bad");
    if (amt > r.owes + 0.005) return toast(`That is more than the ${money(r.owes)} owed`, "bad");
    setBusy(true);
    try {
      const p = await api.post("/payments", {
        direction: "in", party_id: r.id, amount: amt,
        mode, reference: ref || null,
        payment_date: new Date().toISOString().slice(0, 10),
        status: "confirmed",
      });
      toast(`${p.payment_no || "Payment"} — ${money(amt)} from ${r.name}`);
      setAmounts({ ...amounts, [r.id]: "" });
      setRef("");
      load();
      onTaken();
      /* Debt collected at the counter. The customer's copy is the only proof
         they have that the balance came down. */
      offerVoucherPrint({
        noun: "receipt", title: "Receipt", number: p.payment_no,
        direction: "Received from", party: r.name, amount: amt,
        rows: [["Date", new Date().toISOString().slice(0, 10)], ["Method", mode],
               ["Reference", ref || ""], ["Balance now", money(Math.max(0, r.owes - amt))]],
      });
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  return (
    <TillModal title="Credit payments" sub="Take money against an outstanding balance"
               width="w820" onClose={onClose}
               foot={<button className="dk-mbtn" onClick={onClose}>Done</button>}>
      <div className="dk-msearch">
        <input className="dk-input" placeholder="Search customer…" value={q}
               onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>

      <div className="dk-scrollx">
      <table className="dk-table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Customer</th><th>Oldest invoice</th>
            <th className="r">Owes</th><th className="r">Paying now</th><th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {shown === null ? <tr><td colSpan={5}><div className="dk-empty">Loading…</div></td></tr>
            : shown.length === 0 ? <tr><td colSpan={5}><div className="dk-empty">
                {q ? "Nobody matches that." : "Nobody owes anything — the book is clear."}
              </div></td></tr>
            : shown.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.name}</td>
                <td className="tight dk-n dim">
                  {r.oldest_ref ? `${r.oldest_ref} · ${r.oldest_days}\u2009d` : "—"}
                </td>
                <td className="r dk-n strong">{inr(r.owes)}</td>
                <td className="r">
                  <input className="dk-takeinput dk-n" inputMode="decimal" placeholder="—"
                         value={amounts[r.id] ?? ""}
                         onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value.replace(/[^\d.]/g, "") })} />
                </td>
                <td className="r">
                  <button className="dk-minibtn" disabled={busy || !(Number(amounts[r.id]) > 0)} onClick={() => take(r)}>Take</button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>

      <div className="dk-mbody" style={{ paddingTop: 18 }}>
        <div className="dk-twoup">
          <label className="dk-field">
            <span>Received by</span>
            <select className="dk-input" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="cash">Cash into drawer</option>
              <option value="mobile">Mobile money</option>
              <option value="bank">Bank transfer</option>
              <option value="cheque">Cheque</option>
            </select>
          </label>
          <label className="dk-field">
            <span>Reference</span>
            <input className="dk-input" placeholder="MoMo code or slip number"
                   value={ref} onChange={(e) => setRef(e.target.value)} />
          </label>
        </div>
      </div>
    </TillModal>
  );
}

/* ── Previous sales ──────────────────────────────────────────────────────── */
export function PrevSalesDlg({ onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [q, setQ] = useState("");

  const load = () => api.get("/pos/today-sales").then(setD).catch(() => setD({ rows: [], totals: { bills: 0, taken: 0 } }));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!d) return null;
    const t = q.toLowerCase().trim();
    return d.rows.filter((r) => !t || `${r.invoice_no} ${r.party_name} ${r.grand_total}`.toLowerCase().includes(t));
  }, [d, q]);

  const reprint = async (r) => {
    try { const full = await api.get(`/sales/${r.id}`); printInvoice(full, r.party_name, "pos"); }
    catch (e) { toast(e.message, "bad"); }
  };

  const voidSale = async (r) => {
    if (!(await confirmDialog({
      title: `Void ${r.invoice_no}?`,
      message: `This reverses a sale of ${money(r.grand_total)} to ${r.party_name}.`,
      detail: `Stock goes back on the shelf and it appears as voided on today's Z report.${r.paid_amount > 0 ? `\n${money(r.paid_amount)} already taken will be reversed out of the till.` : ""}`,
      danger: true, confirmLabel: "Void this sale",
    }))) return;
    try { await api.delete(`/sales/${r.id}`); toast(`${r.invoice_no} voided`); load(); onChanged(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const tone = (r) => r.status === "voided" ? ""
    : r.balance_due > 0.005 ? (r.paid_amount > 0 ? "warn" : "bad")
    : "good";
  const label = (r) => r.status === "voided" ? "voided"
    : r.balance_due > 0.005 ? (r.paid_amount > 0 ? "partial" : "credit")
    : (r.payment_type || "paid");

  return (
    <TillModal title="Previous sales" sub="Everything rung through this till today, newest first"
               width="w820" onClose={onClose}
               note={d ? `${d.totals.bills} bill${d.totals.bills === 1 ? "" : "s"} today · ${money(d.totals.taken)} taken. Voiding a settled bill writes an audit entry.` : null}
               foot={<button className="dk-mbtn" onClick={onClose}>Close</button>}>
      <div className="dk-msearch">
        <input className="dk-input" placeholder="Search invoice, customer or amount…"
               value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>

      <div className="dk-scrollx">
      <table className="dk-table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Invoice</th><th>Time</th><th>Customer</th><th>Tender</th>
            <th className="r">Amount</th><th style={{ width: 150 }} />
          </tr>
        </thead>
        <tbody>
          {shown === null ? <tr><td colSpan={6}><div className="dk-empty">Loading…</div></td></tr>
            : shown.length === 0 ? <tr><td colSpan={6}><div className="dk-empty">
                {q ? "Nothing matches that." : "Nothing has been sold yet today."}
              </div></td></tr>
            : shown.map((r) => (
              <tr key={r.id} className={r.status === "voided" ? "void" : ""}>
                <td className="dk-n strong">{r.invoice_no}</td>
                <td className="tight dk-n dim">{String(r.created_at || "").slice(11, 16) || "—"}</td>
                <td className="tight">{r.party_name}</td>
                <td className="tight"><span className={`dk-tpill ${tone(r)}`}>{label(r)}</span></td>
                <td className={`r dk-n ${r.status === "voided" ? "amt-void" : "strong"}`}>{inr(r.grand_total)}</td>
                <td className="r" style={{ whiteSpace: "nowrap" }}>
                  <button className="dk-minibtn ghost" onClick={() => reprint(r)}>Reprint</button>
                  {r.status !== "voided" && can("sales", "delete") && (
                    <button className="dk-minibtn ghost" style={{ marginLeft: 6, color: "var(--danger)" }}
                            onClick={() => voidSale(r)}>Void</button>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>
    </TillModal>
  );
}

/* ── Find a receipt ───────────────────────────────────────────────────────
   A scanner types the number and presses Enter, so the input is simply
   focused and waiting — no separate scan mode to remember. */
export function FindReceiptDlg({ onClose }) {
  const [no, setNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);

  const look = async () => {
    const ref = no.trim();
    if (!ref) return;
    setBusy(true);
    try {
      const doc = await api.get(`/sales/by-number/${encodeURIComponent(ref)}`);
      setFound(doc);
    } catch (e) { toast(e.message, "bad"); setFound(null); }
    setBusy(false);
  };

  return (
    <TillModal title="Find a receipt" sub="Scan the barcode at the foot of the slip"
               width="w560" onClose={onClose}
               foot={<>
                 <button className="dk-mbtn" onClick={onClose}>Cancel</button>
                 {found
                   ? <button className="dk-mbtn go" onClick={() => printInvoice(found, found.party_name || "Cash Sale", "pos")}>Reprint receipt</button>
                   : <button className="dk-mbtn go" disabled={busy || !no.trim()} onClick={look}>{busy ? "Looking…" : "Open receipt"}</button>}
               </>}>
      <div className="dk-mbody">
        {found ? (
          <div className="dk-figbox">
            <div className="l">{found.invoice_no}</div>
            <div className="v dk-n">{money(found.grand_total)}</div>
            <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 6 }}>
              {found.party_name || "Cash Sale"} · {found.invoice_date}
              {found.balance_due > 0.005 ? ` · ${money(found.balance_due)} still owing` : " · settled"}
            </div>
          </div>
        ) : (
          <div className="dk-scanbox">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M3 5v14" /><path d="M7 5v14" /><path d="M10 5v14" /><path d="M13 5v9" />
              <path d="M13 17v2" /><path d="M16 5v14" /><path d="M20 5v14" />
            </svg>
            <div className="t">Waiting for a scan…</div>
            <div className="s">Point the scanner at the receipt, or type the invoice number below.</div>
          </div>
        )}

        <input className="dk-input dk-n" placeholder="INV-000147" value={no} autoFocus
               onChange={(e) => { setNo(e.target.value); setFound(null); }}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); look(); } }} />
      </div>
    </TillModal>
  );
}
