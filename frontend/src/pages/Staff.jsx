/* ── Staff ─────────────────────────────────────────────────────────────────
   Who is on, what they sold, and what they are owed.

   This is the operational view, and it is reached from Reports rather than
   from the rail — it is figures about people, which is a report. Accounts,
   passwords, PINs and permissions live on the Users & roles screen (⋯ beside
   the business name) and are not repeated here: one place to decide what
   someone may do, one place to see what they did.

   Everything shown is derived from records the app already keeps: shifts
   opened and closed, and documents carrying a sales rep. Nothing is estimated.
*/
import React, { useEffect, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur } from "../lib/tax.js";
import { Modal, toast, RowMenu, DateRangePicker } from "../lib/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { LoadingRows, useRead, LoadFailed, FailedRows } from "../lib/deckui.jsx";

const money = (v) => `${cur()} ${inr(v)}`;
const hrs = (v) => `${(Number(v) || 0).toFixed(1)}h`;
const clock = (s) => (s ? String(s).slice(11, 16) : "—");

/* ── The period ───────────────────────────────────────────────────────────
   Payroll and commission are monthly, and the server takes `month=YYYY-MM`
   and nothing else. So the screen uses the one date control the rest of the
   app uses — the preset dropdown — and snaps whatever comes back to the whole
   month it starts in, rather than accepting a range the figures would quietly
   ignore. "This month" is one click; the trigger then reads the period being
   reported on. A range is mandatory here, so there is no "All dates". */
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const thisMonth = () => ym(new Date());
const monthOf = (s) => (typeof s === "string" && /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : "");
/* First and last day of a YYYY-MM, the shape the picker wants. */
function monthBounds(m) {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}` };
}

export default function Staff({ initial }) {
  /* Reports opens this screen on a named tab, so "What they are owed" in the
     reports list lands on the commission board rather than on whatever tab
     happened to be first. */
  const [tab, setTab] = useState(
    ["today", "performance", "commission"].includes(initial) ? initial : "today");
  const [range, setRange] = useState(() => monthBounds(thisMonth()));
  /* Everything below still asks the server for a month, exactly as before. */
  const month = monthOf(range.from) || thisMonth();
  const [terms, setTerms] = useState(null);

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {[["today", "On today"], ["performance", "What they sold"], ["commission", "What they are owed"]]
            .map(([id, label]) => (
              <button key={id} className={`dk-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
            ))}
        </div>
        <div className="spacer" />
        {tab !== "today" && (
          <DateRangePicker from={range.from} to={range.to} align="right" allowAll={false}
                           onChange={(r) => setRange(monthBounds(monthOf(r.from) || thisMonth()))} />
        )}
        {/* Was pointing at Settings, where accounts used to live. They are
            their own screen now. */}
        {can("users", "view") && (
          <button className="dk-sbtn" style={{ height: 40 }}
                  onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "users" } }))}>
            Accounts &amp; permissions
          </button>
        )}
      </div>

      {tab === "today" && <Today />}
      {tab === "performance" && <Performance month={month} onTerms={setTerms} />}
      {tab === "commission" && <Commission month={month} onTerms={setTerms} />}

      {terms && <TermsDialog person={terms} onClose={() => setTerms(null)}
        onSaved={() => { setTerms(null); setRange((r) => r); toast("Saved"); }} />}
    </div>
  );
}

