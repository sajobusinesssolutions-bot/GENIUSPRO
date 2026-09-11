import React, { useEffect, useMemo, useRef, useState } from "react";
import { offerVoucherPrint } from "../lib/printprompt.jsx";
import api, { can } from "../lib/api.js";
import { useAttempt } from "../lib/attempt.jsx";
import { inr, cur, fmtDate } from "../lib/tax.js";
import { Modal, Field, SkeletonRows, Empty, toast , RowMenu , SubmitButton , Pager, StatusChip, DateRangePicker, confirmDialog} from "../lib/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { printReportNode } from "../lib/print.js";
/* The full-screen expense editor lives with Purchases, which owns expenses;
   this screen records them too and must not have a second, thinner form. */
import { ExpenseForm } from "./Purchases.jsx";
import { LoadingRows, useRead, LoadFailed, FailedRows, figure } from "../lib/deckui.jsx";
import { DocShell, DocSection, DocTop, DocParty, DocFields } from "../lib/docshell.jsx";
import { AccountEditor } from "./Accounting.jsx";
import { AccountSelect, defaultAccount, lastAccount, rememberAccount } from "../lib/moneyaccounts.jsx";

/* ── Money, built to the design deck ───────────────────────────────────────
   Where the shop's cash actually is, and what is about to move.

   The deck names six tabs. Four of them describe money the shop is holding —
   everything, the drawer, the bank, mobile money — and those are all the same
   question asked of a different account, so they are driven by whichever
   accounts the shop has actually set up rather than being hard-coded. A shop
   that opens an MTN MoMo account gets a tab for it; one with no bank account
   never sees an empty bank panel.

   The deck's other two tabs, cheques and loans, would each need a register
   this app does not have yet. They are not faked here.  */

const money = (v) => `${cur()} ${inr(v)}`;
const CASH_CODE = "1001";

/* Ugandan notes, largest first — the order a drawer is actually counted in. */
const DENOMS = [50000, 20000, 10000, 5000, 2000, 1000, 500];

/* What each kind of movement is, in a word, coloured by which way it went. */
function movementLabel(m) {
  const src = String(m.source_module || "").replace(/_/g, " ");
  if (+m.cash_in > 0) return { text: src || "receipt", tone: "good" };
  return { text: src || "payment", tone: "warn" };
}

