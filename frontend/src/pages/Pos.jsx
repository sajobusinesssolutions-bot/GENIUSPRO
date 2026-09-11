import React, { useEffect, useMemo, useRef, useState } from "react";
import { askToPrint, offerDocPrint } from "../lib/printprompt.jsx";
import api from "../lib/api.js";
import { computeInvoice, inr, dualQty, cur, fmtDate } from "../lib/tax.js";
import { Modal, Field, toast, confirmDialog, toastUndo, useActiveUsers, PartyCombo } from "../lib/ui.jsx";
import { currentUser, clearSession, newClientRef } from "../lib/api.js";
import { AdminDrawer, CashDlg, XReportDlg, EndDayDlg, CreditDlg, PrevSalesDlg, FindReceiptDlg } from "./PosAdmin.jsx";
import { printInvoice } from "../lib/print.js";
import { effectiveRules } from "../lib/taxrules.js";
import { plural } from "../lib/plural.js";
import { Icon } from "../lib/icons.jsx";
import { AccountSelect, accountKind, defaultAccount, lastAccount, rememberAccount } from "../lib/moneyaccounts.jsx";

/* Which account a till sale should default to.
   Cash goes to the drawer — the account the shop calls its till, or Cash in
   Hand if it has not named one. Card, mobile money and a credit sale's part
   payment go to whatever this terminal last banked into, because that is
   almost always the same MoMo line or merchant account every day. */
function pickTillAccount(accounts, mode) {
  if (mode === "cash") {
    const drawer = accounts.find((a) => a.code === "1001") || accounts.find((a) => accountKind(a) === "cash");
    return drawer ? drawer.code : (accounts[0] ? accounts[0].code : "");
  }
  const wanted = mode === "mobile" ? "mobile" : mode === "card" ? "bank" : null;
  const last = lastAccount();
  if (last && accounts.some((a) => a.code === last && (!wanted || accountKind(a) === wanted))) return last;
  const byKind = wanted && accounts.find((a) => accountKind(a) === wanted);
  return byKind ? byKind.code : defaultAccount(accounts, "");
}


/**
 * POS v3 — the approved till-column design, wired to the real backend.
 * Search modes ALL/NAME/CODE/BARCODE (Ctrl+T) · multi-barcode lookup ·
 * hold/resume/lock bills · void with audited reason · refunds on past sales ·
 * F2 discounts (bill/item, %/Sh) · credit-forces-customer · price-locked items ·
 * below-cost & negative-stock guards (server-enforced, manager override).
 */
const MODES = ["all", "name", "code", "barcode"];

/* ── the idempotency key for the bill on screen ─────────────────────────────
 * One reference per sale ATTEMPT: minted the first time this bill needs one,
 * reused unchanged by every retry of it, and discarded only when the till
 * moves on to the next customer. The server keeps it under
 * UNIQUE(firm_id, client_ref) and answers a repeat with the invoice it already
 * wrote, so a retry cannot bill the customer twice.
 *
 * It lives in localStorage, beside the bill itself, and that is the point.
 * The hole this closes is a page reload during the ambiguous window: the cart
 * was restored from disk but the warning that was holding Confirm shut was
 * not, so the button came back to life and the second press posted a second
 * invoice. The reference is restored with the cart, so that second press is
 * now answered with the first invoice.
 */
const SALE_REF_KEY = "vy_pos_ref";
function saleRef() {
  let r = null;
  try { r = localStorage.getItem(SALE_REF_KEY); } catch {}
  if (r) return r;
  r = newClientRef();
  try { localStorage.setItem(SALE_REF_KEY, r); } catch {}
  return r;
}
function clearSaleRef() { try { localStorage.removeItem(SALE_REF_KEY); } catch {} }

/* ── the unfinished bill on disk ────────────────────────────────────────────
 * The till writes the bill on screen to localStorage so a power cut or a
 * browser crash does not lose a half-rung sale. That much is worth keeping.
 *
 * What it must NOT do — and did — is put that bill back on screen by itself.
 * localStorage belongs to the browser, not to the person signed into it, so
 * the saved cart outlived the cashier, the shift and the customer. The morning
 * shift opened a "new" till and found a Sh 50,000 service sitting in it with a
 * green Take payment button, left there by whoever last touched that machine.
 * A three-second toast was the only warning, and a queue is not a place where
 * toasts get read. The next person in the queue pays for it.
 *
 * So the bill is now an OFFER, shown as a dialog that names who left it and
 * when, and the till behind that dialog is empty until somebody says resume.
 * `by`/`byName`/`at` are stamped on save purely so the prompt can be specific:
 * "left by Grace at 18:42 yesterday" is a question a cashier can answer, and
 * "1 item" is not.
 */
const CART_KEY = "vy_pos_cart";
function readSavedCart() {
  try {
    const s = JSON.parse(localStorage.getItem(CART_KEY) || "null");
    if (s && Array.isArray(s.lines) && s.lines.length) return s;
  } catch {}
  return null;
}
function clearSavedCart() { try { localStorage.removeItem(CART_KEY); } catch {} }

