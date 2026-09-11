/* ── Recurring schedules ───────────────────────────────────────────────────
   Bills that raise themselves. This is one panel used twice: as a tab inside
   Sales for recurring sales, and inside Purchases for recurring bills.

   It used to be its own top-level screen, which meant a shop looking at its
   sales had to leave to find the sales that repeat. They are sales; they
   belong with the sales.

   Three sub-views: what is due, everything, and what has actually been raised.
   They are a segmented filter inside the card head, not a third row of tabs —
   the same shape the other Sales tabs use, so a schedule list reads like an
   invoice list rather than like a screen of its own.
*/
import React, { useEffect, useMemo, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur, fmtDate as sharedFmtDate } from "../lib/tax.js";
import { toast, confirmDialog, RowMenu } from "../lib/ui.jsx";
import { LoadingRows, TableCard } from "../lib/deckui.jsx";
import { Icon } from "../lib/icons.jsx";
import { InvoiceBuilder } from "./Invoices.jsx";

const money = (v) => `${cur()} ${inr(v)}`;
const FREQ = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };

/* How far off the next run is, said the way a person would say it. */
function dueIn(nextRun) {
  if (!nextRun) return { text: "—", tone: "ok" };
  const today = new Date(new Date().toDateString());
  const d = new Date(nextRun);
  const days = Math.round((d - today) / 86400000);
  if (days < 0) return { text: `${-days} day${days === -1 ? "" : "s"} overdue`, tone: "late" };
  if (days === 0) return { text: "Due today", tone: "late" };
  if (days === 1) return { text: "Tomorrow", tone: "soon" };
  if (days <= 7) return { text: `${days} days left`, tone: "soon" };
  return { text: `${days} days left`, tone: "ok" };
}

const fmtDate = sharedFmtDate;