export default function Money() {
  const [tab, setTab] = useState("all");
  const [ov, setOv] = useState(null);
  /* One date range for the whole screen. Every tab under it was fixed to
     today — the tiles, the drawer, the ledgers — so "what did we take last
     week" had no answer anywhere on the money screens. Balances are still as
     they stand now, because an account holds what it holds; it is what MOVED
     that has a period. */
  const [range, setRange] = useState({ from: "", to: "" });

  const [ovFailed, readOv] = useRead();
  const loadOv = () => {
    const sp = new URLSearchParams();
    if (range.from) sp.set("from", range.from);
    if (range.to) sp.set("to", range.to);
    const qs = sp.toString();
    return readOv(api.get(`/money/overview${qs ? `?${qs}` : ""}`), setOv, null);
  };
  useEffect(() => { loadOv(); }, [range.from, range.to]);

  const [payOpen, setPayOpen] = useState(false);
  const [expOpen, setExpOpen] = useState(false);
  const [incOpen, setIncOpen] = useState(false);
  const [expCats, setExpCats] = useState([]);
  useEffect(() => { api.get("/expenses/categories").then(setExpCats).catch(() => setExpCats([])); }, []);
  /* Which ledger sub-tab is showing, held here because the page-level "Record
     payment" button stands down only on the one sub-tab that has its own. */
  const [ledgerSub, setLedgerSub] = useState("payments");

  /* Which account's statement is open, if any. Drilling into an account from
     a tile used to mean one page tab per account, which is fine for a shop
     with a bank account and unreadable for one with six mobile-money floats —
     the tab row grew until "Payments & expenses" fell off the end of a 1366px
     screen. The tiles are the index now, and the statement opens inside the
     Cash & bank tab with a way back. */
  const [statement, setStatement] = useState(null);
  const tabs = [
    { id: "all", label: "All money" },
    { id: "cashbank", label: "Accounts" },
    { id: "cash", label: "Cash drawer" },
    { id: "ledger", label: "Payments & expenses" },
  ];
  const openStatement = (code) => { setStatement(code); setTab("cashbank"); };

  return (
    <div className="dk-page">
      <div className="dk-tabs">
        <div className="grp">
          {tabs.map((t) => (
            <button key={t.id} className={`dk-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <DateRangePicker from={range.from} to={range.to} align="right" allLabel="All time"
                         onChange={(r) => setRange({ from: r.from, to: r.to })} />
        {/* The three things somebody comes to this screen to record, in one
            menu. They used to be one button here and two more on sub-tabs two
            clicks away, so "put in an expense" meant finding the screen that
            happened to own the button. */}
        {can("payments", "create") && (
          <MoneyActions onPayment={() => setPayOpen(true)}
                        onExpense={() => setExpOpen(true)}
                        onIncome={() => setIncOpen(true)} />
        )}
      </div>

      {tab === "all" && <AllMoney ov={ov} ovFailed={ovFailed} onRetryOv={loadOv} />}
      {tab === "cashbank" && (statement
        ? <AccountView code={statement} ov={ov} ovFailed={ovFailed} onRetryOv={loadOv}
                       onBack={() => setStatement(null)} />
        : <CashBank ov={ov} ovFailed={ovFailed} onRetryOv={loadOv}
                    onOpenAccount={openStatement} onChanged={loadOv} />)}
      {tab === "cash" && <CashDrawer ov={ov} ovFailed={ovFailed} onRetryOv={loadOv} range={range} />}
      {tab === "ledger" && <LedgerTabs sub={ledgerSub} setSub={setLedgerSub} onChanged={loadOv} />}

      {payOpen && <PaymentModal onClose={() => setPayOpen(false)}
        onSaved={() => { setPayOpen(false); loadOv(); toast("Payment recorded"); }} />}
      {expOpen && <ExpenseForm cats={expCats} onClose={() => setExpOpen(false)}
        onSaved={() => { setExpOpen(false); loadOv(); toast("Expense recorded"); }} />}
      {incOpen && <IncomeModal onClose={() => setIncOpen(false)}
        onSaved={() => { setIncOpen(false); loadOv(); toast("Income recorded"); }} />}
    </div>
  );
}

/* The three things people come to this screen to record.
 *
 * One menu rather than a button here and two more on sub-tabs two clicks
 * away — "put in an expense" should not mean finding the screen that happens
 * to own the button for it. */
function MoneyActions({ onPayment, onExpense, onIncome }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const shut = () => setOpen(false);
    window.addEventListener("mousedown", shut);
    return () => window.removeEventListener("mousedown", shut);
  }, [open]);

  return (
    <div style={{ position: "relative" }} onMouseDown={(e) => e.stopPropagation()}>
      <button className={`dk-tool ${open ? "on" : ""}`} aria-label="Record something"
              aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="dk-menu">
          <div className="cap">Record</div>
          <button onClick={() => { setOpen(false); onPayment(); }}>Payment in or out</button>
          <button onClick={() => { setOpen(false); onExpense(); }}>Expense</button>
          <button onClick={() => { setOpen(false); onIncome(); }}>Other income</button>
        </div>
      )}
    </div>
  );
}

/* ── All money ────────────────────────────────────────────────────────── */
function AllMoney({ ov, ovFailed, onRetryOv }) {
  const [moves, setMoves] = useState(null);
  const [movesFailed, readMoves] = useRead();
  const loadMoves = () => readMoves(api.get("/money/movements?limit=14"), (d) => setMoves(d ? d.rows : null), null);
  useEffect(() => { loadMoves(); }, []);

  return (
    <>
      {ovFailed ? <div className="dk-card"><LoadFailed what="your account balances" onRetry={onRetryOv} compact /></div> : (
      <div className="dk-strip accounts">
        <div>
          <div className="l">Money on hand</div>
          <div className="big dk-n">{ov ? money(ov.onHand) : "—"}</div>
          <div className="s">
            {ov ? `across ${ov.accounts.length} account${ov.accounts.length === 1 ? "" : "s"} · as of ${fmtDate(new Date())}` : "\u00a0"}
          </div>
        </div>
        {(ov ? ov.accounts : []).map((a) => (
          <div key={a.code}>
            <div className="l">{a.name}</div>
            <div className={`v dk-n ${a.balance < 0 ? "amt-negative" : Math.abs(a.balance) < 0.005 ? "amt-zero" : "amt-neutral"}`}>{money(a.balance)}</div>
            <div className="s dk-n">account {a.code}</div>
          </div>
        ))}
      </div>
      )}

      <div className="dk-money-grid">
        <div className="dk-card flush">
          <div className="dk-card-head">
            <h3>Recent money movement</h3>
            <span className="n">{movesFailed ? "not loaded" : `last ${moves ? moves.length : 0}`}</span>
          </div>
          <div className="dk-tablewrap dk-s">
            <MovementTable rows={moves} showAccount failed={movesFailed} onRetry={loadMoves} what="recent movement" />
          </div>
        </div>

        <div className="dk-side dk-s">
          <div className="dk-card pad">
            <h3 style={{ margin: "0 0 16px", fontSize: 13.5, fontWeight: 650 }}>In and out this month</h3>
            {ovFailed ? <LoadFailed what="this month's flow" onRetry={onRetryOv} compact /> : <FlowBars month={ov ? ov.month : null} />}
          </div>

          <div className="dk-card pad">
            <h3 style={{ margin: "0 0 16px", fontSize: 13.5, fontWeight: 650 }}>Due this week</h3>
            {ovFailed ? <LoadFailed what="what falls due" onRetry={onRetryOv} compact /> : (
            <div className="dk-due">
              {/* Nothing here has been collected or paid yet — it is all due,
                  not late — so both sides are amber. Green would say the money
                  is already in, which is the mistake this pass exists to undo.
                  Direction is carried by the label, not by the colour. */}
              <div className="dk-duerow">
                <span className="dot seg-owed" />
                <span className="t">
                  Coming in
                  <small>{ov ? `${ov.dueThisWeek.incoming.count} invoice${ov.dueThisWeek.incoming.count === 1 ? "" : "s"} from customers` : "…"}</small>
                </span>
                <b className={`dk-n ${ov && ov.dueThisWeek.incoming.amount > 0 ? "amt-owed" : "amt-zero"}`}>{ov ? money(ov.dueThisWeek.incoming.amount) : "—"}</b>
              </div>
              <div className="dk-duerow">
                <span className="dot seg-owed" />
                <span className="t">
                  Going out
                  <small>{ov ? `${ov.dueThisWeek.outgoing.count} bill${ov.dueThisWeek.outgoing.count === 1 ? "" : "s"} to suppliers` : "…"}</small>
                </span>
                <b className={`dk-n ${ov && ov.dueThisWeek.outgoing.amount > 0 ? "amt-owed" : "amt-zero"}`}>{ov ? money(ov.dueThisWeek.outgoing.amount) : "—"}</b>
              </div>
              {ov && (
                <div className="dk-duerow" style={{ background: "transparent", paddingTop: 4 }}>
                  <span className="t" style={{ fontWeight: 650 }}>Net this week</span>
                  <b className="dk-n amt-neutral">
                    {money(ov.dueThisWeek.incoming.amount - ov.dueThisWeek.outgoing.amount)}
                  </b>
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* Two bars scaled against the larger of the pair, so a month where far more
   went out than came in looks like it rather than reading as two equal bars. */
function FlowBars({ month }) {
  if (!month) return <div className="dk-empty" style={{ padding: "20px 0" }}>Reading the books…</div>;
  const peak = Math.max(month.in, month.out, 1);
  return (
    <div className="dk-flow">
      <div className="row">
        <div className="top"><span>Came in</span><b className={`dk-n ${month.in > 0 ? "amt-received" : "amt-zero"}`}>{money(month.in)}</b></div>
        <div className="bar"><i className="seg-received" style={{ width: `${(month.in / peak) * 100}%` }} /></div>
      </div>
      <div className="row">
        <div className="top"><span>Went out</span><b className={`dk-n ${month.out > 0 ? "amt-paid" : "amt-zero"}`}>{money(month.out)}</b></div>
        <div className="bar"><i className="seg-paid" style={{ width: `${(month.out / peak) * 100}%` }} /></div>
      </div>
      <div className="net">
        <span>Net</span>
        <b className={`dk-n ${month.net > 0 ? "amt-received" : month.net < 0 ? "amt-negative" : "amt-zero"}`}>{money(month.net)}</b>
      </div>
    </div>
  );
}

/* ── Cash & bank ───────────────────────────────────────────────────────────
   Every place the shop keeps money, one tile each, cash and bank alike.

   This was a strip of figures and a table, which answered "how much in total"
   well and "is the MoMo float running dry" not at all — you had to read a row
   at a time and hold the numbers in your head. A tile per account puts the
   balance where the eye lands and the day's movement directly under it.

   Three figures per tile, and all three come from the same request:
   the balance the books hold for the account, where it opened today, and
   where it stands now. Nothing here is invented in the browser — see
   backend/modules/money/money.routes.js, which derives the opening by
   unwinding today's journal lines rather than the other way round, so the
   large figure is always the one the rest of the app agrees with.

   Grouping is cosmetic and the backend admits it is a guess (there is no
   cash-vs-bank column in the schema). The figures are not a guess. */

/* Drawn here rather than added to lib/icons.jsx, which this pass does not
   own. Same 24×24 stroke geometry as every other icon in the app. */
/* The two glyphs now come from the shared set (lib/icons.jsx) rather than
   being drawn here, so the account tiles cannot drift from the stroke weight
   the rest of the app uses. `.cb-ic svg` sizes them, so no size is passed. */
function AcctIcon({ kind }) {
  return <Icon n={kind === "cash" ? "wallet" : kind === "mobile" ? "mobile" : "bank"} size={17} />;
}

function CashBank({ ov, ovFailed, onRetryOv, onOpenAccount, onChanged }) {
  /* `null` while the new-account dialog is closed; an object opens it. Held
     here rather than per-tile so two tiles cannot both open one. */
  const [editor, setEditor] = useState(null);
  const [payFor, setPayFor] = useState(null);

  if (ovFailed) return <div className="dk-card"><LoadFailed what="your cash and bank accounts" onRetry={onRetryOv} /></div>;

  const accounts = ov ? ov.accounts : null;
  /* Three groups, not two. Mobile money used to be filed under "Bank & mobile
     money" because the schema could not tell them apart; it can now, and a
     shop reconciling an MTN float against a statement should not have to pick
     it out of a list of bank accounts. Existing accounts are untouched — the
     server only groups an account here when somebody has said so in the
     account editor, so nothing moves on upgrade. */
  const sections = [
    { kind: "cash", title: "Cash accounts", create: "New cash account",
      empty: "No cash account yet — the drawer lives here." },
    { kind: "mobile", title: "Mobile money", create: "New mobile money account",
      empty: "No mobile-money account yet. Add one for each MTN or Airtel line and every deposit can name which float it landed in.",
      /* Hidden until a shop has one, so a shop that takes no MoMo is not shown
         an empty panel it will never fill. The create button lives on the
         section header, so an empty section still has to be reachable —
         it is, from the account editor on Accounting. */
      hideWhenEmpty: true },
    { kind: "bank", title: "Bank accounts", create: "New bank account",
      empty: "No bank account yet. Add one and every deposit can name where it landed." },
  ];

  return (
    <>
      {sections.map((s) => {
        const list = accounts ? accounts.filter((a) => a.kind === s.kind) : null;
        if (s.hideWhenEmpty && list !== null && list.length === 0) return null;
        const total = list ? list.reduce((a, x) => a + x.balance, 0) : 0;
        return (
          <section className="cb-section" key={s.kind}>
            <div className="cb-head">
              <h3>{s.title}</h3>
              <span className="cb-chip dk-n">
                {list === null ? "counting…"
                  : `${list.length} account${list.length === 1 ? "" : "s"} · ${money(total)}`}
              </span>
              <div className="spacer" />
              {can("accounting", "create") && (
                <button className="dk-create" onClick={() => setEditor({ kind: s.kind })}>
                  <Icon n="plus" size={15} />
                  {s.create}
                </button>
              )}
            </div>

            {list === null ? (
              <div className="cb-grid">{[0, 1, 2].map((i) => <div key={i} className="cb-tile is-loading" aria-hidden="true" />)}</div>
            ) : list.length === 0 ? (
              <div className="dk-card pad"><div className="dk-empty">{s.empty}</div></div>
            ) : (
              <div className="cb-grid">
                {list.map((a) => (
                  <AccountTile key={a.code} a={a}
                               onOpen={() => onOpenAccount(a.code)}
                               onPay={() => setPayFor(a.code)} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {editor && (
        /* The one thing a shop gets wrong here is creating the account and
           forgetting the "this is a cash / bank account" tick, then wondering
           why it never appears. Opened from this screen it is ticked already. */
        <AccountEditor editor={{ mode: "new", cashBank: true, title: editor.kind === "cash" ? "New cash account" : "New bank account" }}
                       onClose={() => setEditor(null)}
                       onSaved={() => { setEditor(null); onChanged(); }} />
      )}
      {payFor && <PaymentModal preset={{ deposit_code: payFor }}
                               onClose={() => setPayFor(null)}
                               onSaved={() => { setPayFor(null); onChanged(); }} />}
    </>
  );
}

function AccountTile({ a, onOpen, onPay }) {
  const net = +(a.inToday - a.outToday).toFixed(2);
  const up = net > 0.005, down = net < -0.005;
  return (
    <article className="cb-tile">
      <div className="cb-tile-h">
        <span className={`cb-ic ${a.kind}`}><AcctIcon kind={a.kind} /></span>
        <div className="cb-who">
          <div className="cb-name" title={a.name}>{a.name}</div>
          <div className="cb-code dk-n">account {a.code}</div>
        </div>
        <RowMenu label={`Actions for ${a.name}`} actions={[
          { icon: <Icon n="eye" />, label: "View statement", onClick: onOpen },
          ...(can("payments", "create")
            ? [{ icon: <Icon n="plus" />, label: "Record payment here", onClick: onPay }] : []),
        ]} />
      </div>

      <div className="cb-figure">
        <div className={`cb-big dk-n ${a.balance < 0 ? "amt-negative" : Math.abs(a.balance) < 0.005 ? "amt-zero" : "amt-neutral"}`}>
          {a.balance < 0 ? `−${money(Math.abs(a.balance))}` : money(a.balance)}
        </div>
        <div className="cb-cap">Current balance{a.balance < 0 ? " · overdrawn" : ""}</div>
      </div>

      {/* Two rows, and the second one is the point: a balance on its own does
          not say whether the account is filling or emptying. The tint follows
          the app's rule — green is money in, red is money out — and the words
          "in"/"out"/"no movement" say the same thing again, so the tile still
          reads with the colour removed (WCAG 1.4.1). */}
      <div className="cb-stats">
        <div className="cb-stat">
          <span className="g" aria-hidden="true">•</span>
          <span className="l">Opened today at</span>
          <b className="v dk-n">{money(a.openingToday)}</b>
        </div>
        <div className={`cb-stat ${up ? "up" : down ? "down" : "flat"}`}>
          <span className="g" aria-hidden="true">{up ? "▲" : down ? "▼" : "–"}</span>
          <span className="l">
            Today’s close
            <small className={up ? "amt-received" : down ? "amt-paid" : ""}>
              {up ? `${money(net)} in today` : down ? `${money(-net)} out today` : "no movement today"}
            </small>
          </span>
          <b className="v dk-n">{money(a.closeToday)}</b>
        </div>
      </div>

      <button className="cb-act" onClick={onOpen}>View statement</button>
    </article>
  );
}

/* ── Cash drawer ──────────────────────────────────────────────────────────
   The day's cash book beside a counter. The count is worked out here and not
   saved — closing a shift is the till's job, and two places that both close
   the drawer is one place too many. */
function CashDrawer({ ov, ovFailed, onRetryOv, range }) {
  const today = new Date().toISOString().slice(0, 10);
  /* Which day's drawer. It was pinned to today with no way to say otherwise,
     so "what went through the drawer on Saturday" — the question a shopkeeper
     asks on Monday morning — had no answer. The page's range picks the day
     when one has been set; otherwise it is today, which is the usual case. */
  const [day, setDay] = useState(() => (range && range.to) || today);
  useEffect(() => { if (range && range.to) setDay(range.to); }, [range && range.to]);
  const [d, setD] = useState(null);
  const [counts, setCounts] = useState({});
  const [coins, setCoins] = useState("");
  const [failed, read] = useRead();

  /* The cash book was falling back to `{ rows: [], totals: {} }`, which drew
     "No cash has moved today" and a zero take on a day the request simply
     never arrived. */
  const load = () => read(api.get(`/money/movements?code=${CASH_CODE}&date=${day}&limit=200`), setD, null);
  useEffect(() => { load(); }, [day]);

  const counted = useMemo(
    () => DENOMS.reduce((a, n) => a + n * (Number(counts[n]) || 0), 0) + (Number(coins) || 0),
    [counts, coins]);

  const book = ov && !ovFailed ? (ov.accounts.find((a) => a.is_cash) || {}).balance || 0 : null;
  /* No book figure, no variance — "short by" against a balance that never
     loaded would be a made-up accusation. */
  const diff = book == null ? null : counted - book;

  return (
    <>
      <div className="dk-strip">
        <div>
          <div className="l">In the drawer, per the books</div>
          <div className="big dk-n">{book == null ? "—" : money(book)}</div>
          <div className="s">{ovFailed ? "balance did not load" : "every cash movement posted so far"}</div>
        </div>
        <div>
          <div className="l">Taken {day === today ? "today" : "that day"}</div>
          <div className={`v dk-n ${d && +d.totals.in > 0 ? "amt-received" : "amt-zero"}`}>{d ? money(d.totals.in) : "—"}</div>
          <div className="s">{failed ? "the cash book did not load" : d ? `${d.rows.filter((r) => +r.cash_in > 0).length} receipts` : "\u00a0"}</div>
        </div>
        <div>
          <div className="l">Paid out {day === today ? "today" : "that day"}</div>
          <div className={`v dk-n ${d && +d.totals.out > 0 ? "amt-paid" : "amt-zero"}`}>{d ? money(d.totals.out) : "—"}</div>
          <div className="s">{failed ? "the cash book did not load" : d ? `${d.rows.filter((r) => +r.cash_out > 0).length} payments` : "\u00a0"}</div>
        </div>
      </div>

      <div className="dk-money-grid wide">
        <div className="dk-card flush">
          <div className="dk-card-head">
            <h3>Cash book</h3>
            {/* The day being counted, changeable here. A drawer is counted for
                one day, so this is a date and not a range. */}
            <input type="date" className="dk-input" style={{ width: 158, height: 32, marginLeft: 10 }}
                   value={day} max={today} onChange={(e) => setDay(e.target.value || today)}
                   aria-label="Which day's cash book" />
            <div className="spacer" style={{ flex: 1 }} />
            <span className="n dk-n">{failed ? "not loaded" : d ? `net ${money(d.totals.net)}` : ""}</span>
          </div>
          <div className="dk-tablewrap dk-s">
            <MovementTable rows={d ? d.rows : null} failed={failed} onRetry={load} what="the cash book"
                           emptyText={day === today ? "No cash has moved today." : "No cash moved that day."} />
          </div>
        </div>

        <div className="dk-side dk-s">
          <div className="dk-card pad">
            <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>Count the drawer</h3>
            <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>
              A quick check against the books. Closing the shift for real happens at the till, where the count is recorded.
            </p>
            <div className="dk-count">
              {DENOMS.map((n) => (
                <div className="dk-countrow" key={n}>
                  <span className="dk-n">{n.toLocaleString()}</span>
                  <input className="dk-n" inputMode="numeric" value={counts[n] ?? ""} placeholder="0"
                         onChange={(e) => setCounts({ ...counts, [n]: e.target.value.replace(/[^\d]/g, "") })} />
                  <b className="dk-n">{inr(n * (Number(counts[n]) || 0))}</b>
                </div>
              ))}
              <div className="dk-countrow">
                <span>coins</span>
                <input className="dk-n" inputMode="decimal" value={coins} placeholder="0"
                       onChange={(e) => setCoins(e.target.value.replace(/[^\d.]/g, ""))} />
                <b className="dk-n">{inr(Number(coins) || 0)}</b>
              </div>
              <div className="dk-counttotal">
                <span>Counted</span>
                <b className="dk-n">{money(counted)}</b>
              </div>
              {diff != null && counted > 0 && (
                <div className={`dk-variance ${Math.abs(diff) < 0.005 ? "exact" : diff < 0 ? "short" : "over"}`}>
                  <span className="l">
                    {Math.abs(diff) < 0.005 ? "Matches the books" : diff < 0 ? "Short by" : "Over by"}
                  </span>
                  <b className="dk-n">{Math.abs(diff) < 0.005 ? "—" : money(Math.abs(diff))}</b>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── One account ──────────────────────────────────────────────────────────
   Bank, mobile money, or whatever else the shop keeps money in. Same shape
   for all of them, because the question is the same. */
function AccountView({ code, ov, ovFailed, onRetryOv, onBack }) {
  const [d, setD] = useState(null);
  const [range, setRange] = useState({ from: "", to: "" });
  const [failed, read] = useRead();

  const load = () => {
    const p = new URLSearchParams({ code, limit: "200" });
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    setD(null);
    read(api.get(`/money/movements?${p}`), setD, null);
  };
  useEffect(() => { load(); }, [code, range]);

  const acct = ovFailed ? null : (ov ? ov.accounts : []).find((a) => a.code === code);

  return (
    <>
      {onBack && (
        <div className="cb-back">
          <button className="dk-sbtn" onClick={onBack}>← All cash &amp; bank accounts</button>
        </div>
      )}
      <div className="dk-strip">
        <div>
          <div className="l">{acct ? acct.name : "Account"}</div>
          <div className={`big dk-n ${acct && acct.balance < 0 ? "amt-negative" : ""}`}>
            {acct ? money(acct.balance) : "—"}
          </div>
          <div className="s">{ovFailed ? `balance did not load · account ${code}` : `balance per the books · account ${code}`}</div>
        </div>
        <div>
          <div className="l">In</div>
          <div className={`v dk-n ${d && +d.totals.in > 0 ? "amt-received" : "amt-zero"}`}>{d ? money(d.totals.in) : "—"}</div>
          <div className="s">{range.from || range.to ? "over the chosen dates" : "last 200 movements"}</div>
        </div>
        <div>
          <div className="l">Out</div>
          <div className={`v dk-n ${d && +d.totals.out > 0 ? "amt-paid" : "amt-zero"}`}>{d ? money(d.totals.out) : "—"}</div>
          <div className="s">{failed ? "statement did not load" : d ? `net ${money(d.totals.net)}` : "\u00a0"}</div>
        </div>
      </div>

      <div className="dk-card dk-tablecard">
        <div className="dk-tablehead">
          <h3>Statement</h3>
          <div className="spacer" />
          {/* Opens unfiltered, as it did — the statement starts on the last 200
              movements and narrows only when a range is picked. */}
          <DateRangePicker from={range.from} to={range.to} allLabel="All dates"
                           onChange={(r) => setRange({ from: r.from, to: r.to })} />
        </div>
        <div className="dk-tablewrap dk-s">
          <MovementTable rows={d ? d.rows : null} failed={failed} onRetry={load} what="this statement"
                         emptyText="Nothing has moved on this account." />
        </div>
        <div className="dk-pagefoot">
          <span className="count">{failed ? "Not loaded" : d ? `${d.rows.length} movement${d.rows.length === 1 ? "" : "s"}` : "Loading…"}</span>
        </div>
      </div>
    </>
  );
}

/* Shared movement table — the deck's Type / Detail / Account / In / Out. */
function MovementTable({ rows, showAccount, emptyText, failed, onRetry, what }) {
  return (
    <table className="dk-table">
      <thead>
        <tr>
          <th>Type</th><th>Detail</th>
          {showAccount && <th>Account</th>}
          <th className="r">In</th><th className="r">Out</th>
        </tr>
      </thead>
      <tbody>
        {failed ? <FailedRows cols={showAccount ? 5 : 4} what={what || "these movements"} onRetry={onRetry} /> :
          rows === null ? <LoadingRows cols={showAccount ? 5 : 4} /> :
          rows.length === 0 ? (
            <tr><td colSpan={showAccount ? 5 : 4}><div className="dk-empty">{emptyText || "No money has moved yet."}</div></td></tr>
          ) : rows.map((m, i) => {
            const lbl = movementLabel(m);
            return (
              <tr key={i}>
                <td><span className={`dk-tpill ${lbl.tone}`}>{lbl.text}</span></td>
                <td className="tight">
                  {m.description || "—"}
                  {m.reference && <span className="dim dk-n"> · {m.reference}</span>}
                  <div className="dim dk-n" style={{ fontSize: 11.5, fontWeight: 500 }}>{String(m.d).slice(0, 10)}</div>
                </td>
                {showAccount && <td className="tight dim">{m.account_name}</td>}
                <td className={`r dk-n strong ${+m.cash_in > 0 ? "amt-received" : "amt-zero"}`}>
                  {+m.cash_in > 0 ? inr(m.cash_in) : "—"}
                </td>
                <td className={`r dk-n strong ${+m.cash_out > 0 ? "amt-paid" : "amt-zero"}`}>
                  {+m.cash_out > 0 ? inr(m.cash_out) : "—"}
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

/* ── The existing ledgers ─────────────────────────────────────────────────
   Payments, expenses and other income keep their own lists. They are records
   of individual documents rather than a view of an account, so they sit
   behind their own tab instead of being folded into the account views. */
/* Navigation stops at rail + page pill tabs. These three used to be a third
   tab row, which read as a third level of navigation; they are a filter on one
   screen, so they are drawn as one. The state is unchanged — `ledgerSub` still
   drives which list shows and still tells the page-level "Record payment"
   button to stand down on Payments only. */
function LedgerTabs({ sub, setSub, onChanged }) {
  return (
    <>
      <div className="dk-filterbar" style={{ marginBottom: 14 }}>
        <span className="lbl">Showing</span>
        <div className="dk-seg2 lg" role="group" aria-label="Which ledger">
          {[["payments", "Payments"], ["expenses", "Expenses"],
            ["repeating", "Repeating"], ["income", "Other income"]].map(([id, label]) => (
            <button key={id} className={sub === id ? "on" : ""} aria-pressed={sub === id}
                    onClick={() => setSub(id)}>{label}</button>
          ))}
        </div>
      </div>
      {sub === "payments" && <Payments onChanged={onChanged} />}
      {sub === "expenses" && <Expenses onChanged={onChanged} />}
      {sub === "repeating" && <RepeatingExpenses onChanged={onChanged} />}
      {sub === "income" && <OtherIncome onChanged={onChanged} />}
    </>
  );
}

function Payments({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [meta, setMeta] = useState({ total: 0, pages: 1, sums: {} });
  const [failed, read] = useRead();
  const load = () => {
    const sp = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) sp.set("q", q);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    read(api.get(`/payments?${sp}`),
      (d) => { if (d) { setRows(d.rows); setMeta({ total: d.total, pages: d.pages, sums: d.sums || {} }); }
               else { setRows(null); setMeta({ total: 0, pages: 1, sums: {} }); } },
      null);
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [page, limit, q, from, to]);
  useEffect(() => { setPage(1); }, [q, from, to]);
  /* What "Print" puts on paper: this list as its own document, rather than a
     screenshot of the browser showing it. */
  const paper = React.useRef(null);
  const printList = () => printReportNode(paper.current, {
    title: "Payments",
    caption: from || to ? `${from || "start"} to ${to || "today"}` : "All dates",
  });
  return (
    <div className="dk-card flush" ref={paper}>
      <div className="dk-card-head"><h3>Payments</h3>{can("payments", "create") && <button className="dk-create" style={{ height: 38 }} onClick={() => setOpen(true)}>+ Record payment</button>}</div>
      <div className="list-filters">
        <input placeholder="Search payment #, party or reference…" value={q} onChange={(e) => setQ(e.target.value)} />
        <DateRangePicker from={from} to={to} align="left" allLabel="All dates"
                         onChange={(r) => { setFrom(r.from); setTo(r.to); }} />
        {(q || from || to) && <button className="btn btn-ghost" onClick={() => { setQ(""); setFrom(""); setTo(""); }}>Clear</button>}
      </div>
      <div className="dk-scrollx">
      <table className="dk-table">
        <thead><tr><th>#</th><th>Party</th><th>Date</th><th>Direction</th><th>Mode</th><th className="amt">Amount</th><th /></tr></thead>
        <tbody>
          {failed ? <FailedRows cols={7} what="your payments" onRetry={load} /> :
            rows === null ? <SkeletonRows rows={5} cols={6} /> :
            rows.length === 0 ? <tr><td colSpan={7}><Empty icon="⇅" title="No payments yet" /></td></tr> :
            rows.map((p) => {
              const dead = p.status === "voided";
              return (
              <tr key={p.id} className={`hl ${dead ? "void" : ""}`}>
                <td className="strong num">{p.payment_no}</td><td>{p.party_name}</td><td className="num">{p.payment_date}</td>
                <td>
                  <span className={`pill ${p.direction === "in" ? "pill-ok" : "pill-warn"}`}>{p.direction === "in" ? "received" : "paid"}</span>
                  {p.status === "draft" && <span className="pill" style={{ marginLeft: 6 }}>draft</span>}
                  {dead && <span className="pill" style={{ marginLeft: 6 }}>voided</span>}
                  {!dead && Number(p.edit_count) > 0 && <span className="pill" style={{ marginLeft: 6 }}>amended</span>}
                </td>
                <td style={{ textTransform: "uppercase", fontSize: 12.5, fontWeight: 500 }}>{p.mode}</td>
                <td className={`amt ${dead ? "amt-void" : p.direction === "in" ? "amt-received" : "amt-paid"}`} style={{ fontWeight: 650 }}>{p.direction === "in" ? "+" : "−"}{cur()} {inr(p.amount)}</td>
                <td style={{ textAlign: "right" }}>
                  <RowMenu label={`Actions for ${p.payment_no}`} actions={[
                    { icon: <Icon n="eye" />, label: "View", onClick: () => toast(`${p.payment_no} · ${p.party_name} · ${p.mode} · ${cur()} ${inr(p.amount)} (${p.reference || "no ref"})${dead ? " · VOIDED" : ""}`) },
                    ...(p.status === "draft" ? [{ icon: <Icon n="check" />, label: "Confirm draft", onClick: async () => {
                      try { const r = await api.post(`/payments/${p.id}/confirm`, {}); toast(`${r.payment_no} confirmed — ${cur()} ${inr(r.allocated)} allocated`); load(); onChanged?.(); }
                      catch (e) { toast(e.message, "bad"); }
                    } }] : []),
                    ...(can("payments", "edit") ? [{
                      icon: <Icon n="edit" />, label: "Edit", disabled: dead || p.status === "draft",
                      hint: dead ? "voided" : p.status === "draft" ? "confirm it first" : undefined,
                      onClick: () => setEdit(p),
                    }] : []),
                    { icon: <Icon n="print" />, label: "Print this list", onClick: printList },
                    ...(can("payments", "delete") ? [{
                      icon: <Icon n="trash" />, label: "Void", danger: true, disabled: dead,
                      hint: dead ? "already voided" : undefined,
                      onClick: async () => {
                        if (!(await confirmDialog({
                          title: `Void ${p.payment_no}?`,
                          message: `${cur()} ${inr(p.amount)} ${p.direction === "in" ? "from" : "to"} ${p.party_name}. Every bill this settled gets its balance back, the ledger entry is reversed, and ${p.party_name}'s account returns to what it was before the money was taken.`,
                          danger: true, confirmLabel: "Void entry",
                        }))) return;
                        try { const r = await api.delete(`/payments/${p.id}`); toast(r.message || "Voided"); load(); onChanged?.(); }
                        catch (err) { toast(err.message, "bad"); }
                      },
                    }] : []),
                  ]} />
                </td>
              </tr>
              );
            })}
        </tbody>
      </table>
      </div>
      <Pager page={page} pages={meta.pages} total={meta.total} limit={limit} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
      {/* Reload the account balances too, not just this list. A payment moves
          the tile on the Accounts tab, and that tab was reading an overview
          fetched when the page first opened — so recording 150,000 and
          switching tabs showed the balance from before it. */}
      {open && <PaymentModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged?.(); }} />}
      {edit && <PaymentEdit payment={edit} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); load(); onChanged?.(); }} />}
    </div>
  );
}

