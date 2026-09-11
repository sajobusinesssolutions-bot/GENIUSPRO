/**
 * Licence.jsx — the licence screen, and the door a stopped till waits at.
 *
 * Two components, one file, because they say the same things in two places:
 *
 *   <LicenceStop/>  replaces the whole app when the till may not record
 *                   anything. It is deliberately not a dead end — reading the
 *                   books, running reports and taking a backup out all still
 *                   work, and the buttons here say so.
 *   <Licence/>      the ordinary screen under Settings, for typing a key,
 *                   checking in, and seeing what the plan allows.
 */
import { useEffect, useState } from "react";
import api from "../lib/api.js";
import { toast } from "../lib/ui.jsx";

const fmt = (iso) => {
  if (!iso) return "never";
  const d = new Date(iso);
  return isNaN(d) ? "never" : d.toLocaleString();
};

/** How the licence is doing, and what to do about it. Shared by both screens. */
function useLicence() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get("/licence").then(setSt).catch(() => setSt(null));
  useEffect(() => { load(); }, []);

  const checkNow = async () => {
    setBusy(true);
    try {
      const s = await api.post("/licence/check", {});
      setSt(s);
      if (s.offline) toast(s.why || "Could not reach the licence server", "bad");
      else if (!s.blocks) toast("Licence confirmed", "ok");
      else toast(s.title, "bad");
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  const activate = async (key, server) => {
    setBusy(true);
    try {
      const s = await api.post("/licence/activate", { key, server });
      setSt(s);
      if (s.blocks) toast(s.title, "bad");
      else { toast("This till is licensed", "ok"); setTimeout(() => window.location.reload(), 900); }
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  return { st, busy, load, checkNow, activate, setSt };
}

/* ------------------------------------------------------------------ *
 * the form
 * ------------------------------------------------------------------ */
function KeyForm({ st, busy, onActivate }) {
  const [key, setKey] = useState("");
  const [server, setServer] = useState("");
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { if (st && !server) setServer(st.server || ""); }, [st]);

  return (
    <div className="lic-form">
      <label className="lic-l">Licence key</label>
      <input
        className="lic-key"
        value={key}
        autoFocus
        spellCheck={false}
        placeholder="GENIUS-PRO-XXXX-XXXX-XXXX-XXXX"
        onChange={(e) => setKey(e.target.value.toUpperCase())}
        onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) onActivate(key.trim(), server.trim()); }}
      />
      <div className="lic-hint">
        The letters I, O and the digits 0 and 1 are not used, so a key can be read
        down a phone line without argument.
      </div>

      {advanced ? (
        <>
          <label className="lic-l" style={{ marginTop: 14 }}>Licence server</label>
          <input className="lic-key" value={server} spellCheck={false}
                 onChange={(e) => setServer(e.target.value)} />
          <div className="lic-hint">
            Leave this alone unless your supplier gave you another address. Once a
            till has been activated it will only ever believe that one server.
          </div>
        </>
      ) : (
        <button className="lnk" style={{ marginTop: 10 }} onClick={() => setAdvanced(true)}>
          Change the licence server
        </button>
      )}

      <button className="btn primary wide" style={{ marginTop: 16 }}
              disabled={busy || !key.trim()}
              onClick={() => onActivate(key.trim(), server.trim())}>
        {busy ? "Checking…" : "Activate this computer"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * the door
 * ------------------------------------------------------------------ */
export function LicenceStop({ state, onCleared }) {
  const { st, busy, checkNow, activate } = useLicence();
  const s = st || state || {};
  useEffect(() => { if (st && !st.blocks && onCleared) onCleared(); }, [st]);

  return (
    <div className="lic-stop">
      <div className="lic-card">
        <div className="lic-badge">Genius POS</div>
        <h1 className="lic-title">{s.title || "This till is stopped"}</h1>
        {s.note ? <p className="lic-note">{s.note}</p> : null}

        <div className="lic-keep">
          <b>Nothing has been lost.</b> Every sale, customer and figure is still on
          this computer. You can read the books, run any report and take a backup
          out — the till simply cannot record anything new until the licence is
          sorted.
        </div>

        <KeyForm st={s} busy={busy} onActivate={activate} />

        <div className="lic-row">
          <button className="btn" disabled={busy} onClick={checkNow}>Check again</button>
          <a className="btn" href="/api/system/backup" download>Take a backup out</a>
        </div>

        {s.daysSinceCheck != null && (
          <div className="lic-meta">
            Last reached the licence server {fmt(s.checkedAt)} · {s.daysSinceCheck} day
            {s.daysSinceCheck === 1 ? "" : "s"} ago · {s.salesSince} bill
            {s.salesSince === 1 ? "" : "s"} since
          </div>
        )}
        <div className="lic-meta">Powered by SALJO TECH</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * the ordinary screen
 * ------------------------------------------------------------------ */
/* One allowance, and how close the shop is to it. A bar rather than a number
   because "4 of 5" is read as a fact and a nearly-full bar is read as a
   warning, which is what it is. */
function Allowance({ label, used, allowed }) {
  if (used == null) return null;
  const cap = Number(allowed) || 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const tone = !cap ? "" : pct >= 100 ? "bad" : pct >= 80 ? "warn" : "";
  return (
    <div className="lic-kv lic-allow">
      <span>{label}</span>
      <b>
        {cap ? `${used} of ${cap}` : used}
        {cap ? (
          <span className={`lic-bar ${tone}`}><i style={{ width: `${pct}%` }} /></span>
        ) : null}
      </b>
    </div>
  );
}

export default function Licence() {
  const { st, busy, checkNow, activate, load } = useLicence();
  if (!st) return <div className="pad">Loading…</div>;

  const lic = st.licence || {};
  const good = !st.blocks;

  const forget = async () => {
    if (!window.confirm("Remove the licence from this computer? It will stop recording sales until a key is typed again.")) return;
    try { await api.post("/licence/forget", {}); toast("Licence removed", "ok"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="pg">
      <div className={`lic-state ${good ? "good" : "bad"}`}>
        <div className="lic-state-t">{st.title}</div>
        {st.note ? <div className="lic-state-n">{st.note}</div> : null}
      </div>

      {st.hasKey && (
        <div className="card">
          <div className="lic-kv"><span>Key</span><b className="mono">{st.key}</b></div>
          {lic.no && <div className="lic-kv"><span>Licence</span><b>{lic.no}</b></div>}
          {lic.planName && <div className="lic-kv"><span>Plan</span><b>{lic.planName}</b></div>}
          {lic.expiresAt && (
            <div className="lic-kv"><span>Runs until</span>
              <b>{new Date(lic.expiresAt).toLocaleDateString()}
                {lic.daysLeft != null ? ` · ${lic.daysLeft} days left` : ""}</b></div>
          )}
          {lic.limits && (
            <div className="lic-kv"><span>Allows</span>
              <b>{lic.limits.devices} computer{lic.limits.devices === 1 ? "" : "s"} ·{" "}
                 {lic.limits.businesses} business{lic.limits.businesses === 1 ? "" : "es"} ·{" "}
                 {lic.limits.users} user{lic.limits.users === 1 ? "" : "s"}</b></div>
          )}
          <div className="lic-kv"><span>This computer</span><b>{(st.device || {}).name}</b></div>
          <div className="lic-kv"><span>Last checked</span><b>{fmt(st.checkedAt)}</b></div>
          <div className="lic-kv"><span>Server</span><b className="mono">{st.server}</b></div>

          {/* The two things that end the offline grace, said plainly rather
              than sprung on somebody mid-queue. */}
          <div className="lic-hint" style={{ marginTop: 10 }}>
            With no connection this till keeps selling on the last answer for{" "}
            {st.graceDays} days, and up to {st.maxSales} bills — whichever runs out
            first. It has written {st.salesSince} since the last check.
          </div>

          <div className="lic-row" style={{ marginTop: 14 }}>
            <button className="btn" disabled={busy} onClick={checkNow}>
              {busy ? "Checking…" : "Check in now"}
            </button>
            <button className="btn danger" onClick={forget}>Remove from this computer</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="lic-state-t" style={{ fontSize: 15 }}>
          {st.hasKey ? "Use a different key" : "Type your licence key"}
        </div>
        <KeyForm st={st} busy={busy} onActivate={activate} />
      </div>

      {/* ── Plan & billing ────────────────────────────────────────────────
          What the plan allows against what the shop is using. The allowance
          on its own is a number in a file; beside the real figure it is the
          answer to "can I open another shop", which is the question somebody
          actually has when they open this screen. */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="lic-state-t" style={{ fontSize: 15 }}>Plan &amp; billing</div>
        <div className="lic-kv"><span>Plan</span>
          <b>{lic.planName || (st.hasKey ? "Licensed" : `Free trial — ${st.trialDays} days`)}</b></div>
        {lic.expiresAt && (
          <div className="lic-kv"><span>Renews / expires</span>
            <b>{new Date(lic.expiresAt).toLocaleDateString()}</b></div>
        )}
        {st.usage && (
          <>
            <Allowance label="Businesses" used={st.usage.businesses}
                       allowed={lic.limits && lic.limits.businesses} />
            <Allowance label="Staff logins" used={st.usage.users}
                       allowed={lic.limits && lic.limits.users} />
            <div className="lic-kv"><span>Invoices recorded</span>
              <b className="mono">{st.usage.invoices == null ? "—" : st.usage.invoices.toLocaleString()}</b></div>
          </>
        )}
        <div className="lic-hint" style={{ marginTop: 10 }}>
          {st.hasKey
            ? "To change plan, add computers or extend the licence, contact SALJO TECH with the licence number above."
            : "When the trial ends the books stay open and every report keeps working — only new sales, payments and edits stop until a key is typed."}
        </div>
      </div>

      {lic.features && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="lic-state-t" style={{ fontSize: 15 }}>What this plan includes</div>
          <div className="lic-feats">
            {lic.features.map((f) => <span key={f} className="lic-feat">{f}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}