/* ── On today ─────────────────────────────────────────────────────────── */
function Today() {
  const [d, setD] = useState(null);
  /* The `false` sentinel already kept the figures off, but it said so only in
     one cell and offered no way back. One flag, the shared wording, a retry. */
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get("/staff/today"), setD, null); };
  useEffect(() => { load(); }, []);
  const t = d ? d.totals : null;

  return (
    <>
      <div className="dk-strip four">
        <div>
          <div className="l">Sales per staff hour</div>
          <div className="big dk-n">{t && t.per_hour != null ? money(t.per_hour) : "—"}</div>
          <div className="s">
            {failed ? "today's shifts did not load" : t ? `${t.staff} on the books · ${hrs(t.hours)} logged today` : "\u00a0"}
          </div>
        </div>
        <div>
          <div className="l">On now</div>
          <div className="v dk-n" style={{ color: t && t.on_now ? "var(--good)" : "var(--faint)" }}>
            {t ? t.on_now : "—"}
          </div>
          <div className="s">{t ? `${t.shifts} shift${t.shifts === 1 ? "" : "s"} opened today` : "\u00a0"}</div>
        </div>
        <div>
          <div className="l">Late in</div>
          <div className="v dk-n" style={{ color: t && t.late ? "var(--warnc)" : "var(--faint)" }}>
            {t ? t.late : "—"}
          </div>
          <div className="s">
            {failed ? "today's shifts did not load"
              : d && d.rows && d.rows.some((r) => r.late_mins != null)
              ? "against rostered hours"
              : "no rostered hours set"}
          </div>
        </div>
        <div>
          <div className="l">Sold today</div>
          <div className="v dk-n">{t ? money(t.sales) : "—"}</div>
          <div className="s">{failed ? "today's shifts did not load" : "across every till"}</div>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>Shifts today</h3>
          <div className="spacer" />
          <button className="dk-sbtn" onClick={load}>Refresh</button>
        </div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr>
                <th>Who</th><th>Rostered</th><th>In</th><th>Out</th>
                <th className="r">Hours</th><th className="r">Bills</th><th className="r">Sold</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {failed ? <FailedRows cols={8} what="today's shifts" onRetry={load} />
                : d === null ? <LoadingRows cols={8} />
                : d.rows.length === 0 ? (
                  <tr><td colSpan={8}><div className="dk-empty">
                    Nobody has opened a shift today. Shifts start at the till — that is what marks someone as in.
                  </div></td></tr>
                ) : d.rows.map((r) => (
                  <tr key={r.shift_id}>
                    <td className="strong">{r.name}
                      {r.role_name && <div className="dim" style={{ fontSize: 11.5, fontWeight: 500 }}>{r.role_name}</div>}
                    </td>
                    <td className="tight dk-n dim">{r.roster || "—"}</td>
                    <td className="tight dk-n">
                      {clock(r.opened_at)}
                      {r.late_mins > 0 && (
                        <span className="dk-edited" style={{ marginLeft: 6 }}>{r.late_mins}m late</span>
                      )}
                    </td>
                    <td className="tight dk-n dim">{r.closed_at ? clock(r.closed_at) : "—"}</td>
                    <td className="r dk-n">{hrs(r.hours)}</td>
                    <td className="r dk-n dim">{r.bills}</td>
                    <td className="r dk-n strong">{money(r.sales)}</td>
                    <td className="tight">
                      <span className={`dk-tpill ${r.status === "open" ? "good" : ""}`}>
                        {r.status === "open" ? "on now" : "closed"}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {d && d.absent && d.absent.length > 0 && (
          <div style={{ padding: "14px 24px", borderTop: "1px solid var(--line)", background: "var(--warn-soft)",
                        color: "var(--warnc)", fontSize: 13.5, lineHeight: 1.6 }}>
            <b>Rostered but not in:</b>{" "}
            {d.absent.map((a) => `${a.name} (from ${a.roster})`).join(" · ")}
          </div>
        )}

        <div className="dk-pagefoot">
          <span className="count">
            {failed ? "Not loaded" : d && d.rows
              ? `Showing ${d.rows.length} of ${d.rows.length} shift${d.rows.length === 1 ? "" : "s"} · ${hrs(d.totals.hours)} logged`
              : "Loading…"}
          </span>
        </div>
      </div>
    </>
  );
}

/* ── What they sold ───────────────────────────────────────────────────── */
function Performance({ month, onTerms }) {
  const [d, setD] = useState(null);
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get(`/staff/performance?month=${month}`), setD, null); };
  useEffect(load, [month]);
  const t = d ? d.totals : null;
  const best = d && d.rows.length ? d.rows[0] : null;

  return (
    <>
      <div className="dk-strip four">
        <div>
          <div className="l">Sold this month</div>
          <div className="big dk-n">{t ? money(t.sold) : "—"}</div>
          <div className="s">
            {failed ? "these figures did not load" : t ? `${t.bills} bill${t.bills === 1 ? "" : "s"} · ${t.selling} sold something` : "\u00a0"}
          </div>
        </div>
        <div>
          <div className="l">Best month</div>
          <div className="v dk-n" style={{ fontSize: 19 }}>{best ? best.name : "—"}</div>
          <div className="s dk-n">{best ? money(best.net) : "\u00a0"}</div>
        </div>
        <div>
          <div className="l">Came back</div>
          {/* A return is a reversal, not a debt that has run late. This and the
              other returned/clawback figures borrowed .amt-overdue only to keep
              a red; .amt-reversal now says what they mean. */}
          <div className={`v dk-n ${t && t.returned > 0 ? "amt-reversal" : "amt-zero"}`}>
            {t ? money(t.returned) : "—"}
          </div>
          <div className="s">credited against these sales</div>
        </div>
        <div>
          <div className="l">Hours worked</div>
          <div className="v dk-n">{t ? hrs(t.hours) : "—"}</div>
          <div className="s">{failed ? "these figures did not load" : t && t.hours > 0 ? `${money(t.sold / t.hours)} an hour` : "no shifts logged"}</div>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>What each person sold{d ? ` — ${d.label}` : ""}</h3>
        </div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr>
                <th>Who</th><th className="r">Bills</th><th className="r">Sold</th><th className="r">Average bill</th>
                <th className="r">Discount given</th><th className="r">Returned</th><th className="r">Net</th><th className="r">Per hour</th>
              </tr>
            </thead>
            <tbody>
              {failed ? <FailedRows cols={8} what="these figures" onRetry={load} />
                : d === null ? <LoadingRows cols={8} />
                : d.rows.every((r) => r.bills === 0) ? (
                  <tr><td colSpan={8}><div className="dk-empty">Nothing was sold in this month.</div></td></tr>
                ) : d.rows.filter((r) => r.bills > 0 || r.hours > 0).map((r) => (
                  <tr key={r.id}>
                    <td className="strong">{r.name}
                      <div className="dim" style={{ fontSize: 11.5, fontWeight: 500 }}>
                        {[r.role_name, r.status !== "active" ? "inactive" : null].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="r dk-n">{r.bills}</td>
                    <td className="r dk-n">{money(r.sales)}</td>
                    <td className="r dk-n dim">{r.bills ? money(r.avg_bill) : "—"}</td>
                    <td className="r dk-n dim">{r.discount > 0 ? money(r.discount) : "—"}</td>
                    <td className={`r dk-n ${r.returned > 0 ? "amt-reversal" : "amt-zero"}`}>
                      {r.returned > 0 ? `− ${money(r.returned)}` : "—"}
                    </td>
                    <td className="r dk-n strong">{money(r.net)}</td>
                    <td className="r dk-n dim">{r.per_hour != null ? money(r.per_hour) : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="dk-pagefoot">
          <span className="count">
            {failed ? "Not loaded" : d && d.rows
              ? `Showing ${d.rows.filter((r) => r.bills > 0 || r.hours > 0).length} of ${d.rows.length} · returns count against whoever made the original sale, not whoever handled the return.`
              : "Loading…"}
          </span>
        </div>
      </div>
    </>
  );
}

/* ── What they are owed ───────────────────────────────────────────────── */
function Commission({ month, onTerms }) {
  const [d, setD] = useState(null);
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get(`/staff/commission?month=${month}`), setD, null); };
  useEffect(load, [month]);
  const t = d ? d.totals : null;

  return (
    <>
      {/* The two banner pills said the same thing the strip says on every other
          tab. Commission to pay is money owed out and not yet paid — amber,
          not green. */}
      <div className="dk-strip">
        <div>
          <div className="l">Commission to pay</div>
          <div className={`big dk-n ${t && t.earned > 0.005 ? "amt-owed" : "amt-zero"}`}>
            {t ? money(t.earned) : "—"}
          </div>
          <div className="s">{d ? `${d.label} · ${t.people} earning` : " "}</div>
        </div>
        <div>
          <div className="l">Net sales it is earned on</div>
          <div className="v dk-n">{t ? money(t.net) : "—"}</div>
          <div className="s">sold, less what came back</div>
        </div>
        <div>
          <div className="l">Taken back on returns</div>
          <div className={`v dk-n ${t && t.clawback > 0.005 ? "amt-reversal" : "amt-zero"}`}>
            {t ? money(t.clawback) : "—"}
          </div>
          <div className="s">clawed back this month</div>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>Commission{d ? ` — ${d.label}` : ""}</h3>
          <div className="spacer" />
          {d && (
            <span style={{ fontSize: 12.5, color: "var(--faint)" }}>
              Shop rate {d.default_rate}% unless someone has their own
            </span>
          )}
        </div>
        <div className="dk-tablewrap dk-s">
          <table className="dk-table">
            <thead>
              <tr>
                <th>Who</th><th className="r">Rate</th><th className="r">Sold</th>
                <th className="r">Returned</th><th className="r">Net</th><th className="r">Earned</th><th style={{ width: 52 }} />
              </tr>
            </thead>
            <tbody>
              {failed ? <FailedRows cols={7} what="the commission figures" onRetry={load} />
                : d === null ? <LoadingRows cols={7} />
                : d.rows.length === 0 ? (
                  <tr><td colSpan={7}><div className="dk-empty">
                    No staff accounts yet. Every person on the payroll is listed here, whether or not
                    they sold anything this month.
                  </div></td></tr>
                ) : d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="strong">{r.name}
                      {r.role_name && <div className="dim" style={{ fontSize: 11.5, fontWeight: 500 }}>{r.role_name}</div>}
                    </td>
                    <td className="r dk-n">
                      {r.rate}%
                      {r.own_rate && <span className="dk-tpill accent" style={{ marginLeft: 6 }}>own</span>}
                    </td>
                    <td className="r dk-n dim">{money(r.sold)}</td>
                    <td className={`r dk-n ${r.returned > 0 ? "amt-reversal" : "amt-zero"}`}>
                      {r.returned > 0 ? `− ${money(r.returned)}` : "—"}
                    </td>
                    <td className="r dk-n">{money(r.net)}</td>
                    {/* Owed to the person, not yet paid: amber. It was green,
                        which read as money in the drawer. */}
                    <td className={`r dk-n strong ${r.earned > 0.005 ? "amt-owed" : "amt-zero"}`}>
                      {money(r.earned)}
                      {r.clawback > 0 && (
                        <div className="dim dk-n" style={{ fontSize: 11.5, fontWeight: 500 }}>−{money(r.clawback)} on returns</div>
                      )}
                    </td>
                    <td className="tight r">
                      <RowMenu label={`Actions for ${r.name}`} actions={[
                        can("users", "edit") &&
                          { icon: <Icon n="edit" />, label: "Rate & rostered hours", onClick: () => onTerms(r) },
                      ]} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="dk-pagefoot">
          <span className="count">
            {failed ? "Not loaded" : d && d.rows
              ? `Showing ${d.rows.length} of ${d.rows.length} · commission is earned on net sales, so a sale returned next week takes its commission back with it.`
              : "Loading…"}
          </span>
        </div>
      </div>
    </>
  );
}

/* ── Rate and rostered hours ──────────────────────────────────────────── */
function TermsDialog({ person, onClose, onSaved }) {
  const [rate, setRate] = useState(person.own_rate ? String(person.rate) : "");
  const [start, setStart] = useState(person.roster_start || "");
  const [end, setEnd] = useState(person.roster_end || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/staff/${person.id}/terms`, {
        commission_pct: rate === "" ? null : Number(rate),
        roster_start: start, roster_end: end,
      });
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`Terms — ${person.name}`} onClose={onClose}>
      <label className="dk-field">
        <span>Commission rate</span>
        <input className="dk-input dk-n" type="number" value={rate} placeholder="Leave blank to use the shop rate"
               onChange={(e) => setRate(e.target.value)} autoFocus />
        <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
          Percent of net sales. Blank means whatever the shop rate is at the time.
        </span>
      </label>

      <div className="dk-r2" style={{ marginTop: 16 }}>
        <label className="dk-field">
          <span>Rostered from</span>
          <input className="dk-input dk-n" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="dk-field">
          <span>Rostered to</span>
          <input className="dk-input dk-n" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 12, lineHeight: 1.6 }}>
        Rostered hours are what "late" and "absent" are measured against. Without them nobody can be late,
        because there is nothing to be late for.
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}
