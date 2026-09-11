import React, { useEffect, useState } from "react";
import { offerVoucherPrint } from "../lib/printprompt.jsx";
import api from "../lib/api.js";
import { useAttempt } from "../lib/attempt.jsx";
import { inr, cur, fmtDate as sharedFmtDate } from "../lib/tax.js";
import { Modal, Field, toast, DateRangePicker, RowMenu, confirmDialog } from "../lib/ui.jsx";
import { can } from "../lib/api.js";
import { Icon } from "../lib/icons.jsx";
import { useRead, LoadFailed, figure } from "../lib/deckui.jsx";

/* ── Accounting, built to the design deck ──────────────────────────────────
   Six views of the same books, rendered through one table. The deck draws it
   that way — a column list, a row list, one total row — and it is right to:
   a chart of accounts and a profit and loss are the same object at different
   grains, and giving each its own table is how they end up disagreeing about
   what a total looks like.

   Everything here comes from endpoints that already existed. The one addition
   is /accounting/overview for the four panels across the top.  */

const money = (v) => `${cur()} ${inr(v)}`;
const dash = (v) => (Math.abs(Number(v) || 0) < 0.005 ? "—" : inr(v));

/* The tabs somebody moves between while working. Books health is not one of
   them — it is a thing you go and check, occasionally, when something looks
   wrong — so it sits in the ⋯ menu with the other two occasional actions
   rather than taking a permanent place in a row of six. */
const TABS = [
  ["accounts", "Chart of accounts"],
  ["journals", "Journals"],
  ["pl", "Profit & loss"],
  ["bs", "Balance sheet"],
  ["daybook", "Day book"],
];

