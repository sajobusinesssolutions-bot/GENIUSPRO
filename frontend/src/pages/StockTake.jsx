import React, { useEffect, useMemo, useRef, useState } from "react";
import api, { can } from "../lib/api.js";
import { inr, cur } from "../lib/tax.js";
import { Modal, toast, confirmDialog } from "../lib/ui.jsx";
import { LoadingRows, useRead, LoadFailed, FailedRows, figure } from "../lib/deckui.jsx";

/* ── Stock take, built to the design deck ──────────────────────────────────
   Three tabs: the count you are working on, the ones you have finished, and
   what the counting has been telling you.

   Nothing moves until a count is posted, so an unfinished one is safe to
   leave open — and posting now asks why the count differed, because a shop
   that cannot tell theft from a keying error learns nothing from counting.  */

const money = (v) => `${cur()} ${inr(v)}`;
const q3 = (v) => +Number(v || 0).toFixed(3);

export default function StockTake() {
  const [tab, setTab] = useState("current");
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [cats, setCats] = useState([]);
  const [saving, setSaving] = useState(false);
  const [startOpen, setStartOpen] = useState(false);

  /* Was `.catch(() => setList([]))`, which drew "No counts yet" over a shelf
     full of them and let the toolbar offer a new count while one was already
     running. */
  const [listFailed, readList] = useRead();
  const loadList = () => readList(api.get("/stock-takes"), setList, null);
  useEffect(() => {
    loadList();
    api.get("/settings/categories").then(setCats).catch(() => setCats([]));
  }, []);

  /* Landing on the screen should drop you into the count already running,
     which is almost always why you came. If that read fails the screen must
     not fall through to "No count running" — there plainly is one. */
  const [openFailed, readOpen, setOpenFailed] = useRead();
  const loadOpen = (id) => readOpen(api.get(`/stock-takes/${id}`), setOpen, null);
  useEffect(() => {
    if (open || !list) return;
    const draft = list.find((t) => t.status === "draft");
    if (draft) loadOpen(draft.id);
  }, [list]);

  const openTake = async (id) => {
    try { setOpen(await api.get(`/stock-takes/${id}`)); setOpenFailed(false); setTab("current"); }
    catch (e) { toast(e.message, "bad"); }
  };

  const start = async (categoryId) => {
    try {
      const r = await api.post("/stock-takes", categoryId ? { category_id: categoryId } : {});
      toast(`${r.reference} started — ${r.lines} line${r.lines === 1 ? "" : "s"} to count`);
      setStartOpen(false);
      await loadList();
      await openTake(r.id);
    } catch (e) { toast(e.message, "bad"); }
  };

  const draft = list ? list.find((t) => t.status === "draft") : null;

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {[["current", "Counting now"], ["history", "Past counts"], ["variance", "Variance report"]].map(([id, label]) => (
            <button key={id} className={`dk-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="spacer" />
        {/* Not while the list is unknown: a second count started on top of one
            that is already open is the one mistake this screen must not invite. */}
        {can("items", "edit") && !draft && !listFailed && !openFailed && (
          <button className="dk-create" onClick={() => setStartOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
            New count
          </button>
        )}
      </div>

      {tab === "current" && (
        openFailed
          ? <div className="dk-card"><LoadFailed what="the count in progress"
              onRetry={() => draft && loadOpen(draft.id)} /></div>
        : listFailed
          ? <div className="dk-card"><LoadFailed what="your stock counts" onRetry={loadList} /></div>
        : open && open.status === "draft"
          ? <CountSheet take={open} saving={saving} setSaving={setSaving}
              onReload={async () => { await loadList(); await openTake(open.id); }}
              onPosted={async () => { setOpen(null); await loadList(); setTab("history"); }} />
          : <NoCount hasList={!!list} onStart={() => setStartOpen(true)} canStart={can("items", "edit")} />
      )}

      {tab === "history" && <PastCounts list={list} failed={listFailed} onRetry={loadList} onOpen={openTake} />}
      {tab === "variance" && <VarianceReport />}

      {startOpen && <StartCount cats={cats} onClose={() => setStartOpen(false)} onStart={start} />}
    </div>
  );
}

function NoCount({ hasList, onStart, canStart }) {
  return (
    <div className="dk-card">
      <div className="dk-empty" style={{ padding: "60px 24px" }}>
        {!hasList ? "Loading…" : (
          <>
            <b style={{ display: "block", fontSize: 16, color: "var(--soft)", marginBottom: 8 }}>No count running</b>
            Counting is how the books find out what is really on the shelf. Nothing moves until you post it.
            {canStart && (
              <div style={{ marginTop: 18 }}>
                {/* Same verb as the toolbar button above it — two labels for one
                    action read as two different actions. */}
                <button className="dk-create" onClick={onStart}>New count</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── The count sheet ──────────────────────────────────────────────────── */
function CountSheet({ take, saving, setSaving, onReload, onPosted }) {
  const [lines, setLines] = useState(() => take.lines.map((l) => ({ ...l })));
  const [diffOnly, setDiffOnly] = useState(false);
  const [scan, setScan] = useState("");
  const [reason, setReason] = useState("");
  const [account, setAccount] = useState("");
  const [opts, setOpts] = useState({ reasons: [], accounts: [] });
  const scanRef = useRef(null);

  useEffect(() => { setLines(take.lines.map((l) => ({ ...l }))); }, [take.id]);
  useEffect(() => {
    api.get("/stock-takes/reasons").then((d) => {
      setOpts(d);
      setAccount((a) => a || d.defaultAccount || "");
    }).catch(() => {});
  }, []);

  const stats = useMemo(() => {
    let counted = 0, match = 0, short = 0, over = 0, value = 0;
    for (const l of lines) {
      if (l.counted_qty === null || l.counted_qty === "" || l.counted_qty === undefined) continue;
      counted++;
      const d = Number(l.counted_qty) - Number(l.system_qty);
      if (Math.abs(d) < 0.0001) match++;
      else { if (d < 0) short++; else over++; value += d * (Number(l.unit_cost) || 0); }
    }
    return { counted, match, short, over, value: +value.toFixed(2), diffs: short + over };
  }, [lines]);

  const shown = useMemo(() => {
    if (!diffOnly) return lines;
    return lines.filter((l) => {
      if (l.counted_qty === null || l.counted_qty === "" || l.counted_qty === undefined) return false;
      return Math.abs(Number(l.counted_qty) - Number(l.system_qty)) > 0.0001;
    });
  }, [lines, diffOnly]);

  const setQty = (id, v) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, counted_qty: v } : l)));

  const save = async (msg) => {
    setSaving(true);
    try {
      await api.put(`/stock-takes/${take.id}/lines`, {
        lines: lines.map((l) => ({ id: l.id, counted_qty: l.counted_qty, note: l.note })),
      });
      if (msg) toast(msg);
    } catch (e) { toast(e.message, "bad"); }
    setSaving(false);
  };

  const copySystem = async () => {
    if (!(await confirmDialog({
      title: "Copy system counts into the blanks?",
      message: `${lines.filter((l) => l.counted_qty === null || l.counted_qty === "").length} blank line${lines.filter((l) => l.counted_qty === null || l.counted_qty === "").length === 1 ? "" : "s"} will be filled with what the books already say.`,
      detail: "Use this only when you have checked those shelves and they were right. It is not the same as counting them.",
      confirmLabel: "Fill uncounted lines",
    }))) return;
    setLines((ls) => ls.map((l) => (l.counted_qty === null || l.counted_qty === "" ? { ...l, counted_qty: l.system_qty } : l)));
  };

  const post = async () => {
    const blanks = lines.filter((l) => l.counted_qty === null || l.counted_qty === "").length;
    if (!(await confirmDialog({
      title: "Post this count?",
      message: stats.diffs === 0
        ? "Every line counted matches the books, so nothing will move."
        : `${stats.diffs} line${stats.diffs === 1 ? "" : "s"} differ — ${stats.short} short, ${stats.over} over.`,
      detail: [
        stats.diffs > 0 ? `Stock is adjusted to what you counted and ${money(Math.abs(stats.value))} is ${stats.value < 0 ? "written off" : "written back"}.` : "",
        blanks > 0 ? `${blanks} line${blanks === 1 ? "" : "s"} left blank will be ignored — those items keep their current figure.` : "",
        "This cannot be undone.",
      ].filter(Boolean).join("\n"),
      danger: true, confirmLabel: "Post count",
    }))) return;

    setSaving(true);
    try {
      await api.put(`/stock-takes/${take.id}/lines`, {
        lines: lines.map((l) => ({ id: l.id, counted_qty: l.counted_qty, note: l.note })),
      });
      const r = await api.post(`/stock-takes/${take.id}/post`, { reason, account });
      toast(`${take.reference} posted — ${r.changed || stats.diffs} line${(r.changed || stats.diffs) === 1 ? "" : "s"} adjusted`);
      onPosted();
    } catch (e) { toast(e.message, "bad"); setSaving(false); }
  };

  const abandon = async () => {
    if (!(await confirmDialog({
      title: `Abandon ${take.reference}?`,
      message: "The counts keyed in so far are thrown away.",
      detail: "Nothing has been posted, so no stock changes either way.",
      danger: true, confirmLabel: "Discard count",
    }))) return;
    try { await api.delete(`/stock-takes/${take.id}`); toast("Count abandoned"); onPosted(); }
    catch (e) { toast(e.message, "bad"); }
  };

  /* A scanner types the code and presses Enter; jump to that line and select
     the box so the counter can type straight into it. */
  const jump = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const t = scan.trim().toLowerCase();
    if (!t) return;
    const hit = lines.find((l) => String(l.item_code || "").toLowerCase() === t
      || String(l.barcode || "").toLowerCase() === t
      || String(l.name || "").toLowerCase().includes(t));
    if (!hit) return toast("Nothing on this sheet matches that", "bad");
    setDiffOnly(false);
    setScan("");
    const box = document.getElementById(`cnt-${hit.id}`);
    if (box) { box.scrollIntoView({ block: "center", behavior: "smooth" }); box.focus(); box.select(); }
  };

  const total = lines.length;
  const blanks = total - stats.counted;
  const needsReason = stats.diffs > 0;

  return (
    <>
      <div className="dk-strip four">
        <div>
          <div className="l">Counting now — {take.reference}</div>
          <div className="big dk-n">
            {stats.counted} <span style={{ fontSize: 16, fontWeight: 650, color: "var(--faint)" }}>of {total} items</span>
          </div>
          <div className="dk-progress"><i style={{ width: `${total ? (stats.counted / total) * 100 : 0}%` }} /></div>
          <div className="s">
            started {String(take.created_at || "").slice(11, 16)} by {take.created_by_name || "—"} · {take.scope || "all items"}
          </div>
        </div>
        <div>
          <div className="l">Matches</div>
          <div className="v dk-n val-good">{stats.match}</div>
          <div className="s">counted as expected</div>
        </div>
        <div>
          <div className="l">Differences</div>
          <div className={`v dk-n ${stats.diffs ? "val-watch" : "val-flat"}`}>{stats.diffs}</div>
          <div className="s">{stats.short} short · {stats.over} over</div>
        </div>
        <div>
          <div className="l">Value effect</div>
          <div className={`v dk-n ${stats.value < 0 ? "val-loss" : stats.value > 0 ? "val-good" : "val-flat"}`}>
            {stats.value === 0 ? "—" : `${stats.value < 0 ? "− " : "+ "}${money(Math.abs(stats.value))}`}
          </div>
          <div className="s">if you post this count</div>
        </div>
      </div>

      <div className="dk-st">
        <div className="dk-card dk-tablecard">
          <div className="dk-tablehead">
            <h3>Count sheet</h3>
            <div className="spacer" />
            <input ref={scanRef} className="dk-input search" placeholder="Scan a barcode to jump to its line…"
                   value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={jump} />
            <button className={`dk-daterange ${diffOnly ? "on" : ""}`} onClick={() => setDiffOnly((v) => !v)}>
              Differences only
            </button>
          </div>

          <div className="dk-tablewrap dk-s">
            <table className="dk-table">
              <thead>
                <tr>
                  <th>Item</th><th className="r">System</th><th className="r">Counted</th>
                  <th className="r">Difference</th><th className="r">Value</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={6}><div className="dk-empty">
                    {diffOnly ? "Nothing counted differs from the books yet." : "This count has no lines."}
                  </div></td></tr>
                ) : shown.map((l) => {
                  const blank = l.counted_qty === null || l.counted_qty === "" || l.counted_qty === undefined;
                  const d = blank ? 0 : Number(l.counted_qty) - Number(l.system_qty);
                  const state = blank ? "blank" : Math.abs(d) < 0.0001 ? "match" : d < 0 ? "short" : "over";
                  return (
                    <tr key={l.id}>
                      <td className="strong">
                        {l.name}
                        <div className="dim" style={{ fontSize: 11.5, fontWeight: 500 }}>
                          {[l.item_code, l.category_name].filter(Boolean).join(" · ") || l.unit}
                        </div>
                      </td>
                      <td className="r dk-n dim">{q3(l.system_qty)} {l.unit}</td>
                      <td className="r">
                        <input id={`cnt-${l.id}`} className={`dk-countcell dk-n ${state}`} inputMode="decimal"
                               placeholder="—" aria-label={`Counted quantity for ${l.name}`}
                               value={blank ? "" : l.counted_qty}
                               onChange={(e) => setQty(l.id, e.target.value.replace(/[^\d.\-]/g, ""))}
                               onBlur={() => save()} />
                      </td>
                      <td className={`r dk-n dk-diff ${state === "blank" ? "match" : state}`}>
                        {blank ? "—" : Math.abs(d) < 0.0001 ? "0" : `${d > 0 ? "+" : "−"}${q3(Math.abs(d))}`}
                      </td>
                      <td className={`r dk-n ${d < 0 ? "val-loss" : d > 0 ? "val-good" : "val-flat"}`}>
                        {blank || Math.abs(d) < 0.0001 ? "—" : `${d < 0 ? "− " : "+ "}${inr(Math.abs(d * (Number(l.unit_cost) || 0)))}`}
                      </td>
                      <td>
                        <span className={`dk-tpill ${state === "match" ? "good" : state === "short" ? "bad" : state === "over" ? "warn" : ""}`}>
                          {state === "blank" ? "not counted" : state === "match" ? "matches" : state}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="dk-pagefoot">
            <span className="count">
              {stats.counted} of {total} counted{blanks > 0 ? ` · ${blanks} line${blanks === 1 ? "" : "s"} still blank` : " · all done"}
            </span>
            <div className="nav">
              <button className="dk-pgbtn" disabled={saving} onClick={() => save("Draft saved")}>Save draft</button>
              <button className="dk-pgbtn" disabled={saving || blanks === 0} onClick={copySystem}>Copy system to counted</button>
            </div>
          </div>
        </div>

        <div className="dk-side dk-s">
          <div className="dk-card pad">
            <h3 style={{ margin: "0 0 16px", fontSize: 13.5, fontWeight: 650 }}>Post this count</h3>
            <div className="dk-postbox">
              <label className="dk-field">
                <span>Reason for differences</span>
                <select className="dk-input" value={reason} onChange={(e) => setReason(e.target.value)}
                        disabled={!needsReason}>
                  <option value="">{needsReason ? "Choose a reason…" : "No differences to explain"}</option>
                  {opts.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="dk-field">
                <span>Post to account</span>
                <select className="dk-input" value={account} onChange={(e) => setAccount(e.target.value)}
                        disabled={!needsReason}>
                  {opts.accounts.map((a) => <option key={a.code} value={a.code}>{a.name} ({a.code})</option>)}
                </select>
              </label>

              <div className={`dk-writeoff ${stats.value < 0 ? "loss" : stats.value > 0 ? "gain" : ""}`}>
                <span>{stats.value < 0 ? "Writes off" : stats.value > 0 ? "Writes back" : "No value change"}</span>
                <b className="dk-n">{stats.value === 0 ? "—" : money(Math.abs(stats.value))}</b>
              </div>

              <button className="dk-postbtn" disabled={saving || stats.counted === 0 || (needsReason && !reason)}
                      onClick={post}>
                {saving ? "Posting…" : "Post count & adjust stock"}
              </button>
              {needsReason && !reason && (
                <div style={{ fontSize: 12.5, color: "var(--faint)", textAlign: "center" }}>
                  Choose a reason first — the books need to know what kind of loss this was.
                </div>
              )}
              <button className="dk-postbtn ghost" disabled={saving} onClick={abandon}>Abandon count</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Past counts ──────────────────────────────────────────────────────── */
function PastCounts({ list, onOpen, failed, onRetry }) {
  return (
    <div className="dk-card dk-tablecard">
      <div className="dk-tablehead"><h3>Past counts</h3></div>
      <div className="dk-tablewrap dk-s">
        <table className="dk-table">
          <thead>
            <tr>
              <th>Reference</th><th>Started</th><th>By</th><th>Scope</th><th>Reason</th>
              <th className="r">Lines</th><th className="r">Value effect</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {failed ? <FailedRows cols={8} what="your past counts" onRetry={onRetry} />
              : list === null ? <LoadingRows cols={8} />
              : list.length === 0 ? (
                <tr><td colSpan={8}><div className="dk-empty">No counts yet.</div></td></tr>
              ) : list.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => onOpen(t.id)}>
                  <td className="dk-n strong">{t.reference}</td>
                  <td className="tight dk-n dim">{String(t.created_at || "").slice(0, 16).replace("T", " ")}</td>
                  <td className="tight">{t.created_by_name || "—"}</td>
                  <td className="tight dim">{t.scope || "all items"}</td>
                  <td className="tight dim">{t.reason || "—"}</td>
                  <td className="r dk-n">{t.counted_lines}/{t.total_lines}</td>
                  <td className={`r dk-n strong ${
                    t.variance_value < 0 ? "val-loss" : t.variance_value > 0 ? "val-good" : "val-flat"
                  }`}>
                    {!t.variance_value ? "—" : `${t.variance_value < 0 ? "− " : "+ "}${inr(Math.abs(t.variance_value))}`}
                  </td>
                  <td><span className={`dk-tpill ${t.status === "posted" ? "good" : "warn"}`}>{t.status}</span></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Variance report ──────────────────────────────────────────────────────
   What the counting has been telling you across every posted count. An item
   that is short every single time is a different problem from one that was
   short once, and only this view can tell them apart. */
function VarianceReport() {
  const [d, setD] = useState(null);
  const [range, setRange] = useState({ from: "", to: "" });

  const [failed, read] = useRead();
  const load = () => {
    const p = new URLSearchParams();
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    setD(null);
    read(api.get(`/stock-takes/variance?${p}`), setD, null);
  };
  useEffect(load, [range]);

  return (
    <>
      <div className="dk-strip">
        <div>
          <div className="l">Lost to shrinkage</div>
          {/* Shrinkage reads as a fact about the shop. A read that never
              arrived must not print one. */}
          <div className="big dk-n val-loss">{figure(failed, d ? money(d.totals.lost) : "—")}</div>
          <div className="s">{failed ? "the counts did not load"
            : d ? `across ${d.totals.items} item${d.totals.items === 1 ? "" : "s"} that came up short or over` : "\u00a0"}</div>
        </div>
        <div>
          <div className="l">Found</div>
          <div className="v dk-n val-good">{figure(failed, d ? money(d.totals.gained) : "—")}</div>
          <div className="s">{failed ? "the counts did not load" : "counted more than the books said"}</div>
        </div>
        <div>
          <div className="l">Net</div>
          <div className={`v dk-n ${d && d.totals.net < 0 ? "val-loss" : "val-good"}`}>
            {figure(failed, d ? money(d.totals.net) : "—")}
          </div>
          <div className="s">{failed ? "the counts did not load" : "across every posted count"}</div>
        </div>
      </div>

      <div className="dk-st">
        <div className="dk-card dk-tablecard">
          <div className="dk-tablehead">
            <h3>Where stock goes missing</h3>
            <div className="spacer" />
            <label className="dk-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <span style={{ letterSpacing: 0, textTransform: "none", fontSize: 12.5, fontWeight: 500 }}>From</span>
              <input type="date" className="dk-input" style={{ width: 155, height: 38 }}
                     value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </label>
            <label className="dk-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <span style={{ letterSpacing: 0, textTransform: "none", fontSize: 12.5, fontWeight: 500 }}>To</span>
              <input type="date" className="dk-input" style={{ width: 155, height: 38 }}
                     value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </label>
          </div>
          <div className="dk-tablewrap dk-s">
            <table className="dk-table">
              <thead>
                <tr>
                  <th>Item</th><th className="r">Counted</th><th className="r">Times off</th>
                  <th className="r">Net quantity</th><th className="r">Net value</th>
                </tr>
              </thead>
              <tbody>
                {failed ? <FailedRows cols={5} what="the counts" onRetry={load} />
                  : d === null ? <LoadingRows cols={5} />
                  : d.rows.length === 0 ? (
                    <tr><td colSpan={5}><div className="dk-empty">
                      No posted count has found a difference yet.
                    </div></td></tr>
                  ) : d.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="strong">{r.name}</td>
                      <td className="r dk-n dim">{r.counts}×</td>
                      <td className="r dk-n">
                        <span className={`dk-tpill ${r.off_count === r.counts ? "bad" : "warn"}`}>
                          {r.off_count} of {r.counts}
                        </span>
                      </td>
                      <td className={`r dk-n ${r.net_qty < 0 ? "val-loss" : "val-good"}`}>
                        {r.net_qty > 0 ? "+" : ""}{r.net_qty} {r.unit}
                      </td>
                      <td className={`r dk-n strong ${r.net_value < 0 ? "val-loss" : "val-good"}`}>
                        {r.net_value < 0 ? "− " : "+ "}{inr(Math.abs(r.net_value))}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="dk-side dk-s">
          <div className="dk-card flush">
            <div className="dk-card-head"><h3>By reason given</h3></div>
            {failed ? <LoadFailed what="the reasons given" onRetry={load} compact />
              : d && d.byReason.length > 0 ? d.byReason.map((r, i) => (
              <div className="dk-pastrow" key={i} style={{ cursor: "default" }}>
                <div className="who">
                  <div>{r.reason}</div>
                  <div>{r.counts} count{r.counts === 1 ? "" : "s"}</div>
                </div>
                <b className={`dk-n ${r.value < 0 ? "val-loss" : "val-good"}`}>
                  {r.value < 0 ? "− " : "+ "}{inr(Math.abs(r.value))}
                </b>
              </div>
            )) : (
              <div className="dk-empty">
                {d === null ? "Loading…" : "No posted counts to group yet."}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Start a count ────────────────────────────────────────────────────── */
function StartCount({ cats, onClose, onStart }) {
  const [cat, setCat] = useState("");
  return (
    <Modal title="Start a stock count" onClose={onClose}>
      <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5, lineHeight: 1.55 }}>
        The count takes a snapshot of what the books currently say. Selling carries on while you count —
        anything sold after the snapshot will look like a difference, so count a category at a time if the shop is busy.
      </p>
      <label className="dk-field" style={{ marginBottom: 18 }}>
        <span>What to count</span>
        <select className="dk-input" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">Everything on the shelf</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name} only</option>)}
        </select>
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="dk-sbtn" onClick={onClose}>Cancel</button>
        <button className="dk-sbtn primary" onClick={() => onStart(cat || null)}>Start counting</button>
      </div>
    </Modal>
  );
}