export default function RecurringPanel({ docType = "sale" }) {
  const isPurchase = docType === "purchase";
  const [view, setView] = useState("all");
  const [rows, setRows] = useState(null);
  const [history, setHistory] = useState(null);
  const [sum, setSum] = useState(null);
  const [q, setQ] = useState("");
  const [editor, setEditor] = useState(null);

  const load = () => {
    api.get(`/recurring?doc_type=${docType}`).then(setRows).catch(() => setRows([]));
    api.get(`/recurring/summary?doc_type=${docType}`).then(setSum).catch(() => setSum(null));
  };
  useEffect(() => { load(); setView("all"); }, [docType]);
  useEffect(() => {
    if (view !== "history") return;
    setHistory(null);
    api.get(`/recurring/history?doc_type=${docType}`).then(setHistory).catch(() => setHistory([]));
  }, [view, docType]);

  const shown = useMemo(() => {
    if (!rows) return null;
    const t = q.toLowerCase().trim();
    return rows
      .filter((r) => (view === "due" ? r.due : true))
      .filter((r) => !t || `${r.name} ${r.party_name || ""} ${r.notes || ""}`.toLowerCase().includes(t));
  }, [rows, view, q]);

  const shownHistory = useMemo(() => {
    if (!history) return null;
    const t = q.toLowerCase().trim();
    return history.filter((h) => !t
      || `${h.doc_no || ""} ${h.schedule_name || ""} ${h.party_name || ""}`.toLowerCase().includes(t));
  }, [history, q]);

  const runNow = async (r) => {
    if (!(await confirmDialog({
      title: `Raise ${r.name} now?`,
      message: `A ${isPurchase ? "bill" : "sale"} of about ${money(r.amount)} for ${r.party_name}.`,
      detail: `It posts to the books straight away and the next run moves on to the following ${FREQ[r.frequency].toLowerCase()} date.`,
      confirmLabel: `Raise it now`,
    }))) return;
    try { const d = await api.post(`/recurring/${r.id}/run`, {}); toast(d.message || "Raised"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const toggle = async (r) => {
    const next = r.status === "active" ? "paused" : "active";
    try {
      await api.post(`/recurring/${r.id}/status`, { status: next });
      toast(next === "paused" ? `${r.name} paused` : `${r.name} switched back on`);
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  const remove = async (r) => {
    if (!(await confirmDialog({
      title: `Delete ${r.name}?`,
      message: "The schedule stops. Documents it already raised are untouched.",
      danger: true, confirmLabel: "Delete schedule",
    }))) return;
    try { await api.delete(`/recurring/${r.id}`); toast("Schedule deleted"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const openEdit = async (r) => {
    try { setEditor({ mode: "edit", doc: await api.get(`/recurring/${r.id}`) }); }
    catch (e) { toast(e.message, "bad"); }
  };

  /* Same three figures the two banner pills carried, in the strip every other
     Sales tab opens with. Sub-lines are kept short — .dk-strip .s is now a
     single ellipsised line. */
  const strip = (
    <div className="dk-strip">
      <div>
        <div className="l">Projected monthly {isPurchase ? "spend" : "revenue"}</div>
        <div className="big dk-n">{sum ? money(sum.projectedMonthly) : "—"}</div>
        <div className="s">
          {sum ? `${sum.active} active of ${sum.total} schedule${sum.total === 1 ? "" : "s"}` : " "}
        </div>
      </div>
      <div>
        <div className="l">Expected this month</div>
        <div className="v dk-n amt-owed">{sum ? money(sum.expectedThisMonth) : "—"}</div>
        <div className="s">still to be raised</div>
      </div>
      <div>
        <div className="l">Due now</div>
        {/* A count of schedules ready to be raised, not a sum of money and not
            overdue — so it takes none of the `.amt-*` money vocabulary. `.v`
            already carries the size and weight the strip gives its figures;
            the sub-line says what it is. */}
        <div className="v dk-n">{sum ? sum.dueSoon : "—"}</div>
        <div className="s">ready to raise today</div>
      </div>
    </div>
  );

  const showing = view === "history"
    ? shownHistory === null ? "Loading…" : `Showing ${shownHistory.length} of ${(history || []).length}`
    : shown === null ? "Loading…" : `Showing ${shown.length} of ${(rows || []).length}`;

  return (
    <>
      {strip}

      <TableCard
        title={isPurchase ? "Recurring purchases" : "Recurring sales"}
        createLabel={`Add recurring ${isPurchase ? "purchase" : "sale"}`}
        canCreate={can(isPurchase ? "purchases" : "sales", "create")}
        onCreate={() => setEditor({ mode: "new" })}
        filters={[
          ["due", `Due soon${sum && sum.dueSoon > 0 ? ` (${sum.dueSoon})` : ""}`],
          ["all", "All schedules"],
          ["history", "History"],
        ]}
        filter={view} onFilter={setView}
        q={q} onQ={setQ} searchHint="Search schedules or history…"
        showing={showing}
      >
        {view === "history" ? (
            <table className="dk-table">
              <thead>
                <tr><th>Document</th><th>Schedule</th><th>{isPurchase ? "Supplier" : "Customer"}</th><th>Raised</th><th>Result</th></tr>
              </thead>
              <tbody>
                {shownHistory === null ? <LoadingRows cols={5} />
                  : shownHistory.length === 0 ? (
                    <tr><td colSpan={5}><div className="dk-empty">
                      {q ? "Nothing matches that." : "Nothing has been raised from a schedule yet."}
                    </div></td></tr>
                  ) : shownHistory.map((h) => (
                    <tr key={h.id}>
                      <td className="dk-n strong">{h.doc_no || "—"}</td>
                      <td className="tight">{h.schedule_name}</td>
                      <td className="tight">{h.party_name || "—"}</td>
                      <td className="tight dk-n dim">{fmtDate(h.run_date)}</td>
                      <td className="tight">
                        <span className={`dk-tpill ${h.status === "created" ? "good" : "bad"}`}>
                          {h.status === "created" ? "raised" : h.status}
                        </span>
                        {h.message && <span className="dim" style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 500 }}>{h.message}</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <table className="dk-table">
              <thead>
                <tr>
                  <th>Description</th><th>Frequency</th><th className="r">Amount</th>
                  <th>Next billing</th><th>Days left</th><th>Status</th><th style={{ width: 52 }} />
                </tr>
              </thead>
              <tbody>
                {shown === null ? <LoadingRows cols={7} />
                  : shown.length === 0 ? (
                    <tr><td colSpan={7}><div className="dk-empty">
                      {view === "due" ? "Nothing is due — every schedule is up to date."
                        : q ? "Nothing matches that."
                        : `No recurring ${isPurchase ? "purchases" : "sales"} yet. Set one up for anything billed on the same day every month.`}
                    </div></td></tr>
                  ) : shown.map((r) => {
                    const d = dueIn(r.next_run);
                    return (
                      <tr key={r.id}>
                        <td className="strong">
                          {r.name}
                          <div className="dim" style={{ fontSize: 11.5, fontWeight: 500 }}>
                            {[r.party_name, r.notes || "No notes"].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="tight" style={{ color: "var(--accent)", fontWeight: 650 }}>{FREQ[r.frequency] || r.frequency}</td>
                        <td className="r dk-n strong">{money(r.amount)}</td>
                        <td className="tight dk-n">{fmtDate(r.next_run)}</td>
                        <td className="tight">
                          <span className={`dk-due ${r.status === "active" ? d.tone : "ok"}`}>
                            {r.status === "active" ? d.text : "—"}
                          </span>
                        </td>
                        <td className="tight">
                          <span className={`dk-tpill ${r.status === "active" ? "good" : r.status === "paused" ? "warn" : ""}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="tight r">
                          <RowMenu actions={[
                            r.status === "active" && r.due && can(isPurchase ? "purchases" : "sales", "create") &&
                              { icon: <Icon n="send" />, label: "Raise now", onClick: () => runNow(r) },
                            can(isPurchase ? "purchases" : "sales", "edit") &&
                              { icon: <Icon n={r.status === "active" ? "pause" : "play"} />,
                                label: r.status === "active" ? "Pause" : "Switch on", onClick: () => toggle(r) },
                            can(isPurchase ? "purchases" : "sales", "edit") &&
                              { icon: <Icon n="edit" />, label: "Edit", onClick: () => openEdit(r) },
                            can(isPurchase ? "purchases" : "sales", "delete") &&
                              { icon: <Icon n="trash" />, label: "Delete schedule", danger: true, onClick: () => remove(r) },
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
      </TableCard>

      {editor && (
        <InvoiceBuilder
          recurring docType={docType}
          initial={editor.mode === "edit" ? editor.doc : null}
          editing={editor.mode === "edit"}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); load(); toast(editor.mode === "edit" ? "Schedule updated" : "Schedule created"); }}
        />
      )}
    </>
  );
}
