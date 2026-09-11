import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";
import { inr, cur } from "../lib/tax.js";
import { Empty, toast, Field } from "../lib/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { useRead, LoadFailed } from "../lib/deckui.jsx";
import { printReportNode } from "../lib/print.js";

/**
 * Reminders — chasing what the shop is owed, one customer at a time.
 *
 * The app works out who is overdue and writes the message; the phone opens it;
 * a person presses send. Nothing goes out on its own. That is the whole design
 * and it is deliberate: the message arrives from the shopkeeper's own number,
 * which is the number their customers answer, and the decision about whether
 * to chase somebody at all stays with the person who knows them.
 *
 * Each one sent is recorded, which is what makes "leave a week between
 * reminders" mean anything — without the record, working down the list on
 * Tuesday sends the same person the same words they got on Monday.
 */
const money = (v) => `${cur()} ${inr(v)}`;

export default function Reminders() {
  const [data, setData] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState("chase");     // chase | everyone | sent
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);      // the customer being looked at
  const [prefs, setPrefs] = useState(false);
  const [failed, read] = useRead();
  const paper = React.useRef(null);

  const load = () => {
    read(api.get("/reminders"), setData, null);
    api.get("/reminders/log").then(setLog).catch(() => {});
  };
  useEffect(load, []);

  const rows = useMemo(() => {
    const all = (data && data.rows) || [];
    const t = q.trim().toLowerCase();
    const base = tab === "everyone" ? all : all.filter((r) => !r.in_cooldown);
    return base.filter((r) => !t || `${r.name} ${r.phone}`.toLowerCase().includes(t));
  }, [data, tab, q]);

  const totals = (data && data.totals) || { owed: 0, customers: 0, overdue: 0, ready: 0, unreachable: 0 };

  /* Opening the message and recording it are one action from here, because
     they are one action to the person doing it. The record is written after
     the link is opened, never before — what is being recorded is that somebody
     was asked. */
  const chase = async (r) => {
    if (!r.link) { toast(`${r.name} has no phone number saved`, "bad"); return; }
    window.open(r.link, "_blank", "noopener");
    try {
      await api.post(`/reminders/${r.party_id}/sent`, {
        channel: data.channel, balance: r.balance, days: r.days, message: r.message,
      });
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  const copy = async (r) => {
    try { await navigator.clipboard.writeText(r.message); toast("Message copied"); }
    catch { toast("Could not copy — select the text instead", "bad"); }
  };

  if (failed && !data) {
    return <div className="dk-card"><LoadFailed what="who owes you" onRetry={load} /></div>;
  }

  return (
    <div ref={paper}>
      <div className="dk-strip" style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1fr" }}>
        <div>
          <div className="l">Owed to you</div>
          <div className="v dk-n amt-owed">{money(totals.owed)}</div>
          <div className="s">{totals.customers} customer{totals.customers === 1 ? "" : "s"}</div>
        </div>
        <div>
          <div className="l">Overdue</div>
          <div className="v dk-n">{totals.overdue}</div>
          <div className="s">past their due date</div>
        </div>
        <div>
          <div className="l">Ready to chase</div>
          <div className="v dk-n">{totals.ready}</div>
          <div className="s">
            {data ? (data.channel === "sms" ? "by text message" : "on WhatsApp") : ""}
          </div>
        </div>
        <div>
          <div className="l">No phone number</div>
          <div className="v dk-n">{totals.unreachable}</div>
          <div className="s">add one to chase them</div>
        </div>
      </div>

      <div className="dk-card flush" style={{ marginTop: 16 }}>
        <div className="dk-tablehead no-print">
          <div className="dk-seg2">
            {[["chase", "To chase"], ["everyone", "Everyone owing"], ["sent", "Already sent"]].map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {tab !== "sent" && (
            <input className="dk-input" style={{ width: 240, height: 38 }} placeholder="Find a customer…"
                   value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="spacer" style={{ flex: 1 }} />
          <button className="dk-sbtn" onClick={() => printReportNode(paper.current, {
            title: "Debts to chase", caption: `${money(totals.owed)} outstanding`,
          })}>Print</button>
          <button className="dk-sbtn" onClick={() => setPrefs(true)}>Message settings</button>
        </div>

        {tab === "sent" ? (
          <div className="dk-scrollx">
            <table className="dk-table">
              <thead><tr><th>When</th><th>Customer</th><th>How</th><th className="amt">Owed then</th><th>Overdue</th><th>By</th></tr></thead>
              <tbody>
                {log.length === 0 ? (
                  <tr><td colSpan={6}><Empty icon="✉" title="Nothing sent yet"
                        sub="Reminders you send appear here, so you can see who has already been asked." /></td></tr>
                ) : log.map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{String(r.created_at || "").replace("T", " ")}</td>
                    <td>{r.party_name || "—"}</td>
                    <td style={{ textTransform: "capitalize" }}>{r.channel}</td>
                    <td className="amt dk-n">{money(r.balance)}</td>
                    <td className="num">{r.days ? `${r.days} days` : "—"}</td>
                    <td>{r.who || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dk-scrollx">
            <table className="dk-table">
              <thead>
                <tr><th>Customer</th><th className="amt">Owes</th><th>Bills</th><th>Overdue</th><th>Last asked</th><th /></tr>
              </thead>
              <tbody>
                {data === null ? (
                  <tr><td colSpan={6} style={{ color: "var(--muted)" }}>Working out who owes you…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6}><Empty icon="✓" title="Nobody to chase"
                        sub="Either everyone has paid, or the ones who have not were asked recently." /></td></tr>
                ) : rows.map((r) => (
                  <tr key={r.party_id} className={r.in_cooldown ? "dim" : ""}>
                    <td>
                      <b>{r.name}</b>
                      <div style={{ fontSize: 12, color: "var(--faint)" }}>
                        {r.phone || "no phone number"}
                      </div>
                    </td>
                    <td className="amt dk-n amt-owed">{money(r.balance)}</td>
                    <td className="num">{r.bills}</td>
                    <td className="num">
                      {r.days > 0
                        ? <span className={r.days >= 30 ? "pill pill-bad" : "pill pill-warn"}>{r.days} days</span>
                        : <span className="pill">not yet due</span>}
                    </td>
                    <td className="num" style={{ fontSize: 12.5, color: "var(--faint)" }}>
                      {r.last_sent ? String(r.last_sent).slice(0, 10) : "never"}
                      {r.in_cooldown ? " · asked recently" : ""}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }} className="no-print">
                      <button className="dk-sbtn" onClick={() => setOpen(r)}>Read it</button>
                      <button className="btn btn-primary btn-sm" style={{ marginLeft: 6 }}
                              disabled={!r.reachable} onClick={() => chase(r)}>
                        <Icon n="send" size={14} /> {data.channel === "sms" ? "Text" : "WhatsApp"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <MessagePreview r={open} channel={data.channel}
                        onClose={() => setOpen(null)}
                        onCopy={() => copy(open)}
                        onSend={() => { chase(open); setOpen(null); }} />
      )}
      {prefs && <ReminderSettings onClose={() => { setPrefs(false); load(); }} />}
    </div>
  );
}

/* What the customer is about to read, before it is sent to them. */
function MessagePreview({ r, channel, onClose, onCopy, onSend }) {
  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cf-box" style={{ maxWidth: 560 }}>
        <h3>{r.name}</h3>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          {money(r.balance)} across {r.bills} bill{r.bills === 1 ? "" : "s"}
          {r.days > 0 ? ` · ${r.days} days past due` : " · not yet due"}
          {r.phone ? ` · ${r.phone}` : " · no phone number saved"}
        </p>
        <div style={{
          whiteSpace: "pre-wrap", background: "var(--sunk)", borderRadius: 10,
          padding: "12px 14px", fontSize: 13.5, lineHeight: 1.55, margin: "10px 0 4px",
        }}>{r.message}</div>
        <p style={{ color: "var(--faint)", fontSize: 12 }}>
          {channel === "sms" ? "Your messaging app" : "WhatsApp"} opens with this ready. You press send.
        </p>
        <div className="cf-actions">
          <button className="btn btn-ghost" onClick={onCopy}>Copy the words</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={onSend} disabled={!r.reachable}>
            Open {channel === "sms" ? "messages" : "WhatsApp"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* The words themselves, and when to use them. */
const TOKENS = [
  ["{name}", "the customer's first name"],
  ["{balance}", "what they owe"],
  ["{business}", "your business name"],
  ["{days}", "how many days the oldest bill is overdue"],
  ["{bills}", "how many bills are open"],
  ["{phone}", "your phone number"],
];

function ReminderSettings({ onClose }) {
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/settings").then((s) => setV(s.values || {})).catch(() => setV({})); }, []);
  const set = (k, x) => setV((c) => ({ ...c, [k]: x }));

  const save = async () => {
    setBusy(true);
    try {
      await api.put("/settings", {
        remind_channel: v.remind_channel, remind_grace_days: v.remind_grace_days,
        remind_min_balance: v.remind_min_balance, remind_cooldown_days: v.remind_cooldown_days,
        remind_signature: v.remind_signature, remind_country_code: v.remind_country_code,
        remind_tpl_gentle: v.remind_tpl_gentle, remind_tpl_due: v.remind_tpl_due,
        remind_tpl_late: v.remind_tpl_late,
      });
      toast("Saved");
      onClose();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  if (!v) return null;
  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cf-box" style={{ maxWidth: 700, maxHeight: "88vh", overflow: "auto" }}>
        <h3>Reminder messages</h3>
        <div className="row2">
          <Field label="Send by">
            <select value={v.remind_channel || "whatsapp"} onChange={(e) => set("remind_channel", e.target.value)}>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">Text message</option>
            </select>
          </Field>
          <Field label="Country code for numbers starting 0">
            <input value={v.remind_country_code || "256"} onChange={(e) => set("remind_country_code", e.target.value)} />
          </Field>
        </div>
        <div className="row2">
          <Field label="Wait this many days past due">
            <input type="number" value={v.remind_grace_days ?? "0"} onChange={(e) => set("remind_grace_days", e.target.value)} />
          </Field>
          <Field label="Leave this many days between reminders">
            <input type="number" value={v.remind_cooldown_days ?? "7"} onChange={(e) => set("remind_cooldown_days", e.target.value)} />
          </Field>
        </div>
        <Field label="Do not chase balances under">
          <input type="number" value={v.remind_min_balance ?? "0"} onChange={(e) => set("remind_min_balance", e.target.value)} />
        </Field>

        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "14px 0 6px" }}>
          Anything in braces is filled in for each customer:{" "}
          {TOKENS.map(([t, d], i) => (
            <span key={t}><code>{t}</code> {d}{i < TOKENS.length - 1 ? " · " : ""}</span>
          ))}
        </p>

        <Field label="Not yet overdue">
          <textarea rows={3} value={v.remind_tpl_gentle || ""} onChange={(e) => set("remind_tpl_gentle", e.target.value)} />
        </Field>
        <Field label="Overdue">
          <textarea rows={3} value={v.remind_tpl_due || ""} onChange={(e) => set("remind_tpl_due", e.target.value)} />
        </Field>
        <Field label="Thirty days or more">
          <textarea rows={3} value={v.remind_tpl_late || ""} onChange={(e) => set("remind_tpl_late", e.target.value)} />
        </Field>
        <Field label="Signed off with (optional)">
          <input value={v.remind_signature || ""} onChange={(e) => set("remind_signature", e.target.value)}
                 placeholder="e.g. — the counter, 0700 000 000" />
        </Field>

        <div className="cf-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
