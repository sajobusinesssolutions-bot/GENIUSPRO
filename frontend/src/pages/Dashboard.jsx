import React, { useEffect, useState } from "react";
import api from "../lib/api.js";
import { inr, cur } from "../lib/tax.js";
import { LoadingRows, useRead, LoadFailed } from "../lib/deckui.jsx";

/* ── Dashboard, built to the design deck ───────────────────────────────────
   What a shopkeeper wants before doing anything else: what came in today, how
   it is tracking, who owes money, and what needs doing right now.

   Everything on this screen is one request. The old version already fetched
   most of it; what it did not carry — today's bill count, the hourly curve,
   parked bills and the latest receipts — was added to the same endpoint rather
   than fired off as four more.  */

const money = (v) => `${cur()} ${inr(v)}`;
const nav = (page, sub) => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page, sub } }));

export default function Dashboard() {
  const [d, setD] = useState(null);

  /* The whole screen is one read, so one flag covers every panel: when it is
     raised nothing below renders, and no figure on this page can have come
     out of a failed request. What was missing was the shared wording and a
     way back — the old branch said its own sentence and left you stuck. */
  const [failed, read] = useRead();
  const load = () => { setD(null); read(api.get("/dashboard"), setD, null); };
  useEffect(() => { load(); }, []);

  if (failed) {
    return <div className="dk-card"><LoadFailed what="today's figures" onRetry={load} /></div>;
  }

  const bills = d ? d.billsToday : 0;
  const today = d ? d.todayTotal : 0;
  const yest = d ? d.salesYesterday : 0;
  const delta = yest > 0 ? Math.round(((today - yest) / yest) * 100) : null;

  return (
    <div className="dk-dash">
      <MorningBand d={d} />

      <div className="dk-dash-top">
        <div className="dk-card pad">
          <div className="dk-dash-figs">
            <div style={{ minWidth: 0 }}>
              {/* The takings figure itself now leads the screen in the stat
                  strip above. Repeating it here gave the same number two
                  different sizes on one page, which reads as two figures. */}
              <div className="l">Sales through the day</div>
              <div className="mid dk-n">{d ? money(today) : "\u2014"}</div>
              <div className="s">
                {d ? (
                  <>
                    {bills} bill{bills === 1 ? "" : "s"}
                    {bills > 0 ? ` \u00b7 avg ${money(d.avgBillToday)}` : ""}
                  </>
                ) : "\u00a0"}
              </div>
            </div>
            <div style={{ textAlign: "right", flex: "none" }}>
              <div className="l">In the drawer</div>
              <div className="mid dk-n">{d && d.drawer ? money(d.drawer.expected) : "\u2014"}</div>
              <div className="s">
                {/* The drawer figure covers the open shift, which may have
                    started before today \u2014 say so, or it reads as a second
                    opinion on "sales today". */}
                {d
                  ? d.drawer
                    ? `float ${money(d.drawer.float)} \u00b7 shift since ${String(d.drawer.opened_at || "").slice(0, 16).replace("T", " ") || "\u2014"}`
                    : "no shift open"
                  : "\u00a0"}
              </div>
            </div>
          </div>
          <HourlyChart points={d ? d.hourly : null} />
        </div>

        <div className="dk-dash-side">
          <Receivables d={d} />
          <NeedsYouNow d={d} />
        </div>
      </div>

      <WatchRow d={d} />

      <div className="dk-dash-bottom">
        <BestSellers rows={d ? d.topSellers : null} />
        <LatestBills rows={d ? d.latestBills : null} />
      </div>
    </div>
  );
}

/* ── Small shared pieces ───────────────────────────────────────────────── */

const DAYNAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* "6 Aug", not "2026-08-06" — the caption under a trend strip is read at a
   glance and an ISO date makes the eye stop and parse. */
function shortDate(iso) {
  const s = String(iso || "");
  const p = s.slice(0, 10).split("-");
  if (p.length !== 3) return s;
  return `${+p[2]} ${MONTH[+p[1] - 1] || ""}`;
}
function weekdayOf(iso) {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(t) ? "" : DAYNAME[new Date(t).getDay()];
}