/* ── Recording a payment ───────────────────────────────────────────────────
   What this form is for is two questions: how much money moved, and which
   invoices it clears. The version this replaces answered the first in a field
   halfway down a stack of eight and never answered the second at all — it
   said, in prose, "money is applied to the oldest open invoices first", and
   then showed nothing. A shopkeeper taking 400,000 off a customer with four
   unpaid bills had to save it and go looking to find out what had happened.
   Worse, the one figure the bottom bar did show — "Settles Sh 0.00 of
   invoices" — is *not* the amount received when tax has been withheld, and
   nothing on the screen explained the difference.

   So the layout is by importance rather than by database column:

     1. the money and the party, together, at the top;
     2. the allocation, live, beside them — every open invoice this payment
        will touch, in the order the server will touch them, with what is left
        over named as an advance;
     3. bank charges, mode, deposit account, reference and notes below, where
        details that do not change what is settled belong.

   The allocation panel reads GET /payments/open, which runs the same query
   the allocator does. It is a preview of a real calculation, not a second
   implementation of it.

   `preset` lets another screen open this already pointed at a party, a
   direction or a deposit account — the Parties statement records a payment
   against the customer you are looking at, rather than making you find them
   again in a dropdown. Kept identical, because Parties.jsx and
   InstalmentsPanel.jsx both rely on it. */
