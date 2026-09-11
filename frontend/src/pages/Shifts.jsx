import React, { useEffect, useState } from "react";
import api, { currentUser } from "../lib/api.js";
import { inr, cur as curSym, fmtDateTime } from "../lib/tax.js";
import { Empty, SkeletonRows, toast, Field, confirmDialog } from "../lib/ui.jsx";
import { useRead, LoadFailed } from "../lib/deckui.jsx";
import { can } from "../lib/api.js";

/**
 * Shifts.jsx — a cashier's till session.
 *
 * Top card is the live shift (open one, or close the current one after counting
 * the drawer). Below is the history, with the variance and how long each shift
 * ran. "Expected cash" is computed by the server the same way the Z report is,
 * so the two never disagree.
 */
export default function Shifts() {
  const [current, setCurrent] = useState(undefined);   // undefined=loading, null=none
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState(null);
  const [openFloat, setOpenFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [moves, setMoves] = useState([]);       // this shift's drawer movements
  const [othersOpen, setOthersOpen] = useState([]);
  const [drawer, setDrawer] = useState(false);  // the denomination counter
  const [cashOpen, setCashOpen] = useState(null); // "in" | "out" | null
  const me = currentUser();

  /* Three reads, three ways this screen used to lie: a failed /shifts/current
     drew "Start a shift" over a shift that was already open, a failed
     /shifts/preview drew "Expected in drawer Sh 0", and a failed /shifts
     drew "No shifts yet". */
  const [curFailed, , setCurFailed] = useRead();
  const [prevFailed, , setPrevFailed] = useRead();
  const [histFailed, readHist] = useRead();

  const load = async () => {
    try {
      const cur = await api.get("/shifts/current");
      setCurFailed(false);
      setCurrent(cur || null);
      if (cur) {
        try { setPreview(await api.get("/shifts/preview")); setPrevFailed(false); }
        catch { setPreview(null); setPrevFailed(true); }
      } else { setPreview(null); setPrevFailed(false); }
    } catch { setCurFailed(true); setCurrent(undefined); }
    readHist(api.get("/shifts"), (d) => setHistory(d ? d.rows || [] : null), null);
    /* Who else is standing at a till right now. A cashier who went home
       without closing used to leave a shift nobody could find.
       
       Gated on users.edit, not reports.view: reading the list needs the
       reports permission, but the only thing anybody does with it is close
       one, and THAT needs users.edit (shifts.routes.js). Showing the list to
       somebody the close route will refuse means asking them to count a
       drawer and then telling them they may not. */
    if (can("reports", "view") && can("users", "edit")) {
      api.get("/shifts/open")
        .then((d) => setOthersOpen((d.rows || []).filter((x) => x.user_id !== (me && me.id))))
        .catch(() => setOthersOpen([]));
    }
  };

  /* What went in and out of this drawer. A variance with no movements behind
     it is a number somebody has to take on faith. */
  const loadMoves = (shiftId) => {
    if (!shiftId) return setMoves([]);
    api.get(`/shifts/${shiftId}/movements`).then((d) => setMoves(d.rows || [])).catch(() => setMoves([]));
  };
  useEffect(() => { loadMoves(current && current.id); }, [current && current.id]);
  useEffect(() => { load(); }, []);

  const openShift = async () => {
    setBusy(true);
    try {
      await api.post("/shifts/open", { opening_float: Number(openFloat) || 0, open_note: note || undefined });
      setOpenFloat(""); setNote("");
      await load();
    } catch (e) { toast(e.message, "bad"); } finally { setBusy(false); }
  };

  const closeShift = async () => {
    if (counted === "") return toast("Count the cash in the drawer first", "bad");
    setBusy(true);
    try {
      const done = await api.post("/shifts/close", { counted_cash: Number(counted), close_note: note || undefined });
      const v = Number(done.variance) || 0;
      toast(v === 0 ? "Shift closed — drawer balances exactly"
        : `Shift closed — ${v > 0 ? "over" : "short"} by ${curSym()} ${inr(Math.abs(v))}`, v === 0 ? "ok" : "warn");
      setCounted(""); setNote("");
      await load();
    } catch (e) { toast(e.message, "bad"); } finally { setBusy(false); }
  };

  /* Closing somebody else's shift. Deliberately asks for the counted cash: a
     manager closing a cashier's till has to have counted it, and a close with
     no count records a variance of "unknown" that nobody can chase later. */
  const closeSomeoneElses = async (sh) => {
    const typed = window.prompt(
      `Count ${sh.user_name}'s drawer. Expected: ${curSym()} ${inr(sh.expected_cash)}.\n\n` +
      "How much cash is actually in it?");
    if (typed === null) return;
    const countedCash = Number(String(typed).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(countedCash)) return toast("That is not an amount", "bad");
    if (!(await confirmDialog({
      title: `Close ${sh.user_name}'s shift?`,
      message: `Counted ${curSym()} ${inr(countedCash)} against ${curSym()} ${inr(sh.expected_cash)} expected.`,
      detail: "The shift is closed against your name, and the variance is recorded.",
      confirmLabel: "Close shift",
    }))) return;
    try {
      await api.post("/shifts/close", { shift_id: sh.id, counted_cash: countedCash,
        close_note: `Closed by ${me && (me.full_name || me.username)}` });
      toast(`${sh.user_name}'s shift closed`);
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  const money = (v) => `${curSym()} ${inr(Number(v) || 0)}`;
  const dur = (m) => (m == null ? "—" : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`);

  /* How long the open shift has been running. A till session is a day's work;
     one left open for days quietly turns "cash sales so far" into a figure
     nobody can reconcile against a drawer, and the dashboard's "sales today"
     into something that looks like it disagrees with it. */
  const openedAt = current && current.opened_at ? new Date(current.opened_at.replace(" ", "T")) : null;
  const openHours = openedAt && !Number.isNaN(openedAt.getTime())
    ? Math.floor((Date.now() - openedAt.getTime()) / 3600000) : null;
  const openDays = openHours == null ? null : Math.floor(openHours / 24);
  const stale = openHours != null && openHours >= 24;
  const sinceLabel = openedAt && !Number.isNaN(openedAt.getTime())
    ? fmtDateTime(current.opened_at.replace(" ", "T")) : "—";

  /* The tenders this shift took, cash first — it is the only one the drawer
     ever sees, and the rest exist to explain why the drawer is smaller than
     the day felt. */
  const TENDER_LABEL = { cash: "Cash", mobile: "Mobile money", card: "Card", bank: "Bank transfer", cheque: "Cheque" };
  const tenders = (preview && preview.tenders) || [];
  const nonCash = tenders.filter((t) => t.mode !== "cash").reduce((a, t) => a + t.amount, 0);

  return (
    <div className="dk-page shifts">
      {curFailed ? (
        <div className="dk-card"><LoadFailed what="your till session" onRetry={load} /></div>
      ) : current === undefined ? (
        <div className="dk-card"><div className="dk-empty">Reading your till session…</div></div>
      ) : current ? (
        <>
        {stale && (
          <div className="sh-stale">
            <b>This shift has been open {openDays === 1 ? "since yesterday" : `for ${openDays} days`}.</b>
            <span>
              Every figure below covers the whole time since {sinceLabel} — not today. Close it and
              start a new one so the drawer is counted against a day's trading.
            </span>
          </div>
        )}

        {/* ── The shift, at the top, as one thing ───────────────────────────
            Was a strip of four figures, then a card headed "Your shift is
            open", then the close form inside it — three containers deep for
            one question: how much should be in this drawer, and does it
            match? The count now sits beside the figure it is counted against,
            so the two are read together instead of a screen apart. */}
        <div className="sh-live">
          <section className="dk-card sh-expected">
            <div className="sh-openhead">
              <span className="dot" aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <div className="t">Your shift is open</div>
                <div className="s">
                  since {sinceLabel}
                  {openHours != null ? ` · ${openHours < 24 ? `${openHours}h` : dur(openHours * 60)} ago` : ""}
                </div>
              </div>
            </div>

            <div className="sh-big">
              <div className="l">Expected in the drawer</div>
              <div className="v dk-n">{prevFailed || !preview ? "—" : money(preview.expected_cash)}</div>
              <div className="s">
                {prevFailed ? "the shift figures did not load" : "float, plus cash taken, less cash paid out"}
              </div>
            </div>

            {/* The arithmetic behind the figure, spelled out. A number a
                cashier is asked to match a drawer against, with no working
                shown, is a number they cannot argue with when it is wrong. */}
            <dl className="sh-work">
              <div><dt>Opening float</dt><dd className="dk-n">{money(current.opening_float)}</dd></div>
              <div><dt>Cash taken this shift</dt>
                <dd className="dk-n amt-received">{preview ? `+ ${money(preview.cash_collected)}` : "—"}</dd></div>
              <div><dt>Cash paid out</dt>
                <dd className="dk-n amt-reversal">{preview ? `− ${money(preview.cash_paid_out)}` : "—"}</dd></div>
            </dl>
          </section>

          <section className="dk-card sh-count">
            <div className="dk-card-head"><h3>Count the drawer</h3></div>
            <div className="sh-countbody">
              {prevFailed && <LoadFailed what="what should be in the drawer" onRetry={load} compact />}
              <Field label="Cash actually in the drawer">
                <input className="dk-input dk-n" type="number" inputMode="decimal" value={counted}
                       onChange={(e) => setCounted(e.target.value)} placeholder="e.g. 24000" />
              </Field>
              <button className="dk-sbtn" style={{ alignSelf: "flex-start" }}
                      onClick={() => setDrawer((dd) => !dd)}>
                {drawer ? "Hide the note count" : "Count it note by note"}
              </button>
              {drawer && <DrawerCount onTotal={(t) => setCounted(String(t))} />}
              {counted !== "" && preview && (
                <div className={`shift-var ${Number(counted) - preview.expected_cash === 0 ? "ok" : "off"}`}>
                  {(() => { const v = Number(counted) - preview.expected_cash;
                    return v === 0 ? "Balances exactly" : `${v > 0 ? "Over" : "Short"} by ${money(Math.abs(v))}`; })()}
                </div>
              )}
              <Field label="Note (optional)">
                <input className="dk-input" value={note} onChange={(e) => setNote(e.target.value)}
                       placeholder="Anything worth recording" />
              </Field>
              <button className="dk-sbtn primary" style={{ height: 42 }} disabled={busy} onClick={closeShift}>
                {busy ? "Closing…" : "Close shift"}
              </button>
            </div>
          </section>
        </div>

        {/* ── What the shift actually did ───────────────────────────────────
            None of this was on the screen. A drawer that balances says
            nothing about whether the shift went well, and a cashier who took
            nine bills — four of them on mobile money — had no way to see it
            here. Every figure comes from rows the app already writes. */}
        <div className="dk-strip four">
          <div>
            <div className="l">Bills rung up</div>
            <div className="v dk-n">{preview ? preview.bills : "—"}</div>
            <div className="s">
              {preview && preview.average_bill != null
                ? `${money(preview.average_bill)} average`
                : "nothing sold yet this shift"}
            </div>
          </div>
          <div>
            <div className="l">Sold this shift</div>
            <div className="v dk-n">{preview ? money(preview.sales_total) : "—"}</div>
            <div className="s">before anything was paid</div>
          </div>
          <div>
            <div className="l">Taken other than cash</div>
            <div className="v dk-n">{preview ? money(nonCash) : "—"}</div>
            <div className="s">mobile money, card, bank — never in the drawer</div>
          </div>
          <div>
            <div className="l">Left on account</div>
            <div className="v dk-n amt-owed">{preview ? money(preview.on_account) : "—"}</div>
            <div className="s">sold but not paid for</div>
          </div>
        </div>

        <div className="sh-two">
          {/* How the money came in. The drawer only ever holds one row of
              this, which is the point of showing all of them. */}
          <section className="dk-card">
            <div className="dk-card-head"><h3>How it was paid</h3></div>
            {tenders.length === 0 ? (
              <div className="dk-empty">No money taken yet this shift.</div>
            ) : (
              <div className="sh-tenders">
                {tenders.map((t) => (
                  <div className={`row ${t.mode === "cash" ? "is-cash" : ""}`} key={t.mode}>
                    <span className="nm">
                      {TENDER_LABEL[t.mode] || t.mode}
                      {t.mode === "cash" && <em>in the drawer</em>}
                    </span>
                    <span className="n dk-n">{t.n} {t.n === 1 ? "payment" : "payments"}</span>
                    <b className="v dk-n">{money(t.amount)}</b>
                  </div>
                ))}
              </div>
            )}
            {preview && preview.discounts > 0 && (
              <div className="sh-foot">
                <span>Discount given this shift</span>
                <b className="dk-n amt-reversal">−{inr(preview.discounts)}</b>
              </div>
            )}
            {preview && preview.voided_n > 0 && (
              <div className="sh-foot warn">
                <span>{preview.voided_n} {preview.voided_n === 1 ? "sale was" : "sales were"} voided in this shift</span>
                <b className="dk-n">{money(preview.voided_total)}</b>
              </div>
            )}
          </section>

          {/* ── The drawer itself ────────────────────────────────────────
              Money that is not a sale: a boda paid, a float topped up, a run
              to the bank. Every one of these moves the expected figure, so a
              shift with no way to record them ends every day "short" by
              exactly the amount somebody spent legitimately. */}
          <section className="dk-card">
            <div className="dk-card-head">
              <h3>Drawer movements</h3>
              <button className="dk-sbtn" onClick={() => setCashOpen("in")}>Cash in</button>
              <button className="dk-sbtn" onClick={() => setCashOpen("out")}>Cash out</button>
            </div>
            {moves.length === 0 ? (
              <Empty title="Nothing in or out yet"
                     hint="Anything that is not a sale — a payout, a top-up, a bank run — belongs here so the drawer still balances." />
            ) : (
              <div className="dk-tablewrap dk-s">
                <table className="tw">
                  <thead><tr><th>When</th><th>Reason</th><th className="r">Amount</th><th>Note</th></tr></thead>
                  <tbody>
                    {moves.map((m) => (
                      <tr key={m.id}>
                        <td>{fmtDateTime(String(m.created_at).replace(" ", "T"))}</td>
                        <td>{m.reason}</td>
                        <td className={`r num ${m.direction === "in" ? "amt-received" : "amt-paid"}`}>
                          {m.direction === "in" ? "+" : "−"}{inr(m.amount)}
                        </td>
                        <td style={{ color: "var(--faint)" }}>{m.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        </>
      ) : (
        <section className="dk-card sh-start">
          <div className="dk-card-head"><h3>Start a shift</h3></div>
          <div className="sh-countbody">
            <p className="sh-hint">
              Open your till session with the cash you are starting with. When you close it, the app says what
              should be in the drawer and records the difference.
            </p>
            <Field label="Opening float — cash in the drawer now">
              <input className="dk-input dk-n" type="number" inputMode="decimal" value={openFloat}
                     onChange={(e) => setOpenFloat(e.target.value)} placeholder="e.g. 20000" autoFocus />
            </Field>
            <Field label="Note (optional)">
              <input className="dk-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </Field>
            <button className="dk-sbtn primary" style={{ height: 42, alignSelf: "flex-start", minWidth: 160 }}
                    disabled={busy} onClick={openShift}>
              {busy ? "Opening…" : "Start shift"}
            </button>
          </div>
        </section>
      )}

      {othersOpen.length > 0 && (
        <section className="dk-card">
          <div className="dk-card-head"><h3>Open at other tills</h3></div>
          <p className="sh-hint" style={{ padding: "12px 20px 0", margin: 0 }}>
            These shifts are still running. A shift left open overnight makes the next day's expected cash
            cover two days' trading, so somebody has to close it.
          </p>
          <div className="dk-tablewrap dk-s">
            <table className="tw">
              <thead><tr><th>Who</th><th>Since</th><th className="r">Float</th>
                <th className="r">Expected now</th><th /></tr></thead>
              <tbody>
                {othersOpen.map((sh) => (
                  <tr key={sh.id}>
                    <td>{sh.user_name}</td>
                    <td>{fmtDateTime(String(sh.opened_at).replace(" ", "T"))} · {dur(sh.minutes)}</td>
                    <td className="r num">{inr(sh.opening_float)}</td>
                    <td className="r num">{inr(sh.expected_cash)}</td>
                    <td className="r">
                      <button className="dk-sbtn" onClick={() => closeSomeoneElses(sh)}>Close shift</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="dk-card">
        <div className="dk-card-head">
          <h3>Shift history</h3>
          {history && history.length > 0 && (() => {
            /* The one figure a manager wants off this table and would
               otherwise add up by hand: is this till accurate over time? */
            const closed = history.filter((h) => h.variance != null);
            const off = closed.reduce((a, h) => a + Math.abs(Number(h.variance) || 0), 0);
            const exact = closed.filter((h) => Number(h.variance) === 0).length;
            return closed.length ? (
              <span className="sh-tally dk-n">
                {exact} of {closed.length} balanced exactly · {money(off)} out across the rest
              </span>
            ) : null;
          })()}
        </div>
        {histFailed ? (
          <LoadFailed what="the shift history" onRetry={load} />
        ) : history === null ? (
          <div className="dk-tablewrap"><table className="tw"><tbody><SkeletonRows rows={4} cols={9} /></tbody></table></div>
        ) : history.length === 0 ? (
          <Empty title="No shifts yet" hint="Your closed shifts will appear here." />
        ) : (
          <div className="dk-tablewrap dk-s">
            <table className="tw">
              <thead><tr>
                <th>User</th><th>Opened</th><th>Closed</th><th className="r">Duration</th>
                <th className="r">Float</th><th className="r">Expected</th><th className="r">Counted</th>
                <th className="r">Variance</th><th>Closed by</th>
              </tr></thead>
              <tbody>
                {history.map((sr) => (
                  <tr key={sr.id}>
                    <td>{sr.user_name}</td>
                    <td>{fmtDateTime(sr.opened_at.replace(" ", "T"))}</td>
                    <td>{sr.closed_at ? fmtDateTime(sr.closed_at.replace(" ", "T")) : <span className="shift-openpill">open</span>}</td>
                    <td className="r">{dur(sr.minutes)}</td>
                    <td className="r num">{inr(sr.opening_float)}</td>
                    <td className="r num">{sr.expected_cash != null ? inr(sr.expected_cash) : "—"}</td>
                    <td className="r num">{sr.counted_cash != null ? inr(sr.counted_cash) : "—"}</td>
                    {/* Over/short is an accuracy signal, not money in or out — a
                        drawer that is over is as wrong as one that is short. The
                        .val-* family says that without borrowing the money scale. */}
                    <td className={`r num ${sr.variance == null ? "val-flat" : sr.variance === 0 ? "val-good" : "val-loss"}`}
                        style={{ fontWeight: 650 }}>
                      {sr.variance == null ? "—" : (sr.variance > 0 ? "+" : "") + inr(sr.variance)}
                    </td>
                    <td>{sr.closed_by_name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {cashOpen && (
        <CashMovement direction={cashOpen}
                      onClose={() => setCashOpen(null)}
                      onDone={() => { setCashOpen(null); load(); loadMoves(current && current.id); }} />
      )}
    </div>
  );
}

/* ── Counting the drawer ───────────────────────────────────────────────────
 *
 * A cashier counting up has notes in piles in front of them, not a total in
 * their head. Typing "how many five-thousands" and letting the app multiply
 * is both faster and the arithmetic a tired person at the end of a shift gets
 * wrong — and a mis-added drawer is recorded for ever as a variance somebody
 * has to explain.
 */
const DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];

function DrawerCount({ onTotal }) {
  const [n, setN] = useState({});
  const total = DENOMINATIONS.reduce((a, d) => a + d * (Number(n[d]) || 0), 0);
  return (
    <div className="shift-drawer">
      <div className="shift-denoms">
        {DENOMINATIONS.map((d) => (
          <label key={d}>
            <span className="dk-n">{inr(d)}</span>
            <input type="number" min="0" inputMode="numeric" value={n[d] ?? ""}
                   placeholder="0" onChange={(e) => setN({ ...n, [d]: e.target.value })} />
            <b className="dk-n">{(Number(n[d]) || 0) ? inr(d * Number(n[d])) : "—"}</b>
          </label>
        ))}
      </div>
      <div className="shift-denoms-foot">
        <span>Counted</span>
        <b className="dk-n">{curSym()} {inr(total)}</b>
        <button className="dk-sbtn" disabled={!total} onClick={() => onTotal(total)}>
          Use this total
        </button>
      </div>
    </div>
  );
}

/* Money in or out of the drawer that is not a sale. The reasons come from the
   server rather than from a list typed here — the till screen offers the same
   ones, and two lists that could disagree would put the same payout under two
   different names in the day book. */
function CashMovement({ direction, onClose, onDone }) {
  const [reasons, setReasons] = useState({ in: [], out: [] });
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/pos/cash-reasons").then((r) => {
      setReasons(r || { in: [], out: [] });
      const first = (r && r[direction] && r[direction][0]) || "";
      setReason(first);
    }).catch(() => {});
  }, [direction]);

  const save = async () => {
    if (!(Number(amount) > 0)) return toast("Enter an amount", "bad");
    if (!reason) return toast("Choose a reason", "bad");
    setBusy(true);
    try {
      await api.post("/pos/cash-movement", { direction, amount: Number(amount), reason, note: note || undefined });
      toast(direction === "in" ? "Cash in recorded" : "Cash out recorded");
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cf-box" style={{ maxWidth: 440, textAlign: "left" }}>
        <h3>{direction === "in" ? "Cash into the drawer" : "Cash out of the drawer"}</h3>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Anything that is not a sale. It changes what the drawer should hold at close.
        </p>
        <Field label="Amount">
          <input className="dk-input dk-n" type="number" inputMode="decimal" autoFocus value={amount}
                 onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason">
          <select className="dk-input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {(reasons[direction] || []).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input className="dk-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who, or what for" />
        </Field>
        <div className="cf-actions">
          <button className="dk-sbtn" onClick={onClose}>Cancel</button>
          <button className="dk-sbtn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Record movement"}
          </button>
        </div>
      </div>
    </div>
  );
}
