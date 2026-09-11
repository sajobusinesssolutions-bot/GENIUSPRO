import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";
import { inr, cur} from "../lib/tax.js";
import { Empty, DateRangePicker, CountUp } from "../lib/ui.jsx";
import { ReportTable, ReportPrintHeader, ReportPrintStyles, TotalsBand } from "../lib/reportshell.jsx";
import { useRead, LoadFailed } from "../lib/deckui.jsx";
import { printReportNode } from "../lib/print.js";

const money = (v) => `${cur()} ${inr(v)}`;

const REPORTS = [
  // Sales
  { id: "day-close", title: "Z report · End of day", sub: "Close the day — takings by mode and cashier", group: "Sales" },
  { id: "x-report", title: "X report", sub: "Today so far, without closing", group: "Sales" },
  { id: "sale-summary", title: "Sale summary", sub: "All invoices with tax & dues", group: "Sales" },
  { id: "daily-sales", title: "Daily sales", sub: "Totals per day in the range", group: "Sales" },
  { id: "hourly-sales", title: "Hourly sales", sub: "Which hours sell the most", group: "Sales" },
  { id: "invoice-list", title: "Invoice list", sub: "Every sale invoice in the range", group: "Sales" },
  { id: "item-sales", title: "Item list (units sold)", sub: "Quantity & revenue per item", group: "Sales" },
  { id: "sales-by-category", title: "Sales by category", sub: "Product groups ranked by revenue", group: "Sales" },
  { id: "sales-by-customer", title: "Sales by customer", sub: "Who buys the most", group: "Sales" },
  { id: "sales-by-user", title: "Sales by cashier", sub: "Bills & totals per user", group: "Sales" },
  { id: "sale-summary-by-user", title: "Sale summary by user", sub: "Items, sales, tax, discounts, commission per rep", group: "Sales" },
  { id: "sale-summary-by-category-item", title: "Sale summary by category & item", sub: "Every item under its category with qty, tax & running", group: "Sales" },
  { id: "user-profit", title: "User sales & profit", sub: "Revenue, cost, profit & margin per rep (date range)", group: "Sales" },
  { id: "user-hourly", title: "User sales by hour", sub: "When each rep sells through the day", group: "Sales" },
  { id: "user-time", title: "User time on shift", sub: "Hours worked & average shift length per user", group: "Sales" },
  { id: "bill-profit", title: "Bill-wise profit", sub: "Profit earned on each invoice", group: "Sales" },
  { id: "sales-by-items", title: "Sales by items (per bill)", sub: "Each sale grouped, with per-line profit", group: "Sales" },
  { id: "profit-margin", title: "Profit & margin", sub: "Revenue vs cost per item", group: "Sales" },
  { id: "discounts-granted", title: "Discounts granted", sub: "Every discounted line, who and how much", group: "Sales" },
  { id: "refunds", title: "Refunds", sub: "Credit notes issued in the range", group: "Sales" },
  { id: "voided-items", title: "Voided items", sub: "Everything voided at the till, by whom and why", group: "Sales" },
  // Purchase
  { id: "purchase-summary", title: "Purchase summary", sub: "All supplier bills", group: "Purchase" },
  { id: "bill-list", title: "Purchase bill list", sub: "Every supplier bill in the range", group: "Purchase" },
  { id: "purchase-by-item", title: "Purchases by product", sub: "What you bought, ranked by spend", group: "Purchase" },
  { id: "purchase-by-supplier", title: "Purchases by supplier", sub: "Spend & dues per supplier", group: "Purchase" },
  { id: "unpaid-purchases", title: "Unpaid purchases", sub: "What you owe suppliers, with age", group: "Purchase" },
  // Money
  { id: "cash-flow", title: "Cash flow", sub: "Money in & out of cash/bank", group: "Money" },
  { id: "payment-types", title: "Payment types", sub: "Tender totals — cash, mobile, card", group: "Money" },
  { id: "payment-types-by-user", title: "Payment types by user", sub: "Tender split per cashier", group: "Money" },
  { id: "payment-types-by-customer", title: "Payment types by customer", sub: "How each customer pays", group: "Money" },
  { id: "drawer-entries", title: "Drawer cash entries", sub: "POS cash in / out with reasons", group: "Money" },
  { id: "unpaid-sales", title: "Unpaid sales", sub: "Open customer balances with age", group: "Money" },
  /* Receivables & payables (Zoho Books report set) */
  { id: "ar-aging-summary", title: "AR Aging Summary", sub: "What each customer owes, by how overdue", group: "Receivables" },
  { id: "ar-aging-details", title: "AR Aging Details", sub: "Every open invoice with its age", group: "Receivables" },
  { id: "invoice-details", title: "Invoice Details", sub: "Every invoice in the range and how much is settled", group: "Receivables" },
  { id: "quote-details", title: "Quote Details", sub: "Estimates and orders with their status", group: "Receivables" },
  { id: "customer-balance-summary", title: "Customer Balance Summary", sub: "Invoiced, paid and still owing per customer", group: "Receivables" },
  { id: "receivable-summary", title: "Receivable Summary", sub: "The whole debtors book in age buckets", group: "Receivables" },
  { id: "receivable-details", title: "Receivable Details", sub: "Flat list of everything owed to you, oldest first", group: "Receivables" },
  { id: "ap-aging-summary", title: "AP Aging Summary", sub: "What you owe each supplier, by how overdue", group: "Payables" },
  { id: "ap-aging-details", title: "AP Aging Details", sub: "Every open bill with its age", group: "Payables" },
  { id: "supplier-balance-summary", title: "Supplier Balance Summary", sub: "Billed, paid and still owing per supplier", group: "Payables" },
  { id: "payable-summary", title: "Payable Summary", sub: "The whole creditors book in age buckets", group: "Payables" },
  { id: "payable-details", title: "Payable Details", sub: "Flat list of everything you owe, oldest first", group: "Payables" },
  // Stock
  { id: "stock-summary", title: "Stock summary", sub: "Quantity & value of every item", group: "Stock" },
  { id: "stock-movement", title: "Stock movement", sub: "Every in/out with document reference", group: "Stock" },
  { id: "low-stock", title: "Low stock", sub: "Items at or below reorder level", group: "Stock" },
  { id: "reorder-list", title: "Reorder product list", sub: "What to buy now, with suggested quantity", group: "Stock" },
  { id: "expiry", title: "Batch / expiry", sub: "Tracked batches by days to expiry", group: "Stock" },
  { id: "loss-damage", title: "Loss & damage", sub: "Stock written off by adjustment, with value", group: "Stock" },
  { id: "fast-moving", title: "Fast-moving products", sub: "Best sellers with current stock & prices", group: "Stock" },
  { id: "slow-moving", title: "Slow-moving products", sub: "Holding stock with no sales in range", group: "Stock" },
  { id: "stock-adjustment", title: "Stock adjustment by item", sub: "Recounts grouped by reference, value up/down", group: "Stock" },
  // Tax & books
  { id: "tax-summary", title: "Tax summary", sub: "WHT & VAT levied — sales vs purchases", group: "Tax & books" },
  { id: "party-statement", title: "Party statement", sub: "Running ledger for any party", group: "Tax & books" },
  { id: "trial-balance", title: "Trial balance", sub: "All accounts — Dr must equal Cr", group: "Tax & books" },
  { id: "general-ledger", title: "General ledger", sub: "Every account: opening, debit, credit, closing", group: "Tax & books" },
  { id: "zreport-summary", title: "Zreport summary", sub: "Sales, journals, payouts and expected cash", group: "Tax & books" },
];