export function PaymentModal({ onClose, onSaved, preset }) {
  /* Held for as long as this payment is unsaved, so a Save pressed twice
     after a dropped line is one payment, not two. */
  const attempt = useAttempt("payment");
  const [parties, setParties] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  /* `target_doc_id` is not a form field — it is "the operator opened this from
     one particular invoice", which switches the allocation to manual and puts
     the money on that invoice alone as soon as the open list arrives. Pulled
     out of the preset so it never gets posted as part of the payment body. */
  const targetDocId = preset && preset.target_doc_id ? Number(preset.target_doc_id) : 0;
  const { target_doc_id: _drop, ...presetFields } = preset || {};
  const [f, setF] = useState({
    direction: "in", party_id: "", amount: "", mode: "cash", reference: "", notes: "",
    bank_charges: "", tax_deducted: "", withheld: "no", deposit_code: "",
    payment_date: today, received_on: "",
    ...presetFields,
  });
  useEffect(() => { api.get("/parties").then(setParties).catch(() => {}); }, []);
  useEffect(() => {
    api.get("/accounting/cash-accounts")
      .then((a) => {
        setAccounts(a);
        /* Default to the account this machine last put money into. A shop that
           banks everything through MoMo should not have to re-pick MoMo on
           every payment, and the alternative default — whichever account sorts
           first by code — is "Cash in Hand" for every shop, which is the one
           that gets silently wrong most often. */
        setF((x) => (x.deposit_code ? x : { ...x, deposit_code: defaultAccount(a, lastAccount()) }));
      })
      .catch(() => {});
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const party = parties.find((p) => p.id === Number(f.party_id));
  const incoming = f.direction === "in";
  const amt = Number(f.amount) || 0;
  const charges = Number(f.bank_charges) || 0;
  const deducted = f.withheld === "yes" ? Number(f.tax_deducted) || 0 : 0;
  /* Withheld tax settles the invoice even though it never arrives, so what
     clears the ledger and what lands in the account are two different
     numbers. Both are named on screen; conflating them is the bug this form
     inherited. */
  const settles = +(amt + deducted).toFixed(2);
  const netCash = +(incoming ? amt - charges : amt + charges).toFixed(2);

  /* What this payment would clear, fetched whenever the party or the
     direction changes. `open === null` means "not asked yet or in flight" and
     is drawn as such — an empty allocation panel on a customer who does have
     open invoices would read as "this settles nothing", which is a lie the
     save then contradicts. */
  const [open, setOpen] = useState(null);
  const [openFailed, setOpenFailed] = useState(false);
  const loadOpen = () => {
    if (!f.party_id) { setOpen(null); setOpenFailed(false); return; }
    setOpen(null); setOpenFailed(false);
    api.get(`/payments/open?party_id=${Number(f.party_id)}&direction=${f.direction}`)
      .then(setOpen).catch(() => setOpenFailed(true));
  };
  useEffect(loadOpen, [f.party_id, f.direction]);

  /* Automatic is the default because it is right most of the time. Manual
     exists because "most of the time" is not always: a customer hands over
     money *for a particular invoice*, often the newest one, and before this
     the only way to record that was to let the server settle the oldest and
     then unpick it by hand afterwards.

     `manual` is a map of doc id → typed amount. It is only sent to the server
     when the operator has actually switched over; an untouched form posts no
     allocations at all and the server plans it oldest-first, so the two
     defaults cannot drift. */
  const [manual, setManual] = useState(null);   /* null = automatic */
  const manualOn = manual !== null;

  /* Opened from an invoice's own row menu: point the money at that invoice as
     soon as we know what it owes. Runs once — re-running would overwrite an
     amount the operator had since typed. */
  const targeted = useRef(false);
  useEffect(() => {
    if (targeted.current || !targetDocId || !open) return;
    const row = open.rows.find((r) => Number(r.id) === targetDocId);
    if (!row) return;
    targeted.current = true;
    setManual({ [row.id]: String(Math.min(settles || row.balance_due, row.balance_due)) });
  }, [open, targetDocId, settles]);

  /* Keep a manual plan pointing at documents that are still open. If the list
     reloads (party changed, or a retry) an id that is no longer there would
     otherwise be posted and refused by the server with nothing on screen
     explaining which line was at fault. */
  useEffect(() => {
    if (!open) return;
    setManual((m) => {
      if (!m) return m;
      const live = new Set(open.rows.map((r) => String(r.id)));
      const kept = Object.fromEntries(Object.entries(m).filter(([k]) => live.has(String(k))));
      return Object.keys(kept).length === Object.keys(m).length ? m : kept;
    });
  }, [open]);

  const plan = useMemo(() => {
    const rows = open ? open.rows : [];
    if (manualOn) {
      let used = 0;
      const errors = [];
      const applied = rows.map((r) => {
        const raw = manual[r.id];
        const alloc = Math.max(0, Number(raw) || 0);
        if (alloc > r.balance_due + 0.005) errors.push(`${r.doc_no} only has ${cur()} ${inr(r.balance_due)} outstanding.`);
        used = +(used + alloc).toFixed(2);
        return { ...r, alloc, typed: raw ?? "", clears: alloc >= r.balance_due - 0.005 && alloc > 0 };
      });
      if (used > settles + 0.005) errors.push(`The invoices you picked come to ${cur()} ${inr(used)} — more than the ${cur()} ${inr(settles)} this payment settles.`);
      return { applied, advance: +Math.max(0, settles - used).toFixed(2), used, manual: true, errors };
    }
    let left = settles;
    const applied = rows.map((r) => {
      const alloc = Math.max(0, Math.min(left, r.balance_due));
      left = +(left - alloc).toFixed(2);
      return { ...r, alloc, clears: alloc >= r.balance_due - 0.005 && alloc > 0 };
    });
    return { applied, advance: +left.toFixed(2), used: +(settles - left).toFixed(2), manual: false, errors: [] };
  }, [open, settles, manual, manualOn]);

  /* Switching to manual starts from the automatic plan rather than from an
     empty grid: the operator is usually adjusting one line of it, not building
     it from nothing. */
  const startManual = () => {
    const seed = {};
    for (const r of plan.applied) if (r.alloc > 0) seed[r.id] = String(r.alloc);
    setManual(seed);
  };
  const setManualAmt = (id, v) => setManual((m) => ({ ...(m || {}), [id]: v.replace(/[^\d.]/g, "") }));

  const save = async (status) => {
    if (!f.party_id) return toast("Choose a customer or supplier", "bad");
    if (!(amt > 0)) return toast("Enter the amount", "bad");
    if (charges > amt) return toast("Bank charges cannot exceed the amount", "bad");
    /* Refused here as well as on the server. The server is the authority, but
       an over-application caught after the round trip means the operator has
       already pressed Save on a figure they believed. */
    if (status !== "draft" && manualOn && plan.errors.length) return toast(plan.errors[0], "bad");
    if (status !== "draft" && manualOn && plan.used <= 0) return toast("Put an amount against at least one invoice, or switch back to automatic", "bad");
    setBusy(true);
    try {
      const r = await api.post("/payments", {
        /* One reference for this attempt at this payment. Pressing Save again
           after a dropped connection sends the same one, and the server hands
           back the payment it already took rather than taking it twice. */
        client_ref: attempt.ref(),
        direction: f.direction, party_id: Number(f.party_id), amount: amt,
        mode: f.mode, reference: f.reference || null, notes: f.notes || null,
        payment_date: f.payment_date, received_on: f.received_on || null,
        bank_charges: charges, tax_deducted: deducted,
        deposit_code: f.deposit_code || null, status,
        /* Only sent when the operator overrode the plan. An automatic payment
           posts nothing here and the server allocates oldest-first, so there
           is exactly one implementation of the default. */
        allocations: manualOn && status !== "draft"
          ? plan.applied.filter((r) => r.alloc > 0).map((r) => ({ doc_id: r.id, amount: r.alloc }))
          : undefined,
      });
      /* Posted — this attempt is over, so the next payment gets a reference of
         its own rather than being mistaken for a retry of this one. */
      attempt.done();
      if (f.deposit_code) rememberAccount(f.deposit_code);
      if (r.replayed) toast(`${r.payment_no} had already gone through — this did not record it twice`);
      else if (status === "draft") toast(`${r.payment_no} saved as a draft — confirm it to allocate and post`);
      else if (!r.replayed) toast(`${r.payment_no} — ${cur()} ${inr(r.allocated)} allocated${r.unallocated ? `, ${cur()} ${inr(r.unallocated)} left as advance` : ""}`);
      onSaved();
      /* A draft has not moved any money and allocates nothing, so there is
         nothing to give anybody a receipt for. Offering paper for it would
         hand a customer evidence of a payment that has not been posted. */
      if (status !== "draft") {
        const who = (parties.find((x) => String(x.id) === String(f.party_id)) || {}).name;
        offerVoucherPrint({
          noun: "receipt", number: r.payment_no,
          title: f.direction === "in" ? "Receipt" : "Payment voucher",
          direction: f.direction === "in" ? "Received from" : "Paid to",
          party: who, amount: amt,
          /* Which bills this settled, printed on the slip. */
          applied: r.applied || [],
          rows: [
            ["Date", f.payment_date],
            ["Method", f.mode],
            ["Reference", f.reference || ""],
            ["Allocated", `${cur()} ${inr(r.allocated)}`],
            /* Named on the paper because an advance is the figure a customer
               argues about later, and "we have it on account" is only
               believable if their own copy says so. */
            ["On account", r.unallocated ? `${cur()} ${inr(r.unallocated)}` : ""],
            ["Bank charges", charges ? `${cur()} ${inr(charges)}` : ""],
            ["Tax withheld", deducted ? `${cur()} ${inr(deducted)}` : ""],
          ],
          note: f.notes || null,
        });
      }
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const docWord = incoming ? "invoice" : "bill";
  const acct = accounts.find((a) => a.code === f.deposit_code);

  return (
    <DocShell
      title={incoming ? "Payment received" : "Payment made"}
      docNo="Auto: PAY-…"
      meta={`${f.payment_date}${acct ? ` · ${incoming ? "into" : "from"} ${acct.name}` : ""}`}
      onClose={onClose} onSave={() => save("paid")} busy={busy}
      saveLabel={`Save as paid · ${cur()} ${inr(amt)}`}
      actions={
        /* A draft allocates nothing and posts nothing, so it must not look
           like the ordinary way to finish. It sits beside Save rather than
           under it, and says what it will not do. */
        <button className="btn btn-ghost pay-draft" onClick={() => save("draft")} disabled={busy}
                title="Park it — nothing is allocated or posted until you confirm it">
          Save as draft
        </button>
      }
      summary={[
        { label: incoming ? "Received" : "Paid", value: `${cur()} ${inr(amt)}` },
        deducted > 0 ? { label: "Tax withheld", value: `+${cur()} ${inr(deducted)}` } : null,
        charges > 0 ? { label: "Bank charges", value: `−${cur()} ${inr(charges)}`, tone: "amt-paid" } : null,
        { label: `Clears ${docWord}s`, value: `${cur()} ${inr(plan.used)}`, tone: plan.used > 0 ? "amt-received" : "amt-zero" },
        plan.advance > 0 ? { label: "Left as advance", value: `${cur()} ${inr(plan.advance)}`, tone: "amt-owed" } : null,
      ]}
      total={{ label: incoming ? "Into the account" : "Out of the account", value: `${cur()} ${inr(netCash)}` }}
      footNote={
        !f.party_id
          ? `Choose a ${incoming ? "customer" : "supplier"} to see which ${docWord}s this clears.`
          : manualOn
            ? `You have chosen which ${docWord}s this settles. Anything not allocated stays on the account as an advance.`
            : `Applied oldest ${docWord} first, by the date on the ${docWord}. Anything left over stays on the account as an advance.`
      }
    >
      <DocTop>
        <DocSection title={incoming ? "Money in" : "Money out"}>
          <div className="pay-dir" role="group" aria-label="Which way the money went">
            {[["in", "Received from customer"], ["out", "Paid to supplier"]].map(([v, label]) => (
              <button key={v} type="button" onClick={() => setF({ ...f, direction: v })}
                      aria-pressed={f.direction === v}
                      className={`btn ${f.direction === v ? "btn-primary" : "btn-ghost"}`}>{label}</button>
            ))}
          </div>

          {/* The amount is the first thing typed and the largest thing on the
              screen, because it is the one figure that is checked against the
              cash in somebody's hand. */}
          <label className="pay-amount">
            <span className="l">{incoming ? "Amount received" : "Amount paid"} ({cur()})</span>
            <input type="number" inputMode="decimal" value={f.amount} onChange={set("amount")}
                   className="dk-n" placeholder="0" autoFocus />
          </label>

          <DocFields>
            <Field label={incoming ? "From customer" : "To supplier"}>
              <select value={f.party_id} onChange={set("party_id")}>
                <option value="">Select…</option>
                {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Payment date">
              <input type="date" value={f.payment_date} onChange={set("payment_date")} />
            </Field>
          </DocFields>

          <DocParty party={party} emptyHint={`No ${incoming ? "customer" : "supplier"} chosen yet — pick one and their balance and open ${docWord}s appear.`} />

          <div className="pay-wht">
            <div className="pay-wht-q">Did they deduct withholding tax?</div>
            <div className="pay-radios">
              <label><input type="radio" name="pay-wht" checked={f.withheld === "no"}
                            onChange={() => setF({ ...f, withheld: "no" })} /> No</label>
              <label><input type="radio" name="pay-wht" checked={f.withheld === "yes"}
                            onChange={() => setF({ ...f, withheld: "yes" })} /> Yes</label>
              {f.withheld === "yes" && (
                <input type="number" className="dk-n" placeholder="Amount withheld" value={f.tax_deducted}
                       onChange={set("tax_deducted")} aria-label="Amount withheld" />
              )}
            </div>
            {f.withheld === "yes" && (
              <div className="doc-sec-hint">
                {incoming
                  ? `Withheld tax still settles the ${docWord} — it goes to Tax Recoverable as a URA credit you can claim. That is why ${cur()} ${inr(settles)} clears while only ${cur()} ${inr(netCash)} reaches the account.`
                  : `Withheld tax still settles the ${docWord} — it goes to Taxes Payable as an amount you owe URA.`}
              </div>
            )}
          </div>
        </DocSection>

        <DocSection title={`What this clears`}>
          <AllocationPanel plan={plan} open={open} failed={openFailed} onRetry={loadOpen}
                           chosen={!!f.party_id} settles={settles} incoming={incoming}
                           docWord={docWord} manualOn={manualOn}
                           onManual={startManual} onAuto={() => setManual(null)}
                           onAmount={setManualAmt} />
        </DocSection>
      </DocTop>

      {/* Everything below changes where the money sits, not what it settles.
          It was competing for attention with the amount; now it is one block,
          below the fold if the screen is short, and nothing in it is required
          beyond the account. The wrapper only exists to put air between it and
          the two columns above — DocShell's own rule spaces sibling sections,
          and this one's sibling is the two-column top. */}
      <div className="pay-below">
      <DocSection title="Banking details" hint="None of this changes which invoices are cleared — only where the money sits and how it is traced.">
        <DocFields cols={3}>
          <Field label="Payment mode">
            <select value={f.mode} onChange={set("mode")}>
              {["cash", "mobile money", "card", "cheque", "bank"].map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
            </select>
          </Field>
          <Field label={incoming ? "Deposit to" : "Paid from"}>
            <AccountSelect accounts={accounts} value={f.deposit_code}
                           ariaLabel={incoming ? "Deposit to" : "Paid from"}
                           onChange={(v) => setF((x) => ({ ...x, deposit_code: v }))} />
          </Field>
          <Field label={`Bank charges (${cur()})`}>
            <input type="number" className="dk-n" value={f.bank_charges} onChange={set("bank_charges")} placeholder="0" />
          </Field>
          <Field label={incoming ? "Money reached the account on" : "Money left the account on"}>
            <input type="date" value={f.received_on} onChange={set("received_on")} />
          </Field>
          <Field label="Reference #">
            <input value={f.reference} onChange={set("reference")} placeholder="Mobile money txn / cheque no" />
          </Field>
        </DocFields>
        <Field label="Notes">
          <textarea value={f.notes} onChange={set("notes")} placeholder="Anything worth remembering about this payment" />
        </Field>
      </DocSection>
      </div>
    </DocShell>
  );
}

/* The allocation, as a list of documents rather than a sentence.
   Rows the money reaches are shown with what comes off them and whether that
   clears them; rows it does not reach are dimmed and say "not reached", which
   is the honest description — they are still open. Colour is never the only
   signal: "cleared", "part paid", "not reached" and "overdue" are all words. */
function AllocationPanel({ plan, open, failed, onRetry, chosen, settles, incoming, docWord,
                          manualOn, onManual, onAuto, onAmount }) {
  if (!chosen) {
    return <div className="pay-alloc empty">Pick a {incoming ? "customer" : "supplier"} and this fills in with the {docWord}s the money will clear, oldest first.</div>;
  }
  if (failed) {
    return (
      <div className="pay-alloc empty">
        Their open {docWord}s did not load, so this payment cannot be previewed.
        <div style={{ marginTop: 8 }}><button className="dk-sbtn" onClick={onRetry}>Try again</button></div>
      </div>
    );
  }
  if (open === null) return <div className="pay-alloc empty">Looking up their open {docWord}s…</div>;
  if (open.rows.length === 0) {
    return (
      <div className="pay-alloc empty">
        Nothing outstanding — every {docWord} of theirs is settled.
        {settles > 0 && <div className="pay-advance solo">The whole {cur()} {inr(settles)} stays on their account as an advance.</div>}
      </div>
    );
  }

  return (
    <div className={`pay-alloc ${manualOn ? "is-manual" : ""}`}>
      {/* Automatic stays the default and stays first, because it is right most
          of the time and a shop that never needs to override should never have
          to think about this. What was missing was the choice at all. */}
      <div className="pay-allocmode" role="group" aria-label="How this payment is applied">
        <button type="button" className={`pay-modebtn ${manualOn ? "" : "on"}`} aria-pressed={!manualOn}
                onClick={onAuto}>Automatic — oldest first</button>
        <button type="button" className={`pay-modebtn ${manualOn ? "on" : ""}`} aria-pressed={!!manualOn}
                onClick={onManual}>Choose {docWord}s myself</button>
      </div>
      {manualOn && (
        <div className="pay-override" role="status">
          You are choosing which {docWord}s this settles — the automatic plan has been overridden.
        </div>
      )}
      <div className="pay-alloc-head">
        <span>{docWord === "invoice" ? "Invoice" : "Bill"}</span>
        <span className="r">Outstanding</span>
        <span className="r">This pays</span>
      </div>
      {plan.applied.map((r) => (
        <div key={r.id} className={`pay-alloc-row ${r.alloc > 0 ? (r.clears ? "clears" : "part") : "untouched"}`}>
          <span className="d">
            <b className="dk-n">{r.doc_no}</b>
            <small className="dk-n">
              {String(r.doc_date).slice(0, 10)}
              {r.overdue ? " · overdue" : r.due_date ? ` · due ${String(r.due_date).slice(0, 10)}` : ""}
            </small>
          </span>
          <span className={`r dk-n ${r.overdue ? "amt-overdue" : "amt-owed"}`}>{inr(r.balance_due)}</span>
          {manualOn ? (
            <span className="r pay-allocedit">
              <input className="dk-n" inputMode="decimal" value={r.typed ?? ""} placeholder="0"
                     aria-label={`Amount to apply to ${r.doc_no}`}
                     data-alloc-doc={r.id}
                     aria-invalid={r.alloc > r.balance_due + 0.005 ? "true" : undefined}
                     onChange={(e) => onAmount(r.id, e.target.value)} />
              {/* One click to settle this one in full — the common case, and
                  the one where a typed figure is most likely to be a cent out
                  from the balance and leave the invoice open by 0.01. */}
              <button type="button" className="dk-linkbtn" onClick={() => onAmount(r.id, String(r.balance_due))}>
                Pay all
              </button>
            </span>
          ) : (
            <span className="r">
              <b className={`dk-n ${r.alloc > 0 ? "amt-received" : "amt-zero"}`}>{r.alloc > 0 ? inr(r.alloc) : "—"}</b>
              <small>{r.alloc > 0 ? (r.clears ? "cleared" : "part paid") : "not reached"}</small>
            </span>
          )}
        </div>
      ))}
      {manualOn && plan.errors.length > 0 && (
        <div className="pay-allocerr" role="alert">{plan.errors[0]}</div>
      )}
      <div className="pay-alloc-foot">
        <span>{plan.applied.filter((r) => r.alloc > 0).length} of {plan.applied.length} {docWord}s touched · {plan.applied.filter((r) => r.clears).length} cleared</span>
        <b className="dk-n">{cur()} {inr(plan.used)}</b>
      </div>
      {plan.advance > 0 && (
        <div className="pay-advance">
          {cur()} {inr(plan.advance)} more than they owe — it stays on their account as an advance
          against the next {docWord}.
        </div>
      )}
    </div>
  );
}

function Expenses({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [cats, setCats] = useState([]);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [meta, setMeta] = useState({ total: 0, pages: 1, sums: {} });
  const [failed, read] = useRead();
  const load = () => {
    const sp = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) sp.set("q", q);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    read(api.get(`/expenses?${sp}`),
      (d) => { if (d) { setRows(d.rows); setMeta({ total: d.total, pages: d.pages, sums: d.sums || {} }); }
               else { setRows(null); setMeta({ total: 0, pages: 1, sums: {} }); } },
      null);
  };
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [page, limit, q, from, to]);
  useEffect(() => { setPage(1); }, [q, from, to]);
  useEffect(() => { api.get("/expenses/categories").then(setCats).catch(() => {}); }, []);
  const paper = React.useRef(null);
  const printList = () => printReportNode(paper.current, {
    title: "Expenses",
    caption: from || to ? `${from || "start"} to ${to || "today"}` : "All dates",
  });
  return (
    <div className="dk-card flush" ref={paper}>
      <div className="dk-card-head"><h3>Expenses</h3>{can("expenses", "create") && <button className="dk-create" style={{ height: 38 }} onClick={() => setOpen(true)}>+ Add expense</button>}</div>
      <div className="list-filters">
        <input placeholder="Search expense #, category or note…" value={q} onChange={(e) => setQ(e.target.value)} />
        <DateRangePicker from={from} to={to} align="left" allLabel="All dates"
                         onChange={(r) => { setFrom(r.from); setTo(r.to); }} />
        {(q || from || to) && <button className="btn btn-ghost" onClick={() => { setQ(""); setFrom(""); setTo(""); }}>Clear</button>}
      </div>
      <div className="dk-scrollx">
      <table className="dk-table">
        <thead><tr><th>#</th><th>Category</th><th>Date</th><th>Mode</th><th className="amt">Amount</th><th /></tr></thead>
        <tbody>
          {failed ? <FailedRows cols={6} what="your expenses" onRetry={load} /> :
            rows === null ? <SkeletonRows rows={4} cols={5} /> :
            rows.length === 0 ? <tr><td colSpan={6}><Empty icon="▽" title="No expenses recorded" /></td></tr> :
            rows.map((e) => {
              const dead = e.status === "voided";
              return (
              <tr key={e.id} className={`hl ${dead ? "void" : ""}`}>
                <td className="strong num">{e.expense_no}</td>
                <td>
                  {e.category}
                  {dead && <span className="pill" style={{ marginLeft: 6 }}>voided</span>}
                  {!dead && Number(e.edit_count) > 0 && <span className="pill" style={{ marginLeft: 6 }}>amended</span>}
                </td>
                <td className="num">{e.expense_date}</td>
                <td style={{ textTransform: "uppercase", fontSize: 12.5, fontWeight: 500 }}>{e.mode}</td>
                <td className={`amt ${dead ? "amt-void" : ""}`} style={{ fontWeight: 650 }}>{cur()} {inr(e.amount)}</td>
                <td style={{ textAlign: "right" }}>
                  <RowMenu label={`Actions for ${e.expense_no}`} actions={[
                    { icon: <Icon n="eye" />, label: "View", onClick: () => toast(`${e.expense_no} · ${e.category} · ${cur()} ${inr(e.amount)}${e.notes ? " · " + e.notes : ""}${dead ? " · VOIDED" : ""}`) },
                    ...(can("expenses", "edit") ? [{
                      icon: <Icon n="edit" />, label: "Edit", disabled: dead,
                      hint: dead ? "voided" : undefined, onClick: () => setEdit(e),
                    }] : []),
                    { icon: <Icon n="print" />, label: "Print this list", onClick: printList },
                    ...(can("expenses", "delete") ? [{
                      icon: <Icon n="trash" />, label: "Void", danger: true, disabled: dead,
                      hint: dead ? "already voided" : undefined,
                      onClick: async () => {
                        if (!(await confirmDialog({
                          title: `Void ${e.expense_no}?`,
                          message: `${cur()} ${inr(e.amount)} for ${e.category}. What it posted to the books is reversed and the expense stays in the list, marked voided — so the correction is on the record rather than the entry simply vanishing.`,
                          danger: true, confirmLabel: "Void entry",
                        }))) return;
                        try { const r = await api.delete(`/expenses/${e.id}`); toast(r.message || "Voided"); load(); onChanged?.(); }
                        catch (err) { toast(err.message, "bad"); }
                      },
                    }] : []),
                  ]} />
                </td>
              </tr>
              );
            })}
        </tbody>
      </table>
      </div>
      <Pager page={page} pages={meta.pages} total={meta.total} limit={limit} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
      {open && <ExpenseForm cats={cats} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged?.(); toast("Expense recorded"); }} />}
      {edit && <ExpenseEdit expense={edit} cats={cats} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); load(); onChanged?.(); }} />}
    </div>
  );
}