/* First and last day of the current month, which is what every view opens on. */
function thisMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const first = `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: first, to: `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}` };
}

/* Uses the shared formatter so this follows the date_format setting instead of
   printing "Aug 4, 2026" while every table nearby printed ISO. */
const prettyDate = sharedFmtDate;

/* The occasional actions, out of the tab row.
 *
 * A row of six tabs where one of them is a diagnostic reads as six equal
 * places to work. Books health is somewhere you go when a figure looks wrong,
 * which is not most days — and "new account" was reachable only from inside
 * the chart, which is fine until you are on the balance sheet and realise one
 * is missing. */
function AccountingActions({ canCreate, onJournal, onAccount, onHealth, healthOn }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const shut = () => setOpen(false);
    window.addEventListener("mousedown", shut);
    return () => window.removeEventListener("mousedown", shut);
  }, [open]);

  return (
    <div style={{ position: "relative" }} onMouseDown={(e) => e.stopPropagation()}>
      <button className={`dk-tool ${open ? "on" : ""}`} aria-label="More" aria-expanded={open}
              onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="dk-menu">
          {canCreate && <>
            <div className="cap">Create</div>
            <button onClick={() => { setOpen(false); onJournal(); }}>New journal entry</button>
            <button onClick={() => { setOpen(false); onAccount(); }}>New account</button>
            <div className="rule" />
          </>}
          <button onClick={() => { setOpen(false); onHealth(); }}>
            Books health{healthOn && <span className="tick">✓</span>}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Accounting() {
  const [tab, setTab] = useState("accounts");
  const [range, setRange] = useState(thisMonth);
  const [ov, setOv] = useState(null);
  const [firm, setFirm] = useState({});
  const [view, setView] = useState(null);
  const [journalOpen, setJournalOpen] = useState(false);
  /* Adding an account belongs to the chart, not the toolbar — the deck puts
     only "New journal" up there, and a create button that changes meaning
     with the tab is worse than one that sits where it applies. */
  const [acctEditor, setAcctEditor] = useState(null);

  /* Two reads, two flags. "Balanced" and a net profit are the two things on
     this screen nobody should ever read off a request that failed. */
  const [ovFailed, readOv] = useRead();
  const loadOv = () => readOv(api.get("/accounting/overview"), setOv, null);
  useEffect(() => { loadOv(); api.get("/settings/firm").then(setFirm).catch(() => {}); }, []);

  /* Each tab fetches its own shape and folds it into columns / rows / total. */
  const [viewFailed, readView] = useRead();
  const [viewSeq, setViewSeq] = useState(0);
  const reloadView = () => setViewSeq((n) => n + 1);
  useEffect(() => {
    let alive = true;
    setView(null);
    /* The journals tab hangs Edit and Delete off each row, and those need to
       reach this component's state — so the callbacks go down with the
       request rather than the table reaching back up for them. */
    readView(buildView(tab, range, {
      editJournal: (e) => setJournalOpen(e),
      refresh: () => { loadOv(); setViewSeq((n) => n + 1); },
    }), (v) => { if (alive) setView(v); }, null);
    return () => { alive = false; };
  }, [tab, range, viewSeq]);

  const exportCsv = () => {
    if (!view) return;
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [
      view.columns.map((c) => esc(c[0])).join(","),
      ...view.rows.map((r) => r.cells.map((c) => esc(c.raw ?? c.v)).join(",")),
    ];
    if (view.total) lines.push(view.total.map((c) => esc(c.raw ?? c.v)).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${tab}-${range.from}-to-${range.to}.csv`;
    a.click();
    toast("Exported");
  };

  const print = () => {
    if (!view) return;
    const head = view.columns.map((c) => `<th style="text-align:${c[1]}">${c[0]}</th>`).join("");
    const body = view.rows.map((r) =>
      `<tr>${r.cells.map((c, i) => `<td style="text-align:${view.columns[i][1]}">${c.v}</td>`).join("")}</tr>`).join("");
    const tot = view.total
      ? `<tr class="t">${view.total.map((c, i) => `<td style="text-align:${view.columns[i][1]}">${c.v}</td>`).join("")}</tr>`
      : "";
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>${view.title}</title><style>
      body{font-family:'Inter','Segoe UI',sans-serif;margin:30px}
      h2{margin:0 0 2px}.s{color:#666;font-size:12.5px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{padding:7px 10px;border-bottom:1px solid #ddd}
      th{background:#F1F3F7;text-transform:uppercase;font-size:11px;text-align:left}
      tr.t td{border-top:2px solid #999;font-weight:700;background:#F8F9FB}
      </style></head><body>
      <h2>${view.title}</h2>
      <div class="s">${firm.name || ""} · ${view.period}</div>
      <table><thead><tr>${head}</tr></thead><tbody>${body}${tot}</tbody></table></body></html>`);
    w.document.close();
    /* The opener prints it: an inline <script> in this document is
       refused by the content policy, and refused silently. */
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* closed already */ } }, 300);
  };

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {TABS.map(([id, label]) => (
            <button key={id} className={`dk-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="spacer" />
        {/* One date filter across the app: the preset dropdown. A range is
            mandatory here — the balance sheet reads its as-at date off the To
            end — so "All dates" is not offered. Opens on this month, as before. */}
        <DateRangePicker from={range.from} to={range.to} allowAll={false}
                         onChange={(r) => setRange({ from: r.from || range.from, to: r.to || range.to })} />
        {/* New journal, new account, and the health check — the three things
            done from here rather than from a tab. "New account" was reachable
            only from inside the chart, which is fine until you are on the
            balance sheet and realise one is missing. */}
        <AccountingActions
          canCreate={can("accounting", "create")}
          onJournal={() => setJournalOpen(true)}
          onAccount={() => { setTab("accounts"); setAcctEditor({}); }}
          onHealth={() => setTab("health")}
          healthOn={tab === "health"} />
      </div>

      {ovFailed && (
        <div className="dk-card"><LoadFailed what="the state of the books" onRetry={loadOv} compact /></div>
      )}

      <AccountingStrip ov={ov} view={view} ovFailed={ovFailed} viewFailed={viewFailed} />

      <div className="dk-card dk-tablecard">
        <div className="dk-ledger-head">
          <div style={{ minWidth: 0 }}>
            <h3>{view ? view.title : "…"}</h3>
            <div className="sub">{firm.name || "This shop"} · {view ? view.period : ""}</div>
          </div>
          {view && view.note && <span className="note">{view.note}</span>}
        </div>

        <div className="dk-tablewrap dk-s">
          {viewFailed ? <LoadFailed what="the books" onRetry={reloadView} />
            : view === null ? <div className="dk-empty">Reading the books…</div>
            : <LedgerTable view={view} />}
        </div>

        <div className="dk-ledger-foot">
          <span className="note">{view ? view.foot : ""}</span>
          <div className="acts">
            {tab === "accounts" && can("accounting", "create") && (
              <button className="dk-sbtn" onClick={() => setAcctEditor({})}>Add account</button>
            )}
            <button className="dk-sbtn" disabled={!view} onClick={exportCsv}>Export CSV</button>
            <button className="dk-sbtn" disabled={!view} onClick={print}>Print</button>
          </div>
        </div>
      </div>

      {journalOpen && <JournalEditor edit={journalOpen === true ? null : journalOpen}
        onClose={() => setJournalOpen(false)}
        onSaved={() => { setJournalOpen(false); loadOv(); setRange({ ...range }); }} />}
      {acctEditor && <AccountEditor editor={acctEditor} onClose={() => setAcctEditor(null)}
        onSaved={() => { setAcctEditor(null); loadOv(); setRange({ ...range }); toast("Account saved"); }} />}
    </div>
  );
}

/* ── The four panels ──────────────────────────────────────────────────────
   The deck's third and fourth panels are "Unposted journals" and "Period
   locked to". This app has neither — every journal posts the moment it is
   made, and there is no period lock — so rather than show a figure that would
   always read zero, those slots carry what the books do have. */
function AccountingStrip({ ov, view, ovFailed, viewFailed }) {
  return (
    <div className="dk-strip four">
      <div>
        <div className="l">{view ? view.figLabel : "\u00a0"}</div>
        <div className={`big dk-n ${view && view.figTone === "good" ? "amt-received" : view && view.figTone === "bad" ? "amt-overdue" : ""}`}>
          {figure(viewFailed, view ? view.fig : "—")}
        </div>
        <div className="s">{viewFailed ? "this view did not load" : view ? view.figSub : "\u00a0"}</div>
      </div>
      <div>
        <div className="l">Books health</div>
        <div className={`v dk-n ${!ov ? "" : ov.balanced ? "amt-received" : "amt-overdue"}`}>
          {/* "Balanced" is a clean bill of health for the ledger. It has to
              come from an answer, never from the absence of one. */}
          {figure(ovFailed, ov ? (ov.balanced ? "Balanced" : "Out of balance") : "—")}
        </div>
        <div className="s dk-n">
          {ovFailed ? "the books summary did not load"
            : ov ? (ov.balanced ? `Dr = Cr · ${inr(ov.bothSides)}` : `out by ${inr(Math.abs(ov.gap))}`) : "\u00a0"}
        </div>
      </div>
      <div>
        <div className="l">Journals by hand</div>
        <div className="v dk-n">{figure(ovFailed, ov ? ov.manualJournals : "—")}</div>
        <div className="s">{ovFailed ? "the books summary did not load"
          : ov ? `${ov.entriesTotal} entries in all · ${ov.entriesThisMonth} this month` : "\u00a0"}</div>
      </div>
      <div>
        <div className="l">Books run from</div>
        <div className="v dk-n">{figure(ovFailed, ov ? prettyDate(ov.firstEntry) : "—")}</div>
        <div className="s">{ovFailed ? "the books summary did not load"
          : ov ? `${ov.accounts} accounts on the chart` : "\u00a0"}</div>
      </div>
    </div>
  );
}

/* ── The one table ────────────────────────────────────────────────────── */
function LedgerTable({ view }) {
  /* A trailing ⋮ column, present only when some row in this view has anything
     to offer. The chart of accounts and the balance sheet have no per-row
     actions, and an empty column of dots on every report would be six pixels
     of noise on five screens to serve one. */
  const hasActions = view.rows.some((r) => r.actions && r.actions.length);
  return (
    <table className="dk-table">
      <thead>
        <tr>
          {view.columns.map((c, i) => <th key={i} className={c[1] === "right" ? "r" : ""}>{c[0]}</th>)}
          {hasActions && <th />}
        </tr>
      </thead>
      <tbody>
        {view.rows.length === 0 ? (
          <tr><td colSpan={view.columns.length + (hasActions ? 1 : 0)}><div className="dk-empty">{view.empty || "Nothing here for these dates."}</div></td></tr>
        ) : view.rows.map((r, i) => (
          <tr key={i} className={r.sub ? "sub" : ""}>
            {r.cells.map((c, j) => (
              <td key={j} className={[
                view.columns[j][1] === "right" ? "r dk-n" : "",
                c.strong ? "strong" : "", c.dim ? "dim" : "", c.tone || "",
              ].filter(Boolean).join(" ")}>
                {c.pill ? <span className={`dk-tpill ${c.pill}`}>{c.v}</span> : c.v}
              </td>
            ))}
            {hasActions && (
              <td style={{ textAlign: "right", width: 44 }}>
                {r.actions && r.actions.length
                  ? <RowMenu label={r.actionsLabel || "Actions"} actions={r.actions} />
                  : null}
              </td>
            )}
          </tr>
        ))}
        {view.total && view.rows.length > 0 && (
          <tr className="total">
            {view.total.map((c, j) => (
              <td key={j} className={[view.columns[j][1] === "right" ? "r dk-n" : "", c.tone || ""].filter(Boolean).join(" ")}>
                {c.v}
              </td>
            ))}
            {hasActions && <td />}
          </tr>
        )}
      </tbody>
    </table>
  );
}

/* ── Turning each endpoint into columns and rows ──────────────────────── */
const txt = (v, o = {}) => ({ v, raw: v, ...o });
const num = (v, o = {}) => ({ v: dash(v), raw: v, ...o });

async function buildView(tab, range, ctx = {}) {
  const period = `${prettyDate(range.from)} – ${prettyDate(range.to)}`;
  const asAt = `As at ${prettyDate(range.to)}`;

  if (tab === "accounts") {
    const rows = await api.get("/accounting/accounts");
    const assets = rows.filter((r) => r.type === "asset").reduce((a, r) => a + (+r.balance || 0), 0);
    const groups = new Set(rows.map((r) => r.type)).size;
    return {
      title: "Chart of accounts", period: asAt,
      note: `${rows.length} accounts · ${groups} groups`,
      figLabel: "Total assets", fig: money(assets), figTone: "ink",
      figSub: "cash, debtors and stock",
      foot: "Codes follow the standard 1000–6000 blocks",
      columns: [["Code", "left"], ["Account", "left"], ["Group", "left"], ["Balance", "right"]],
      rows: rows.map((r) => ({
        cells: [txt(r.code, { dim: true }), txt(r.name, { strong: true }),
                txt(String(r.type || "").replace(/^./, (c) => c.toUpperCase())), num(r.balance)],
      })),
      total: [txt(""), txt("All accounts"), txt(""), num(rows.reduce((a, r) => a + Math.abs(+r.balance || 0), 0))],
      empty: "No accounts on the chart yet.",
    };
  }

  if (tab === "health") {
    const d = await api.get("/accounting/integrity");
    const pass = d.checks.filter((c) => c.ok).length;
    /* Name what failed rather than saying "some checks" — the failure is the
       whole reason anyone opens this tab. */
    const failed = d.checks.filter((c) => !c.ok).map((c) => c.name);
    return {
      title: "Books health", period: asAt,
      note: `${pass} passed · ${failed.length} need${failed.length === 1 ? "s" : ""} a look`,
      figLabel: "Status", fig: d.ok ? "All clear" : `${failed.length} to look at`,
      figTone: d.ok ? "good" : "bad",
      figSub: d.ok ? "every check passed" : failed.join(" · ").toLowerCase(),
      foot: "Run this before filing or closing a period",
      columns: [["Check", "left"], ["Result", "left"], ["Detail", "left"]],
      rows: d.checks.map((c) => ({
        cells: [txt(c.name, { strong: true }),
                { v: c.ok ? "pass" : "look", raw: c.ok ? "pass" : "look", pill: c.ok ? "good" : "warn" },
                txt(c.detail, { dim: true })],
      })),
      total: [txt(`${d.checks.length} checks`), txt(`${pass} pass · ${d.checks.length - pass} to look at`), txt("")],
      empty: "No checks ran.",
    };
  }

  if (tab === "journals" || tab === "daybook") {
    const d = await api.get(`/accounting/daybook?from=${range.from}&to=${range.to}`);
    const totalDr = d.reduce((a, e) => a + (e.lines || []).reduce((s, l) => s + (+l.debit || 0), 0), 0);
    const byHand = d.filter((e) => e.source_module === "manual").length;

    if (tab === "journals") {
      return {
        title: "Journals", period,
        note: `${d.length} entries · ${byHand} made by hand`,
        figLabel: "Posted this period", fig: money(totalDr), figTone: "ink",
        figSub: `${d.length} entr${d.length === 1 ? "y" : "ies"}`,
        foot: "Journals made by hand are flagged; the rest come from bills, sales and payments",
        columns: [["Entry", "left"], ["Date", "left"], ["Narration", "left"], ["Source", "left"], ["Debit", "right"], ["Credit", "right"]],
        rows: d.map((e) => {
          const dr = (e.lines || []).reduce((s, l) => s + (+l.debit || 0), 0);
          const cr = (e.lines || []).reduce((s, l) => s + (+l.credit || 0), 0);
          /* Only an entry with no document behind it may be changed here. One
             a sale or a payment wrote belongs to that document — correcting it
             from the ledger would leave the sale saying one thing and the
             books another, which is the failure this whole screen exists to
             make visible. Those rows simply carry no menu. */
          const standalone = e.source_module === "manual" || e.source_module === "other_income";
          const edited = Number(e.edit_count) > 0;
          return {
            cells: [txt(e.entry_no, { strong: true }), txt(String(e.entry_date).slice(0, 10), { dim: true }),
                    txt((e.description || "—") + (edited ? "  (amended)" : "")),
                    { v: e.source_module || "—", raw: e.source_module || "", pill: e.source_module === "manual" ? "accent" : "" },
                    num(dr), num(cr)],
            actionsLabel: `Actions for ${e.entry_no}`,
            actions: standalone && ctx.editJournal ? [
              ...(can("accounting", "edit") ? [{
                icon: <Icon n="edit" />, label: "Edit entry",
                onClick: () => ctx.editJournal(e),
              }] : []),
              ...(can("accounting", "delete") ? [{
                icon: <Icon n="trash" />, label: "Delete entry", danger: true,
                onClick: async () => {
                  if (!(await confirmDialog({
                    title: `Delete ${e.entry_no}?`,
                    message: "The balances it moved are put back and the entry is removed. Nothing else in the books changes.",
                    danger: true, confirmLabel: "Delete",
                  }))) return;
                  try {
                    const r = await api.delete(`/accounting/journal/${e.id}`);
                    toast(r.message || `${e.entry_no} deleted`);
                    ctx.refresh?.();
                  } catch (err) { toast(err.message, "bad"); }
                },
              }] : []),
            ] : [],
          };
        }),
        total: [txt(`${d.length} entries`), txt(""), txt(""), txt(""), num(totalDr), num(totalDr)],
        empty: "No journals in this period.",
      };
    }

    /* Day book: every posting line, not just the entry heading. */
    const lines = [];
    for (const e of d) {
      for (const l of e.lines || []) {
        lines.push({
          cells: [txt(String(e.entry_date).slice(0, 10), { dim: true }), txt(e.entry_no, { dim: true }),
                  txt(l.account_name || l.account_code, { strong: true }),
                  txt(l.narration || e.description || "—", { dim: true }),
                  num(l.debit), num(l.credit)],
        });
      }
    }
    const dr = lines.reduce((a, r) => a + (+r.cells[4].raw || 0), 0);
    const cr = lines.reduce((a, r) => a + (+r.cells[5].raw || 0), 0);
    return {
      title: "Day book", period,
      note: `${lines.length} postings across ${d.length} entries`,
      figLabel: "Posted this period", fig: money(dr), figTone: "ink",
      figSub: `${lines.length} posting${lines.length === 1 ? "" : "s"}`,
      foot: "Every line that hit the ledger, oldest entry last",
      columns: [["Date", "left"], ["Entry", "left"], ["Account", "left"], ["Narration", "left"], ["Debit", "right"], ["Credit", "right"]],
      rows: lines,
      total: [txt(""), txt(""), txt(`${lines.length} postings`), txt(""), num(dr), num(cr)],
      empty: "Nothing was posted in this period.",
    };
  }

  if (tab === "pl") {
    const d = await api.get(`/accounting/profit-loss?from=${range.from}&to=${range.to}`);
    const rev = d.totalIncome || 0;
    const pct = (v) => (rev > 0 ? `${((Math.abs(v) / rev) * 100).toFixed(1)}%` : "—");
    const rows = [];
    for (const r of d.income) rows.push({ cells: [txt(r.name), num(r.amount), txt(pct(r.amount))] });
    rows.push({ sub: true, cells: [txt("Total income", { strong: true }), num(d.totalIncome), txt(rev > 0 ? "100.0%" : "—")] });
    for (const r of d.expense) rows.push({ cells: [txt(r.name), num(r.amount), txt(pct(r.amount))] });
    rows.push({ sub: true, cells: [txt("Total expenses", { strong: true }), num(d.totalExpense), txt(pct(d.totalExpense))] });

    return {
      title: "Profit & loss", period,
      note: "accrual basis",
      figLabel: "Net profit", fig: money(d.netProfit),
      figTone: d.netProfit >= 0 ? "good" : "bad",
      figSub: rev > 0 ? `${((d.netProfit / rev) * 100).toFixed(1)}% of income` : "no income in this period",
      foot: "Income less expenses, from the accounts as posted",
      columns: [["Line", "left"], ["Amount", "right"], ["% of income", "right"]],
      rows,
      total: [txt("Net profit"), num(d.netProfit, { tone: d.netProfit < 0 ? "neg" : "pos" }),
              txt(rev > 0 ? `${((d.netProfit / rev) * 100).toFixed(1)}%` : "—")],
      empty: "Nothing was posted in this period.",
    };
  }

  /* Balance sheet */
  const d = await api.get(`/accounting/balance-sheet?asOf=${range.to}`);
  const rows = [];
  const section = (label, list, total) => {
    for (const r of list) rows.push({ cells: [txt(r.name), num(r.amount)] });
    rows.push({ sub: true, cells: [txt(label, { strong: true }), num(total)] });
  };
  section("Total assets", d.assets, d.totalAssets);
  section("Total liabilities", d.liabilities, d.totalLiab);
  for (const r of d.equity) rows.push({ cells: [txt(r.name), num(r.amount)] });
  rows.push({ cells: [txt("Profit for the period"), num(d.netProfit)] });
  rows.push({ sub: true, cells: [txt("Total equity", { strong: true }), num(d.totalEquity)] });

  const balanced = Math.abs(d.totalAssets - d.totalLiabilitiesAndEquity) < 0.005;
  return {
    title: "Balance sheet", period: asAt,
    note: balanced ? "assets = liabilities + equity" : "does not balance — check the books health tab",
    figLabel: "Total assets", fig: money(d.totalAssets),
    figTone: balanced ? "ink" : "bad",
    figSub: balanced ? "matched by liabilities and equity" : `out by ${inr(Math.abs(d.totalAssets - d.totalLiabilitiesAndEquity))}`,
    foot: "A position at a single date — the To date above",
    columns: [["Line", "left"], ["Amount", "right"]],
    rows,
    total: [txt("Liabilities + equity"), num(d.totalLiabilitiesAndEquity, { tone: balanced ? "" : "neg" })],
    empty: "Nothing was posted up to this date.",
  };
}

/* Exported because the Cash & Bank screen adds accounts too, and a second
   "add account" dialog written over there would be a second place for the
   is_cash_bank tick to be forgotten — an account created without it never
   appears in the picker, and the shopkeeper is left wondering where it went.
   `editor.cashBank` opens it pre-ticked and typed as an asset, which is what
   "New bank account" already means; `editor.title` lets the caller name the
   dialog after the button that opened it. */
export function AccountEditor({ editor, onClose, onSaved }) {
  const edit = editor.mode === "edit" ? editor.account : null;
  const [f, setF] = useState(edit
    ? { name: edit.name, type: edit.type, code: edit.code, is_cash_bank: edit.is_cash_bank === 1,
        /* Blank means "nobody has said" — the same NULL the column holds for
           every account that predates it. Defaulting it to cash or bank here
           would silently reclassify an old account the first time somebody
           opened this dialog to fix a typo in its name. */
        kind: edit.kind || "", opening_balance: 0 }
    : { name: "", type: editor.cashBank ? "asset" : "expense", code: "",
        /* Opened from a Cash & bank section header, the section already says
           what is being created — a "New mobile money account" dialog that
           defaults to Bank is a wrong answer nobody would think to check. */
        is_cash_bank: !!editor.cashBank,
        kind: editor.cashBank ? (editor.kind || "bank") : "", opening_balance: 0 });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) return toast("Enter an account name", "bad");
    setBusy(true);
    try {
      const kind = f.is_cash_bank ? (f.kind || null) : null;
      if (edit) await api.put(`/accounting/accounts/${edit.code}`, { name: f.name, type: f.type, is_cash_bank: f.is_cash_bank, kind });
      else await api.post("/accounting/accounts", { name: f.name, type: f.type, code: f.code || undefined, is_cash_bank: f.is_cash_bank, kind, opening_balance: f.opening_balance });
      toast(edit ? "Account updated" : "Account created");
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };
  return (
    <Modal title={edit ? `Edit ${edit.name}` : (editor.title || "Add account")} onClose={onClose}>
      <Field label="Account name"><input value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus placeholder="e.g. Rent expense" /></Field>
      <div className="row2">
        <Field label="Type">
          <select value={f.type} onChange={(e) => set("type", e.target.value)} disabled={!!edit && edit.is_control}>
            {["asset", "liability", "equity", "income", "expense"].map((t) => <option key={t} value={t} style={{ textTransform: "capitalize" }}>{t}</option>)}
          </select>
        </Field>
        <Field label={edit ? "Code (fixed)" : "Code (optional — auto if blank)"}>
          <input value={f.code} onChange={(e) => set("code", e.target.value)} disabled={!!edit} placeholder="auto" />
        </Field>
      </div>
      {!edit && (
        <Field label="Opening balance (optional)">
          <input type="number" value={f.opening_balance} onChange={(e) => set("opening_balance", e.target.value)} />
        </Field>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 2px", fontSize: 13.5 }}>
        <input type="checkbox" checked={f.is_cash_bank} onChange={(e) => set("is_cash_bank", e.target.checked)} />
        This is a cash / bank account (available in the cash-sale picker)
      </label>
      {/* Which half of the Cash & bank screen this account is grouped under.
          It used to be guessed from the name, which put "Cash at Stanbic" in
          with the till. Only asked when the box above is ticked, because it
          means nothing for a rent-expense account. */}
      {f.is_cash_bank && (
        <Field label="Where the money sits">
          <select value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            <option value="">Work it out from the name</option>
            <option value="cash">Cash — a till, drawer, float or safe on the premises</option>
            <option value="bank">Bank — a current or savings account, or card settlement</option>
            {/* Mobile money is its own thing here: MTN and Airtel float is a
                real balance that gets reconciled against a statement, and a
                shop running four lines needs to see them apart from the bank. */}
            <option value="mobile">Mobile money — an MTN, Airtel or other wallet float</option>
          </select>
        </Field>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : edit ? "Save" : "Create account"}</button>
      </div>
    </Modal>
  );
}

/* New or amended. A journal is the one entry no document produced, so it is
   also the one that can be rewritten in place rather than reversed: there is
   no receipt in anybody's file quoting it, and filling the day book with
   reversal pairs for a mistyped narration would make it harder to read to
   nobody's benefit. The entry keeps its number and counts its amendments. */
function JournalEditor({ edit, onClose, onSaved }) {
  const attempt = useAttempt("journal");
  const [accounts, setAccounts] = useState([]);
  const [date, setDate] = useState((edit && String(edit.entry_date).slice(0, 10)) || new Date().toISOString().slice(0, 10));
  const [desc, setDesc] = useState((edit && edit.description) || "");
  const [lines, setLines] = useState(() => {
    const l = edit && Array.isArray(edit.lines) && edit.lines.length
      ? edit.lines.map((x) => ({
          account_code: x.account_code || "",
          debit: Number(x.debit) > 0 ? String(x.debit) : "",
          credit: Number(x.credit) > 0 ? String(x.credit) : "",
        }))
      : [];
    while (l.length < 2) l.push({ account_code: "", debit: "", credit: "" });
    return l;
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/accounting/accounts").then((a) => setAccounts(a.filter((x) => x.status !== "disabled"))).catch(() => {}); }, []);
  const set = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const totDr = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const totCr = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totDr - totCr) < 0.01 && totDr > 0;
  const save = async () => {
    const valid = lines.filter((l) => l.account_code && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0));
    if (valid.length < 2) return toast("Add at least two lines", "bad");
    if (!balanced) return toast("Debits must equal credits", "bad");
    setBusy(true);
    const payload = { date, description: desc,
      lines: valid.map((l) => ({ account_code: l.account_code, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })) };
    try {
      if (edit) {
        const r = await api.put(`/accounting/journal/${edit.id}`, payload);
        toast(r.message || `${edit.entry_no} updated`);
        onSaved();
        return;
      }
      const je = await api.post("/accounting/journal", { ...payload, client_ref: attempt.ref() });
      attempt.done();
      toast(je.replayed ? `${je.entry_no} had already been posted — this did not post it twice` : "Journal posted");
      onSaved();
      /* A hand-keyed journal is the entry an auditor asks about first, because
         it is the only one no document produced. Its own slip — with the
         account codes and both columns — is what answers that question. */
      offerVoucherPrint({
        noun: "journal slip", title: "Journal voucher", number: je && je.entry_no,
        direction: "Posted by", party: desc,
        amount: valid.reduce((t, l) => t + (Number(l.debit) || 0), 0),
        rows: [["Date", date], ...valid.map((l) => [
          l.account_code,
          Number(l.debit) > 0 ? `Dr ${Number(l.debit).toFixed(2)}` : `Cr ${Number(l.credit).toFixed(2)}`,
        ])],
      });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };
  return (
    <Modal title={edit ? `Edit ${edit.entry_no}` : "New journal entry"} onClose={onClose} wide>
      {edit && (
        <div style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6, marginBottom: 10 }}>
          The entry keeps its number and the balances it moved are recalculated
          from what you leave here — so what the books show afterwards is this
          entry, not this entry plus the old one.
          {Number(edit.edit_count) > 0 ? ` It has been amended ${edit.edit_count} time${edit.edit_count === 1 ? "" : "s"} already.` : ""}
        </div>
      )}
      <div className="row2">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Description"><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Owner capital injection" /></Field>
      </div>
      <table className="line-grid" style={{ marginTop: 8 }}>
        <thead><tr><th style={{ width: "50%" }}>Account</th><th style={{ width: "22%" }}>Debit</th><th style={{ width: "22%" }}>Credit</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select className="cell-input" value={l.account_code} onChange={(e) => set(i, { account_code: e.target.value })}>
                  <option value="">— account —</option>
                  {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                </select>
              </td>
              <td className="num"><input className="cell-input" type="number" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: "" })} /></td>
              <td className="num"><input className="cell-input" type="number" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: "" })} /></td>
              <td><button className="icon-btn" onClick={() => setLines((ls) => ls.length > 2 ? ls.filter((_, j) => j !== i) : ls)}><Icon n="close" size={15} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setLines((l) => [...l, { account_code: "", debit: "", credit: "" }])}>+ Add line</button>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, padding: "10px 4px", borderTop: "1px solid var(--border)", fontWeight: 700 }}>
        <span style={{ color: balanced ? "var(--ok)" : "var(--bad)" }}>{balanced ? "✓ Balanced" : "Debits must equal credits"}</span>
        <span className="num">Dr {cur()} {inr(totDr)} · Cr {cur()} {inr(totCr)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !balanced}>
          {busy ? (edit ? "Saving…" : "Posting…") : (edit ? "Save changes" : "Post journal")}
        </button>
      </div>
    </Modal>
  );
}

