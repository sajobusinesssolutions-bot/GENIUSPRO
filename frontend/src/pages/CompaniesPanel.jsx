/**
 * CompaniesPanel.jsx — every business at once.
 *
 * ── the form decisions, made before any colour ────────────────────────────
 *
 * Almost every chart here is the same one: a **sorted horizontal bar, one hue,
 * with the name and the figure written on it**. That is not laziness, it is
 * what the data's job asks for. Revenue by business, stock by business,
 * expenses by category — each is a magnitude comparison across a handful of
 * named things, and a sorted single-hue bar is the form that answers it. The
 * ranking carries the message; hue would only repeat what position already says.
 *
 * It also settles the palette question the honest way. §4 of the design review
 * allows one accent, one destructive, and the three money colours — nothing
 * else — and a categorical set for "company 1..6" would be exactly the accent
 * creep it warns about. **Identity is carried by the label on every bar, not by
 * colour**, which is stronger anyway and survives greyscale, a photocopier and
 * a colourblind reader without special provision.
 *
 * Two places genuinely need more than one colour, and both already have a
 * vocabulary:
 *
 *   • **Profit** is polarity, not identity. Above zero it reads `amt-received`,
 *     below zero `amt-overdue`, and the sign is written out either way.
 *   • **Receivables ageing** is sequential, and uses the four `--age-*` steps
 *     round nine engineered to be monotone in luminance. I re-measured them
 *     rather than trust the comment: light 0.50 → 0.16, dark 0.65 → 0.26, both
 *     strictly decreasing, so the ramp still reads pale-to-dark with the hue
 *     removed. The two palest steps measure 1.89:1 and 2.86:1 against white —
 *     under 3:1 — so **every ageing segment carries a visible label**, which is
 *     the relief that contrast level obliges rather than an optional nicety.
 *
 * No charting library, per §8: the SVG here is a few hundred bytes of rects.
 */
import React, { useEffect, useMemo, useState } from "react";
import api, { isAdmin } from "../lib/api.js";
import { LoadFailed } from "../lib/deckui.jsx";
import { inr, cur } from "../lib/tax.js";
import { toast, Field, Modal } from "../lib/ui.jsx";
import { printReportNode } from "../lib/print.js";

const money = (v) => `${cur()} ${inr(v)}`;
/* Compact, for a bar label where the full figure would not fit. The full one is
   always in the row's own text and in the hover title, so nothing is only ever
   shown rounded. */
const short = (v) => {
  const n = Math.abs(Number(v) || 0);
  const s = n >= 1e9 ? (n / 1e9).toFixed(1) + "b"
    : n >= 1e6 ? (n / 1e6).toFixed(1) + "m"
    : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));
  return (Number(v) < 0 ? "−" : "") + s;
};

const PERIODS = [
  ["today", "Today"], ["last_7", "Last 7 days"],
  ["this_month", "This month"], ["last_month", "Last month"], ["this_year", "This year"],
];