function OtherIncome({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(null);
  const [failed, read] = useRead();
  const load = () => read(api.get("/expenses/other-income"), setRows, null);
  useEffect(() => { load(); }, []);
  return (
    <div className="dk-card flush">
      <div className="dk-card-head"><h3>Other income</h3>{can("expenses", "create") && <button className="dk-create" style={{ height: 38 }} onClick={() => setOpen(true)}>+ Add income</button>}</div>
      <div className="dk-scrollx">
      <table className="dk-table">
        <thead><tr><th>Entry</th><th>Date</th><th>Description</th><th className="amt">Amount</th><th /></tr></thead>
        <tbody>
          {failed ? <FailedRows cols={4} what="other income" onRetry={load} /> :
            rows === null ? <SkeletonRows rows={3} cols={4} /> :
            rows.length === 0 ? <tr><td colSpan={4}><Empty icon="△" title="No other income" hint="Interest, commission, scrap sales…" /></td></tr> :
            rows.map((r) => (
              <tr key={r.id} className="hl">
                <td className="strong num">{r.entry_no}</td><td className="num">{r.entry_date}</td><td>{r.description}</td>
                <td className="amt amt-received" style={{ fontWeight: 650 }}>+{cur()} {inr(r.amount)}</td>
                <td style={{ textAlign: "right" }}>
                  <RowMenu label={`Actions for ${r.entry_no}`} actions={[
                    ...(can("expenses", "edit") ? [{
                      icon: <Icon n="edit" />, label: "Edit", onClick: () => setEdit(r),
                    }] : []),
                    ...(can("expenses", "delete") ? [{
                      icon: <Icon n="trash" />, label: "Delete", danger: true,
                      onClick: async () => {
                        if (!(await confirmDialog({
                          title: `Delete ${r.entry_no}?`,
                          message: `${cur()} ${inr(r.amount)} — ${r.description || "other income"}. Other income is a ledger entry and nothing else, so this removes it and puts the balances back. Nothing else in the books changes.`,
                          danger: true, confirmLabel: "Delete",
                        }))) return;
                        try { const x = await api.delete(`/expenses/other-income/${r.id}`); toast(x.message || "Removed"); load(); onChanged?.(); }
                        catch (err) { toast(err.message, "bad"); }
                      },
                    }] : []),
                  ]} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>
      {open && <IncomeModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); onChanged?.(); toast("Income recorded"); }} />}
      {edit && <IncomeModal edit={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); onChanged?.(); }} />}
    </div>
  );
}