/* Group order across the top. Anything in REPORTS with a group not listed here
   simply would not appear, so the two are checked against each other below. */
const GROUP_ORDER = ["Sales", "Purchase", "Money", "Receivables", "Payables", "Stock", "Tax & books"];

/* Reports that read a position at a single date rather than over a period. */
const AS_OF = ["ar-aging-summary", "ar-aging-details", "ap-aging-summary", "ap-aging-details",
               "customer-balance-summary", "supplier-balance-summary",
               "receivable-summary", "receivable-details", "payable-summary", "payable-details"];
/* Reports that take no dates at all — they describe how things stand now. */
const UNDATED = ["stock-summary", "low-stock", "trial-balance", "party-statement", "expiry",
                 "x-report", "unpaid-sales", "unpaid-purchases", "reorder-list"];

/* The three staff boards, and the tab each one opens. */
const STAFF_VIEWS = [
  ["today",       "On today",           "Who is signed on, hours so far, sales per staff hour"],
  ["performance", "What they sold",     "Revenue, bills and profit per person for a month"],
  ["commission",  "What they are owed", "Commission and pay worked out from the month's sales"],
];

const FAV_KEY = "vy_report_favs";
const RECENT_KEY = "vy_report_recent";
const readList = (k) => {
  try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
};

const thisMonth = () => {
  const d = new Date();
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return { from, to: d.toISOString().slice(0, 10) };
};

/* ── The reports browser ──────────────────────────────────────────────────
 *
 * Sixty-six reports behind two levels of navigation — a row of group tabs
 * across the top, and a list of that group's reports below it — meant you had
 * to know which of seven groups a report was filed under before you could look
 * for it, and there was no way to search. "Voided items" is a Sales report;
 * nobody guesses that first time.
 *
 * The tabs are gone. There is one column: a search box, then the reports you
 * starred, then the ones you ran recently, then every group as a labelled
 * band. Starring and recency were already being recorded — both lists were
 * written to localStorage by the old screen and then never drawn anywhere,
 * which is the whole value of keeping them thrown away.
 *
 * Searching matches the title, the description and the group, so "vat", "who
 * owes" and "stock" all land somewhere sensible.
 */