export default function CompaniesPanel({ onClose }) {
  const [period, setPeriod] = useState("this_month");
  const [tab, setTab] = useState("sales");        // sales | stock | expenses
  const [d, setD] = useState(null);
  const [failed, setFailed] = useState(false);
  /* The panel's own lock. `locked` means the server refused for want of a PIN,
     which is a different thing from the fetch failing. */
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState("");
  const [held, setHeld] = useState("");           // the PIN this session is using
  const [pinMgr, setPinMgr] = useState(false);
  /* Folded away by default, and remembered. Somebody who reads the charts
     every morning should not have to open them every morning; somebody who
     came for the four figures should not have to scroll past six charts. */
  const [charts, setCharts] = useState(() => {
    try { return localStorage.getItem("vy_panel_charts") === "1"; } catch { return false; }
  });
  /* Whether a PIN exists at all. The panel was openable by anybody who could
     reach this screen unless somebody had thought to press "Panel PIN" — and
     nothing ever suggested they should. This is the one screen in the product
     that shows every business's takings to whoever is standing at the machine,
     so it asks once, the first time it is opened without one.

     Asked, not forced. A single shop with one owner does not need a second
     lock, and a screen that will not open until you invent a PIN is how people
     end up with 0000. Dismissing it is remembered per computer. */
  const [pinSet, setPinSet] = useState(null);
  const [pinAsked, setPinAsked] = useState(() => {
    try { return localStorage.getItem("vy_panel_pin_asked") === "1"; } catch { return true; }
  });
  useEffect(() => {
    if (!isAdmin()) return;
    api.get("/companies/panel-pin").then((r) => setPinSet(!!r.set)).catch(() => setPinSet(null));
  }, []);
  const dismissPin = () => {
    setPinAsked(true);
    try { localStorage.setItem("vy_panel_pin_asked", "1"); } catch { /* private mode */ }
  };
  const paper = React.useRef(null);

  const load = (p, withPin = held) => {
    setD(null); setFailed(false);
    const q = withPin ? `&pin=${encodeURIComponent(withPin)}` : "";
    api.get(`/companies/panel?period=${p}${q}`)
      .then((x) => { setD(x); setLocked(false); })
      .catch((e) => {
        /* 401 here means "there is a PIN and you have not given it", which is
           an ordinary state of this screen rather than a failure to report. */
        if (/PIN/i.test(e.message || "")) { setLocked(true); return; }
        setFailed(true); toast(e.message, "bad");
      });
  };
  useEffect(() => { load(period); }, [period]);

  const unlock = async () => {
    try {
      await api.post("/companies/panel-unlock", { pin });
      setHeld(pin); setPin(""); setLocked(false);
      load(period, pin);
    } catch (e) { toast(e.message, "bad"); setPin(""); }
  };

  if (locked) {
    return (
      <div className="dk-card" style={{ maxWidth: 420, margin: "40px auto", padding: 26, textAlign: "center" }}>
        <h3 style={{ margin: "0 0 6px" }}>The branch panel is locked</h3>
        <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6 }}>
          This screen shows what every business took. Enter the panel PIN to open it.
        </p>
        <input className="dk-input" type="password" inputMode="numeric" value={pin} autoFocus
               style={{ textAlign: "center", letterSpacing: ".3em", margin: "12px 0" }}
               onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
               onKeyDown={(e) => e.key === "Enter" && pin && unlock()} />
        <button className="btn btn-primary" style={{ width: "100%" }} disabled={!pin} onClick={unlock}>
          Open the panel
        </button>
        {onClose && (
          <button className="btn btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={onClose}>Back</button>
        )}
      </div>
    );
  }

  if (failed) return <div className="dk-card"><LoadFailed what="the branch panel figures" onRetry={() => load(period)} /></div>;
  if (!d) return <div className="dk-card"><div className="dk-empty">Adding up every business…</div></div>;

  const t = d.totals || {};
  const cos = d.companies || [];
  const margin = t.revenue > 0 ? (t.profit / t.revenue) * 100 : null;

  /* One row per business, in the columns this tab is about. Built here rather
     than inside the table so the CSV and the printed copy are the same figures
     in the same order as the screen — three implementations of "the panel" is
     three chances for them to disagree. */
  const COLUMNS = {
    sales: [
      ["Business", (c) => c.name],
      ["Revenue", (c) => c.revenue, "money"],
      ["Invoices", (c) => c.invoices],
      ["Average bill", (c) => c.avg_bill, "money"],
      ["Cost of sales", (c) => c.cogs, "money"],
      ["Profit", (c) => c.profit, "money"],
    ],
    stock: [
      ["Business", (c) => c.name],
      ["Stock at cost", (c) => c.stock_value, "money"],
      ["Units on hand", (c) => c.on_hand],
      ["Running low", (c) => c.low],
    ],
    expenses: [
      ["Business", (c) => c.name],
      ["Expenses", (c) => c.expenses, "money"],
      ["Entries", (c) => c.expense_count],
      ["Owed to you", (c) => c.receivable, "money"],
      ["You owe", (c) => c.payable, "money"],
    ],
  };

  const csv = () => {
    const cols = COLUMNS[tab];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => c[0]).join(",")];
    for (const c of cos) lines.push(cols.map((col) => esc(col[1](c) ?? "")).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `business-panel-${tab}-${d.period.from}-to-${d.period.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="cp" ref={paper}>
      <div className="cp-head">
        <div>
          <h2>Branch panel</h2>
          <p>{cos.length} business{cos.length === 1 ? "" : "es"} · {d.period.label} · {d.period.from} to {d.period.to}</p>
        </div>
        <div className="dk-seg2 cp-period">
          {PERIODS.map(([id, label]) => (
            <button key={id} className={period === id ? "on" : ""} onClick={() => setPeriod(id)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="cp-tabs no-print">
        <div className="dk-seg2">
          {[["sales", "Sales"], ["stock", "Stock"], ["expenses", "Expenses"]].map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="dk-sbtn" onClick={csv}>Export CSV</button>
        <button className="dk-sbtn" onClick={() => printReportNode(paper.current, {
          title: `Branch panel — ${tab}`,
          caption: `${d.period.label} · ${d.period.from} to ${d.period.to}`,
        })}>Print / PDF</button>
        {/* Setting the PIN locks everyone else out of these figures, so it is the
            owner's or an administrator's to set. The server refuses the rest. */}
        {isAdmin() && <button className="dk-sbtn" onClick={() => setPinMgr(true)}>Panel PIN</button>}
      </div>

      {/* Put up the moment the panel opens with no PIN on it.
       *
       * This used to be a banner across the top of the figures, which is the
       * one thing it must not be: the figures it is warning about are already
       * on screen and being read while the banner asks whether they should
       * be. A dialog comes first and covers them, which is the whole point.
       *
       * Still dismissible — a single shop with one owner does not need a
       * second lock, and a screen that will not open until you invent a PIN
       * is how people end up with 0000 — but it is a decision taken before
       * the takings are visible rather than after. */}
      {pinSet === false && !pinAsked && isAdmin() && (
        <Modal title="Protect the branch panel?" onClose={dismissPin}>
          <p style={{ margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.6, color: "var(--soft)" }}>
            This screen shows what <b>every</b> business took, side by side — takings, profit,
            stock and expenses. Anybody who can reach this computer can read it.
          </p>
          <p style={{ margin: "0 0 18px", fontSize: 13.5, lineHeight: 1.6, color: "var(--soft)" }}>
            A PIN keeps it to you. You will be asked for it each time the panel is opened,
            and it is separate from the password you sign in with.
          </p>
          <div className="modal-foot">
            <button className="dk-sbtn" onClick={dismissPin}>Not now</button>
            <button className="dk-sbtn primary" onClick={() => { setPinMgr(true); dismissPin(); }}>
              Set a PIN
            </button>
          </div>
        </Modal>
      )}

      {/* ── The headline four. Stat tiles, not charts: a single number's job is
             to be read, and a chart of one number is decoration. ── */}
      <div className="cp-tiles">
        <Tile label="Revenue" value={money(t.revenue)} sub={`${t.invoices} invoice${t.invoices === 1 ? "" : "s"} · ${t.trading} trading`} tone="amt-received" />
        <Tile label="Profit after costs" value={money(t.profit)}
              /* One decimal is useful at 12.4%; at −450% it is noise, and the
                 extra digit makes an already alarming figure look like a bug. */
              sub={margin === null ? "nothing sold yet"
                : `${Math.abs(margin) >= 100 ? Math.round(margin) : margin.toFixed(1)}% of revenue`}
              tone={t.profit >= 0 ? "amt-received" : "amt-overdue"}
              /* The word, not only the colour. */
              flag={t.profit < 0 ? "at a loss" : null} />
        <Tile label="Owed to you" value={money(t.receivable)} sub="across every business" tone="amt-owed" />
        <Tile label="Stock at cost" value={money(t.stock_value)}
              sub={t.low_stock ? `${t.low_stock} item${t.low_stock === 1 ? "" : "s"} low` : "nothing running low"}
              tone="amt-neutral" flag={t.low_stock ? "low stock" : null} />
      </div>

      {/* ── The charts the chosen tab is about, and no others ────────────────
             Six charts were drawn on every tab, so Sales, Stock and Expenses
             differed only in the columns of the table right at the bottom —
             which meant the tabs looked like they did nothing and the screen
             looked like everything at once. The tab now decides what is on it.
             Charts fold away because on most visits the four tiles and the
             table are the whole answer. ── */}
      <div className="cp-tabs no-print" style={{ marginTop: 4 }}>
        <button className="dk-sbtn" aria-expanded={charts}
                onClick={() => { setCharts(!charts); try { localStorage.setItem("vy_panel_charts", charts ? "0" : "1"); } catch {} }}>
          {charts ? "Hide charts" : "Show charts"}
        </button>
      </div>

      {charts && (
        <div className="cp-grid">
          {tab === "sales" && <>
            <Bars title="Revenue by business"
                  hint="This period, largest first."
                  rows={cos.map((c) => ({ key: c.id, name: c.name, value: c.revenue,
                                          note: `${c.invoices} invoice${c.invoices === 1 ? "" : "s"}`,
                                          muted: c.status !== "active" }))} />

            <Bars title="Profit after costs"
                  hint="Revenue less cost of goods and running costs. A bar below the line is a loss."
                  signed
                  rows={cos.map((c) => ({ key: c.id, name: c.name, value: c.profit,
                                          note: c.revenue > 0 ? `${Math.round((c.profit / c.revenue) * 100)}% of revenue` : "no sales",
                                          muted: c.status !== "active" }))} />

            <Ageing ageing={d.ageing || {}} total={t.receivable} />

            <Money totals={t} />
          </>}

          {tab === "stock" && (
            <Bars title="Stock at cost"
                  hint="What is on the shelves right now, valued at what it cost."
                  rows={cos.map((c) => ({ key: c.id, name: c.name, value: c.stock_value,
                                          note: c.low_stock ? `${c.low_stock} low` : `${inr(c.on_hand)} on hand`,
                                          warn: c.low_stock > 0,
                                          muted: c.status !== "active" }))} />
          )}

          {tab === "expenses" && (
            <Bars title="Where the money went"
                  hint="Running costs this period, by category, across every business."
                  empty="No expenses recorded in this period."
                  rows={(d.expense_categories || []).map((e) => ({
                    key: e.category, name: e.category, value: e.amount,
                    note: `${e.count} entr${e.count === 1 ? "y" : "ies"}` }))} />
          )}
        </div>
      )}

      <Table companies={cos} totals={t} tab={tab} columns={COLUMNS[tab]} />

      {pinMgr && <PanelPin onClose={() => { setPinMgr(false);
          api.get("/companies/panel-pin").then((r) => setPinSet(!!r.set)).catch(() => {}); }}
        held={held} onSet={(p2) => setHeld(p2)} />}
    </div>
  );
}

/* Setting, changing or removing the panel's PIN.
 *
 * Changing one asks for the old one. Without that, anybody sitting at an
 * unlocked machine could lock the owner out of their own figures — and there
 * is no reset for a PIN whose whole purpose is to keep people out. */
function PanelPin({ onClose, held, onSet }) {
  const [set, setSet] = React.useState(null);
  const [oldPin, setOld] = React.useState(held || "");
  const [pin, setPin] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api.get("/companies/panel-pin").then((r) => setSet(!!r.set)).catch(() => setSet(false));
  }, []);

  const save = async (clearing) => {
    setBusy(true);
    try {
      const r = await api.post("/companies/panel-pin", {
        old_pin: oldPin || undefined, pin: clearing ? "" : pin });
      toast(r.message || "Saved");
      onSet(clearing ? "" : pin);
      onClose();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  if (set === null) return null;
  return (
    <div className="cf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cf-box" style={{ maxWidth: 420, textAlign: "left" }}>
        <h3>Panel PIN</h3>
        <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6 }}>
          A manager entitled to open one business's books is not, by that fact, entitled to see
          what the others took. A PIN here asks for one more thing before this screen opens.
        </p>
        {set && (
          <Field label="Current PIN">
            <input type="password" inputMode="numeric" value={oldPin}
                   onChange={(e) => setOld(e.target.value.replace(/\D/g, "").slice(0, 8))} />
          </Field>
        )}
        <Field label={set ? "New PIN" : "PIN — four to eight digits"}>
          <input type="password" inputMode="numeric" value={pin} autoFocus
                 onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} />
        </Field>
        <div className="cf-actions">
          {set && <button className="btn btn-ghost" onClick={() => save(true)} disabled={busy}>Remove the PIN</button>}
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save(false)} disabled={busy || pin.length < 4}>
            {busy ? "Saving…" : set ? "Change it" : "Set it"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone, flag }) {
  return (
    <div className="cp-tile">
      <div className="l">{label}</div>
      <div className={`v dk-n ${tone || ""}`}>{value}</div>
      <div className="s">
        {flag && <span className="cp-flag">{flag}</span>}
        {sub}
      </div>
    </div>
  );
}

/**
 * A sorted single-hue bar chart.
 *
 * `signed` turns it into a polarity chart: bars grow right from a zero line for
 * a profit and left for a loss, and the loss is coloured AND labelled, because
 * "colour is never the only signal" is the rule this app has already had to go
 * back and fix once.
 */
function Bars({ title, hint, rows, signed, empty }) {
  const [hover, setHover] = useState(null);
  const sorted = useMemo(
    () => [...(rows || [])].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), [rows]);
  const max = Math.max(1, ...sorted.map((r) => Math.abs(r.value)));
  const anyNegative = sorted.some((r) => r.value < 0);
  /* A zero line only where it earns its place: with no losses it would be an
     axis drawn against the left edge of every bar, which is the border §2 says
     the eye should not have to parse. */
  const zero = signed && anyNegative ? 0.42 : 0;

  if (!sorted.length || sorted.every((r) => !r.value)) {
    return (
      <section className="dk-card pad cp-chart">
        <h3>{title}</h3>
        {hint && <p className="cp-hint">{hint}</p>}
        <div className="dk-empty">{empty || "Nothing to show for this period yet."}</div>
      </section>
    );
  }

  return (
    <section className="dk-card pad cp-chart">
      <h3>{title}</h3>
      {hint && <p className="cp-hint">{hint}</p>}
      <div className="cp-bars" role="list">
        {sorted.map((r) => {
          /* A zero draws nothing at all. The first version floored every bar at
             0.6% so it would be "visible", which meant a business that sold
             nothing showed the same small mark as one that sold a little —
             a figure invented by the rendering rather than by the data. The
             row still carries the name, the note and the "0", which is what
             says there is nothing here. */
          const isZero = !Number(r.value);
          const frac = isZero ? 0 : Math.abs(r.value) / max;
          const neg = r.value < 0;
          const width = signed && anyNegative ? frac * (neg ? zero : 1 - zero) : frac;
          const left = signed && anyNegative ? (neg ? zero - width : zero) : 0;
          const tone = !signed ? "is-plain" : neg ? "is-loss" : "is-gain";
          return (
            <div key={r.key} className={`cp-bar ${r.muted ? "is-muted" : ""}`} role="listitem"
                 onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)}
                 /* The full figure, always, whatever the bar label had room for. */
                 title={`${r.name} — ${money(r.value)}${r.note ? ` · ${r.note}` : ""}`}>
              <div className="nm">
                {r.name}
                {r.muted && <span className="cp-flag">suspended</span>}
                {r.warn && <span className="cp-flag">low stock</span>}
              </div>
              <div className="track">
                {signed && anyNegative && <i className="zero" style={{ left: `${zero * 100}%` }} />}
                {!isZero && (
                  <i className={`fill ${tone} ${hover === r.key ? "on" : ""}`}
                     style={{ left: `${left * 100}%`, width: `${Math.max(width * 100, 1.2)}%` }} />
                )}
                <span className={`val dk-n ${isZero ? "is-nil" : ""}`}>{short(r.value)}</span>
              </div>
              <div className="note">{r.note}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Receivables by age — the one sequential ramp on this screen.
 *
 * Round nine had to correct this chart once: 0–30 days was drawn in green,
 * which painted money that has NOT been received as received. It is an
 * amber-to-red ramp now, monotone in luminance, and every segment is labelled
 * because the two palest steps sit under 3:1 against white.
 */
function Ageing({ ageing, total }) {
  const rows = [
    ["d0", "Not yet 30 days", "age-1"],
    ["d31", "31 to 60 days", "age-2"],
    ["d61", "61 to 90 days", "age-3"],
    ["d90", "Over 90 days", "age-4"],
  ];
  const sum = rows.reduce((t, [k]) => t + (Number(ageing[k]) || 0), 0);
  return (
    <section className="dk-card pad cp-chart">
      <h3>Who owes you, and for how long</h3>
      <p className="cp-hint">
        Small shops die of uncollected credit, not of low sales. The further down this
        list money sits, the less of it comes back.
      </p>
      {sum <= 0 ? (
        <div className="dk-empty">Nothing outstanding. Every invoice is settled.</div>
      ) : (
        <>
          <div className="cp-ramp" role="img"
               aria-label={rows.map(([k, l]) => `${l}: ${money(ageing[k] || 0)}`).join(", ")}>
            {rows.map(([k, label, step]) => {
              const v = Number(ageing[k]) || 0;
              if (v <= 0) return null;
              return <i key={k} className={`seg ${step}`} style={{ flexGrow: v }} title={`${label} — ${money(v)}`} />;
            })}
          </div>
          <div className="cp-ramp-key">
            {rows.map(([k, label, step]) => {
              const v = Number(ageing[k]) || 0;
              return (
                <div key={k} className={`k ${v > 0 ? "" : "is-nil"}`}>
                  <i className={`sw ${step}`} />
                  <span className="lb">{label}</span>
                  <span className="vl dk-n">{money(v)}</span>
                </div>
              );
            })}
          </div>
          {(Number(ageing.d90) || 0) > 0 && (
            <p className="cp-warn">
              {money(ageing.d90)} has been outstanding for more than ninety days.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Cash, owed to you, owed by you — three figures, so three figures. */
function Money({ totals }) {
  const net = (Number(totals.cash) || 0) + (Number(totals.receivable) || 0) - (Number(totals.payable) || 0);
  return (
    <section className="dk-card pad cp-chart">
      <h3>Where you stand</h3>
      <p className="cp-hint">Every business added together.</p>
      <div className="cp-stand">
        <Row label="Cash and bank" value={totals.cash} tone="amt-received" />
        <Row label="Owed to you" value={totals.receivable} tone="amt-owed" />
        <Row label="You owe" value={totals.payable} tone="amt-paid" />
        <Row label="Net position" value={net} tone={net >= 0 ? "amt-received" : "amt-overdue"} strong
             flag={net < 0 ? "you owe more than you hold" : null} />
      </div>
    </section>
  );
}

function Row({ label, value, tone, strong, flag }) {
  return (
    <div className={`cp-standrow ${strong ? "is-strong" : ""}`}>
      <span className="l">{label}{flag && <span className="cp-flag">{flag}</span>}</span>
      <span className={`v dk-n ${tone}`}>{money(value)}</span>
    </div>
  );
}

/**
 * The table.
 *
 * Not a fallback for the charts — the figures a shopkeeper acts on are read off
 * a row, not off a bar. It also happens to be what makes every chart above
 * accessible without special provision, which is the right way round.
 */
function Table({ companies, totals, tab, columns }) {
  const TITLES = { sales: "Sales, business by business",
                   stock: "Stock, business by business",
                   expenses: "Expenses and balances, business by business" };
  /* The footer adds up only what adds up. A total row under "Average bill"
     would be the sum of averages, which is not the average of anything. */
  const SUMMABLE = new Set(["Revenue", "Invoices", "Cost of sales", "Profit",
                            "Stock at cost", "Units on hand", "Running low",
                            "Expenses", "Entries", "Owed to you", "You owe"]);
  const isMoney = (c) => c[2] === "money";

  return (
    <section className="dk-card flush">
      <div className="dk-card-head"><h3>{TITLES[tab] || "Every business, side by side"}</h3></div>
      <div className="dk-scrollx">
        <table className="dk-table cp-table">
          <thead>
            <tr>{columns.map((c, i) => (
              <th key={c[0]} className={i === 0 ? "" : "amt"}>{c[0]}</th>
            ))}</tr>
          </thead>
          <tbody>
            {companies.map((co) => (
              <tr key={co.id}>
                {columns.map((c, i) => {
                  const v = c[1](co);
                  if (i === 0) {
                    return (
                      <th scope="row" className="co-name" key={c[0]}>
                        <span className="nm">{v}</span>
                        {co.status !== "active" && <span className="sub">suspended</span>}
                      </th>
                    );
                  }
                  const neg = isMoney(c) && Number(v) < 0;
                  return (
                    <td key={c[0]} className={`amt dk-n ${neg ? "amt-overdue" : ""}`}>
                      {isMoney(c) ? `${neg ? "−" : ""}${money(Math.abs(Number(v) || 0))}` : (v ?? 0)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All businesses</th>
              {columns.slice(1).map((c) => {
                if (!SUMMABLE.has(c[0])) return <td key={c[0]} className="amt">—</td>;
                const sum = companies.reduce((a, co) => a + (Number(c[1](co)) || 0), 0);
                const neg = isMoney(c) && sum < 0;
                return (
                  <td key={c[0]} className={`amt dk-n ${neg ? "amt-overdue" : ""}`}>
                    {isMoney(c) ? `${neg ? "−" : ""}${money(Math.abs(sum))}` : sum}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      {/* `totals` comes from the server and is what the tiles above show; the
          footer here is the sum of the rows on screen. They agree, and saying
          which is which stops anybody wondering why there are two. */}
      <div className="cp-foot-note">Totals are the sum of the rows above, for {tab}.</div>
    </section>
  );
}