function IncomeModal({ edit, onClose, onSaved }) {
  const [f, setF] = useState(edit
    ? { description: edit.description || "", amount: String(edit.amount || ""), cash_account_code: "",
        date: String(edit.entry_date || "").slice(0, 10) }
    : { description: "", amount: "", cash_account_code: "" });
  /* Interest, commission and scrap sales arrive somewhere specific — bank
     interest is credited to the bank, not carried to the till in a bag — and
     this form had no way to say so, so every one of them was posted to Cash in
     Hand and the drawer read long by the amount. */
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    api.get("/accounting/cash-accounts")
      .then((a) => { setAccounts(a); setF((x) => (x.cash_account_code ? x : { ...x, cash_account_code: defaultAccount(a, lastAccount()) })); })
      .catch(() => {});
  }, []);
  const save = async () => {
    if (!(Number(f.amount) > 0)) return toast("Enter an amount", "bad");
    try {
      if (edit) {
        const r = await api.put(`/expenses/other-income/${edit.id}`, {
          amount: Number(f.amount), description: f.description,
          date: f.date || undefined, cash_account_code: f.cash_account_code || undefined,
        });
        toast(r.message || `${edit.entry_no} updated`);
        if (f.cash_account_code) rememberAccount(f.cash_account_code);
        onSaved();
        return;
      }
      const saved = await api.post("/expenses/other-income", { ...f, amount: Number(f.amount), cash_account_code: f.cash_account_code || undefined });
      if (f.cash_account_code) rememberAccount(f.cash_account_code);
      onSaved();
      offerVoucherPrint({
        noun: "receipt", title: "Receipt", number: saved.entry_no || "",
        direction: "Received", party: f.description, amount: Number(f.amount),
        /* The form carries no date field — the server stamps today — so the
           voucher says today rather than inventing one from a key that is not
           there. */
        rows: [["Date", new Date().toISOString().slice(0, 10)],
               ["Account", f.cash_account_code || ""]],
      });
    } catch (e) { toast(e.message, "bad"); }
  };
  return (
    <Modal title={edit ? `Edit ${edit.entry_no}` : "Add other income"} onClose={onClose}>
      <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Interest received, scrap sale…" autoFocus /></Field>
      <Field label="Amount (Sh )"><input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      {edit && <Field label="Date"><input type="date" value={f.date || ""} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>}
      {accounts.length > 0 && (
        <Field label="Money went into">
          <AccountSelect accounts={accounts} value={f.cash_account_code} ariaLabel="Account this income went into"
                         onChange={(v) => setF((x) => ({ ...x, cash_account_code: v }))} />
        </Field>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <SubmitButton onClick={save}>{edit ? "Save changes" : "Save income"}</SubmitButton>
      </div>
    </Modal>
  );
}

/* ── Correcting an expense ────────────────────────────────────────────────
 *
 * A single expense, not the multi-line batch form that records them. The two
 * are different jobs: entering a shelf of receipts is a grid, and fixing the
 * amount on one of them is four fields. Reusing the batch form here would mean
 * a screen full of empty rows around the one line being corrected.
 */
function ExpenseEdit({ expense, cats, onClose, onSaved }) {
  const [f, setF] = useState({
    category: expense.category || "", amount: String(expense.amount || ""),
    tax_amount: String(expense.tax_amount || ""), expense_date: String(expense.expense_date || "").slice(0, 10),
    mode: expense.mode || "cash", notes: expense.notes || "",
    cash_account_code: expense.cash_account_code || "",
  });
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/accounting/cash-accounts").then(setAccounts).catch(() => setAccounts([])); }, []);

  const save = async () => {
    if (!(Number(f.amount) > 0)) return toast("Enter an amount", "bad");
    setBusy(true);
    try {
      const r = await api.put(`/expenses/${expense.id}`, {
        category: f.category, amount: Number(f.amount), tax_amount: Number(f.tax_amount) || 0,
        expense_date: f.expense_date || undefined, mode: f.mode, notes: f.notes || null,
        cash_account_code: f.cash_account_code || undefined,
      });
      toast(r.message || `${expense.expense_no} updated`);
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`Edit ${expense.expense_no}`} onClose={onClose}>
      <div style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6, marginBottom: 10 }}>
        What this expense posted is reversed and posted again with the figures
        below, under the same number — so the books hold the corrected amount,
        and the reversal is there for anybody who asks what changed.
        {Number(expense.edit_count) > 0
          ? ` It has been amended ${expense.edit_count} time${expense.edit_count === 1 ? "" : "s"} already.`
          : ""}
      </div>
      <div className="row2">
        <Field label="Category">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {!(cats || []).includes(f.category) && f.category ? <option value={f.category}>{f.category}</option> : null}
            {(cats || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Date"><input type="date" value={f.expense_date} onChange={(e) => setF({ ...f, expense_date: e.target.value })} /></Field>
      </div>
      <div className="row2">
        <Field label={`Amount (${cur()})`}><input type="number" value={f.amount} autoFocus onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={`Of which tax (${cur()})`}><input type="number" value={f.tax_amount} onChange={(e) => setF({ ...f, tax_amount: e.target.value })} /></Field>
      </div>
      {accounts.length > 0 && (
        <Field label="Paid from">
          <AccountSelect accounts={accounts} value={f.cash_account_code} ariaLabel="Account this expense was paid from"
                         onChange={(v) => setF((x) => ({ ...x, cash_account_code: v }))} />
        </Field>
      )}
      <Field label="Note"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <SubmitButton onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</SubmitButton>
      </div>
    </Modal>
  );
}

/* ── Correcting a payment ─────────────────────────────────────────────────
 *
 * Amount, date and the details around it. Deliberately NOT the allocation
 * grid the create form carries: correcting a payment unwinds what it settled
 * and applies the new amount from scratch, oldest bill first, because there is
 * no sensible "adjusted" version of an old split — a payment cut from 200,000
 * to 150,000 has to take money back off one of the bills it cleared, and which
 * one is a decision rather than arithmetic. The result is shown afterwards.
 *
 * The party is fixed. Money that moved from one customer's account to
 * another's is two documents, not an edit.
 */
function PaymentEdit({ payment, onClose, onSaved }) {
  const [f, setF] = useState({
    amount: String(payment.amount || ""), payment_date: String(payment.payment_date || "").slice(0, 10),
    mode: payment.mode || "cash", reference: payment.reference || "", notes: payment.notes || "",
    bank_charges: String(payment.bank_charges || ""), tax_deducted: String(payment.tax_deducted || ""),
    deposit_code: payment.deposit_code || "",
  });
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get("/accounting/cash-accounts").then(setAccounts).catch(() => setAccounts([])); }, []);

  const save = async () => {
    if (!(Number(f.amount) > 0)) return toast("Enter an amount", "bad");
    setBusy(true);
    try {
      const r = await api.put(`/payments/${payment.id}`, {
        amount: Number(f.amount), payment_date: f.payment_date || undefined, mode: f.mode,
        reference: f.reference || null, notes: f.notes || null,
        bank_charges: Number(f.bank_charges) || 0, tax_deducted: Number(f.tax_deducted) || 0,
        deposit_code: f.deposit_code || undefined,
      });
      /* Say which bills it now settles. "Updated" alone leaves the operator to
         go and look, and the whole point of the correction was the allocation. */
      const applied = (r.applied || []).map((a) => `${a.doc_no} ${cur()} ${inr(a.amount)}`).join(" · ");
      toast(applied ? `${payment.payment_no} updated — ${applied}` : (r.message || "Updated"));
      onSaved();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  return (
    <Modal title={`Edit ${payment.payment_no}`} onClose={onClose}>
      <div style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6, marginBottom: 10 }}>
        {payment.direction === "in" ? "Received from" : "Paid to"} <b>{payment.party_name}</b> — that cannot be
        changed here. The bills this settled are released and the new amount is
        applied again, oldest first; you will be told which ones it lands on.
      </div>
      <div className="row2">
        <Field label={`Amount (${cur()})`}><input type="number" value={f.amount} autoFocus onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Date"><input type="date" value={f.payment_date} onChange={(e) => setF({ ...f, payment_date: e.target.value })} /></Field>
      </div>
      <div className="row2">
        <Field label="Method">
          <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            {["cash", "bank", "mobile", "cheque", "card", "upi"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Reference"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Cheque or transaction no." /></Field>
      </div>
      <div className="row2">
        <Field label={`Bank charges (${cur()})`}><input type="number" value={f.bank_charges} onChange={(e) => setF({ ...f, bank_charges: e.target.value })} /></Field>
        <Field label={`Tax withheld (${cur()})`}><input type="number" value={f.tax_deducted} onChange={(e) => setF({ ...f, tax_deducted: e.target.value })} /></Field>
      </div>
      {accounts.length > 0 && (
        <Field label={payment.direction === "in" ? "Money went into" : "Money went out of"}>
          <AccountSelect accounts={accounts} value={f.deposit_code} ariaLabel="Cash or bank account"
                         onChange={(v) => setF((x) => ({ ...x, deposit_code: v }))} />
        </Field>
      )}
      <Field label="Note"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <SubmitButton onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</SubmitButton>
      </div>
    </Modal>
  );
}


/* ── Repeating expenses ───────────────────────────────────────────────────
 *
 * Rent, wages, power, the internet bill. Set up from the expense form (tick
 * "Set this up to repeat"), managed here.
 *
 * The screen leads with what these schedules cost the shop in a month,
 * because that is the figure an owner actually wants off it and adding it up
 * across four different frequencies by hand is exactly the arithmetic nobody
 * does.
 */
const FREQ_WORD = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
function everyPhrase(freq, n) {
  const w = FREQ_WORD[freq] || "month";
  return (Number(n) || 1) === 1 ? `Every ${w}` : `Every ${n} ${w}s`;
}

function RepeatingExpenses({ onChanged }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, read] = useRead();

  const load = () => { setD(null); read(api.get("/expenses/recurring"), setD, null); };
  useEffect(() => { load(); }, []);

  const rows = (d && d.rows) || [];
  const due = rows.filter((r) => r.due);

  const runDue = async () => {
    setBusy(true);
    try {
      const r = await api.post("/expenses/recurring/run-due", {});
      toast(r.message || "Done");
      load(); onChanged && onChanged();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const runOne = async (r) => {
    if (!(await confirmDialog({
      title: `Record ${r.name} now?`,
      message: `An expense of ${cur()} ${inr(r.amount)} is posted, dated ${r.next_run || "today"}.`,
      confirmLabel: "Record it",
    }))) return;
    try {
      const x = await api.post(`/expenses/recurring/${r.id}/run`, {});
      toast(`${x.expense_no} recorded`);
      load(); onChanged && onChanged();
    } catch (e) { toast(e.message, "bad"); }
  };

  const setStatus = async (r, status) => {
    try {
      await api.post(`/expenses/recurring/${r.id}/status`, { status });
      toast(status === "active" ? "Resumed" : status === "paused" ? "Paused" : "Ended");
      load();
    } catch (e) { toast(e.message, "bad"); }
  };

  const remove = async (r) => {
    if (!(await confirmDialog({
      title: `Delete the ${r.name} schedule?`,
      message: "It stops raising expenses from now on.",
      detail: "The expenses it has already recorded are real and stay exactly where they are — only the schedule goes.",
      danger: true, confirmLabel: "Delete schedule",
    }))) return;
    try { await api.delete(`/expenses/recurring/${r.id}`); toast("Schedule deleted"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  return (
    <div className="dk-card dk-tablecard">
      <div className="dk-card-head">
        <h3>Repeating expenses</h3>
        {d && (
          <span className="n dk-n">
            {cur()} {inr(d.monthly_cost)} a month across {rows.filter((r) => r.status === "active").length} live
            schedule{rows.filter((r) => r.status === "active").length === 1 ? "" : "s"}
          </span>
        )}
        {due.length > 0 && can("expenses", "create") && (
          <button className="dk-sbtn primary" disabled={busy} onClick={runDue}>
            {busy ? "Recording…" : `Record ${due.length} due now`}
          </button>
        )}
      </div>

      {due.length > 0 && (
        <div className="rx-due">
          <b>{due.length} {due.length === 1 ? "schedule is" : "schedules are"} due.</b>
          <span>
            Nothing is posted until you say so, so the books do not gain entries you have not seen.
          </span>
        </div>
      )}

      {failed ? (
        <LoadFailed what="your repeating expenses" onRetry={load} />
      ) : d === null ? (
        <div className="dk-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty icon="⟳" title="Nothing repeats yet"
               hint="Record an expense and tick “Set this up to repeat” — rent, wages and power are the usual three." />
      ) : (
        <div className="dk-tablewrap dk-s">
          <table className="tw">
            <thead><tr>
              <th>What</th><th>How often</th><th>Next due</th>
              <th className="r">Amount</th><th className="r">Raised so far</th><th>Status</th><th />
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.due ? "rx-isdue" : ""}>
                  <td>
                    <span className="strong">{r.name}</span>
                    <div className="mt">{r.category}{r.party_name ? ` · ${r.party_name}` : ""}</div>
                  </td>
                  <td>{everyPhrase(r.frequency, r.interval_n)}</td>
                  <td className="num">
                    {r.next_run || "—"}
                    {r.due && <span className="rx-pill">due</span>}
                  </td>
                  <td className="r num strong">{inr(r.amount)}</td>
                  <td className="r num">{r.generated || 0}</td>
                  <td>
                    <span className={`rx-state ${r.status}`}>{r.status}</span>
                  </td>
                  <td className="r">
                    <RowMenu label={`Actions for ${r.name}`} actions={[
                      ...(can("expenses", "create") && r.status !== "ended"
                        ? [{ icon: <Icon n="play" />, label: "Record it now", onClick: () => runOne(r) }] : []),
                      ...(can("expenses", "edit") && r.status === "active"
                        ? [{ icon: <Icon n="pause" />, label: "Pause", onClick: () => setStatus(r, "paused") }] : []),
                      ...(can("expenses", "edit") && r.status === "paused"
                        ? [{ icon: <Icon n="play" />, label: "Resume", onClick: () => setStatus(r, "active") }] : []),
                      ...(can("expenses", "edit") && r.status !== "ended"
                        ? [{ icon: <Icon n="ban" />, label: "End it", onClick: () => setStatus(r, "ended") }] : []),
                      ...(can("expenses", "delete")
                        ? [{ icon: <Icon n="trash" />, label: "Delete schedule", danger: true, onClick: () => remove(r) }] : []),
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rx-foot">
        A repeated expense is an ordinary expense — same numbering, same journal, same audit trail.
        It simply was not typed by hand.
      </div>
    </div>
  );
}