export default function Reports({ initial }) {
  const first = initial ? REPORTS.find((r) => r.id === initial) : null;
  const [active, setActive] = useState(first || REPORTS[0]);
  const [favs, setFavs] = useState(() => readList(FAV_KEY));
  const [recent, setRecent] = useState(() => readList(RECENT_KEY));
  const [q, setQ] = useState("");

  const byId = useMemo(() => new Map(REPORTS.map((r) => [r.id, r])), []);

  const open = (r) => {
    const next = [r.id, ...recent.filter((x) => x !== r.id)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
    setActive(r);
  };
  const toggleFav = (id) => {
    const next = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    setFavs(next);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch {}
  };

  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => (needle.length < 2 ? null : REPORTS.filter((r) =>
    [r.title, r.sub, r.group].some((f) => f.toLowerCase().includes(needle)))), [needle]);

  /* Rendered the same way in every band, so a starred report and the same
     report down in its group are visibly one thing. */
  const Row = (r) => (
    <button key={r.id} className={`dk-rp-item ${active && active.id === r.id ? "on" : ""}`}
            aria-current={active && active.id === r.id ? "true" : undefined}
            onClick={() => open(r)}>
      <span className="txt">
        <span className="t">{r.title}</span>
        <span className="s">{r.sub}</span>
      </span>
      <span className={`star ${favs.includes(r.id) ? "on" : ""}`} role="button" tabIndex={-1}
            title={favs.includes(r.id) ? "Remove from favourites" : "Add to favourites"}
            onClick={(e) => { e.stopPropagation(); toggleFav(r.id); }}>
        {favs.includes(r.id) ? "★" : "☆"}
      </span>
      <span className="go" aria-hidden="true">›</span>
    </button>
  );

  const Band = ({ title, note, rows }) => (rows.length ? (
    <div className="dk-rp-band">
      <div className="cap">{title}<span className="n dk-n">{rows.length}</span></div>
      {note && <div className="nt">{note}</div>}
      {rows.map(Row)}
    </div>
  ) : null);

  const favRows = favs.map((id) => byId.get(id)).filter(Boolean);
  const recentRows = recent.map((id) => byId.get(id)).filter(Boolean)
    /* A report that is already starred is one row up the screen. Printing it
       twice makes the top of the list look like a bug. */
    .filter((r) => !favs.includes(r.id));

  return (
    <div className="dk-page">
    <div className="dk-rp">
      <div className="dk-card flush dk-rp-nav">
        <div className="dk-rp-find">
          <input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder={`Search ${REPORTS.length} reports…`}
                 aria-label="Search every report" />
          {q && <button onClick={() => setQ("")} aria-label="Clear the search">✕</button>}
        </div>

        <div className="dk-list dk-s">
          {hits ? (
            hits.length
              ? <Band title={`${hits.length} matching “${q.trim()}”`} rows={hits} />
              : (
                <div className="dk-empty">
                  Nothing matches “{q.trim()}”.<br />
                  Try what the report is about — “vat”, “stock”, “who owes me”.
                </div>
              )
          ) : (
            <>
              <Band title="Starred" rows={favRows} />
              <Band title="Recently run" rows={recentRows} />
              {GROUP_ORDER.filter((g) => REPORTS.some((r) => r.group === g)).map((g) => (
                <Band key={g} title={g} rows={REPORTS.filter((r) => r.group === g)} />
              ))}

              {/* Staff used to be a rail entry: three tabs of figures about
                  people — who is on, what they sold, what they are owed. That
                  is a report, not a place you go to do something, so it is
                  filed with the other reports. These three open the staff
                  screen rather than the pane on the right, because they are
                  live boards rather than a table over a date range. */}
              <div className="dk-rp-band">
                <div className="cap">Staff<span className="n dk-n">3</span></div>
                <div className="nt">Opens the staff board — live figures rather than a table over a range.</div>
                {STAFF_VIEWS.map(([sub, title, note]) => (
                  <button key={sub} className="dk-rp-item"
                          onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", {
                            detail: { page: "staff", sub },
                          }))}>
                    <span className="txt">
                      <span className="t">{title}</span>
                      <span className="s">{note}</span>
                    </span>
                    <span className="go" aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
              {!favRows.length && (
                <div className="dk-rp-tip">
                  Tap the ☆ beside a report to keep it at the top of this list.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {active ? <ReportPane key={active.id} report={active} /> : (
        <div className="dk-card"><div className="dk-empty">Pick a report.</div></div>
      )}
    </div>
    </div>
  );
}

/* ── One report ───────────────────────────────────────────────────────── */
function ReportPane({ report }) {
  const dated = !UNDATED.includes(report.id);
  const asOfOnly = AS_OF.includes(report.id);
  const [{ from, to }, setRange] = useState(thisMonth());
  const [partyId, setPartyId] = useState("");
  const [parties, setParties] = useState([]);
  const [data, setData] = useState(null);
  const [firm, setFirm] = useState({});
  const [stg, setStg] = useState({});

  useEffect(() => {
    api.get("/settings/firm").then((f) => setFirm(f || {})).catch(() => {});
    api.get("/settings").then((d) => setStg(d.values || {})).catch(() => {});
  }, []);

  useEffect(() => {
    if (report.id === "party-statement") {
      api.get("/parties").then((p) => { setParties(p); if (p[0]) setPartyId(String(p[0].id)); }).catch(() => {});
    }
  }, [report.id]);

  /* `setData({ rows: [] })` was the worst shape of this bug in the app: it
     rendered every report as a report that found nothing — and, because the
     bodies read `d.totals.*`, several of them threw on the way. */
  const [failed, read] = useRead();
  const load = () => {
    setData(null);
    let path = `/reports/${report.id === "x-report" ? "day-close" : report.id}`;
    if (report.id === "party-statement") { if (!partyId) return; path += `/${partyId}`; }
    if (dated) path += `?from=${from}&to=${to}`;
    read(api.get(path), setData, null);
  };
  useEffect(load, [report.id, from, to, partyId, dated]);

  const band = data && !failed ? bandFrom(data.totals) : [];
  const headline = band[0] || null;

  const period = !dated ? "All records"
    : asOfOnly ? `As at ${to}`
    : `${from || "start"} to ${to || "today"}`;

  /* What goes on paper. The report is printed as its own document rather than
     by calling window.print() on the app, which is what put the browser's URL
     and date across the top of every report a shop ever handed a customer. */
  const paper = React.useRef(null);

  return (
    <div className="dk-card dk-tablecard" ref={paper}>
      <div className="dk-rp-head">
        <div style={{ minWidth: 0 }}>
          <h3>{report.title}</h3>
          <div className="sub">{firm.name || "This shop"} · {period}</div>
        </div>
        {headline && (
          <div className="dk-rp-fig">
            <div className="l">{headline.label}</div>
            <div className="v dk-n" style={{
              color: headline.tone === "bad" ? "var(--danger)" : headline.tone === "ok" ? "var(--good)" : undefined,
            }}>{headline.value}</div>
          </div>
        )}
      </div>

      <div className="dk-tablehead">
        {report.id === "party-statement" && (
          <select className="dk-input" style={{ width: 240, height: 38 }}
                  value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {dated && (asOfOnly ? (
          <label className="dk-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <span style={{ letterSpacing: 0, textTransform: "none", fontSize: 12.5, fontWeight: 500 }}>As at</span>
            <input type="date" className="dk-input" style={{ width: 160, height: 38 }}
                   value={to} onChange={(e) => setRange({ from, to: e.target.value })} />
          </label>
        ) : (
          <DateRangePicker from={from} to={to} onChange={(r) => setRange(r)} />
        ))}
        {/* A report that takes no dates left this bar holding nothing but a
            Print button, which read as a date picker that had failed to load.
            It now says why there is nothing to set. */}
        {!dated && (
          <span className="dk-rp-nodate">
            This one describes how things stand now, so there is no date range to set.
          </span>
        )}
        <div className="spacer" />
        <button className="dk-sbtn" onClick={load} disabled={data === null && !failed}>
          {data === null && !failed ? "Running…" : "Refresh"}
        </button>
        <button className="dk-sbtn" onClick={() => printReportNode(paper.current, {
          title: report.title, caption: `${firm.name || "This shop"} · ${period}`, firm,
        })}>Print</button>
      </div>

      <ReportPrintStyles />
      <ReportPrintHeader firm={firm} settings={stg} title={report.title} caption={period} />
      {band.length > 1 && <TotalsBand items={band} />}

      <div className="dk-rp-body dk-s">
        {failed ? <LoadFailed what="this report" onRetry={load} />
          /* A skeleton rather than the words "Running the report…". A report
             over a year of sales takes a couple of seconds, and a line of grey
             text in the middle of an empty card reads as a report that found
             nothing rather than one that has not arrived. */
          : data === null
          ? (
            /* Bars, not `SkeletonRows` — that one returns <tr> elements and is
               only valid inside a <table>. */
            <div className="dk-rp-wait" aria-live="polite" aria-label="Running the report">
              {[...Array(8)].map((_, i) => <span className="sk" key={i} />)}
            </div>
          )
          : <Body id={report.id} d={data} />}
      </div>

      <div className="dk-ledger-foot">
        <span className="note">{report.sub}</span>
      </div>
    </div>
  );
}

/* Thin alias kept so the ten report bodies below need no edits — the shared
   shell supplies sorting, the column picker, CSV export and row numbering. */
function Table(props) {
  return <ReportTable {...props} />;
}


/* Every report already returns a `totals` object, so the band is wired once
   here rather than in each of the fifty-odd report bodies. Counts stay plain
   integers; everything else is money. Capped at five so a report with a dozen
   aging buckets does not turn the band into a second table. */
const TOTAL_LABELS = {
  grand_total: "Total", grand: "Total", total: "Total", amount: "Amount",
  paid_amount: "Received", received: "Received", balance_due: "Outstanding",
  due: "Outstanding", tax: "Tax", profit: "Profit", cost: "Cost",
  qty: "Quantity", quantity: "Quantity", documents: "Documents",
  count: "Count", money_in: "Money in", money_out: "Money out",
  opening: "Opening", closing: "Closing", value: "Value",
};
const COUNT_KEYS = new Set(["documents", "count", "qty", "quantity"]);
const TOTAL_ORDER = ["grand_total", "grand", "total", "amount", "money_in", "money_out",
                     "paid_amount", "received", "balance_due", "due", "tax", "profit"];

function bandFrom(totals) {
  if (!totals || typeof totals !== "object") return [];
  const keys = Object.keys(totals).filter((k) => {
    const v = totals[k];
    return (typeof v === "number" || (typeof v === "string" && v !== "")) && TOTAL_LABELS[k];
  });
  keys.sort((a, b) => {
    const ia = TOTAL_ORDER.indexOf(a), ib = TOTAL_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return keys.slice(0, 5).map((k) => ({
    label: TOTAL_LABELS[k],
    value: COUNT_KEYS.has(k) ? String(totals[k]) : money(totals[k]),
    tone: k === "balance_due" || k === "due" ? "bad" : k === "profit" ? "ok" : null,
  }));
}

function Body({ id, d }) {
  /* Aging summary/details share a shape across the receivable and payable sides. */
  const agingSummaryTable = (who) => {
    const buckets = d.buckets || [];
    return <Table rows={d.rows} empty="Nothing outstanding — the book is clear"
      cols={[
        { k: "party_name", h: who },
        ...buckets.map((b) => ({ k: b, h: b, num: 1, fmt: (v) => (v ? money(v) : "—") })),
        { k: "total", h: "Total", num: 1, fmt: (v) => <b>{money(v)}</b> },
      ]}
      foot={["Totals", ...buckets.map((b) => money(d.totals[b] || 0)), money(d.totals.total)]} />;
  };
  const agingDetailTable = (who, docLabel) => (
    <Table rows={d.rows} empty="Nothing outstanding — the book is clear"
      cols={[
        { k: "doc_no", h: docLabel }, { k: "doc_date", h: "Date" }, { k: "due_date", h: "Due" },
        { k: "party_name", h: who },
        { k: "days_overdue", h: "Days overdue", num: 1, fmt: (v) => v > 0 ? <span className="aging-over">{v}</span> : "—" },
        { k: "bucket", h: "Age" },
        { k: "grand_total", h: "Total", num: 1, fmt: money },
        { k: "balance_due", h: "Balance", num: 1, fmt: money },
      ]}
      foot={["Totals", "", "", "", "", "", "", money(d.totals.balance_due)]} />
  );
  const balanceTable = (who) => (
    <Table rows={d.rows} empty="Nothing outstanding"
      cols={[
        { k: "party_name", h: who }, { k: "phone", h: "Phone", fmt: (v) => v || "—" },
        { k: "invoices", h: "Open docs", num: 1 },
        { k: "invoiced", h: "Billed", num: 1, fmt: money },
        { k: "paid", h: "Paid", num: 1, fmt: money },
        { k: "balance_due", h: "Balance", num: 1, fmt: (v) => <b>{money(v)}</b> },
      ]}
      foot={["Totals", "", "", "", "", money(d.totals.balance_due)]} />
  );
  const bucketTable = () => (
    <Table rows={d.rows} empty="Nothing outstanding"
      cols={[
        { k: "bucket", h: "Age" }, { k: "documents", h: "Documents", num: 1 },
        { k: "amount", h: "Amount", num: 1, fmt: money },
        { k: "share", h: "Share", num: 1, fmt: (v) => `${v}%` },
      ]}
      foot={["Totals", d.totals.documents, money(d.totals.amount), "100%"]} />
  );

  switch (id) {
    case "ar-aging-summary": return agingSummaryTable("Customer");
    case "ap-aging-summary": return agingSummaryTable("Supplier");
    case "ar-aging-details": return agingDetailTable("Customer", "Invoice");
    case "ap-aging-details": return agingDetailTable("Supplier", "Bill");
    case "customer-balance-summary": return balanceTable("Customer");
    case "supplier-balance-summary": return balanceTable("Supplier");
    case "receivable-summary":
    case "payable-summary": return bucketTable();
    case "receivable-details": return agingDetailTable("Customer", "Invoice");
    case "payable-details": return agingDetailTable("Supplier", "Bill");
    case "invoice-details":
      return <Table rows={d.rows} empty="No invoices in this range" cols={[
        { k: "invoice_no", h: "Invoice" }, { k: "invoice_date", h: "Date" },
        { k: "due_date", h: "Due", fmt: (v) => v || "—" }, { k: "party_name", h: "Customer" },
        { k: "grand_total", h: "Total", num: 1, fmt: money },
        { k: "paid_amount", h: "Paid", num: 1, fmt: money },
        { k: "balance_due", h: "Balance", num: 1, fmt: money },
        { k: "status", h: "Status" },
      ]} foot={["Totals", "", "", "", money(d.totals.grand_total), money(d.totals.paid_amount), money(d.totals.balance_due), ""]} />;
    case "quote-details":
      return <Table rows={d.rows} empty="No quotes or orders in this range" cols={[
        { k: "quote_no", h: "Quote" }, { k: "quote_date", h: "Date" },
        { k: "valid_till", h: "Valid till", fmt: (v) => v || "—" },
        { k: "party_name", h: "Customer" },
        { k: "grand_total", h: "Total", num: 1, fmt: money },
        { k: "status", h: "Status" },
      ]} foot={["Totals", "", "", "", money(d.totals.grand_total), ""]} />;
    case "sale-summary":
      return <Table rows={d.rows} cols={[
        { k: "invoice_no", h: "Invoice" }, { k: "invoice_date", h: "Date" }, { k: "party_name", h: "Customer" },
        { k: "payment_type", h: "Type" }, { k: "tax", h: "Tax", num: 1, fmt: money },
        { k: "grand_total", h: "Total", num: 1, fmt: money }, { k: "balance_due", h: "Due", num: 1, fmt: money },
      ]} foot={["Totals", "", "", "", money(d.totals.tax), money(d.totals.grand), money(d.totals.due)]} />;
    case "purchase-summary":
      return <Table rows={d.rows} cols={[
        { k: "bill_no", h: "Bill" }, { k: "bill_date", h: "Date" }, { k: "party_name", h: "Supplier" },
        { k: "tax", h: "Tax", num: 1, fmt: money }, { k: "grand_total", h: "Total", num: 1, fmt: money }, { k: "balance_due", h: "Due", num: 1, fmt: money },
      ]} foot={["Totals", "", "", money(d.totals.tax), money(d.totals.grand), money(d.totals.due)]} />;
    case "x-report":
    case "day-close":
      return (
        <div>
          <div className="sum-bar" style={{ flexWrap: "wrap" }}>
            <div className="sum-chip sum-total"><div className="sc-label">Bills</div><div className="sc-value num"><CountUp value={d.totals.bills} /></div></div>
            <div className="sum-chip sum-paid"><div className="sc-label">Gross sales</div><div className="sc-value num">{cur()} <CountUp value={d.totals.gross} decimals={2} /></div></div>
            <div className="sum-chip sum-unpaid"><div className="sc-label">Unpaid (credit)</div><div className="sc-value num">{cur()} <CountUp value={d.totals.unpaid} decimals={2} /></div></div>
            <div className="sum-chip" style={{ background: "var(--bad-bg)" }}><div className="sc-label">Refunds ({d.totals.refunds})</div><div className="sc-value num">{cur()} <CountUp value={d.totals.refund_total} decimals={2} /></div></div>
            <div className="sum-chip" style={{ background: "var(--warn-bg)" }}><div className="sc-label">Voids ({d.totals.voids})</div><div className="sc-value num">{cur()} <CountUp value={d.totals.void_total} decimals={2} /></div></div>
            <div className="sum-chip sum-paid"><div className="sc-label">Net</div><div className="sc-value num">{cur()} <CountUp value={d.totals.net} decimals={2} /></div></div>
          </div>
          {/* The report scopes to one day or to a range — say which was asked for. */}
          <Table rows={d.rows} empty={d.one_day === false ? "No sales in this range" : "No sales on this day"} cols={[
            { k: "mode", h: "Payment mode" }, { k: "bills", h: "Bills", num: 1 },
            { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
            { k: "received", h: "Received", num: 1, fmt: (v) => money(v) },
          ]} />
          <div style={{ height: 14 }} />
          <Table rows={d.by_user} empty="" cols={[
            { k: "user", h: "Cashier" }, { k: "bills", h: "Bills", num: 1 },
            { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
          ]} />
        </div>
      );
    case "daily-sales":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "d", h: "Date" }, { k: "bills", h: "Bills", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "received", h: "Received", num: 1, fmt: (v) => money(v) },
        { k: "unpaid", h: "Unpaid", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "hourly-sales": {
      const c = d.cards || {};
      return (
        <div>
          <div className="ha-cards">
            <div className="ha-card g"><div className="l">Best sales hour</div><div className="v">{c.best_hour}</div><div className="s">{cur()} {inr(c.best_hour_sales)}</div></div>
            <div className="ha-card b"><div className="l">Highest profit hour</div><div className="v">{c.profit_hour}</div><div className="s">{cur()} {inr(c.profit_hour_val)}</div></div>
            <div className="ha-card"><div className="l">Most transactions</div><div className="v">{c.top_txn_hour}</div><div className="s">{c.top_txn_count} bills</div></div>
            <div className="ha-card y"><div className="l">Quietest hour</div><div className="v">{c.lowest_hour}</div><div className="s">room to promote</div></div>
            <div className="ha-card g"><div className="l">Best day</div><div className="v">{c.best_day}</div><div className="s">{cur()} {inr(c.best_day_sales)}</div></div>
            <div className="ha-card y"><div className="l">Worst day</div><div className="v">{c.worst_day}</div></div>
            <div className="ha-card b"><div className="l">Revenue / hour</div><div className="v">{cur()} {inr(c.revenue_per_hour)}</div><div className="s">active hours</div></div>
            <div className="ha-card"><div className="l">Txns / hour</div><div className="v">{c.avg_txn_per_hour}</div></div>
          </div>
          <h3 style={{ fontFamily: "var(--disp)", fontSize: 15, margin: "0 0 8px" }}>Hourly breakdown</h3>
          <Table rows={d.rows} empty="No sales in range" cols={[
            { k: "hour", h: "Hour" }, { k: "bills", h: "Bills", num: 1 }, { k: "qty", h: "Qty", num: 1 },
            { k: "gross", h: "Gross", num: 1, fmt: (v) => money(v) },
            { k: "profit", h: "Profit", num: 1, fmt: (v) => money(v) },
            { k: "margin_pct", h: "Margin", num: 1, fmt: (v) => v + "%" },
          ]} />
          <h3 style={{ fontFamily: "var(--disp)", fontSize: 15, margin: "18px 0 8px" }}>Weekday analysis</h3>
          <Table rows={d.weekday} empty="" cols={[
            { k: "day", h: "Day" }, { k: "bills", h: "Transactions", num: 1 },
            { k: "sales", h: "Sales", num: 1, fmt: (v) => money(v) },
          ]} />
        </div>
      );
    }
    case "item-sales":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "item", h: "Item" }, { k: "qty", h: "Qty sold", num: 1 },
        { k: "bills", h: "Bills", num: 1 },
        { k: "revenue", h: "Revenue", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "sales-by-customer":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "customer", h: "Customer" }, { k: "bills", h: "Bills", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "unpaid", h: "Unpaid", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "sales-by-user":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "cashier", h: "Cashier" }, { k: "bills", h: "Bills", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "profit-margin":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "item", h: "Item" }, { k: "qty", h: "Qty", num: 1 },
        { k: "revenue", h: "Revenue", num: 1, fmt: (v) => money(v) },
        { k: "cost", h: "Cost", num: 1, fmt: (v) => money(v) },
        { k: "profit", h: "Profit", num: 1, fmt: (v) => money(v) },
        { k: "margin_pct", h: "Margin %", num: 1, fmt: (v) => v + "%" },
      ]} />;
    case "discounts-granted":
      return <Table rows={d.rows} empty="No discounts given" cols={[
        { k: "d", h: "Date" }, { k: "invoice_no", h: "Invoice" }, { k: "party", h: "Party" },
        { k: "item", h: "Item" }, { k: "discount_pct", h: "%", num: 1 },
        { k: "discount_amt", h: "Discount", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "refunds":
      return <Table rows={d.rows} empty="No refunds in range" cols={[
        { k: "d", h: "Date" }, { k: "note_no", h: "Credit note" }, { k: "party", h: "Party" },
        { k: "total", h: "Amount", num: 1, fmt: (v) => money(v) }, { k: "reason", h: "Reason" },
      ]} />;
    case "unpaid-sales":
      return <Table rows={d.rows} empty="Nothing outstanding — well collected" cols={[
        { k: "invoice_no", h: "Invoice" }, { k: "party", h: "Customer" }, { k: "invoice_date", h: "Date" },
        { k: "grand_total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "balance_due", h: "Due", num: 1, fmt: (v) => money(v) },
        { k: "age_days", h: "Age", num: 1, fmt: (v) => v + "d" },
      ]} />;
    case "unpaid-purchases":
      return <Table rows={d.rows} empty="No supplier dues" cols={[
        { k: "bill_no", h: "Bill" }, { k: "party", h: "Supplier" }, { k: "bill_date", h: "Date" },
        { k: "grand_total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "balance_due", h: "Due", num: 1, fmt: (v) => money(v) },
        { k: "age_days", h: "Age", num: 1, fmt: (v) => v + "d" },
      ]} />;
    case "payment-types":
      return <Table rows={d.rows} empty="No payments in range" cols={[
        { k: "mode", h: "Mode" }, { k: "direction", h: "Dir", fmt: (v) => v === "in" ? "In" : "Out" },
        { k: "entries", h: "Entries", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "payment-types-by-user":
      return <Table rows={d.rows} empty="No payments in range" cols={[
        { k: "user", h: "Cashier" }, { k: "mode", h: "Mode" }, { k: "entries", h: "Entries", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "stock-movement":
      return <Table rows={d.rows} empty="No movement in range" cols={[
        { k: "d", h: "Date", fmt: (v) => String(v).slice(0, 10) }, { k: "item", h: "Item" },
        { k: "direction", h: "Dir", fmt: (v) => v === "in" ? "＋In" : "−Out" },
        { k: "quantity", h: "Qty", num: 1 }, { k: "ref", h: "Ref" }, { k: "source_module", h: "Source" },
      ]} />;
    case "reorder-list":
      return <Table rows={d.rows} empty="Nothing needs reordering" cols={[
        { k: "name", h: "Item" }, { k: "on_hand", h: "In stock", num: 1 },
        { k: "reorder_level", h: "Reorder at", num: 1 },
        { k: "suggested_qty", h: "Suggested buy", num: 1, fmt: (v, r) => v + " " + (r.unit || "") },
      ]} />;
    case "sales-by-category":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "category", h: "Category" }, { k: "qty", h: "Qty", num: 1 },
        { k: "revenue", h: "Revenue", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "invoice-list":
      return <Table rows={d.rows} empty="No invoices in range" cols={[
        { k: "invoice_no", h: "Invoice" }, { k: "invoice_date", h: "Date" }, { k: "party", h: "Customer" },
        { k: "payment_type", h: "Type" }, { k: "cashier", h: "Cashier" },
        { k: "grand_total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "balance_due", h: "Due", num: 1, fmt: (v) => v > 0 ? money(v) : "—" },
      ]} />;
    case "bill-list":
      return <Table rows={d.rows} empty="No bills in range" cols={[
        { k: "bill_no", h: "Bill" }, { k: "bill_date", h: "Date" }, { k: "party", h: "Supplier" },
        { k: "grand_total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "balance_due", h: "Due", num: 1, fmt: (v) => v > 0 ? money(v) : "—" },
      ]} />;
    case "purchase-by-item":
      return <Table rows={d.rows} empty="No purchases in range" cols={[
        { k: "item", h: "Item" }, { k: "qty", h: "Qty bought", num: 1 },
        { k: "spend", h: "Spend", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "purchase-by-supplier":
      return <Table rows={d.rows} empty="No purchases in range" cols={[
        { k: "supplier", h: "Supplier" }, { k: "bills", h: "Bills", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
        { k: "unpaid", h: "Unpaid", num: 1, fmt: (v) => v > 0 ? money(v) : "—" },
      ]} />;
    case "payment-types-by-customer":
      return <Table rows={d.rows} empty="No payments in range" cols={[
        { k: "customer", h: "Customer" }, { k: "mode", h: "Mode" }, { k: "entries", h: "Entries", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "drawer-entries":
      return <Table rows={d.rows} empty="No cash in/out recorded" cols={[
        { k: "d", h: "Date" },
        { k: "direction", h: "Dir", fmt: (v) => v === "in" ? "＋ In" : "− Out" },
        { k: "amount", h: "Amount", num: 1, fmt: (v) => money(v) },
        { k: "note", h: "Reason" },
      ]} />;
    case "loss-damage":
      return <Table rows={d.rows} empty="Nothing written off — good" cols={[
        { k: "d", h: "Date", fmt: (v) => String(v).slice(0, 10) }, { k: "item", h: "Item" },
        { k: "quantity", h: "Qty", num: 1 },
        { k: "value", h: "Value lost", num: 1, fmt: (v) => money(v) },
      ]} />;
    case "fast-moving":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "item", h: "Item" }, { k: "barcode", h: "Barcode" },
        { k: "sales_qty", h: "Sold", num: 1 },
        { k: "sales_total", h: "Sales", num: 1, fmt: (v) => money(v) },
        { k: "current_qty", h: "In stock", num: 1 },
        { k: "bp", h: "Buy", num: 1, fmt: (v) => inr(v) },
        { k: "sp", h: "Sell", num: 1, fmt: (v) => inr(v) },
      ]} />;
    case "slow-moving":
      return <Table rows={d.rows} empty="Everything is selling — no dead stock" cols={[
        { k: "item", h: "Item" }, { k: "barcode", h: "Barcode" },
        { k: "sales_qty", h: "Sold", num: 1 },
        { k: "current_qty", h: "In stock", num: 1 },
        { k: "bp", h: "Buy", num: 1, fmt: (v) => inr(v) },
        { k: "sp", h: "Sell", num: 1, fmt: (v) => inr(v) },
        { k: "last_sold", h: "Last sold", fmt: (v) => v || "never" },
      ]} />;
    case "stock-adjustment":
      return <Table rows={d.rows} empty="No adjustments in range" cols={[
        { k: "ref", h: "Ref #", fmt: (v) => "#" + v },
        { k: "d", h: "Date" }, { k: "product", h: "Product" }, { k: "barcode", h: "Barcode" },
        { k: "direction", h: "Dir", fmt: (v) => v === "in" ? "＋In" : "−Out" },
        { k: "quantity", h: "Qty", num: 1 },
        { k: "value_up", h: "Value up", num: 1, fmt: (v) => v ? money(v) : "—" },
        { k: "value_down", h: "Value down", num: 1, fmt: (v) => v ? money(v) : "—" },
      ]} />;
    case "general-ledger":
      return (
        <div>
          {(d.groups || []).length === 0 ? <Empty icon="▱" title="No account activity" /> :
            d.groups.map((g, gi) => (
              <div key={gi} style={{ marginBottom: 16 }}>
                <div style={{ background: "var(--primary-tint)", color: "var(--primary)", fontWeight: 750, padding: "8px 12px", borderRadius: "6px 6px 0 0", fontSize: 13.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{g.label}</div>
                <table className="tw"><thead><tr>
                  <th>Code</th><th>Ledger account</th><th className="amt">Balance B/F</th><th className="amt">Debit</th><th className="amt">Credit</th><th className="amt">Closing</th>
                </tr></thead><tbody>
                  {g.rows.map((r, ri) => (
                    <tr key={ri}><td className="num">{r.code}</td><td>{r.account}</td>
                      <td className="amt num">{inr(r.opening)}</td><td className="amt num">{inr(r.debit)}</td>
                      <td className="amt num">{inr(r.credit)}</td>
                      <td className="amt num" style={{ color: r.closing < 0 ? "var(--bad)" : "inherit" }}>{inr(r.closing)}</td></tr>
                  ))}
                  <tr style={{ background: "var(--card-2)", fontWeight: 700 }}>
                    <td colSpan={3}>{g.label} subtotal</td>
                    <td className="amt num">{inr(g.subtotal.debit)}</td><td className="amt num">{inr(g.subtotal.credit)}</td>
                    <td className="amt num">{inr(g.subtotal.closing)}</td></tr>
                </tbody></table>
              </div>
            ))}
        </div>
      );
    case "zreport-summary":
      return (
        <div>
          <table className="tw"><tbody>
            {d.rows.map((r, i) => (
              <tr key={i} style={r.head ? { background: "var(--card-2)" } : {}}>
                <td style={{ fontWeight: r.head ? 800 : 400, color: r.head ? "var(--warn)" : "var(--text)", paddingLeft: r.head ? 12 : 26 }}>{r.section}</td>
                <td className="amt num" style={{ fontWeight: r.head ? 800 : 400 }}>{typeof r.amount === "number" && !Number.isInteger(r.amount) ? money(r.amount) : r.amount}</td>
              </tr>
            ))}
          </tbody></table>
          <div style={{ marginTop: 14, padding: "12px 16px", background: "var(--ok-bg)", borderRadius: 8, display: "flex", justifyContent: "space-between", fontWeight: 750 }}>
            <span>Expected cash amount</span><span className="num">{cur()} {inr(d.totals.expected_cash)}</span>
          </div>
          {(d.by_user || []).length > 0 && (
            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontFamily: "var(--disp)", fontSize: 15, margin: "0 0 8px" }}>Sales by cashier</h3>
              <Table rows={d.by_user} empty="" cols={[
                { k: "cashier", h: "Cashier" }, { k: "bills", h: "Bills", num: 1 },
                { k: "total", h: "Sales", num: 1, fmt: (v) => money(v) },
                { k: "collected", h: "Collected", num: 1, fmt: (v) => money(v) },
              ]} />
            </div>
          )}
        </div>
      );
    case "sales-by-items":
      return (
        <div>
          {(d.groups || []).length === 0 ? <Empty icon="▱" title="No sales in range" /> :
            d.groups.map((g, gi) => (
              <div key={gi} style={{ marginBottom: 16 }}>
                <div style={{ background: "var(--primary-tint)", color: "var(--primary)", fontWeight: 700, padding: "8px 12px", borderRadius: "6px 6px 0 0", fontSize: 13.5 }}>
                  {g.sale} · by {g.seller} · {String(g.at).slice(0, 16)}
                </div>
                <table className="tw"><thead><tr>
                  <th>Item</th><th>Barcode</th><th className="amt">Rate</th><th className="amt">Qty</th><th className="amt">Total</th><th className="amt">Profit</th>
                </tr></thead><tbody>
                  {g.lines.map((l, li) => (
                    <tr key={li}><td>{l.item}</td><td className="num">{l.barcode || "—"}</td>
                      <td className="amt num">{inr(l.rate)}</td><td className="amt num">{l.qty}</td>
                      <td className="amt num">{cur()} {inr(l.total)}</td>
                      <td className="amt num" style={{ color: "var(--ok)" }}>{cur()} {inr(l.profit)}</td></tr>
                  ))}
                  <tr style={{ background: "var(--card-2)", fontWeight: 700 }}>
                    <td colSpan={3}>[SUMMARY]</td><td className="amt num">{g.qty}</td>
                    <td className="amt num">{cur()} {inr(g.total)}</td><td className="amt num" style={{ color: "var(--ok)" }}>{cur()} {inr(g.profit)}</td></tr>
                </tbody></table>
              </div>
            ))}
          {d.totals && (d.groups || []).length > 0 && (
            <div style={{ padding: "12px 16px", background: "var(--warn-bg)", borderRadius: 8, display: "flex", justifyContent: "space-between", fontWeight: 750 }}>
              <span>[ALL SUMMARY] · {d.totals.qty} items</span>
              <span className="num">{cur()} {inr(d.totals.total)} · profit {cur()} {inr(d.totals.profit)}</span>
            </div>
          )}
        </div>
      );
    case "voided-items":
      return <Table rows={d.rows} empty="Nothing voided — good discipline" cols={[
        { k: "created_at", h: "When", fmt: (v) => String(v).slice(0, 16) },
        { k: "scope", h: "Scope" },
        { k: "item_name", h: "Item", fmt: (v) => v || "(whole bill)" },
        { k: "quantity", h: "Qty", num: 1 },
        { k: "amount", h: "Amount", num: 1, fmt: (v) => money(v) },
        { k: "reason", h: "Reason" },
        { k: "voided_by", h: "By" },
      ]} />;
    case "expiry":
      return <Table rows={d.rows} empty="No batches with expiry dates" cols={[
        { k: "item_name", h: "Item" }, { k: "batch_no", h: "Batch" },
        { k: "quantity", h: "Qty", num: 1 },
        { k: "expiry_date", h: "Expiry" },
        { k: "days_left", h: "Days left", num: 1, fmt: (v) => v < 0 ? `EXPIRED ${-v}d ago` : `${v}d` },
      ]} />;
    case "tax-summary":
      return <Table rows={d.rows} empty="No taxed transactions in this range" cols={[
        { k: "name", h: "Tax" }, { k: "rate", h: "Rate", fmt: (v) => `${v}%` },
        { k: "mode", h: "Effect", fmt: (v) => (v === "deduct" ? "Deducted" : "Added") },
        { k: "net_sales", h: "On sales (net)", num: 1, fmt: money },
        { k: "net_purchases", h: "On purchases (net)", num: 1, fmt: money },
      ]} foot={["Totals", "", "", money(d.totals.sales), money(d.totals.purchases)]} />;
    case "stock-summary":
      return <Table rows={d.rows} cols={[
        { k: "name", h: "Item" }, { k: "unit", h: "Unit" },
        { k: "on_hand", h: "In stock", num: 1 }, { k: "purchase_price", h: "Cost", num: 1, fmt: money }, { k: "stock_value", h: "Stock value", num: 1, fmt: money },
      ]} foot={["Totals", "", d.totals.qty, "", money(d.totals.value)]} />;
    case "low-stock":
      return <Table rows={d.rows} empty="No items below reorder level 🎉" cols={[
        { k: "name", h: "Item" }, { k: "unit", h: "Unit" }, { k: "on_hand", h: "In stock", num: 1 }, { k: "reorder_level", h: "Reorder at", num: 1 },
      ]} />;
    case "party-statement":
      return (
        <>
          <div style={{ padding: "12px 18px 0", fontSize: 13.5 }}>
            <b>{d.party.name}</b> — closing balance <b style={{ color: d.closing > 0 ? "var(--ok)" : d.closing < 0 ? "var(--bad)" : "inherit" }}>
              {cur()} {inr(Math.abs(d.closing))} {d.closing > 0 ? "receivable" : d.closing < 0 ? "payable" : ""}</b>
          </div>
          <Table rows={d.rows} cols={[
            { k: "d", h: "Date" }, { k: "type", h: "Transaction" }, { k: "ref", h: "Ref" },
            { k: "debit", h: "Debit", num: 1, fmt: (v) => (v ? money(v) : "") },
            { k: "credit", h: "Credit", num: 1, fmt: (v) => (v ? money(v) : "") },
            { k: "balance", h: "Balance", num: 1, fmt: money },
          ]} />
        </>
      );
    case "trial-balance":
      return <Table rows={d.rows} cols={[
        { k: "code", h: "Code" }, { k: "name", h: "Account" }, { k: "type", h: "Type" },
        { k: "debit", h: "Debit", num: 1, fmt: (v) => (v ? money(v) : "") },
        { k: "credit", h: "Credit", num: 1, fmt: (v) => (v ? money(v) : "") },
      ]} foot={["Totals", "", "", money(d.totals.debit), money(d.totals.credit)]} />;
    case "cash-flow":
      return <Table rows={d.rows} cols={[
        { k: "d", h: "Date" }, { k: "entry_no", h: "Entry" }, { k: "description", h: "Description" }, { k: "account_name", h: "Account" },
        { k: "cash_in", h: "In", num: 1, fmt: (v) => (v ? money(v) : "") },
        { k: "cash_out", h: "Out", num: 1, fmt: (v) => (v ? money(v) : "") },
        { k: "running", h: "Running", num: 1, fmt: money },
      ]} foot={["Totals", "", "", "", money(d.totals.cash_in), money(d.totals.cash_out), money(d.totals.net)]} />;
    case "bill-profit":
      return <Table rows={d.rows} cols={[
        { k: "invoice_no", h: "Invoice" }, { k: "invoice_date", h: "Date" }, { k: "party_name", h: "Customer" },
        { k: "sale_value", h: "Sale value", num: 1, fmt: money }, { k: "cost", h: "Cost", num: 1, fmt: money },
        { k: "profit", h: "Profit", num: 1, fmt: (v) => <span style={{ color: v >= 0 ? "var(--ok)" : "var(--bad)", fontWeight: 650 }}>{money(v)}</span> },
      ]} foot={["Totals", "", "", money(d.totals.sale), money(d.totals.cost), money(d.totals.profit)]} />;
    case "sale-summary-by-user":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "rep", h: "Sales rep" },
        { k: "items_sold", h: "Items sold", num: 1, fmt: (v) => inr(v) },
        { k: "total_sales", h: "Total sales", num: 1, fmt: money },
        { k: "total_tax", h: "Total tax", num: 1, fmt: money },
        { k: "running", h: "Running", num: 1, fmt: money },
        { k: "invoices", h: "Invoices", num: 1 },
        { k: "discounts", h: "Discounts", num: 1, fmt: money },
        { k: "commission", h: "Commission", num: 1, fmt: money },
        { k: "status", h: "Status", fmt: (v) => <span style={{ color: v === "Owing" ? "var(--bad)" : "var(--ok)", fontWeight: 650 }}>{v}</span> },
      ]} foot={["Totals", inr(d.totals.items_sold), money(d.totals.total_sales), money(d.totals.total_tax),
                money(d.totals.running), d.totals.invoices, money(d.totals.discounts), money(d.totals.commission), ""]} />;
    case "sale-summary-by-category-item":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "category", h: "Category" }, { k: "item_name", h: "Item name" }, { k: "barcode", h: "Barcode" },
        { k: "qty", h: "Qty", num: 1, fmt: (v) => inr(v) },
        { k: "total", h: "Total", num: 1, fmt: money },
        { k: "tax", h: "Tax", num: 1, fmt: money },
        { k: "running", h: "Running", num: 1, fmt: money },
        { k: "invoices", h: "Invoices", num: 1 },
      ]} foot={["Totals", "", "", inr(d.totals.qty), money(d.totals.total), money(d.totals.tax), money(d.totals.running), ""]} />;
    case "user-profit":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "rep", h: "Sales rep" }, { k: "invoices", h: "Invoices", num: 1 },
        { k: "revenue", h: "Revenue", num: 1, fmt: money },
        { k: "cost", h: "Cost", num: 1, fmt: money },
        { k: "profit", h: "Profit", num: 1, fmt: (v) => <span style={{ color: v >= 0 ? "var(--ok)" : "var(--bad)", fontWeight: 650 }}>{money(v)}</span> },
        { k: "margin_pct", h: "Margin %", num: 1, fmt: (v) => v + "%" },
        { k: "avg_bill", h: "Avg bill", num: 1, fmt: money },
      ]} foot={["Totals", d.totals.invoices, money(d.totals.revenue), money(d.totals.cost), money(d.totals.profit), "", ""]} />;
    case "user-hourly":
      return <Table rows={d.rows} empty="No sales in range" cols={[
        { k: "rep", h: "Sales rep" },
        { k: "hour", h: "Hour", num: 1, fmt: (v) => `${String(v).padStart(2, "0")}:00` },
        { k: "bills", h: "Bills", num: 1 },
        { k: "total", h: "Total", num: 1, fmt: money },
      ]} foot={["Totals", "", "", money(d.totals.total)]} />;
    case "user-time":
      return <Table rows={d.rows} empty="No closed shifts in range" cols={[
        { k: "rep", h: "User" }, { k: "shifts", h: "Shifts", num: 1 },
        { k: "hours", h: "Hours", num: 1, fmt: (v) => v + " h" },
        { k: "avg_minutes", h: "Avg shift", num: 1, fmt: (v) => v < 60 ? `${v} min` : `${Math.floor(v / 60)}h ${v % 60}m` },
        { k: "total_variance", h: "Cash variance", num: 1, fmt: (v) => <span style={{ color: v === 0 ? "var(--ok)" : "var(--bad)", fontWeight: 650 }}>{money(v)}</span> },
      ]} foot={["Totals", "", d.totals.hours + " h", "", ""]} />;
    default:
      return <Empty title="Unknown report" />;
  }
}


