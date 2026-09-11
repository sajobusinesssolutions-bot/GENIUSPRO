/* ── Loyalty ───────────────────────────────────────────────────────────────
   Points earned on what people buy, and what those points are worth when they
   come back. A tab inside Sales, because points are earned by selling.

   Three sub-tabs: who is close to a reward, every member, and every movement.
   Points are earned automatically as sales are rung up; nothing here has to
   be done by hand for the scheme to work. What this screen is for is seeing
   the liability, redeeming at the counter, and correcting mistakes.
*/
import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur, fmtDate as sharedFmtDate } from "../lib/tax.js";
import { Modal, toast, confirmDialog, PartyCombo } from "../lib/ui.jsx";
import { LoadingRows } from "../lib/deckui.jsx";
import { SettingRow, settingsIn } from "../lib/settingsui.jsx";

const money = (v) => `${cur()} ${inr(v)}`;
const pts = (v) => Math.round(Number(v) || 0).toLocaleString("en-UG");
const fmtDate = sharedFmtDate;

const DIR_TONE = { earn: "good", redeem: "accent", adjust: "warn", expire: "bad" };
const DIR_WORD = { earn: "earned", redeem: "redeemed", adjust: "adjusted", expire: "expired" };

export default function LoyaltyPanel() {
  const [view, setView] = useState("members");
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [q, setQ] = useState("");
  const [redeemFor, setRedeemFor] = useState(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [prefs, setPrefs] = useState(false);

  const load = () => api.get("/loyalty").then(setData).catch(() => setData({ rows: [], totals: {}, scheme: {} }));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (view !== "history") return;
    setHistory(null);
    api.get("/loyalty/history").then(setHistory).catch(() => setHistory({ rows: [], totals: {} }));
  }, [view]);

  const scheme = (data && data.scheme) || {};
  const t = q.toLowerCase().trim();

  /* "Close to a reward" is the useful thing to see first: these are the people
     worth telling, because a customer who does not know they have points does
     not come back for them. */
  const members = useMemo(() => {
    if (!data) return null;
    const rows = data.rows.filter((r) => !t || `${r.party_name} ${r.phone || ""}`.toLowerCase().includes(t));
    if (view !== "close") return rows;
    const min = Number(scheme.minRedeem) || 0;
    return rows.filter((r) => r.balance >= min && r.balance > 0);
  }, [data, t, view, scheme]);

  const histRows = useMemo(() => {
    if (!history) return null;
    return history.rows.filter((r) => !t || `${r.party_name} ${r.note || ""}`.toLowerCase().includes(t));
  }, [history, t]);

  const closeCount = data
    ? data.rows.filter((r) => r.balance >= (Number(scheme.minRedeem) || 0) && r.balance > 0).length
    : 0;

  const expire = async () => {
    if (!(await confirmDialog({
      title: "Expire old points?",
      message: `Points older than ${scheme.expiryMonths} months will be written off.`,
      detail: "Every customer affected gets an expiry entry on their record, so it can be explained if anyone asks.",
      danger: true, confirmLabel: "Expire points",
    }))) return;
    try { const r = await api.post("/loyalty/expire", {}); toast(r.message || "Points expired"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <>
      <div className="dk-tablehead" style={{ border: "none", padding: "0 0 4px" }}>
        <div className="dk-subtabs">
          <button className={`dk-subtab ${view === "close" ? "on" : ""}`} onClick={() => setView("close")}>
            Can redeem
            {closeCount > 0 && <span className="badge dk-n" style={{ background: "var(--good)" }}>{closeCount}</span>}
          </button>
          <button className={`dk-subtab ${view === "members" ? "on" : ""}`} onClick={() => setView("members")}>All Members</button>
          <button className={`dk-subtab ${view === "history" ? "on" : ""}`} onClick={() => setView("history")}>Points History</button>
        </div>
        <div className="spacer" />
        <input className="dk-input search" placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} />
        {can("sales", "edit") && Number(scheme.expiryMonths) > 0 && (
          <button className="dk-sbtn" onClick={expire}>Expire old points</button>
        )}
        {can("settings", "edit") && (
          /* The scheme's own numbers — points per shilling, what a point is
             worth, when they lapse — used to be a Settings page. They describe
             this screen and nothing else, so they are configured from it. */
          <button className="dk-sbtn" onClick={() => setPrefs(true)}>Scheme…</button>
        )}
        {can("sales", "edit") && (
          <button className="dk-sbtn" onClick={() => setAdjustOpen(true)}>Adjust</button>
        )}
        {can("sales", "create") && (
          <button className="dk-create" style={{ height: 38 }} onClick={() => setRedeemFor({})}>
            Redeem points
          </button>
        )}
      </div>

      <div className="dk-recstats">
        <div className="dk-recstat">
          <span className="l">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z" />
            </svg>
            Points outstanding:
          </span>
          <b className="v dk-n">{data ? pts(data.totals.outstanding) : "—"}</b>
        </div>
        <div className="dk-recstat tint">
          <span className="l">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 7h16v10H4z" /><path d="M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5" />
            </svg>
            What that would cost you:
          </span>
          <b className="v dk-n">{data ? money(data.totals.liability) : "—"}</b>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        {data && (
          <div style={{ padding: "12px 24px", borderBottom: "1px solid var(--line)", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
            1 point per {money(scheme.earnPer)} spent · each point is worth {money(scheme.pointValue)} ·
            {Number(scheme.minRedeem) > 0 ? ` ${pts(scheme.minRedeem)} points needed before redeeming` : " no minimum to redeem"}
            {Number(scheme.expiryMonths) > 0 ? ` · points expire after ${scheme.expiryMonths} months` : " · points never expire"}.
            Change any of this under Settings → Loyalty.
          </div>
        )}

        <div className="dk-tablewrap dk-s">
          {view === "history" ? (
            <table className="dk-table">
              <thead>
                <tr><th>Customer</th><th>What happened</th><th className="r">Points</th><th className="r">Value</th><th>When</th><th>By</th></tr>
              </thead>
              <tbody>
                {histRows === null ? <LoadingRows cols={6} />
                  : histRows.length === 0 ? (
                    <tr><td colSpan={6}><div className="dk-empty">
                      {q ? "Nothing matches that." : "No points have moved yet — they are earned automatically as you sell."}
                    </div></td></tr>
                  ) : histRows.map((r) => (
                    <tr key={r.id}>
                      <td className="strong">{r.party_name}</td>
                      <td className="tight">
                        <span className={`dk-tpill ${DIR_TONE[r.direction] || ""}`}>{DIR_WORD[r.direction] || r.direction}</span>
                        {r.note && <span className="dim" style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 500 }}>{r.note}</span>}
                      </td>
                      <td className="r dk-n strong" style={{ color: r.direction === "earn" || r.direction === "adjust" ? "var(--good)" : "var(--danger)" }}>
                        {r.direction === "earn" || r.direction === "adjust" ? "+" : "−"}{pts(r.points)}
                      </td>
                      <td className="r dk-n dim">{r.value ? money(r.value) : "—"}</td>
                      <td className="tight dk-n dim">{fmtDate(r.created_at)}</td>
                      <td className="tight dim">{r.by_user || "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <table className="dk-table">
              <thead>
                <tr>
                  <th>Customer</th><th className="r">Earned</th><th className="r">Used</th>
                  <th className="r">Balance</th><th className="r">Worth</th><th>Last activity</th><th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {members === null ? <LoadingRows cols={7} />
                  : members.length === 0 ? (
                    <tr><td colSpan={7}><div className="dk-empty">
                      {q ? "Nothing matches that."
                        : view === "close" ? "Nobody has enough points to redeem yet."
                        : "No members yet — points start collecting as soon as a saved customer buys something."}
                    </div></td></tr>
                  ) : members.map((r) => {
                    const canRedeem = r.balance >= (Number(scheme.minRedeem) || 0) && r.balance > 0;
                    return (
                      <tr key={r.party_id}>
                        <td className="strong">{r.party_name}
                          {r.phone && <div className="dim dk-n" style={{ fontSize: 11.5, fontWeight: 500 }}>{r.phone}</div>}
                        </td>
                        <td className="r dk-n dim">{pts(r.credited)}</td>
                        <td className="r dk-n dim">{pts(r.spent)}</td>
                        <td className="r dk-n strong" style={{ color: canRedeem ? "var(--good)" : undefined }}>{pts(r.balance)}</td>
                        <td className="r dk-n">{money(r.value)}</td>
                        <td className="tight dk-n dim">{fmtDate(r.last_activity)}</td>
                        <td className="r">
                          {canRedeem && can("sales", "create") && (
                            <button className="dk-minibtn" onClick={() => setRedeemFor(r)}>Redeem</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </div>

        <div className="dk-pagefoot">
          <span className="count">
            {view === "history"
              ? histRows
                ? `${histRows.length} movement${histRows.length === 1 ? "" : "s"} · ${pts((history || {}).totals?.earnedThisMonth || 0)} earned and ${pts((history || {}).totals?.redeemedThisMonth || 0)} redeemed this month`
                : "Loading…"
              : data
                ? `${data.totals.members} member${data.totals.members === 1 ? "" : "s"}${closeCount ? ` · ${closeCount} can redeem now` : ""}`
                : "Loading…"}
          </span>
        </div>
      </div>

      {redeemFor && <RedeemDialog member={redeemFor.party_id ? redeemFor : null} scheme={scheme}
        onClose={() => setRedeemFor(null)}
        onDone={() => { setRedeemFor(null); load(); if (view === "history") api.get("/loyalty/history").then(setHistory).catch(() => {}); }} />}
      {adjustOpen && <AdjustDialog onClose={() => setAdjustOpen(false)}
        onDone={() => { setAdjustOpen(false); load(); }} />}
      {prefs && <LoyaltyScheme onClose={() => setPrefs(false)} onSaved={() => { setPrefs(false); load(); }} />}
    </>
  );
}

/* ── Redeeming ────────────────────────────────────────────────────────────
   Redeeming records that the points were spent; taking the money off the bill
   happens at the till. The dialog says so plainly, because a shopkeeper who
   thinks this discounts the sale will hand over goods twice. */
function RedeemDialog({ member, scheme, onClose, onDone }) {
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState(member ? String(member.party_id) : "");
  const [quote, setQuote] = useState(member ? { balance: member.balance, value: member.value } : null);
  const [points, setPoints] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!member) api.get("/parties").then(setParties).catch(() => {}); }, []);
  useEffect(() => {
    if (!partyId) return setQuote(null);
    api.get(`/loyalty/quote/${partyId}`).then(setQuote).catch(() => setQuote(null));
  }, [partyId]);

  const n = Math.floor(Number(points) || 0);
  const worth = n * (Number(scheme.pointValue) || 0);
  const balance = quote ? quote.balance : 0;
  const tooMany = n > balance;
  const tooFew = n > 0 && n < (Number(scheme.minRedeem) || 0);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post("/loyalty/redeem", { party_id: Number(partyId), points: n });
      toast(r.message || "Points redeemed");
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title="Redeem points" onClose={onClose}>
      {member ? (
        <div className="dk-figbox" style={{ marginBottom: 16 }}>
          <div className="l">{member.party_name}</div>
          <div className="v dk-n">{pts(member.balance)} points</div>
          <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 4 }}>worth {money(member.value)}</div>
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <div className="dk-login-cap" style={{ marginBottom: 8 }}>Customer</div>
          <PartyCombo parties={parties} value={partyId} autoFocus
                      onPick={(id) => setPartyId(String(id))}
                      onCreated={async (p) => { setParties(await api.get("/parties")); setPartyId(String(p.id)); }} />
          {quote && (
            <div style={{ marginTop: 10, fontSize: 13.5, color: "var(--soft)" }}>
              Balance <b className="dk-n">{pts(quote.balance)} points</b> · worth <b className="dk-n">{money(quote.value)}</b>
            </div>
          )}
        </div>
      )}

      <label className="dk-field">
        <span>Points to redeem</span>
        <input className="dk-input dk-n" type="number" value={points} placeholder="0" autoFocus={!!member}
               onChange={(e) => setPoints(e.target.value)} />
      </label>

      {balance > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button className="dk-minibtn ghost" onClick={() => setPoints(String(balance))}>All {pts(balance)}</button>
          {[100, 500, 1000].filter((v) => v <= balance).map((v) => (
            <button key={v} className="dk-minibtn ghost" onClick={() => setPoints(String(v))}>{pts(v)}</button>
          ))}
        </div>
      )}

      <div className="dk-after" style={{ marginTop: 16 }}>
        <span>Take off the bill</span>
        <b className="dk-n" style={{ color: n > 0 && !tooMany && !tooFew ? "var(--good)" : "var(--faint)" }}>
          {n > 0 ? money(worth) : "—"}
        </b>
      </div>

      {tooMany && <div className="dk-login-err" style={{ marginTop: 12 }}>That is more than the {pts(balance)} points available.</div>}
      {tooFew && <div className="dk-login-err" style={{ marginTop: 12 }}>At least {pts(scheme.minRedeem)} points are needed to redeem.</div>}

      <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
        This records that the points were spent. Taking the {n > 0 ? money(worth) : "amount"} off the bill is done
        at the till as a discount — it does not happen on its own.
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy || !partyId || !(n > 0) || tooMany || tooFew} onClick={go}>
          {busy ? "Redeeming…" : "Redeem"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Correcting a balance ─────────────────────────────────────────────── */
function AdjustDialog({ onClose, onDone }) {
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState("");
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get("/parties").then(setParties).catch(() => {}); }, []);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post("/loyalty/adjust", { party_id: Number(partyId), points: Number(points), note });
      toast(r.message || "Adjusted");
      onDone();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title="Adjust points by hand">
      <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5, lineHeight: 1.6 }}>
        For putting right what the scheme got wrong — a sale rung up on the wrong customer, a goodwill
        gesture, a correction. Every adjustment is recorded with its reason and who made it.
      </p>
      <div style={{ marginBottom: 14 }}>
        <div className="dk-login-cap" style={{ marginBottom: 8 }}>Customer</div>
        <PartyCombo parties={parties} value={partyId} autoFocus
                    onPick={(id) => setPartyId(String(id))}
                    onCreated={async (p) => { setParties(await api.get("/parties")); setPartyId(String(p.id)); }} />
      </div>
      <label className="dk-field">
        <span>Points to add</span>
        <input className="dk-input dk-n" type="number" value={points} placeholder="50"
               onChange={(e) => setPoints(e.target.value)} />
      </label>
      <label className="dk-field" style={{ marginTop: 14 }}>
        <span>Reason</span>
        <input className="dk-input" value={note} placeholder="Why this adjustment is being made"
               onChange={(e) => setNote(e.target.value)} />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" disabled={busy || !partyId || !Number(points) || !note.trim()} onClick={go}>
          {busy ? "Saving…" : "Adjust"}
        </button>
      </div>
    </Modal>
  );
}


/* ── The loyalty scheme's own numbers ─────────────────────────────────────
 * Points per shilling, what a point is worth, the floor on redeeming, when
 * points lapse. All five were a Settings page; they describe this screen and
 * nothing else, so they are set from it. The rows are the shared `SettingRow`,
 * so they read exactly as they did on Settings.
 */
function LoyaltyScheme({ onClose, onSaved }) {
  const [catalog, setCatalog] = React.useState(null);
  const [v, setV] = React.useState({});
  const [dirty, setDirty] = React.useState({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
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

  const rows = settingsIn(catalog || [], "loyalty");
  return (
    <Modal title="Loyalty scheme" onClose={onClose} wide>
      {catalog === null ? <div className="dk-empty">Loading…</div> : (
        <div className="dk-setsec" style={{ border: 0, padding: 0, background: "none", marginBottom: 0 }}>
          <div className="rows">
            {rows.map((c) => <SettingRow key={c.key} c={c} values={v} setVal={setVal} dirty={dirty} />)}
          </div>
        </div>
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