function PIc({ d }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-4px", marginRight: "var(--pic-mr, 7px)" }}>
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

/**
 * NumCell — an editable number cell for the bill grid.
 *
 * Idle it shows a formatted figure ("12,500"); the moment you focus it, it
 * swaps to plain digits and holds your keystrokes locally, committing on blur
 * or Enter. That separation matters: the previous cell rendered `inr(rate)` and
 * parsed the same string back on every keystroke, so a typed digit landed after
 * the thousands separators and "5,000" + "5" became 50,005.
 */
function NumCell({ value, onCommit, readOnly = false, width = 96, format = (n) => String(n), title, className = "cell-input num cell3", live = false }) {
  const [draft, setDraft] = useState(null);
  const editing = draft !== null;

  /* If the value changes underneath an open draft — which is what a unit flip
     does — the draft is now describing the old unit. Blurring would commit it
     and undo the flip, which is how switching a focused line to its second
     unit left the quantity sitting at 1. Drop the draft instead.
     `pushed` holds the exact figure this cell last sent up by live typing, so a
     value change that matches it is recognised as our own and must NOT wipe the
     half-typed draft under the cursor. A bare "it was me" flag could not be
     cleared when the parent's update was a no-op or was rejected — it then leaked
     into the next external change (a unit flip) and silently undid it. Keying it
     to the value means a stale entry can never match a foreign change. */
  const seen = useRef(value);
  const pushed = useRef(null);
  useEffect(() => {
    if (seen.current !== value) {
      seen.current = value;
      const isMine = pushed.current !== null && Number(pushed.current) === Number(value);
      pushed.current = null;
      if (!isMine) setDraft(null);
    }
  }, [value]);
  const parse = (s) => Number(String(s).replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"));
  const commit = () => {
    if (draft === null) return;
    const n = parse(draft);
    setDraft(null); pushed.current = null;
    onCommit(Number.isFinite(n) ? n : 0);
  };
  /* Live cells push every keystroke straight into the line, so the amount,
     subtotal and Take payment button can never show a stale figure while a new
     quantity sits typed but uncommitted. Empty / "." / "12." are held back as
     transient input rather than committed as 0.
     A commit that returns false was refused (stock guard): snap the cell back to
     the figure the bill actually holds, so the cell can't display a quantity the
     total does not contain. */
  const onType = (raw) => {
    setDraft(raw);
    if (!live) return;
    if (raw === "" || raw === "." || raw.endsWith(".")) return;
    const n = parse(raw);
    if (!Number.isFinite(n)) return;
    pushed.current = n;
    const ok = onCommit(n);
    if (ok === false) { pushed.current = null; setDraft(String(Number(value) || 0)); }
  };
  return (
    <input
      className={className}
      style={{ width, textAlign: "right" }}
      inputMode="decimal"
      title={title}
      readOnly={readOnly}
      value={editing ? draft : format(value)}
      onFocus={(e) => { if (readOnly) return; pushed.current = null; setDraft(String(Number(value) || 0)); const el = e.target; setTimeout(() => el.select(), 0); }}
      onChange={(e) => onType(e.target.value.replace(/[^\d.]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        /* Enter commits what is typed — it must never hand back the old figure,
           and it must not reach the till's global Enter (scanner) handler. */
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); setDraft(null); e.currentTarget.blur(); }
      }}
    />
  );
}

export default function Pos() {
  const [items, setItems] = useState([]);
  const [parties, setParties] = useState([]);
  const [rules, setRules] = useState([]);
  const [settings, setSettings] = useState({});
  const users = useActiveUsers();
  const [salesRep, setSalesRep] = useState(() => { const u = currentUser(); return u ? String(u.id) : ""; });
  const [held, setHeld] = useState([]);
  /* The till ALWAYS opens empty. See the note above readSavedCart(): a bill
     put back on screen by itself is a bill somebody can charge a stranger for. */
  const [lines, setLines] = useState([]);
  /* The unfinished bill found on disk, if any — offered, never applied. */
  const [recovery, setRecovery] = useState(() => readSavedCart());
  /* Set once the saved bill has been dealt with, so the persist effect below
     may start writing again. Until then it must not touch the key it is
     reading the offer from. */
  const [recoveryDone, setRecoveryDone] = useState(() => !readSavedCart());
  const [mode, setMode] = useState("all");
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [partyId, setPartyId] = useState("");
  const [partyRates, setPartyRates] = useState({});
  const [listPrices, setListPrices] = useState({});
  const [listName, setListName] = useState("");
  /* Every price list the shop has, and which one this bill is using.
     Following the customer is right nearly always, and is what the till did
     before. Choosing one by hand is for the times it is not — a staff sale, a
     wholesale price for somebody who usually pays retail — and that was not
     possible at all: the list followed the customer or it did not apply, so
     the only way to sell at another band's price was to retype every line. */
  const [priceLists, setPriceLists] = useState([]);
  const [partyList, setPartyList] = useState(0);   // the customer's own, 0 = none
  /* Not just `override`: `save(andPrint, override)` already takes a manager
     override as an argument, and two different overrides one scope apart is a
     bug waiting for whoever edits this next. */
  const [listOverride, setListOverride] = useState(null);  // null = follow the customer
  const listId = listOverride == null ? partyList : listOverride;
  const [pay, setPay] = useState("cash");
  /* Where the money for this sale lands. The till was the one money-taking
     screen in the app with no such choice: every sale posted to Cash in Hand
     whatever the customer actually paid with, so a shop taking half its
     takings on MoMo ended the day with a drawer that could not be counted
     against the books. `cashTouched` stops the mode buttons overwriting a
     choice the cashier has already made by hand. */
  const [cashAccounts, setCashAccounts] = useState([]);
  const [cashCode, setCashCode] = useState("");
  const [cashTouched, setCashTouched] = useState(false);

  /* Cash at the till belongs in the till's own drawer; anything else belongs
     wherever this counter usually banks it. Switching the payment mode moves
     the default with it, because a cashier who taps "Mobile Money" and leaves
     the account on Cash in Hand has recorded the sale in the wrong place and
     nothing on the receipt would show it. */
  useEffect(() => {
    if (cashTouched || !cashAccounts.length) return;
    setCashCode(pickTillAccount(cashAccounts, pay));
  }, [pay, cashAccounts, cashTouched]);

  const [received, setReceived] = useState("");
  const [billDisc, setBillDisc] = useState(0);
  const [sel, setSel] = useState(-1);
  const [dlg, setDlg] = useState(null);
  const [unlockTarget, setUnlockTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  /* A save that did not go through, held on screen until it is dealt with. */
  const [saveErr, setSaveErr] = useState(null);
  const [payScr, setPayScr] = useState(false);
  /* The sale that was just saved. The deck ends a sale on its own screen —
     a receipt, the change to hand over, and one obvious way into the next
     sale — instead of snapping straight back to an empty cart. */
  const [done, setDone] = useState(null);
  const [firm, setFirm] = useState({});
  const [drawerTotal, setDrawerTotal] = useState(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminDlg, setAdminDlg] = useState(null);
  const searchRef = useRef(null);
  const repRef = useRef(null);
  const recvRef = useRef(null);

  const loadHeld = () => api.get("/pos/held").then(setHeld).catch(() => {});
  useEffect(() => {
    api.get("/items").then((r) => setItems(r.filter((i) => i.is_active !== 0))).catch(() => {});
    api.get("/parties").then((p) => {
      setParties(p);
      const w = p.find((x) => x.name === "Cash Sale");
      if (w) setPartyId(String(w.id));
    }).catch(() => {});
    api.get("/settings/tax-rules").then(setRules).catch(() => setRules([]));
    api.get("/settings").then((s) => setSettings(s.values || {})).catch(() => {});
    loadHeld();
    api.get("/settings/firm").then(setFirm).catch(() => {});
    api.get("/accounting/cash-accounts")
      .then((a) => { setCashAccounts(a); setCashCode((c) => c || pickTillAccount(a, "cash")); })
      .catch(() => setCashAccounts([]));
    refreshDrawer();
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  /* What the drawer should hold: the open shift's expected cash — opening
     float, plus cash taken, less cash paid out or moved by hand. If there is
     no open shift the figure is left off the bar rather than shown as zero;
     a wrong number on a till is worse than no number. */
  const refreshDrawer = () =>
    api.get("/shifts/preview")
      .then((d) => setDrawerTotal(d && d.expected_cash != null ? Number(d.expected_cash) : null))
      .catch(() => setDrawerTotal(null));

  const goDash = () => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "dashboard" } }));
  const signOut = () => { clearSession(); window.location.reload(); };

  /* The lists themselves, once. Small, and it decides what the picker offers. */
  useEffect(() => {
    api.get("/settings/price-lists").then(setPriceLists).catch(() => setPriceLists([]));
  }, []);

  /* Special rates follow the customer and are not overridable — they are an
     agreement with that person, not a price band.

     The list is two values, deliberately. `partyList` is whatever the customer
     is on; `listOverride` is null until somebody picks from the box, and naming a
     new customer clears it. Collapsing them into one would force a choice
     between two wrong behaviours: either a hand-picked Wholesale silently
     survives onto the next customer's bill, or naming the customer throws the
     cashier's choice away mid-sale. */
  useEffect(() => {
    setPartyRates({}); setPartyList(0); setListOverride(null);
    if (!partyId) return;
    api.get(`/parties/${partyId}/rates`)
      .then((rs) => setPartyRates(Object.fromEntries(rs.map((r) => [r.item_id, r.rate])))).catch(() => {});
    api.get(`/parties/${partyId}`).then((p) => setPartyList(p.price_list_id || 0)).catch(() => {});
  }, [partyId]);

  /* Whichever list is in force — chosen or inherited — loads its prices here.
     One effect for both, so the name on screen and the prices being charged
     can never come from different lists. */
  useEffect(() => {
    if (!listId) { setListPrices({}); setListName(""); return; }
    const l = priceLists.find((x) => x.id === listId);
    setListName(l ? l.name : "");
    api.get(`/settings/price-lists/${listId}/items`)
      .then((rows) => setListPrices(Object.fromEntries(rows.map((r) => [r.item_id, r.price]))))
      .catch(() => setListPrices({}));
  }, [listId, priceLists]);

  const priceFor = (it) => partyRates[it.id] ?? listPrices[it.id] ?? it.sale_price;
  const walkIn = parties.find((p) => p.id === Number(partyId))?.name === "Cash Sale";

  /* ── search ── */
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return items.filter((i) => {
      if (cat && i.category_name !== cat) return false;
      const bcs = (i.barcodes || []).map((b) => String(b).toLowerCase());
      if (mode === "name") return i.name.toLowerCase().includes(t);
      if (mode === "code") return (i.item_code || "").toLowerCase() === t;
      if (mode === "barcode") return bcs.includes(t);
      return i.name.toLowerCase().includes(t) || (i.item_code || "").toLowerCase().includes(t) || bcs.includes(t);
    }).slice(0, 8);
  }, [q, items, mode]);

  const cycleMode = () => setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]);
  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category_name).filter(Boolean));
    return [...set].sort();
  }, [items]);

  /* ── lines ── */
  const add = (it) => {
    const guardStock = settings.prevent_negative_stock !== "0" && it.is_inventory === 1;
    setLines((ls) => {
      const dq = Number(it.default_qty) || 1;
      const ix = ls.findIndex((l) => l.item_id === it.id && !l.use_secondary);
      if (ix >= 0) {
        if (guardStock && ls[ix].quantity + dq > it.on_hand) { toast(`Only ${dualQty(it.on_hand, it.unit, it.secondary_unit, it.conversion_rate)} in stock`, "bad"); return ls; }
        return ls.map((l, j) => (j === ix ? { ...l, quantity: Number(l.quantity) + dq } : l));
      }
      if (guardStock && it.on_hand < dq) { toast(`"${it.name}" is out of stock`, "bad"); return ls; }
      return [...ls, {
        item_id: it.id, description: it.name, quantity: dq, rate: priceFor(it),
        unit: it.unit, base_unit: it.unit, secondary_unit: it.secondary_unit,
        conversion_rate: it.conversion_rate, secondary_price: it.secondary_price || 0, use_secondary: false,
        disc: 0, locked: it.price_change_allowed === 0, cost: it.purchase_price,
        on_hand: it.on_hand, is_inventory: it.is_inventory,
      }];
    });
    setQ(""); setSel(lines.length);
    searchRef.current?.focus();
  };

  const upd = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  /* Always-current view of the cart, for handlers that fire from events which
     may have already changed it. */
  const linesRef = useRef(lines);
  useEffect(() => { linesRef.current = lines; }, [lines]);

  /* Rounding helpers — money to 2dp, quantity to 3dp, so a conversion never
     leaves 0.30000000000000004 sitting in a cell. */
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

  /* INVARIANT: `quantity` and `rate` are always expressed in the line's CURRENT
     unit (l.unit). Flipping the unit converts both together, so qty × rate —
     the amount the customer pays — never changes. Nothing else may convert
     them; the engine multiplies them as-is.
     Returns false when the quantity was refused, so a live cell can roll its
     draft back instead of displaying a figure the bill does not contain. */
  const setQty = (i, v) => {
    const l = lines[i]; if (!l) return false;
    const q = Math.max(0.001, r3(Number(v) || 0));
    const cr = Number(l.conversion_rate) || 0;
    const base = l.use_secondary && cr > 0 ? q / cr : q;      // stock is held in base units
    if (settings.prevent_negative_stock !== "0" && l.is_inventory === 1 && base > l.on_hand) {
      toast(`Only ${dualQty(l.on_hand, l.base_unit, l.secondary_unit, l.conversion_rate)} available — blocked by Settings`, "bad");
      return false;
    }
    upd(i, { quantity: q });
    return true;
  };

  /* BUGFIX: this used to write `typed × conversion_rate` back into l.rate — the
     very field the cell displays. So on a flipped (secondary-unit) line every
     edit re-multiplied the previous result: type 100 → 5,000 → 250,000. The
     typed value IS the rate for the current unit; store it as typed. */
  const setRate = (i, v) => {
    const l = lines[i]; if (!l || l.locked) return;
    const nv = Math.max(0, r2(Number(v) || 0));
    const cr = Number(l.conversion_rate) || 0;
    // cost is stored per BASE unit — scale it before comparing, or a per-kg
    // price is always "below" a per-bag cost and the warning fires wrongly.
    const costHere = l.use_secondary && cr > 0 ? (Number(l.cost) || 0) / cr : Number(l.cost) || 0;
    if (settings.prevent_below_cost !== "0" && costHere > 0 && nv < costHere) {
      toast(`Below cost (${cur()} ${inr(r2(costHere))} per ${l.unit}) — will need a manager override`, "bad");
    }
    // A manual price while flipped supersedes the remembered base rate, so
    // flipping back derives from what was actually typed.
    upd(i, l.use_secondary ? { rate: nv, base_rate: null } : { rate: nv });
  };

  const flip = (i) => {
    /* Read the line from the latest state: a click on the unit chip can land
       after a blur that has just changed this same line. */
    const l = linesRef.current[i];
    const cr = Number(l && l.conversion_rate) || 0;
    if (!l || !l.secondary_unit || cr <= 0) return;
    if (!l.use_secondary) {
      // base → secondary: price per unit falls by the factor, quantity rises by it
      const secRate = Number(l.secondary_price) > 0 ? Number(l.secondary_price) : Number(l.rate) / cr;
      upd(i, {
        use_secondary: true, unit: l.secondary_unit, base_rate: Number(l.rate) || 0,
        rate: r2(secRate), quantity: r3((Number(l.quantity) || 0) * cr),
      });
    } else {
      const baseRate = l.base_rate != null ? Number(l.base_rate) : Number(l.rate) * cr;
      upd(i, {
        use_secondary: false, unit: l.base_unit, base_rate: null,
        rate: r2(baseRate), quantity: Math.max(0.001, r3((Number(l.quantity) || 0) / cr)),
      });
    }
  };

  /* ── totals via the real engine ──
     Secondary-unit lines keep their displayed rate × qty (amount is already correct);
     no back-conversion, so a custom secondary_price is honoured exactly. */
  const engineLines = useMemo(() => lines.map((l) => ({
    ...l,
    discount_pct: (Number(l.disc) || 0) + (Number(billDisc) || 0),
  })), [lines, billDisc]);
  /* Shared with every other document screen, and mirrors the server. This also
     drops rules switched off in Settings — the endpoint returns them all, so
     the till used to charge tax the saved invoice didn't have. */
  const effRules = useMemo(
    () => effectiveRules({ rules, settings, doc: "pos", paymentType: pay }),
    [rules, settings, pay]);
  const taxActive = effRules.length > 0;
  const calc = useMemo(() => computeInvoice({ lines: engineLines, rules: effRules, roundOff: true, roundTo: Number(settings.cash_round_to) || 1, pricesIncludeTax: settings.tax_inclusive_default === "1" }), [engineLines, effRules, settings.cash_round_to, settings.tax_inclusive_default]);
  const lineTotal = (ix) => (calc.lines[ix] ? calc.lines[ix].line_total : 0);
  const change = Math.max(0, (Number(received) || 0) - calc.grand_total);

  const voidLine = async (i, reason) => {
    const l = lines[i];
    if (!l) return;
    if (settings.require_void_reason !== "0" && !reason) { setSel(i); setDlg("void-item"); return; }
    try {
      await api.post("/pos/void", { scope: "item", item_name: l.description, quantity: l.quantity, amount: lineTotal(i), reason: reason || null });
    } catch {}
    const removed = l;
    setLines((ls) => ls.filter((_, j) => j !== i)); setSel(-1); setDlg(null);
    toastUndo(`${removed.description} voided`, () => {
      setLines((ls) => { const copy = [...ls]; copy.splice(Math.min(i, copy.length), 0, removed); return copy; });
      toast("Put back on the bill");
    });
  };

  /* ── hold / resume / lock ── */
  const holdBill = async (lock) => {
    if (!lines.length) return toast("Nothing to hold", "bad");
    const party = parties.find((p) => p.id === Number(partyId));
    await api.post("/pos/held", {
      label: `${lock ? "🔒 " : ""}${party ? party.name : "Bill"}`,
      total_hint: calc.grand_total,
      payload: { party_id: Number(partyId), lines, billDisc, pay },
    });
    if (lock) {
      const list = await api.get("/pos/held");
      if (list[0]) await api.put(`/pos/held/${list[0].id}/lock`, { locked: 1 });
    }
    newBill(); loadHeld();
    toast(lock ? "Bill locked — a user with edit rights must unlock it" : "Bill held (F8) — resume from the strip above");
  };
  const resume = async (h) => {
    if (h.locked) { setUnlockTarget(h); setDlg("unlock"); return; }
    try {
      const full = await api.get(`/pos/held/${h.id}`);
      setLines(full.payload.lines || []);
      setPartyId(String(full.payload.party_id || partyId));
      setBillDisc(full.payload.billDisc || 0);
      setPay(full.payload.pay || "cash");
      await api.delete(`/pos/held/${h.id}`);
      loadHeld();
      toast(`Resumed: ${h.label || "held bill"}`);
    } catch (e) { toast(e.message, "bad"); }
  };
  const unlock = async () => {
    try {
      await api.put(`/pos/held/${unlockTarget.id}/lock`, { locked: 0 });
      setDlg(null); loadHeld();
      toast("Unlocked — click it again to resume");
    } catch (e) { toast(e.message, "bad"); }
  };

  /* Keep the in-progress bill on disk so it survives a reload, crash or power
     cut. Held back until the saved bill already there has been answered for —
     an empty till on first paint would otherwise delete the very offer the
     dialog is about before the cashier has read it. */
  useEffect(() => {
    /* `done` means the bill on screen has been paid for and is now an invoice.
       Writing it back to disk would offer a paid sale up for "resume". */
    if (!recoveryDone || done) return;
    try {
      const u = currentUser() || {};
      if (lines.length) {
        localStorage.setItem(CART_KEY, JSON.stringify({
          lines, billDisc, pay, at: Date.now(),
          /* Stamped so the resume prompt can say whose bill this is. */
          by: u.id ?? null, byName: u.full_name || u.username || null,
        }));
      } else clearSavedCart();
    } catch {}
  }, [recoveryDone, done, lines, billDisc, pay]);

  /* Resume: the cashier looked at the lines and said yes, this is mine. */
  const resumeSaved = () => {
    if (!recovery) return;
    setLines(recovery.lines);
    setBillDisc(Number(recovery.billDisc) || 0);
    if (recovery.pay) setPay(recovery.pay);
    setRecovery(null); setRecoveryDone(true);
    toast(`Resumed ${plural(recovery.lines.length, "item")} from the unfinished bill`);
    searchRef.current?.focus();
  };
  /* Discard: the bill and its idempotency reference go together. Leaving the
     reference behind would make the next, unrelated sale a "retry" of the
     abandoned one, and the server would answer it with the wrong invoice. */
  const discardSaved = () => {
    clearSavedCart(); clearSaleRef();
    setRecovery(null); setRecoveryDone(true);
    searchRef.current?.focus();
  };

  /* A new bill is a new sale, so it gets a new reference. Called after a sale
     completes and whenever the cashier clears the till by hand. */
  const newBill = () => { clearSavedCart(); clearSaleRef(); setLines([]); setBillDisc(0); setReceived(""); setQ(""); setSel(-1); setPayScr(false); searchRef.current?.focus(); };

  /* ── save ── */
  const save = async (andPrint, override = false) => {
    if (!lines.length) return toast("Scan or search an item first", "bad");
    if (pay === "credit" && walkIn) return toast("Credit sales need a saved customer — pick one [F11]", "bad");
    if (settings.require_sales_rep !== "0" && !salesRep) return toast("Choose a sales rep before saving", "bad");
    setBusy(true);
    setSaveErr(null);
    const attemptAt = Date.now();
    /* The same reference on every try at this bill — see saleRef() above. */
    const ref = saleRef();
    try {
      const r = await api.post("/sales", {
        client_ref: ref,
        party_id: Number(partyId),
        sales_rep_id: salesRep ? Number(salesRep) : undefined,
        payment_type: pay === "credit" ? "credit" : "cash",
        payment_mode: pay === "credit" ? "cash" : pay,
        /* The account this money lands in. Without it the server falls back to
           Cash in Hand, which is how every card and MoMo sale this till ever
           took ended up in the drawer's balance. */
        cash_account_code: cashCode || undefined,
        source: "pos",
        paid_amount: pay === "credit" ? Number(received) || 0 : calc.grand_total,
        manager_override: override || undefined,
        lines: lines.map((l, ix) => ({
          item_id: l.item_id, description: l.description,
          quantity: Number(engineLines[ix].quantity),
          rate: engineLines[ix].rate,
          discount_pct: engineLines[ix].discount_pct,
          unit: l.unit, use_secondary: l.use_secondary,
        })),
      });
      if (cashCode) rememberAccount(cashCode);
      const who = parties.find((p) => p.id === Number(partyId));
      const doPrint = async () => {
        const full = await api.get(`/sales/${r.id}`);
        printInvoice(full, who ? who.name : "Cash Sale", "pos");
      };
      /* "Confirm & print" is an instruction, not a question — rule 3 in
         printprompt.jsx. Plain "Confirm" is the path that used to end a sale
         with no paper and no offer of any, which is the whole reason this
         feature exists. */
      if (andPrint) await doPrint();
      else await askToPrint({
        noun: "receipt", number: r.invoice_no,
        detail: `${who ? who.name : "Cash Sale"} · ${cur()} ${inr(r.totals.grand_total)}`,
        print: doPrint,
      });

      const tendered = pay === "credit" ? Number(received) || 0 : Math.max(Number(received) || 0, r.totals.grand_total);
      setDone({
        invoice_no: r.invoice_no, id: r.id,
        party: who ? who.name : "Cash Sale",
        phone: who ? who.phone : null,
        credit: pay === "credit",
        modeName: { cash: "Cash", mobile: "Mobile Money", card: "Card", credit: "On account" }[pay] || pay,
        total: r.totals.grand_total,
        subtotal: calc.gross_total, discount: calc.discount_total, tax: calc.tax_total,
        tendered,
        change: Math.max(0, tendered - r.totals.grand_total),
        lines: lines.map((l, ix) => ({
          description: l.description, quantity: engineLines[ix].quantity,
          amount: Number(l.rate) * Number(l.quantity) * (1 - (Number(l.disc) || 0) / 100),
        })),
        when: new Date().toLocaleString(),
        servedBy: (users.find((u) => String(u.id) === String(salesRep)) || currentUser() || {}).full_name
          || (currentUser() || {}).username || "—",
        onReprint: doPrint,
        onWhatsApp: () => {
          if (!who || !who.phone) return;
          const msg = `*${r.invoice_no}*%0a${cur()} ${inr(r.totals.grand_total)}%0aThank you for your custom.`;
          window.open(`https://wa.me/${String(who.phone).replace(/\D/g, "").replace(/^0/, "256")}?text=${msg}`, "_blank");
        },
      });
      setPayScr(false);
      setSaveErr(null);
      /* This sale is on the books. The next attempt is a different sale and
         must not reuse this reference, or the server would answer it with this
         invoice. Retire the key here rather than waiting for newBill(), which
         only runs when the operator leaves the completion screen. */
      clearSaleRef();
      /* And the copy on disk goes with it. `lines` is still on screen behind
         the completion slip, so without this the sold bill sat in localStorage
         until the operator pressed Next sale — and a machine switched off at
         the completion screen would offer that already-paid bill to whoever
         opened the till next. */
      clearSavedCart();
      api.get("/items").then((x) => setItems(x.filter((i) => i.is_active !== 0))).catch(() => {});
    } catch (e) {
      if (/Below cost/.test(e.message) && await confirmDialog({ title: "Below cost price", message: e.message, detail: "Approve a one-time manager override? This is recorded in the audit log.", confirmLabel: "Approve override", danger: true })) {
        setBusy(false); return save(andPrint, true);
      }
      /* A toast is gone in three seconds and the cashier was looking at the
         customer, not the screen. The bill is still on the till and still on
         disk; what was missing was anything on screen that said so. */
      setSaveErr({
        message: e.message || "The sale was not saved",
        /* Ambiguous means the request left the browser and no answer came
           back: the server may or may not have posted it. Pressing save again
           can bill the customer twice, so that path is checked, not repeated. */
        ambiguous: !!e.ambiguous,
        total: calc.grand_total,
        at: attemptAt,
        /* The reference this attempt carried. The check below asks the server
           about this exact value, so it is an answer rather than a guess. */
        ref,
        andPrint,
      });
      toast(e.message, "bad");
    }
    setBusy(false);
  };

  /* ── after an ambiguous failure ──
     There is no idempotency key on POST /sales (see the note in
     e2e/specs/resilience.spec.mjs), so the only honest thing the till can do
     is look before it leaps: read back the recent invoices and see whether the
     one we were trying to post is already there. It matches on customer,
     total and the fact that it appeared after we pressed the button. That is
     a reconciliation, not a guarantee — if it finds nothing it says so and
     leaves the decision to the operator rather than quietly posting again. */
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    if (!saveErr) return;
    setChecking(true);
    try {
      const res = await api.get("/sales?limit=20");
      const rows = Array.isArray(res) ? res : (res && res.rows) || [];
      const wantParty = Number(partyId);
      const hit = rows.find((row) => {
        if (Math.abs(Number(row.grand_total) - Number(saveErr.total)) > 0.5) return false;
        if (wantParty && Number(row.party_id) !== wantParty) return false;
        if (String(row.status || "") === "voided") return false;
        /* Selling the same thing to two walk-in customers a minute apart is
           an ordinary morning, so customer-and-amount alone would call the
           previous sale a duplicate of this one. The high-water mark taken
           when the payment screen opened settles it: only a document numbered
           above what already existed can be the one we just tried to post.
           Timestamps are the fallback, and a loose one — SQLite stamps
           `datetime('now')` in UTC with no zone marker, which a browser reads
           as local time, so both readings are allowed. */
        if (Number.isFinite(saveErr.sinceId)) return Number(row.id) > saveErr.sinceId;
        const stamp = String(row.created_at || row.updated_at || "").trim();
        if (!stamp) return true;
        const iso = stamp.replace(" ", "T");
        const cands = [Date.parse(iso), Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`)]
          .filter((n) => Number.isFinite(n));
        return !cands.length || cands.some((w) => w >= saveErr.at - 120000);
      });
      if (hit) {
        setSaveErr({
          ...saveErr, ambiguous: false, resolved: hit,
          message: `It did save — ${hit.invoice_no}. Do not save it again.`,
        });
      } else {
        setSaveErr({ ...saveErr, ambiguous: false, checked: true,
          message: "No matching sale reached the server — it is safe to save again." });
      }
    } catch (e) {
      toast(e.message, "bad");
    }
    setChecking(false);
  };

  /* Finish a sale that turned out to have been saved after all: print it if
     they want the paper, then clear the till so the next customer can be served. */
  const finishResolved = async (print) => {
    const hit = saveErr && saveErr.resolved;
    if (!hit) return;
    if (print) {
      try {
        const full = await api.get(`/sales/${hit.id}`);
        const who = parties.find((p) => p.id === Number(partyId));
        printInvoice(full, who ? who.name : "Cash Sale", "pos");
      } catch (e) { toast(e.message, "bad"); return; }
    }
    setSaveErr(null);
    newBill();
  };

  const heldCountRef = useRef(0);

  /* ── multi-till sync ──
     Another till selling the last unit shouldn't be a surprise at checkout.
     Poll stock + held bills so this screen reflects what the shop actually has. */
  const warnedRef = useRef(new Set());
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await api.get("/pos/sync");
        if (!alive) return;
        const map = new Map(d.stock.map((r) => [r.id, r.on_hand]));
        setItems((prev) => prev.map((i) => (map.has(i.id) ? { ...i, on_hand: map.get(i.id) } : i)));
        if (d.held !== heldCountRef.current) { heldCountRef.current = d.held; loadHeld(); }
        // warn once per item if the bill now exceeds what's actually in stock
        setLines((ls) => {
          ls.forEach((l) => {
            if (!l.item_id || !l.is_inventory) return;
            const live = map.get(l.item_id);
            if (live == null) return;
            const need = l.use_secondary && l.conversion_rate > 0 ? l.quantity / l.conversion_rate : l.quantity;
            if (need > live && !warnedRef.current.has(l.item_id)) {
              warnedRef.current.add(l.item_id);
              toast(`Another till sold ${l.description} — only ${live} left`, "bad");
            }
          });
          return ls;
        });
      } catch {}
    };
    const iv = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  /* ── global barcode capture ──
     Barcode scanners "type" a burst of characters then press Enter. We buffer any
     fast burst that arrives while the cashier isn't in a text field, so scanning
     works no matter where focus happens to be. */
  const scanBuf = useRef({ chars: "", last: 0 });
  useEffect(() => {
    const onKey = (e) => {
      /* A scanner burst must not land in a bill nobody has claimed yet. */
      if (payScr || dlg || recovery) return;
      const t = e.target;
      const typingElsewhere = t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
        (t.tagName === "INPUT" && t !== searchRef.current));
      if (typingElsewhere) return;

      const now = Date.now();
      const b = scanBuf.current;
      if (now - b.last > 120) b.chars = "";   // human-speed gap: start fresh
      b.last = now;

      if (e.key === "Enter") {
        const code = b.chars.trim();
        b.chars = "";
        if (code.length >= 3) {
          const hit = items.find((i) =>
            (i.barcode && String(i.barcode) === code) ||
            (i.barcodes || []).some((c) => String(c) === code) ||
            (i.item_code && String(i.item_code).toLowerCase() === code.toLowerCase()));
          if (hit) { e.preventDefault(); add(hit); setQ(""); toast(`${hit.name} — scanned`); }
        }
        return;
      }
      if (e.key.length === 1) b.chars += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, payScr, dlg, recovery]);

  /* ── keyboard ── */
  useEffect(() => {
    const h = (e) => {
      if (payScr) return;
      /* F12 saves and F10 pays. Neither may fire behind the unfinished-sale
         prompt, which is the one moment the till's own state is not yet the
         cashier's answer. */
      if (recovery) return;
      if (dlg) { if (e.key === "Escape") setDlg(null); return; }
      if (e.key === "F1") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "F2") { e.preventDefault(); setDlg("disc"); }
      else if (e.key === "F3") { e.preventDefault(); setDlg("quickitem"); }
      else if (e.key === "F4") { e.preventDefault(); repRef.current?.focus(); }
      else if (e.key === "Delete" && sel >= 0) { e.preventDefault(); voidLine(sel); }
      else if (e.key === "F6" && lines.length) { e.preventDefault(); flip(sel >= 0 ? sel : lines.length - 1); }
      else if (e.key === "F8") { e.preventDefault(); holdBill(false); }
      else if (e.key === "F10") { e.preventDefault(); if (lines.length) setPayScr(true); }
      else if (e.key === "F11") {
        e.preventDefault();
        /* The Credit button refuses a walk-in sale; the shortcut must refuse
           it too, or the two paths disagree and the till only finds out at
           the server, after the cashier has finished ringing it up. */
        if (walkIn) { setDlg("cust"); toast("Credit needs a saved customer — pick one", "bad"); return; }
        setPay("credit"); if (lines.length) setPayScr(true);
      }
      else if (e.key === "F12") { e.preventDefault(); setPay("cash"); save(true); }
      else if (e.ctrlKey && e.key.toLowerCase() === "t") { e.preventDefault(); cycleMode(); searchRef.current?.focus(); }
      else if (e.ctrlKey && e.key.toLowerCase() === "p") { e.preventDefault(); if (lines.length) setPayScr(true); }
      else if (e.key === "ArrowDown" && lines.length) { e.preventDefault(); setSel((i) => Math.min((i < 0 ? -1 : i) + 1, lines.length - 1)); }
      else if (e.key === "ArrowUp" && lines.length) { e.preventDefault(); setSel((i) => Math.max((i < 0 ? lines.length : i) - 1, 0)); }
      else if (e.key === "?" && !q) { e.preventDefault(); setDlg("keys"); }
      else if (e.key === "Escape") { setQ(""); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const hint = mode === "name" ? "Filters as you type" :
    mode === "all" ? "Ctrl+T switches mode · Enter adds top match" : "Exact match — Enter (scanner does it)";

  const cartCount = lines.length;
  const me = currentUser() || {};
  const repRequired = settings.require_sales_rep !== "0";
  const qtyCount = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
  const party = parties.find((p) => p.id === Number(partyId));
  const partyInitials = String(party ? party.name : "Cash")
    .trim().split(/\s+/).slice(0, 2).filter(Boolean).map((w) => w[0].toUpperCase()).join("");

  /* ── Done ── */
  if (done) return <DoneScreen d={done} firm={firm} onNext={() => { setDone(null); newBill(); searchRef.current?.focus(); }} onClose={goDash} />;

  /* ── Payment ── */
  if (payScr) {
    return (
      <div className="dk-till">
        <TillTop firm={firm} online={online} drawer={drawerTotal} onClose={goDash} onAdmin={() => setAdminOpen(true)} />
        <PayScreen
          calc={calc} lines={lines} parties={parties} partyId={partyId} setPartyId={setPartyId}
          walkIn={walkIn} pay={pay} setPay={setPay} received={received} setReceived={setReceived}
          taxActive={taxActive}
          users={users} salesRep={salesRep} setSalesRep={setSalesRep}
          repRequired={settings.require_sales_rep !== "0"}
          cashAccounts={cashAccounts} cashCode={cashCode}
          setCashCode={(c) => { setCashTouched(true); setCashCode(c); }}
          busy={busy} onConfirm={(print) => save(print)} onBack={() => setPayScr(false)}
          saveErr={saveErr} checking={checking} onRecheck={recheck}
          onFinishResolved={finishResolved} onDismissErr={() => setSaveErr(null)}
          reloadParties={async () => { const p = await api.get("/parties"); setParties(p); return p; }}
        />
      </div>
    );
  }

  /* ── Cart ── */
  return (
    <div className="dk-till">
      <TillTop firm={firm} online={online} drawer={drawerTotal} onClose={goDash} onAdmin={() => setAdminOpen(true)} />

      <div className="dk-till-body cart">
        <div className="dk-till-left">
          <div className="dk-scan">
            <span className="mark">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                <path d="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14" /><path d="M20 20l-3.5-3.5" />
              </svg>
            </span>
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder={mode === "barcode" ? "Scan or type a barcode, then Enter…"
                     : mode === "code" ? "Type an item code, then Enter…"
                     : "Scan barcode or type an item name…"}
                   onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) add(matches[0]); }} />
            {/* Which prices this bill is ringing up at, beside the box that
                rings them up. Pills rather than a dropdown: the one in force
                is lit, the rest are plainly not, so the answer is on screen
                instead of one click inside a <select>. Hidden when the shop
                keeps no lists — a picker with one answer is not a question. */}
            {priceLists.length > 0 && (
              <div className="dk-pricepick" role="group" aria-label="Price list for this sale">
                <span className="cap">Prices</span>
                <button className={`pl ${!listId ? "on" : ""}`}
                        aria-pressed={!listId}
                        onClick={() => setListOverride(0)}>Ordinary</button>
                {priceLists.map((l) => (
                  <button key={l.id} className={`pl ${listId === l.id ? "on" : ""}`}
                          aria-pressed={listId === l.id}
                          onClick={() => setListOverride(l.id)}>{l.name}</button>
                ))}
                {/* Lines already rung up keep the price they were rung at. A
                    cashier who has hand-corrected two of five prices should
                    not lose that work because the sixth needed another band. */}
                {lines.length > 0 && <span className="note">applies from here on</span>}
              </div>
            )}

            <span className="hint">F1 focus · Enter adds top match · Ctrl+T mode</span>

            {q.trim().length > 1 && matches.length === 0 && (
              <div className="dk-suggest">
                <button className="hot" onClick={() => setDlg("quickitem")}>
                  <span className="av" style={{ background: "var(--warnc)" }}>+</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="nm">No item matches “{q}”<span className="kbd">F3</span></span>
                    <div className="st">Add it now without leaving this sale</div>
                  </span>
                </button>
              </div>
            )}
            {matches.length > 0 && (
              <div className="dk-suggest dk-s">
                {matches.map((m, ix) => (
                  <button key={m.id} className={ix === 0 ? "hot" : ""} onClick={() => add(m)}>
                    <span className="av" style={{ background: m.color || "#3A4763" }}>{m.name[0].toUpperCase()}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="nm">{m.name}{ix === 0 && <span className="kbd">Enter ↵</span>}</span>
                      <div className="st">
                        {m.item_code || `#${m.id}`}
                        {m.price_change_allowed === 0 ? " · fixed price" : ""}
                        {" · "}{dualQty(m.on_hand, m.unit, m.secondary_unit, m.conversion_rate)} in stock
                      </div>
                    </span>
                    <span className="pr dk-n">{cur()} {inr(priceFor(m))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="dk-cats">
            <button className={`dk-cat ${cat === "" ? "on" : ""}`} onClick={() => setCat("")}>All</button>
            {categories.map((c) => (
              <button key={c} className={`dk-cat ${cat === c ? "on" : ""}`} onClick={() => setCat(cat === c ? "" : c)}>{c}</button>
            ))}
            <div style={{ flex: 1 }} />
            {held.length > 0 && (
              <button className="dk-cat hold" onClick={() => setDlg("held")}>
                ⏸ {held.length} bill{held.length === 1 ? "" : "s"} on hold
              </button>
            )}
          </div>

          <div className="dk-cart dk-s">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="r" style={{ width: 110 }}>Qty</th>
                  <th className="r" style={{ width: 116 }}>Unit</th>
                  <th className="r" style={{ width: 150 }}>Price</th>
                  <th className="r" style={{ width: 170 }}>Amount</th>
                  <th style={{ width: 52 }} />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: "center", padding: "70px 20px", color: "var(--faint)" }}>
                    <b style={{ display: "block", fontSize: 16, color: "var(--soft)", marginBottom: 6 }}>No items yet</b>
                    Scan a barcode, or search by name or code and press Enter.
                  </td></tr>
                ) : lines.map((l, i) => (
                  <CartRow key={i} l={l} i={i} sel={sel} setSel={setSel}
                           total={lineTotal(i)} onQty={(n) => setQty(i, n)} onRate={(n) => setRate(i, n)}
                           onFlip={() => flip(i)} onVoid={() => voidLine(i)} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="dk-fkeys">
            <span className="dk-fkey"><b>F2</b> Discount</span>
            <span className="dk-fkey"><b>F4</b> Sales rep</span>
            <span className="dk-fkey"><b>F6</b> Change unit</span>
            <span className="dk-fkey"><b>F8</b> Hold bill</span>
            <span className="dk-fkey"><b>F11</b> Customer</span>
            <span className="dk-fkey"><b>Del</b> Void line</span>
            <span className="dk-fkey"><b>Ctrl+P</b> Save &amp; print</span>
          </div>
        </div>

        <div className="dk-till-right">
          <div className="dk-cust">
            <span className="av">{partyInitials || "CS"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="nm">{party ? party.name : "Cash Sale"}</div>
              <div className="sub">
                {[listName ? `${listName} price list` : null,
                  party && Math.abs(party.balance) > 0.005
                    ? `${party.balance > 0 ? "owes" : "in credit"} ${cur()} ${inr(Math.abs(party.balance))}`
                    : "no balance"].filter(Boolean).join(" · ")}
              </div>
            </div>
            <button className="dk-linkbtn" onClick={() => setDlg("cust")}>Change</button>
          </div>

          {/* The price-list switch used to sit here, as a <select> in the
              right-hand column under the customer. It is on the search row now
              (see .dk-pricepick): which prices you are ringing at governs
              every item you are about to add, so it belongs beside the box you
              add items with — and a dropdown hid the answer to "which list am
              I on?" behind a click. */}

          {/* Who the sale is credited to.
              Every sale_invoices row already carries sales_rep_id, and the
              per-person reports (Sales by user, Profit by user, Staff) group
              on it — but the only place to set it was the payment screen, and
              only when require_sales_rep was on. Shops with the setting off
              therefore had every sale credited to whoever was signed in, which
              on a shared till is one name for the whole shop's takings, and
              commission worked out from that is wrong for everybody.
              It sits on the cart, before payment, because that is when the
              cashier knows which of the floor staff served the customer.
              F4 focuses it; a <select> then takes arrow keys and letters, so
              the till never needs the mouse for this. */}
          <div className="pos-rep">
            <span className="l">Sold by</span>
            <select ref={repRef} className="pos-rep-sel" value={salesRep} aria-label="Sales rep for this sale"
                    onChange={(e) => setSalesRep(e.target.value)}>
              <option value="">{repRequired ? "Choose\u2026" : "Not attributed"}</option>
              {/* The signed-in user may not be in /users/reps (an admin, say).
                  Without this the field would silently read blank and the sale
                  would go up unattributed. */}
              {me.id != null && !users.some((u) => String(u.id) === String(me.id)) && (
                <option value={String(me.id)}>{me.full_name || me.username}</option>
              )}
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
            </select>
            <span className="k">F4</span>
          </div>

          <div style={{ flex: 1, minHeight: 0 }} />

          <div className="dk-totals">
            <div className="ln dk-n"><span>{cartCount} item{cartCount === 1 ? "" : "s"} · {+qtyCount.toFixed(3)} qty</span><span /></div>
            <div className="ln dk-n"><span>Subtotal</span><b>{inr(calc.gross_total)}</b></div>
            {/* A discount is a deliberate reduction of what we receive, so it
                is a reversal — never green, which now means money in. */}
            {calc.discount_total > 0 && (
              <div className={`ln dk-n${taxActive ? "" : " last"}`}>
                <span>Discount</span><b className="amt-reversal">−{inr(calc.discount_total)}</b>
              </div>
            )}
            {/* Tax off in Settings means no tax row — not a row reading zero.
                `last` draws the rule above "Amount payable", so it belongs to
                whichever of these is actually the last one rendered. */}
            {taxActive && (
              <div className="ln dk-n last">
                <span>{calc.tax_total < 0 ? "Withholding tax" : "Tax"}</span>
                <b>{inr(calc.tax_total)}</b>
              </div>
            )}
            <div className="dk-payable">
              <div className="pay-l">Amount payable</div>
              {/* Rendered as "Sh34,440" while the Take payment button beside it
                 reads "Sh 34,440". The symbol and the figure are separate
                 elements, so the space has to be explicit. */}
              <div className="pay-v dk-n"><small>{cur()}</small>{" "}{inr(calc.grand_total)}</div>
            </div>
          </div>

          <div className="dk-acts3">
            <button className="dk-act" onClick={() => setDlg("disc")}>％ Discount<small>F2{billDisc ? ` · ${billDisc}%` : ""}</small></button>
            <button className="dk-act" onClick={() => holdBill(false)}>⏸ Hold<small>F8</small></button>
            <button className="dk-act danger" onClick={() => setDlg("refund")}>↩ Refund<small>past sale</small></button>
          </div>

          <button className="dk-takepay" disabled={busy || !lines.length}
                  onClick={() => (lines.length ? setPayScr(true) : toast("Scan or search an item first", "bad"))}>
            Take payment
            <small className="dk-n">{cur()} {inr(calc.grand_total)} · Ctrl+P</small>
          </button>
        </div>
      </div>

      {/* No Escape hatch on purpose. The two ways out are the two answers, and
          a dismissal that quietly left the bill on disk would only hand the
          same trap to the next person to open this till. */}
      {recovery && (
        <Modal title="There is an unfinished sale on this till" onClose={() => {}}>
          <RecoveryOffer saved={recovery} onResume={resumeSaved} onDiscard={discardSaved} />
        </Modal>
      )}

      {dlg === "held" && (
        <Modal title={`${held.length} bill${held.length === 1 ? "" : "s"} on hold`} onClose={() => setDlg(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {held.map((h) => (
              <button key={h.id} className="dk-sbtn" style={{ height: 52, justifyContent: "space-between", display: "flex", alignItems: "center" }}
                      onClick={() => { setDlg(null); resume(h); }}>
                <span>{h.locked ? "🔒 " : "⏸ "}{h.label || "Bill"}</span>
                <b className="dk-n">{cur()} {inr(h.total_hint)}</b>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {dlg === "cust" && (
        <Modal title="Customer for this sale" onClose={() => setDlg(null)}>
          <PartyCombo parties={parties} value={partyId} autoFocus
                      onPick={(id) => { setPartyId(String(id)); setDlg(null); }}
                      onCreated={async () => { setParties(await api.get("/parties")); setDlg(null); }} />
        </Modal>
      )}

      {dlg === "disc" && <DiscountDlg sel={sel} lines={lines} billDisc={billDisc}
        onApply={(scope, type, val) => {
          const v = Number(val) || 0;
          if (scope === "bill") {
            setBillDisc(type === "pct" ? v : calc.sub_total > 0 ? +((v / calc.sub_total) * 100).toFixed(2) : 0);
          } else if (sel >= 0 && lines[sel]) {
            const l = lines[sel];
            const pct = type === "pct" ? v : (Number(l.rate) * Number(l.quantity)) > 0
              ? +((v / (Number(l.rate) * Number(l.quantity))) * 100).toFixed(2) : 0;
            upd(sel, { disc: pct });
          }
          setDlg(null);
        }} onClose={() => setDlg(null)} />}

      {(dlg === "void" || dlg === "void-item") && <VoidDlg scope={dlg === "void" ? "bill" : "item"}
        count={dlg === "void" ? lines.length : 1}
        onConfirm={async (reason) => {
          if (dlg === "void-item") return voidLine(sel, reason);
          try { await api.post("/pos/void", { reason, lines: lines.length }); toast("Bill voided"); newBill(); setDlg(null); }
          catch (e) { toast(e.message, "bad"); }
        }} onClose={() => setDlg(null)} />}

      {dlg === "keys" && <ShortcutsDlg onClose={() => setDlg(null)} />}
      {dlg === "quickitem" && <QuickAddItem initialName={q} onClose={() => setDlg(null)}
        onCreated={(it) => { setDlg(null); setItems((prev) => [...prev, it]); add(it); setQ(""); searchRef.current?.focus(); }} />}
      {dlg === "refund" && <RefundDlg onDone={() => { setDlg(null); api.get("/items").then((x) => setItems(x.filter((i) => i.is_active !== 0))).catch(() => {}); }} onClose={() => setDlg(null)} />}

      {adminOpen && (
        <AdminDrawer
          onClose={() => setAdminOpen(false)}
          onPick={(id) => { setAdminOpen(false); setAdminDlg(id); }}
          onDash={goDash}
          onSignOut={signOut}
        />
      )}
      {adminDlg === "cash" && <CashDlg expected={drawerTotal} onClose={() => setAdminDlg(null)}
        onDone={() => { setAdminDlg(null); refreshDrawer(); }} />}
      {adminDlg === "x" && <XReportDlg onClose={() => setAdminDlg(null)} />}
      {adminDlg === "endday" && <EndDayDlg onClose={() => setAdminDlg(null)}
        onClosed={() => { setAdminDlg(null); refreshDrawer(); }} />}
      {adminDlg === "credit" && <CreditDlg onClose={() => setAdminDlg(null)}
        onTaken={() => { refreshDrawer(); api.get("/parties").then(setParties).catch(() => {}); }} />}
      {adminDlg === "prev" && <PrevSalesDlg onClose={() => setAdminDlg(null)}
        onChanged={() => { refreshDrawer(); api.get("/items").then((x) => setItems(x.filter((i) => i.is_active !== 0))).catch(() => {}); }} />}
      {adminDlg === "find" && <FindReceiptDlg onClose={() => setAdminDlg(null)} />}

      {dlg === "unlock" && unlockTarget && (
        <Modal title={`${unlockTarget.label || "Bill"} is locked`} onClose={() => setDlg(null)}>
          <p style={{ marginTop: 0, color: "var(--faint)", fontSize: 13.5 }}>
            A locked bill can’t be changed or resumed until someone with edit rights unlocks it.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="dk-sbtn" onClick={() => setDlg(null)}>Close</button>
            <button className="dk-sbtn primary" onClick={unlock}>Unlock bill</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Till header ─────────────────────────────────────────────────────────── */
/* The till draws its own top bar and covers the app's, so the appearance
   control in the app header is unreachable from here — a cashier on a bright
   counter at 7am and a dark shop at 7pm had no way to change it without
   closing the till. This is the same switch, on the bar that is actually on
   screen. It writes the app theme, because `.dk-till` is styled from
   body[data-theme] like every other screen; the event keeps App's own copy of
   that state in step. */
function TillThemeButton() {
  const [theme, setTheme] = useState(() => localStorage.getItem("vy_app_theme") || "light");
  const flip = () => {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    localStorage.setItem("vy_app_theme", t);
    document.body.setAttribute("data-theme", t);
    window.dispatchEvent(new CustomEvent("vy-theme", { detail: { theme: t } }));
  };
  return (
    <button className="dk-tbtn icon" onClick={flip} aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
    </button>
  );
}

function TillTop({ firm, online, drawer, onClose, onAdmin }) {
  const u = currentUser();
  return (
    <div className="dk-till-top">
      <button className="dk-tbtn" onClick={onClose}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
        Close till
      </button>
      <div className="who">
        <div className="shop">{firm.name || "Till"}</div>
        <div className="sub">
          {[firm.counter || "Counter 1", u ? (u.full_name || u.username) : null].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="spacer" />
      <div className="right">
        <span className={`dk-status ${online ? "ok" : "bad"}`}>
          ● {online ? "Online" : "Offline — sales are queued"}
        </span>
        {drawer != null && <span className="dk-status dk-n">Drawer {cur()} {inr(drawer)}</span>}
        <TillThemeButton />
        {onAdmin && (
          <button className="dk-tbtn" onClick={onAdmin} aria-haspopup="dialog">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 13a4 4 0 1 0 0-8a4 4 0 0 0 0 8z" /><path d="M4 21c1.4-3.6 4.3-5.4 8-5.4s6.6 1.8 8 5.4" />
            </svg>
            Administrator
          </button>
        )}
      </div>
    </div>
  );
}

/* ── The unfinished-sale offer ─────────────────────────────────────────────
   Everything a cashier needs to say yes or no: whose bill it is, how old, what
   is on it and what it comes to. The total is spelled out because that is the
   figure the customer would have been charged if this had simply appeared in
   the cart, which is what used to happen. */
function RecoveryOffer({ saved, onResume, onDiscard }) {
  const me = currentUser() || {};
  const lines = saved.lines || [];
  const total = lines.reduce(
    (a, l) => a + Number(l.rate || 0) * Number(l.quantity || 0) * (1 - (Number(l.disc) || 0) / 100), 0);
  const when = saved.at ? new Date(saved.at) : null;
  const mine = saved.by != null && me.id != null && Number(saved.by) === Number(me.id);
  /* Same day or not is the question that actually decides it: a bill from
     yesterday is an abandoned bill, whoever started it. */
  const sameDay = when && when.toDateString() === new Date().toDateString();
  const stale = !mine || !sameDay;

  return (
    <div className="pos-recover">
      <div className={`pos-recover-who ${stale ? "stale" : ""}`}>
        {saved.byName
          ? <>Started by <b>{saved.byName}</b>{mine ? " (you)" : ""}</>
          : <>Started on this machine</>}
        {when && <> · {sameDay ? "today" : fmtDate(when.toISOString().slice(0, 10))} at {when.toTimeString().slice(0, 5)}</>}
        {stale && <div className="pos-recover-warn">
          This is not your sale from this session. If you do not recognise it, discard it —
          resuming it would charge your next customer for someone else’s items.
        </div>}
      </div>

      <div className="pos-recover-lines dk-s">
        {lines.map((l, i) => (
          <div className="pos-recover-line" key={i}>
            <span><b className="dk-n">{+Number(l.quantity).toFixed(3)} ×</b> {l.description}</span>
            <span className="dk-n">{inr(Number(l.rate || 0) * Number(l.quantity || 0) * (1 - (Number(l.disc) || 0) / 100))}</span>
          </div>
        ))}
      </div>

      <div className="pos-recover-total">
        <span>{plural(lines.length, "item")}</span>
        <b className="dk-n">{cur()} {inr(total)}</b>
      </div>

      <div className="pos-recover-acts">
        <button className="pos-recover-btn discard" autoFocus={stale} onClick={onDiscard}>
          Discard it — start an empty till
        </button>
        <button className="pos-recover-btn resume" autoFocus={!stale} onClick={onResume}>
          Resume this sale
        </button>
      </div>
    </div>
  );
}

/* ── One cart line ────────────────────────────────────────────────────────
   Quantity and price are edited in place. The unit chip opens a menu when the
   item has two units, and sits flat when it has one — a control that cannot
   do anything should not look like it can. */
function CartRow({ l, i, sel, setSel, total, onQty, onRate, onFlip, onVoid }) {
  const [menu, setMenu] = useState(false);
  const dual = !!(l.secondary_unit && Number(l.conversion_rate) > 0);
  const conv = Number(l.conversion_rate) || 0;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const low = l.is_inventory === 1 && Number(l.on_hand) <= 5;

  return (
    <tr className={i === sel ? "on" : ""} onClick={() => setSel(i)}>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="nm">{l.description}</span>
          {l.disc > 0 && <span className="dk-linebadge">−{l.disc}%</span>}
          {low && <span className="dk-linebadge warn dk-n">low {+Number(l.on_hand).toFixed(2)}</span>}
          {l.locked && <span className="dk-linebadge lock">fixed price</span>}
        </div>
        <div className="meta">
          {dual ? `1 ${l.base_unit} = ${conv} ${l.secondary_unit}` : `per ${l.unit}`}
        </div>
      </td>
      <td className="r dk-n">
        <NumCell value={l.quantity} width={66} format={(n) => String(+Number(n || 0).toFixed(3))}
                 onCommit={onQty} title="Quantity" className="dk-qtycell" live />
      </td>
      <td className="c">
        <div style={{ position: "relative", display: "flex", justifyContent: "flex-end" }}>
          <button className={`dk-unitchipbtn ${dual ? (l.use_secondary ? "live" : "") : "flat"}`}
                  onClick={(e) => { e.stopPropagation(); if (dual) setMenu((v) => !v); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title={dual ? "Sell this line in a different unit (F6)" : undefined}>
            {l.unit}{dual && <span style={{ fontSize: 10.5, opacity: .65 }}>▾</span>}
          </button>
          {menu && dual && (
            <div className="dk-unitmenu" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <div className="cap">Sell this line in</div>
              <button className={!l.use_secondary ? "on" : ""}
                      onMouseDown={(e) => { e.preventDefault(); setMenu(false); if (l.use_secondary) onFlip(); }}>
                {l.base_unit}<span className="note dk-n">whole</span>
              </button>
              <button className={l.use_secondary ? "on" : ""}
                      onMouseDown={(e) => { e.preventDefault(); setMenu(false); if (!l.use_secondary) onFlip(); }}>
                {l.secondary_unit}<span className="note dk-n">{conv} per {l.base_unit}</span>
              </button>
            </div>
          )}
        </div>
      </td>
      <td className="r dk-n rate">
        <NumCell value={l.rate} width={110} readOnly={l.locked} format={inr}
                 onCommit={onRate} title={`Price per ${l.unit}`} className="dk-qtycell" />
      </td>
      <td className="r dk-n amount">{inr(total)}</td>
      <td className="c" style={{ textAlign: "center" }}>
        <button className="dk-xbtn" title="Void this line (Del)"
                onClick={(e) => { e.stopPropagation(); onVoid(); }} aria-label={`Remove ${l.description}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

/* ── Done ─────────────────────────────────────────────────────────────────
   The receipt on the right is the same figures the printer gets, so what is
   on screen and what is in the customer's hand cannot disagree. */
function DoneScreen({ d, firm, onNext, onClose }) {
  return (
    <div className="dk-till">
      <div className="dk-till-top">
        <button className="dk-tbtn" onClick={onClose}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Close till
        </button>
        <div className="who">
          <div className="shop">{firm.name || "Till"}</div>
          <div className="sub">{d.invoice_no} saved</div>
        </div>
      </div>

      <div className="dk-till-body done">
        <div className="dk-done">
          <div className="tick">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 13l4.5 4.5L19 7" />
            </svg>
          </div>
          <div>
            <h2>{d.credit ? "Put on account" : "Paid in full"}</h2>
            <div className="sub">{d.invoice_no} · {d.party} · {d.modeName}</div>
          </div>
          <div className="figs">
            <div>
              <div className="l">Total</div>
              <div className="v dk-n">{cur()} {inr(d.total)}</div>
            </div>
            <div className="sep" />
            <div>
              <div className="l">{d.credit ? "Paid now" : "Change given"}</div>
              <div className="v dk-n amt-received">
                {cur()} {inr(d.credit ? d.tendered : d.change)}
              </div>
            </div>
          </div>
          <div className="acts">
            <button className="primary" onClick={onNext} autoFocus>Next sale · F1</button>
            <button onClick={d.onReprint}>Print again</button>
            {d.phone && <button onClick={d.onWhatsApp}>Send on WhatsApp</button>}
            <button onClick={onClose}>Close till</button>
          </div>
        </div>

        <div className="dk-receipt">
          <div className="l">Receipt preview</div>
          <div className="paper dk-s">
            <div className="mid" style={{ fontWeight: 700 }}>{(firm.name || "").toUpperCase()}</div>
            {firm.address && <div className="mid dim">{firm.address}</div>}
            {firm.gstin && <div className="mid dim">TIN {firm.gstin}</div>}
            <div className="mid dim">{d.when}</div>
            <div className="rule" />
            {d.lines.map((l, i) => (
              <div className="row" key={i}>
                <span>{+Number(l.quantity).toFixed(3)} {l.description}</span>
                <span>{inr(l.amount)}</span>
              </div>
            ))}
            <div className="rule" />
            <div className="row"><span>Subtotal</span><span>{inr(d.subtotal)}</span></div>
            {d.discount > 0 && <div className="row"><span>Discount</span><span>−{inr(d.discount)}</span></div>}
            {d.tax !== 0 && <div className="row"><span>Tax</span><span>{inr(d.tax)}</span></div>}
            <div className="row b"><span>TOTAL</span><span>{inr(d.total)}</span></div>
            <div className="row"><span>{d.modeName}</span><span>{inr(d.tendered)}</span></div>
            {!d.credit && <div className="row"><span>Change</span><span>{inr(d.change)}</span></div>}
            {d.credit && <div className="row"><span>On account</span><span>{inr(d.total - d.tendered)}</span></div>}
            <div className="rule" />
            <div className="mid dim">Served by {d.servedBy}</div>
            <div className="mid dim">Thank you — come again</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiscountDlg({ sel, lines, billDisc, onApply, onClose }) {
  const [scope, setScope] = useState("bill");
  const [type, setType] = useState("pct");
  const [val, setVal] = useState(billDisc || "");
  return (
    <Modal title="Discount [F2]" onClose={onClose}>
      <div className="dk-choice block" style={{ marginBottom: 12 }}>
        {[["bill", "Whole bill"], ["item", sel >= 0 && lines[sel] ? `Item: ${lines[sel].description}` : "Selected item"]].map(([v, label]) => (
          <button key={v} className={scope === v ? "on" : ""} onClick={() => setScope(v)}>{label}</button>
        ))}
      </div>
      <div className="dk-choice block" style={{ marginBottom: 12 }}>
        {[["pct", "Percent %"], ["amt", "Amount Sh"]].map(([v, label]) => (
          <button key={v} className={type === v ? "on" : ""} onClick={() => setType(v)}>{label}</button>
        ))}
      </div>
      <Field label={type === "pct" ? "Discount %" : "Discount amount (Sh)"}>
        <input type="number" autoFocus value={val} onChange={(e) => setVal(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && onApply(scope, type, val)}
               style={{ fontSize: 19, textAlign: "right" }} />
      </Field>
      <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Taxes recalculate <b>after</b> the discount — the WHT/VAT chain applies to the discounted amount.</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onApply(scope, type, val)}>Apply</button>
      </div>
    </Modal>
  );
}

function VoidDlg({ scope, count, onConfirm, onClose }) {
  const [reason, setReason] = useState("Customer changed mind");
  return (
    <Modal title={scope === "bill" ? "Void this bill" : "Void item"} onClose={onClose}>
      <div style={{ background: "var(--bad-bg)", border: "1px solid #EFC4C4", color: "#8C2626", borderRadius: 10, padding: "10px 13px", fontSize: 12.5, marginBottom: 12 }}>
        {scope === "bill" ? `All ${count} items will be removed. ` : ""}The void is recorded in the <b>Voided items report</b> with your name and time.
      </div>
      <Field label="Reason (required by Settings)">
        <select value={reason} onChange={(e) => setReason(e.target.value)} autoFocus>
          <option>Customer changed mind</option><option>Wrong item rung</option>
          <option>Price dispute</option><option>Training / test</option><option>Damaged at counter</option>
        </select>
      </Field>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Keep</button>
        <button className="btn" style={{ background: "var(--bad)", color: "#fff" }} onClick={() => onConfirm(reason)}>Void</button>
      </div>
    </Modal>
  );
}

function RefundDlg({ onDone, onClose }) {
  const [salesList, setSalesList] = useState([]);
  const [pick, setPick] = useState("");
  const [inv, setInv] = useState(null);
  const [checked, setChecked] = useState({});
  const [mode, setMode] = useState("cash");
  useEffect(() => { api.get("/sales").then((r) => setSalesList(r.slice(0, 30))).catch(() => {}); }, []);
  const load = async (id) => {
    setPick(id);
    if (!id) return setInv(null);
    const full = await api.get(`/sales/${id}`);
    setInv(full);
    setChecked(Object.fromEntries(full.lines.map((l) => [l.id, true])));
  };
  const selLines = inv ? inv.lines.filter((l) => checked[l.id]) : [];
  const selTotal = selLines.reduce((a, l) => a + (Number(l.line_total) || 0), 0);
  const refund = async () => {
    if (!inv || !selLines.length) return toast("Tick at least one item to refund", "bad");
    try {
      const r = await api.post("/returns/credit-notes", {
        party_id: inv.party_id, invoice_id: inv.id, refund_mode: mode,
        reason: "POS refund",
        // send the unit too — the server needs it to know whether 10 means
        // 10 KG or 10 BAGS before putting the goods back on the shelf
        lines: selLines.map((l) => ({ item_id: l.item_id, description: l.description, quantity: l.quantity, unit: l.unit, rate: l.rate })),
      });
      toast(`${r.note_no} issued · ${cur()} ${inr(r.totals.grand_total)} refunded, stock returned`);
      onDone();
      /* Cash going back across the counter is the transaction a shop most
         wants evidence of, and it was the one that produced no paper at all. */
      offerDocPrint({
        path: `/returns/credit-notes/${r.id}`, noun: "credit note", number: r.note_no,
        context: "pos", docTitle: "Credit note",
        detail: `${cur()} ${inr(r.totals.grand_total)} refunded`,
      });
    } catch (e) { toast(e.message, "bad"); }
  };
  return (
    <Modal title="Refund a completed sale" onClose={onClose} wide>
      <Field label="Find sale — invoice number">
        <select value={pick} onChange={(e) => load(e.target.value)} autoFocus>
          <option value="">Choose an invoice…</option>
          {salesList.map((s) => <option key={s.id} value={s.id}>{s.invoice_no} · {s.party_name} · {cur()} {inr(s.grand_total)} · {s.invoice_date}</option>)}
        </select>
      </Field>
      {inv && (
        <>
          {/* What is about to be reversed, spelled out before the destructive
              button: which sale, when, whose, and for how much. */}
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", margin: "8px 0 4px", display: "flex", flexWrap: "wrap", gap: "6px 22px" }}>
            <div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>INVOICE</div><b>{inv.invoice_no}</b></div>
            <div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>DATE</div><b>{fmtDate(inv.invoice_date)}</b></div>
            <div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>CUSTOMER</div><b>{inv.party_name || "Walk-in"}</b></div>
            <div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>SALE TOTAL</div><b className="num">{cur()} {inr(inv.grand_total)}</b></div>
            <div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>ITEMS</div><b>{plural(inv.lines.length, "item")}</b></div>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "4px 0 8px" }}>Untick anything the customer is keeping:</p>
          {inv.lines.map((l) => (
            <label key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 4px", borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
              <span><input type="checkbox" checked={!!checked[l.id]} onChange={(e) => setChecked({ ...checked, [l.id]: e.target.checked })} style={{ marginRight: 8 }} />
                {l.description} × {l.quantity}</span>
              <span className="num" style={{ color: checked[l.id] ? "inherit" : "#B9BFD2" }}>{cur()} {inr(l.line_total)}</span>
            </label>
          ))}
          <div className="row2" style={{ marginTop: 12 }}>
            <Field label="Refund by">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="cash">Cash — from drawer</option>
                <option value="adjust">Adjust customer balance</option>
              </select>
            </Field>
            <div style={{ alignSelf: "end", fontSize: 12.5, color: "var(--muted)", paddingBottom: 10 }}>
              Creates a credit note · items return to stock · books reverse the tax chain.
            </div>
          </div>
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 10 }}>
        {inv && <span style={{ marginRight: "auto", fontSize: 12.5, fontWeight: 500 }}>
          Refunding <b>{plural(selLines.length, "item")}</b> · <b className="num">{cur()} {inr(selTotal)}</b> back to {mode === "cash" ? "cash" : "the customer's balance"}
        </span>}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" onClick={refund} disabled={!inv || !selLines.length}>Refund{selLines.length ? ` ${cur()} ${inr(selTotal)}` : ""}</button>
      </div>
    </Modal>
  );
}


/* ── payment screen v2 (Restro): Cash / Other Modes, big amount, numpad ── */
/* ── Payment ──────────────────────────────────────────────────────────────
   Order on the left, the money on the right. The keypad is there because a
   till is often used with a touch monitor and no keyboard; the physical keys
   still work, and both write to the same field. */
function PayScreen({ calc, lines, parties, partyId, setPartyId, walkIn, pay, setPay,
                     taxActive = false,
                     cashAccounts = [], cashCode, setCashCode,
                     received, setReceived, busy, onConfirm, onBack, reloadParties,
                     users, salesRep, setSalesRep, repRequired,
                     saveErr, checking, onRecheck, onFinishResolved, onDismissErr }) {
  const [pickCust, setPickCust] = useState(false);

  const isCredit = pay === "credit";
  const recv = Number(received) || 0;
  const change = Math.max(0, recv - calc.grand_total);
  const shortBy = Math.max(0, calc.grand_total - recv);
  const party = parties.find((p) => p.id === Number(partyId));

  /* What the change row is actually saying, in money terms: on a credit sale
     the remainder is owed to us but not yet late (amber); on a cash sale a
     shortfall is money not paid (red) and change is over-tendered cash
     (green). Nothing left either way is nothing, not good news. */
  const changeAmt = isCredit ? shortBy : shortBy > 0 ? shortBy : change;
  const changeTone = isCredit ? (shortBy > 0 ? "amt-owed" : "amt-zero")
    : shortBy > 0 ? "amt-overdue"
    : change > 0 ? "amt-received" : "amt-zero";

  /* After a save whose outcome is unknown, or one that turned out to have
     gone through, pressing Confirm again would bill the customer twice. The
     way forward is the check, not the button. */
  const blocked = !!(saveErr && (saveErr.ambiguous || saveErr.resolved));

  /* The number pad is a popover on the tendered figure, not a permanent block
     of twelve buttons taking up a third of the pane. It opens when the amount
     is tapped and closes on OK, on Escape, or on a click anywhere else —
     which is how every till anybody has used behaves, and it gives the rest
     of the form the room it needed. */
  const [pad, setPad] = useState(false);
  /* Which way the pad opens. It always dropped downwards, and the tendered
     figure sits about two thirds of the way down a scrolling pane — so on a
     laptop the keys fell off the bottom of the window and the OK button was
     unreachable. Measured when it opens: below if there is room, above if
     there is not. */
  const [padUp, setPadUp] = useState(false);
  const padWrap = useRef(null);
  const padInput = useRef(null);

  useEffect(() => {
    if (!pad) return;
    /* ~330px is the pad at its tallest — input, four rows of keys, footer. */
    const PAD_H = 330;
    const r = padWrap.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom;
      setPadUp(below < PAD_H + 16 && r.top > below);
    }
    padInput.current?.focus();
    padInput.current?.select();
    const away = (e) => { if (padWrap.current && !padWrap.current.contains(e.target)) setPad(false); };
    /* mousedown, not click: a click that begins inside the pad and ends
       outside it (a drag off a key) must not count as clicking away. */
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [pad]);

  const press = (k) => {
    if (k === "C") return setReceived("");
    if (k === "⌫") return setReceived(String(received).slice(0, -1));
    /* One decimal point, and never as the first character — "..5" and "5.2.3"
       both parse to NaN, which silently becomes a zero tender. */
    if (k === ".") {
      if (!received) return setReceived("0.");
      if (String(received).includes(".")) return;
    }
    setReceived(String(received || "") + k);
  };

  useEffect(() => {
    const h = (e) => {
      if (pickCust) return;
      /* Never while the caret is in a field. This handler used to fire
         alongside the tendered input's own onChange, so a typed "5" was
         appended twice and the cashier saw 55. */
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
      if (e.key === "Escape") {
        e.preventDefault();
        /* Escape closes the pad first. Dropping straight back to the cart
           from an open pad loses the amount without saying so. */
        if (pad) return setPad(false);
        return onBack();
      }
      if (typing) {
        if (e.key === "Enter" && pad) { e.preventDefault(); setPad(false); }
        return;
      }
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); press("⌫"); }
      else if (e.key === "Enter") { e.preventDefault(); if (!busy && !blocked) onConfirm(true); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  /* Exact money first, then the notes a customer is most likely to hand over. */
  const quick = [
    { label: "Exact", v: calc.grand_total },
    { label: "5,000", v: 5000 }, { label: "10,000", v: 10000 },
    { label: "20,000", v: 20000 }, { label: "50,000", v: 50000 },
  ];

  const newBalance = party ? (Number(party.balance) || 0) + (calc.grand_total - recv) : 0;
  const overLimit = party && Number(party.credit_limit) > 0 && newBalance > Number(party.credit_limit);

  const qty = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);

  return (
    <div className="dk-till-body pay">
      <div className="dk-order">
        <div className="dk-order-head">
          <button className="dk-tbtn" onClick={onBack}>← Back to cart</button>
          <h2>Order summary</h2>
          <span className="n dk-n">{lines.length} item{lines.length === 1 ? "" : "s"} · {+qty.toFixed(3)} qty</span>
        </div>
        <div className="dk-order-body dk-s">
          {lines.map((l, i) => (
            <div className="dk-order-line" key={i}>
              <span>
                <b className="q dk-n">{+Number(l.quantity).toFixed(3)} ×</b>{l.description}
                {l.disc > 0 && <span className="dk-linebadge" style={{ marginLeft: 6 }}>−{l.disc}%</span>}
              </span>
              <span className="v dk-n">{inr(Number(l.rate) * Number(l.quantity) * (1 - (Number(l.disc) || 0) / 100))}</span>
            </div>
          ))}
          <div className="dk-order-sums">
            <div className="ln dk-n"><span>Subtotal</span><b>{inr(calc.gross_total)}</b></div>
            {/* A discount is a deliberate reduction of what we receive, so it
                is a reversal — never green, which now means money in. */}
            {calc.discount_total > 0 && (
              <div className="ln dk-n"><span>Discount</span><b className="amt-reversal">−{inr(calc.discount_total)}</b></div>
            )}
            {/* A negative total means the chain is withholding rather than adding —
                the ledger books it as "Tax Recoverable (WHT credit)", so say so
                here instead of showing a bare negative "Tax". */}
            {taxActive && (
              <div className="ln dk-n">
                <span>{calc.tax_total < 0 ? "Withholding tax" : "Tax"}</span>
                <b>{calc.tax_total < 0 ? "−" : ""}{inr(Math.abs(calc.tax_total))}</b>
              </div>
            )}
            {calc.round_off !== 0 && <div className="ln dk-n"><span>Round off</span><b>{inr(calc.round_off)}</b></div>}
            <div className="grand dk-n"><span style={{ fontWeight: 700 }}>Grand total</span><b>{cur()} {inr(calc.grand_total)}</b></div>
          </div>
        </div>
      </div>

      <div className="dk-paypanel dk-s">
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 11, background: "var(--sunk)" }}>
          <span style={{ width: 34, height: 34, borderRadius: 999, flex: "none", background: "var(--accent-soft)",
                         color: "var(--accent)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12.5, fontWeight: 500 }}>
            {String(party ? party.name : "Cash").trim().split(/\s+/).slice(0, 2).filter(Boolean).map((w) => w[0].toUpperCase()).join("")}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 650 }}>{party ? party.name : "Cash Sale"}</div>
            <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
              {party && Math.abs(party.balance) > 0.005
                ? `owes ${cur()} ${inr(Math.abs(party.balance))}${party.credit_limit > 0 ? ` · limit ${inr(party.credit_limit)}` : ""}`
                : "no balance on account"}
            </div>
          </div>
          <button className="dk-linkbtn" onClick={() => setPickCust(true)}>Change</button>
        </div>

        <div className="dk-payhead">
          <div className="l">Payable amount</div>
          <div className="v dk-n">{cur()} {inr(calc.grand_total)}</div>
        </div>

        <div className="dk-modes">
          {[["cash", "Cash"], ["mobile", "Mobile Money"], ["card", "Card"], ["credit", "Credit"]].map(([id, label]) => (
            <button key={id}
                    className={`dk-mode ${pay === id ? "on" : ""}${id === "credit" && walkIn ? " off" : ""}`}
                    title={id === "credit" && walkIn ? "Pick a saved customer first" : undefined}
                    onClick={() => {
                      /* Not disabled: a cashier who taps it should be taken to
                         the thing that unblocks it, not left guessing. */
                      if (id === "credit" && walkIn) {
                        toast("Credit needs a saved customer — pick one", "bad");
                        setPickCust(true);
                        return;
                      }
                      setPay(id);
                    }}>{label}</button>
          ))}
        </div>

        {/* Which account the money lands in, next to the mode that decides it.
            A credit sale still shows it, because the part payment taken at the
            counter is real money that has to land somewhere. */}
        {cashAccounts.length > 0 && (
          <label className="dk-field">
            <span>{isCredit ? "Any payment now goes into" : "Money goes into"}</span>
            <AccountSelect className="dk-input" accounts={cashAccounts} value={cashCode} onChange={setCashCode}
                           ariaLabel="Account this payment goes into" />
          </label>
        )}

        {isCredit && party && (
          <div className="dk-creditnote">
            <div className="t">Goes on {party.name}’s account</div>
            <div className="s">
              New balance would be <b className="dk-n">{cur()} {inr(newBalance)}</b>
              {Number(party.credit_limit) > 0 ? <> of a {inr(party.credit_limit)} limit.</> : "."}
              {overLimit && <b style={{ color: "var(--danger)" }}> That is over their limit.</b>}
            </div>
          </div>
        )}

        {repRequired && (
          <label className="dk-field">
            <span>Sold by</span>
            <select className="dk-input" value={salesRep} onChange={(e) => setSalesRep(e.target.value)}>
              <option value="">Choose…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
            </select>
          </label>
        )}

        {/* ── What the customer handed over ──────────────────────────────
            One tall figure with a pencil on it, and the number pad hanging
            off it when it is tapped. It replaces a labelled text box with a
            permanently-open twelve-key pad below it — the pad was a third of
            the pane whether or not anybody was counting cash into it, and on
            a card or mobile-money sale it was never touched at all. */}
        <div className="dk-tender" ref={padWrap}>
          <button type="button" className={`dk-tender-face ${pad ? "open" : ""}`}
                  aria-expanded={pad} aria-haspopup="dialog"
                  onClick={() => setPad((v) => !v)}>
            <span className="l">{isCredit ? "Paying now" : "Amount tendered"}</span>
            <span className="v dk-n">
              <small>{cur()}</small>{" "}{received === "" ? "0" : inr(recv)}
            </span>
            <span className="ed" aria-hidden="true"><Icon n="edit" size={15} /></span>
          </button>

          {pad && (
            <div className={`dk-pad ${padUp ? "up" : ""}`} role="dialog" aria-label="Number pad">
              {/* A real input behind the keys, so a keyboard, a barcode wedge
                  that types digits, and paste all work without any of it
                  being re-implemented on twelve buttons. */}
              <input ref={padInput} className="dk-n dk-pad-in" inputMode="decimal" value={received}
                     onChange={(e) => setReceived(e.target.value.replace(/[^\d.]/g, ""))}
                     placeholder="0" aria-label={isCredit ? "Paying now" : "Amount tendered"} />
              <div className="dk-pad-keys">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((k) => (
                  <button key={k} type="button" className="dk-n" onClick={() => press(k)}
                          aria-label={k === "⌫" ? "Delete the last digit" : k}>{k}</button>
                ))}
              </div>
              <div className="dk-pad-foot">
                <button type="button" className="clr" onClick={() => press("C")}>Clear</button>
                <button type="button" className="ok" onClick={() => setPad(false)}>OK</button>
              </div>
            </div>
          )}
        </div>

        {/* The notes a customer actually hands over, and the exact figure.
            Left where they are: they are the fastest path on most sales and
            settle the amount without the pad ever being opened. */}
        <div className="dk-quick">
          {quick.map((qk) => (
            <button key={qk.label} className={`dk-n ${qk.label === "Exact" ? "exact" : ""}`}
                    onClick={() => { setReceived(String(qk.v)); setPad(false); }}>{qk.label}</button>
          ))}
        </div>

        <div className={`dk-changerow ${shortBy > 0 && !isCredit ? "short" : change > 0 ? "good" : ""}`}>
          <span className={`l ${changeTone}`}>
            {isCredit ? "Left on account" : shortBy > 0 ? "Still short" : "Change to give"}
          </span>
          <b className={`v dk-n ${changeTone}`}>
            {cur()} {inr(changeAmt)}
          </b>
        </div>

        {saveErr && (
          <div className="dk-saveerr" role="alert"
               style={{ border: "1px solid var(--danger, #dc2626)", borderRadius: 11, padding: "12px 14px",
                        background: "rgba(220,38,38,.08)", display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>
              {saveErr.resolved ? "This sale was already saved"
                : saveErr.ambiguous ? "The sale may not have been saved"
                : "The sale was not saved"}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              {saveErr.message}
              <br />
              {saveErr.resolved
                ? "Do not confirm again — that would bill the customer twice."
                : saveErr.ambiguous
                  ? "The request left this till but no answer came back, so it may already be on the books. Check before saving again."
                  : "The bill is still here and is kept on this machine. Nothing has been charged."}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {saveErr.ambiguous && (
                <button className="dk-tbtn" disabled={checking} onClick={onRecheck}>
                  {checking ? "Checking…" : "Check whether it saved"}
                </button>
              )}
              {saveErr.resolved && (
                <>
                  <button className="dk-tbtn" onClick={() => onFinishResolved(true)}>Print receipt &amp; finish</button>
                  <button className="dk-tbtn" onClick={() => onFinishResolved(false)}>Finish without printing</button>
                  {/* The match is customer + amount + timing, not a guarantee.
                      If the operator can see it is a different sale, they must
                      still be able to post this one. */}
                  <button className="dk-tbtn" onClick={onDismissErr}>Not this sale — let me save again</button>
                </>
              )}
              {!saveErr.ambiguous && !saveErr.resolved && (
                <button className="dk-tbtn" onClick={onDismissErr}>Dismiss</button>
              )}
            </div>
          </div>
        )}

        <div className="dk-confirm">
          <button className="plain" disabled={busy || blocked} onClick={() => onConfirm(false)}>Save, no print</button>
          <button className="go" disabled={busy || blocked || (!isCredit && shortBy > 0)}
                  onClick={() => onConfirm(true)}>
            {busy ? "Saving…" : "Confirm & print"}
          </button>
        </div>
      </div>

      {pickCust && (
        <Modal title="Customer for this sale" onClose={() => setPickCust(false)}>
          <PartyCombo parties={parties} value={partyId} autoFocus
                      onPick={(id) => { setPartyId(String(id)); setPickCust(false); }}
                      onCreated={async () => { await reloadParties(); setPickCust(false); }} />
        </Modal>
      )}
    </div>
  );
}

function ShortcutsDlg({ onClose }) {
  const KEYS = [
    ["Scan a barcode", "just scan — no need to click the search box first"],
    ["F1", "jump to item search"],
    ["Enter", "add the first matching item"],
    ["↑ / ↓", "move between items on the bill"],
    ["Delete", "void the selected line"],
    ["F2", "discount"],
    ["F3", "add a new item on the fly"],
    ["F4", "choose who the sale is credited to (sales rep)"],
    ["F6", "switch the line between units (e.g. box / bottle)"],
    ["F8", "hold this bill"],
    ["F10", "checkout"],
    ["F11", "checkout as credit"],
    ["F12", "quick cash sale + print"],
    ["Ctrl + T", "switch price mode"],
    ["Esc", "clear the search box"],
    ["?", "show this list"],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
        <tbody>
          {KEYS.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: "7px 10px 7px 0", whiteSpace: "nowrap" }}><kbd className="kbd">{k}</kbd></td>
              <td style={{ padding: "7px 0", color: "var(--muted)" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn btn-primary" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}

/* Add an item without leaving the till — the customer is still standing there. */
function QuickAddItem({ initialName, onClose, onCreated }) {
  const [f, setF] = useState({ name: initialName || "", sale_price: "", purchase_price: "", unit: "PCS", opening_stock: "" });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (!f.name.trim()) return toast("Enter an item name", "bad");
    if (!(Number(f.sale_price) > 0)) return toast("Enter a selling price", "bad");
    setBusy(true);
    try {
      const it = await api.post("/items", {
        name: f.name.trim(), unit: f.unit, item_type: "product",
        sale_price: Number(f.sale_price), purchase_price: Number(f.purchase_price) || 0,
      });
      if (Number(f.opening_stock) > 0) {
        await api.post(`/items/${it.id}/adjust`, { direction: "in", quantity: Number(f.opening_stock), note: "Opening stock (quick add)" });
      }
      toast(`${f.name} added`);
      onCreated({ ...it, name: f.name.trim(), unit: f.unit, sale_price: Number(f.sale_price),
        purchase_price: Number(f.purchase_price) || 0, on_hand: Number(f.opening_stock) || 0,
        is_inventory: 1, is_active: 1, barcodes: [] });
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };
  return (
    <Modal title="Add item" onClose={onClose}>
      <Field label="Item name"><input value={f.name} onChange={set("name")} autoFocus placeholder="e.g. Blue Band 250g" /></Field>
      <div className="row2">
        <Field label="Selling price (Sh)"><input type="number" value={f.sale_price} onChange={set("sale_price")}
               onKeyDown={(e) => e.key === "Enter" && save()} /></Field>
        <Field label="Cost (Sh) — optional"><input type="number" value={f.purchase_price} onChange={set("purchase_price")} /></Field>
      </div>
      <div className="row2">
        <Field label="Unit"><input value={f.unit} onChange={set("unit")} /></Field>
        <Field label="Stock on hand — optional"><input type="number" value={f.opening_stock} onChange={set("opening_stock")} /></Field>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Added straight to this bill. You can fill in barcodes, category and reorder level later from the Items screen.</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Adding…" : "Add & put on bill"}</button>
      </div>
    </Modal>
  );
}