/* A change against a baseline, said in words as well as colour. The arrow and
   the trailing phrase both carry the direction, because a shopkeeper reading
   this in daylight on a cheap screen may not see the green at all. */
function delta(now, base) {
  if (!(base > 0)) return null;
  const pct = Math.round(((now - base) / base) * 100);
  return { pct, up: pct > 0, down: pct < 0,
           arrow: pct > 0 ? "▲" : pct < 0 ? "▼" : "=",
           tone: pct > 0 ? "good" : pct < 0 ? "bad" : "" };
}

/* ── The trend strip ──────────────────────────────────────────────────────
   Fourteen daily bars under a stat block. Deliberately not a line: these are
   fourteen separate days of trade, not a continuous quantity, and a line
   between Saturday and Monday invents a Sunday that never happened.

   Every day keeps its slot. A day with nothing gets a 2px stub in the
   gridline colour, so "we were shut" and "the data is missing" do not look
   the same — and a fortnight of nothing says so in words instead of drawing
   a flat line that could be misread as a small steady trade. */
function Spark({ days, pick, label }) {
  if (!days || !days.length) return <div className="dk-spark" aria-hidden="true" />;
  const vals = days.map((r) => Math.max(0, +pick(r) || 0));
  const peak = Math.max(...vals);
  const W = 160, H = 32, GAP = 2;
  const bw = (W - GAP * (vals.length - 1)) / vals.length;

  if (peak <= 0) {
    return (
      <>
        <svg className="dk-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
             role="img" aria-label={`${label}: nothing in the last ${vals.length} days`}>
          {vals.map((_, i) => (
            <rect key={i} className="zero" x={i * (bw + GAP)} y={H - 2} width={bw} height="2" rx="1" />
          ))}
        </svg>
        <div className="cap">Nothing in the last {vals.length} days</div>
      </>
    );
  }

  return (
    <svg className="dk-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         role="img"
         aria-label={`${label} for each of the last ${vals.length} days, highest ${Math.round(peak)}`}>
      {vals.map((v, i) => {
        const h = v > 0 ? Math.max(3, (v / peak) * (H - 3)) : 2;
        const isToday = i === vals.length - 1;
        return (
          <rect key={i} x={i * (bw + GAP)} y={H - h} width={bw} height={h} rx="1.5"
                className={v > 0 ? `bar${isToday ? " today" : ""}` : "zero"}>
            <title>{`${weekdayOf(days[i].d)} ${shortDate(days[i].d)}: ${money(v)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/* One stat block: label, the figure, a two-line breakdown, the trend strip and
   the caption that says what period the strip covers. */
function Stat({ label, figure, lines, days, pick, sparkLabel, caption }) {
  return (
    <div className="dk-stat">
      <div className="lab">{label}</div>
      <div className="fig dk-n">{figure}</div>
      <div className="brk">
        {lines.map((l, i) => (
          <span key={i} className={l.tone || ""}>
            <b className={l.num ? "dk-n" : ""}>{l.value}</b>
            <span className="k">{l.text}</span>
          </span>
        ))}
      </div>
      {pick && <Spark days={days} pick={pick} label={sparkLabel} />}
      {pick && days && days.some((r) => (+pick(r) || 0) > 0) && (
        <div className="cap">{caption} · trend since {shortDate(days[0].d)}</div>
      )}
    </div>
  );
}

/* ── The morning band ─────────────────────────────────────────────────────
   The first thing on the screen, and the answer to "should I be worried".
   Left: how much of what I invoiced this month has actually reached me.
   Right: today's takings, what I am owed, where the money physically is, and
   what today's trade actually earned after the goods. */
function MorningBand({ d }) {
  const days = d ? d.days : null;
  const m = d ? d.marginToday : null;
  const cash = d ? d.cashAccounts || [] : [];

  const vsYest = d ? delta(d.todayTotal, d.salesYesterday) : null;
  const vsWeek = d ? delta(d.todayTotal, d.lastWeekSame) : null;
  const owedCurrent = d ? +(d.receivable - d.receivableOverdue).toFixed(2) : 0;

  return (
    <div className="dk-dash-band">
      <CollectionGauge d={d} />
      <div className="dk-card pad">
        <div className="dk-statstrip">
          <Stat
            label="Takings today"
            figure={d ? money(d.todayTotal) : "—"}
            lines={d ? [
              vsYest
                ? { value: `${vsYest.arrow} ${Math.abs(vsYest.pct)}%`, text: `vs yesterday (${money(d.salesYesterday)})`, tone: vsYest.tone }
                : { value: "—", text: "nothing sold yesterday to compare" },
              vsWeek
                ? { value: `${vsWeek.arrow} ${Math.abs(vsWeek.pct)}%`, text: `vs same day last week (${money(d.lastWeekSame)})`, tone: vsWeek.tone }
                : { value: "—", text: "no trade this day last week" },
            ] : [{ value: " ", text: "" }, { value: " ", text: "" }]}
            days={days} pick={(r) => r.sales} sparkLabel="Daily takings" caption="Takings each day"
          />
          <Stat
            label="Owed to me"
            figure={d ? money(d.receivable) : "—"}
            lines={d ? [
              { value: money(owedCurrent), text: "still within 30 days", tone: "warn", num: true },
              { value: money(d.receivableOverdue), text: "overdue past 30 days", tone: d.receivableOverdue > 0.005 ? "bad" : "", num: true },
            ] : [{ value: " ", text: "" }, { value: " ", text: "" }]}
            days={days} pick={(r) => r.credit} sparkLabel="Credit given" caption="Sold on credit each day"
          />
          <Stat
            label="Money I hold"
            figure={d ? money(d.cashTotal) : "—"}
            lines={d ? (cash.length
              ? cash.slice(0, 2).map((a) => ({ value: money(a.balance), text: a.name, tone: "good", num: true }))
              : [{ value: "—", text: "no cash or bank account set up" }]
            ) : [{ value: " ", text: "" }, { value: " ", text: "" }]}
            days={days} pick={(r) => r.received} sparkLabel="Money received" caption="Received each day"
          />
          <Stat
            label={`Earned today${m && m.pct !== null ? ` · ${m.pct}% margin` : ""}`}
            figure={d ? money(m.margin) : "—"}
            lines={d ? [
              { value: money(m.revenue), text: "sold, before tax", tone: "good", num: true },
              { value: money(m.cost), text: "cost of those goods", tone: "warn", num: true },
            ] : [{ value: " ", text: "" }, { value: " ", text: "" }]}
            days={days} pick={(r) => r.margin} sparkLabel="Daily gross margin" caption="Earned each day"
          />
        </div>
      </div>
    </div>
  );
}

/* ── Collection gauge ─────────────────────────────────────────────────────
   Of everything invoiced this month, how much has actually been paid. A shop
   can invoice its best month ever and still fail to pay for stock, and this
   is the one number that separates the two. The band is named in words on the
   pill beneath — colour never carries it alone. */
function CollectionGauge({ d }) {
  const invoiced = d ? d.periodSales : 0;
  const got = d ? d.collected : 0;
  const has = invoiced > 0.005;
  const pct = has ? Math.min(100, Math.max(0, (got / invoiced) * 100)) : 0;

  /* Bands chosen from what actually hurts: below half collected the shop is
     financing its customers, and above 85% the book is healthy. */
  const band = !has ? { cls: "none", word: "Nothing invoiced yet" }
    : pct >= 85 ? { cls: "good", word: "Healthy" }
    : pct >= 50 ? { cls: "warn", word: "Watch it" }
    : { cls: "bad", word: "Too much on credit" };

  const R = 82, CX = 100, CY = 96, SW = 15;
  const arc = Math.PI * R;                       // a half circle's length
  const track = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
  const stroke = band.cls === "good" ? "var(--good)"
    : band.cls === "warn" ? "var(--warnc)"
    : band.cls === "bad" ? "var(--danger)" : "var(--line)";

  return (
    <div className="dk-card pad">
      <h3 style={{ margin: "0 0 4px", fontSize: 13.5, fontWeight: 650 }}>Invoiced money actually collected</h3>
      <div className="dk-gauge">
        <svg viewBox="0 0 200 118" role="img"
             aria-label={has
               ? `${Math.round(pct)} percent of this month's invoices collected — ${band.word}`
               : "No invoices raised this month yet"}>
          <path d={track} fill="none" stroke="var(--sunk)" strokeWidth={SW} strokeLinecap="round" />
          {has && (
            <path d={track} fill="none" stroke={stroke} strokeWidth={SW} strokeLinecap="round"
                  strokeDasharray={`${(arc * pct) / 100} ${arc}`} />
          )}
          {/* The two ends of the dial, so the reader knows what a full arc means. */}
          <text x={CX - R} y={CY + 18} textAnchor="middle" fontSize="10" fill="var(--faint)">0%</text>
          <text x={CX + R} y={CY + 18} textAnchor="middle" fontSize="10" fill="var(--faint)">100%</text>
        </svg>
        <div className="val dk-n">{has ? `${Math.round(pct)}%` : "—"}</div>
        <div className={`st ${band.cls}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {band.cls === "good" ? <path d="M5 13l4.5 4.5L19 7" />
              : band.cls === "none" ? <path d="M5 12h14" />
              : <><path d="M12 7v7" /><path d="M12 17.5v.01" /></>}
          </svg>
          {band.word}
        </div>
        <div className="why">
          {!d ? " " : has
            ? <>You invoiced {money(invoiced)} this month and {money(got)} of it has reached you. The rest, {money(Math.max(0, invoiced - got))}, is still with your customers.</>
            : "No sales have been invoiced this month, so there is nothing to collect yet."}
        </div>
      </div>
    </div>
  );
}

/* ── The watch row ────────────────────────────────────────────────────────
   Cards that exist only when the shop runs that part of the business. A firm
   with purchases, loyalty or manufacturing switched off gets no empty box for
   it — the server does not even run those queries. */
function WatchRow({ d }) {
  if (!d) return null;
  const mods = d.mods || {};
  const cards = [];

  if (mods.purchases) {
    const p = d.payables || { total: 0, overdue: 0, bills: 0, nextDue: null };
    cards.push(
      <div className="dk-card pad dk-watch" key="pay">
        <h3>What I owe suppliers</h3>
        <div className="fig dk-n">{money(p.total)}</div>
        {p.total > 0.005 ? (
          <div className="rows">
            <div><span>Across</span><b className="dk-n">{p.bills} bill{p.bills === 1 ? "" : "s"}</b></div>
            <div className={p.overdue > 0.005 ? "bad" : ""}>
              <span>{p.overdue > 0.005 ? "Already past due" : "None past due"}</span>
              <b className="dk-n">{money(p.overdue)}</b>
            </div>
            {p.nextDue && <div><span>Earliest due</span><b className="dk-n">{shortDate(p.nextDue)}</b></div>}
          </div>
        ) : <div className="note">Every supplier bill is settled.</div>}
      </div>
    );
  }

  if (mods.inventory) {
    const low = (d.lowStock || []).length;
    const dead = d.deadStock || { count: 0, value: 0 };
    cards.push(
      <div className="dk-card pad dk-watch" key="stock">
        <h3>Stock on the shelf</h3>
        <div className="fig dk-n">{money(d.stockValue)}</div>
        <div className="rows">
          <div className={low > 0 ? "bad" : ""}>
            <span>{low > 0 ? "At or below reorder level" : "Nothing below reorder level"}</span>
            <b className="dk-n">{low}</b>
          </div>
          <div className={d.expiringCount > 0 ? "warn" : ""}>
            <span>Expiring within {d.expiryAlertDays} days</span>
            <b className="dk-n">{d.expiringCount} · {money(d.expiringValue)}</b>
          </div>
          <div>
            {/* Not a fault, but it is money that has stopped moving — and the
                only way most shops notice is by tripping over the box. */}
            <span>Unsold for 60 days</span>
            <b className="dk-n">{dead.count} · {money(dead.value)}</b>
          </div>
        </div>
        <div className="note">Stock value is at what you paid for it, not what you will sell it for.</div>
      </div>
    );
  }

  cards.push(
    <div className="dk-card pad dk-watch" key="day">
      <h3>Today at the counter</h3>
      <div className="fig dk-n">{d.billsToday} bill{d.billsToday === 1 ? "" : "s"}</div>
      <div className="rows">
        <div><span>Average bill</span><b className="dk-n">{d.billsToday > 0 ? money(d.avgBillToday) : "—"}</b></div>
        {mods.expenses && (
          <div className={d.expensesToday > 0.005 ? "warn" : ""}>
            <span>Paid out today</span><b className="dk-n">{money(d.expensesToday)}</b>
          </div>
        )}
        {mods.shifts && (
          <div className={d.drawer ? "good" : ""}>
            <span>{d.drawer ? "Till open · drawer should hold" : "No till shift open"}</span>
            <b className="dk-n">{d.drawer ? money(d.drawer.expected) : "—"}</b>
          </div>
        )}
      </div>
      {d.busyHours && (
        <div className="note">
          Over the last 30 days you sold between {String(d.busyHours.open).padStart(2, "0")}:00 and{" "}
          {String(d.busyHours.close + 1).padStart(2, "0")}:00, busiest at{" "}
          {String(d.busyHours.peak).padStart(2, "0")}:00.
        </div>
      )}
    </div>
  );

  if (mods.loyalty && d.loyalty) {
    const l = d.loyalty;
    cards.push(
      <div className="dk-card pad dk-watch" key="loyalty">
        <h3>Loyalty points</h3>
        <div className="fig dk-n">{Math.round(l.outstanding)}</div>
        <div className="rows">
          <div className="good"><span>Earned today</span><b className="dk-n">{Math.round(l.earnedToday)}</b></div>
          <div className="warn"><span>Redeemed today</span><b className="dk-n">{Math.round(l.redeemedToday)} · {money(l.redeemedValue)}</b></div>
        </div>
        <div className="note">Outstanding points are a discount your customers can claim at any time.</div>
      </div>
    );
  }

  if (mods.manufacturing && d.production) {
    const p = d.production;
    cards.push(
      <div className="dk-card pad dk-watch" key="prod">
        <h3>Made today</h3>
        <div className="fig dk-n">{p.runs} run{p.runs === 1 ? "" : "s"}</div>
        <div className="rows">
          <div><span>Units produced</span><b className="dk-n">{inr(p.qty)}</b></div>
          <div className="warn"><span>Cost of the run</span><b className="dk-n">{money(p.value)}</b></div>
        </div>
        {p.runs === 0 && <div className="note">Nothing has been produced today.</div>}
      </div>
    );
  }

  return <div className="dk-dash-watch">{cards}</div>;
}

/* ── The day's curve ──────────────────────────────────────────────────────
   An area under a line, drawn from the hour-by-hour takings. Flat where
   nothing sold, which is the point — a gap in the morning is information. */
function HourlyChart({ points }) {
  const gradId = React.useId();
  if (!points) return <div className="dk-chart" style={{ height: 190 }} />;

  const W = 760, H = 160, PAD = 6;
  const peak = Math.max(...points.map((p) => p.value), 1);
  const x = (i) => PAD + (i * (W - PAD * 2)) / Math.max(points.length - 1, 1);
  const y = (v) => H - PAD - (v / peak) * (H - PAD * 2);

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;

  /* Mark the busiest hour — the one thing on this curve worth pointing at. */
  const peakIdx = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);
  const anySales = points.some((p) => p.value > 0);

  return (
    <div className="dk-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
           aria-label="Sales through the day">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity=".22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[40, 85, 130].map((gy) => (
          <line key={gy} x1="0" x2={W} y1={gy} y2={gy} stroke="var(--line)" strokeWidth="1" />
        ))}
        {anySales && <path d={area} fill={`url(#${gradId})`} />}
        {anySales && <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.5"
                           strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {anySales && <circle cx={x(peakIdx)} cy={y(points[peakIdx].value)} r="4.5" fill="var(--accent)" />}
      </svg>
      <div className="axis dk-n">
        {[0, Math.floor(points.length / 3), Math.floor((points.length * 2) / 3), points.length - 1].map((i) => (
          <span key={i}>{String(points[i].hour).padStart(2, "0")}:00</span>
        ))}
      </div>
    </div>
  );
}

/* ── Money owed to me ─────────────────────────────────────────────────── */
function Receivables({ d }) {
  const a = d ? d.ageing : null;
  const total = a ? a.d30 + a.d60 + a.d90 + a.d90p : 0;
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);

  /* The bar is a share of everything owed, so a bucket that holds the lot
     fills it — which on its own says nothing. Rather than rescale against
     something the bar is not measuring, name what a full bar means: when one
     bucket carries the whole book, the caption says which one. */
  const BUCKETS = a
    ? [["0–30 days", a.d30], ["31–60 days", a.d60], ["61–90 days", a.d90], ["over 90 days", a.d90p]]
    : [];
  const live = BUCKETS.filter(([, v]) => v > 0.005);
  const caption = live.length === 1
    ? `All of it sits in ${live[0][0]}`
    : `Spread across ${live.length} age bands`;

  return (
    <div className="dk-card pad">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 650 }}>How old the money owed is</h3>
        <button className="dk-linkbtn" onClick={() => nav("parties")}>Collect ▸</button>
      </div>
      <div className="dk-n" style={{ fontSize: 32, fontWeight: 750, letterSpacing: "-.02em" }}>
        {d ? money(d.receivable) : "—"}
      </div>
      {a && total > 0 ? (
        <>
          <div className="dk-age-bar">
            <i className="seg-age1" style={{ width: `${pct(a.d30)}%` }} />
            <i className="seg-age2" style={{ width: `${pct(a.d60)}%` }} />
            <i className="seg-age3" style={{ width: `${pct(a.d90)}%` }} />
            <i className="seg-age4" style={{ width: `${pct(a.d90p)}%` }} />
          </div>
          <div className="dk-splitlegend">
            <span>{caption}</span>
            <span className="dk-n">of {money(total)}</span>
          </div>
          <div className="dk-age-grid">
            <div><span>0–30 days</span><b className="dk-n">{inr(a.d30)}</b></div>
            <div><span>31–60</span><b className="dk-n">{inr(a.d60)}</b></div>
            <div><span>61–90</span><b className="dk-n">{inr(a.d90)}</b></div>
            {/* The four cells differ only by the range they name, and the red
                on this one was the only thing marking it as the bad bucket. */}
            <div className="old"><span>Over 90 · overdue</span><b className="dk-n">{inr(a.d90p)}</b></div>
          </div>
        </>
      ) : (
        <div style={{ marginTop: 14, fontSize: 12.5, color: "var(--faint)" }}>
          {d ? "Nobody is carrying a balance." : "\u00a0"}
        </div>
      )}
    </div>
  );
}

/* ── Needs you now ────────────────────────────────────────────────────────
   Only what is actually true. An empty list is a good day, and says so
   rather than showing three rows of zeroes. */
function NeedsYouNow({ d }) {
  const items = [];
  if (d) {
    if (d.lowStock && d.lowStock.length) {
      items.push({
        tone: "bad", n: d.lowStock.length,
        title: `Item${d.lowStock.length === 1 ? "" : "s"} at or below reorder`,
        detail: d.lowStock.slice(0, 3).map((i) => i.name).join(" · "),
        cta: "Order ▸", go: () => nav("purchases"),
      });
    }
    if (d.expiringCount > 0) {
      items.push({
        tone: "warn", n: d.expiringCount,
        title: `Batch${d.expiringCount === 1 ? "" : "es"} expiring in ${d.expiryAlertDays} days`,
        detail: `${money(d.expiringValue)} at risk`,
        cta: "View ▸", go: () => nav("items"),
      });
    }
    if (d.held && d.held.length) {
      const h = d.held[0];
      items.push({
        tone: "", n: d.held.length,
        title: d.held.length === 1 ? `Held bill from ${String(h.created_at || "").slice(11, 16)}` : "Bills held at the till",
        detail: `${h.label || "Bill"} · ${money(h.total_hint)}`,
        cta: "Resume ▸", go: () => nav("pos"),
      });
    }
  }

  return (
    <div className="dk-card pad">
      <h3 style={{ margin: "0 0 16px", fontSize: 13.5, fontWeight: 650 }}>Needs you now</h3>
      {!d ? <div style={{ height: 60 }} /> : items.length === 0 ? (
        <div className="dk-todo-clear">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 13l4.5 4.5L19 7" />
          </svg>
          Nothing needs you — stock is fine and no bills are parked.
        </div>
      ) : (
        <div className="dk-todo">
          {items.map((it, i) => (
            <div className={`dk-todo-row ${it.tone}`} key={i}>
              <span className="n dk-n">{it.n}</span>
              <div className="t">
                <div>{it.title}</div>
                <div>{it.detail}</div>
              </div>
              <button onClick={it.go}>{it.cta}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Best sellers ─────────────────────────────────────────────────────── */
function BestSellers({ rows }) {
  const peak = rows && rows.length ? Math.max(...rows.map((r) => +r.revenue || 0), 1) : 1;
  return (
    <div className="dk-card flush">
      <div className="dk-card-head">
        <h3>Best sellers this month</h3>
        <button className="dk-linkbtn" onClick={() => nav("items")}>All items ▸</button>
      </div>
      {rows === null ? <div className="dk-empty">Counting…</div>
        : rows.length === 0 ? <div className="dk-empty">Nothing has sold this month yet.</div> : (
        <div className="dk-rank">
          {rows.map((r, i) => (
            <div className="dk-rank-row" key={i}>
              <span className="no dk-n">{String(i + 1).padStart(2, "0")}</span>
              <div className="who">
                <div>{r.name}</div>
                <div className="dk-n">
                  {/* Period and unit spelled out, so this figure and the item
                      screen's own count cannot be read against each other by
                      accident. */}
                  {Math.round(+r.qty || 0)}{r.unit ? ` ${r.unit}` : ""} sold this month
                  {r.on_hand != null ? ` · ${Math.round(+r.on_hand)} ${r.unit || ""} left` : ""}
                </div>
              </div>
              <div className="bar"><i style={{ width: `${((+r.revenue || 0) / peak) * 100}%` }} /></div>
              <b className="dk-n">{money(r.revenue)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Latest bills ─────────────────────────────────────────────────────── */
function LatestBills({ rows }) {
  const label = (b) => b.status === "voided" ? "voided"
    : b.balance_due > 0.005 ? (b.paid_amount > 0 ? "partial" : "credit")
    : (b.payment_type || "paid");
  const tone = (b) => b.status === "voided" ? ""
    : b.balance_due > 0.005 ? "warn" : "good";

  return (
    <div className="dk-card flush">
      <div className="dk-card-head">
        <h3>Latest bills</h3>
        <button className="dk-linkbtn" onClick={() => nav("invoices")}>All sales ▸</button>
      </div>
      <div className="dk-tablewrap dk-s">
        <table className="dk-table">
          <thead>
            <tr><th>Invoice</th><th>Customer</th><th>Time</th><th>Tender</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            {rows === null ? <LoadingRows cols={5} n={5} />
              : rows.length === 0 ? (
                <tr><td colSpan={5}><div className="dk-empty">Nothing sold yet.</div></td></tr>
              ) : rows.map((b) => (
                <tr key={b.id} className={b.status === "voided" ? "void" : ""}>
                  {/* "INV-000002" was wrapping after the hyphen and doubling the
                     row height. The number is one token; it must not break. */}
                  <td className="dk-n strong" style={{ whiteSpace: "nowrap" }}>{b.invoice_no}</td>
                  <td className="tight">{b.party_name}</td>
                  <td className="tight dk-n dim">{String(b.created_at || "").slice(11, 16) || b.invoice_date}</td>
                  <td className="tight"><span className={`dk-tpill ${tone(b)}`}>{label(b)}</span></td>
                  <td className={`r dk-n ${b.status === "voided" ? "amt-void" : "strong"}`}>{inr(b.grand_total)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
