/**
 * settingsui.jsx — one setting, rendered the same way wherever it is reached.
 *
 * Settings were regrouped so that a setting describing one screen lives on that
 * screen: item settings on Items, party settings on Parties, loyalty on the
 * Loyalty panel. That only works if a setting looks and behaves identically in
 * all four places — otherwise the same switch reads as two different controls
 * and the app feels assembled rather than designed. §1 of the design review is
 * explicit about this: no new class name in a page file, one implementation in
 * `lib/`, used everywhere. `docshell.jsx` and `rowmenu.jsx` are the model.
 */
import React, { useEffect, useState } from "react";
import api from "./api.js";
import { toast } from "./ui.jsx";
import { PageDock } from "./deckui.jsx";

/* Explanations for settings that shipped with a label and nothing else. */
const NOTES = {
  /* The four that used to do nothing. Each note says where the change shows
     up, because a switch whose effect nobody can find reads as broken. */
  show_received_amount: "Off takes the received and balance boxes off the sale form — every sale is settled in full",
  default_unit: "What a new item starts with. Change it if you sell mostly by the bag, box or kilo",
  low_stock_alert: "Off silences the running-out figure on the dashboard and on Items",
  enable_batches: "Adds batch and expiry boxes to purchase bills. Stock is then sold earliest-expiry-first",
  tax_inclusive_default: "For taxes added on top. A shelf price of 11,800 becomes 10,000 plus 1,800 VAT instead of 11,800 plus 2,124",
  print_preview: "Whether a document is shown before it goes to the printer. The till prints straight through either way",
  print_levy_pct: "Adds a service levy line to receipts. Zero switches it off",
  currency_symbol: "Printed before every amount, on screen and on paper",
  amount_decimals: "How many places money is shown to. Two is normal; zero suits shillings",
  date_format: "How dates read everywhere in the app",
  firm_email: "Appears on invoices when Settings → Print is set to show it",
  firm_address: "Appears on invoices and receipts",
  taxes_enabled: "The master switch. Off means no tax is calculated on anything",
  tax_on_pos: "Whether tax rules apply to sales rung up at the till",
  tax_on_cash: "Whether tax rules apply when a sale is settled in full",
  tax_on_credit: "Whether tax rules apply when a sale is left outstanding",
  invoice_prefix: "The letters before every invoice number, e.g. INV-000123",
  prevent_negative_stock: "Refuse a sale that would take stock below zero",
  prevent_below_cost: "Refuse a sale priced under what the item cost you",
  force_customer_on_credit: "A sale left outstanding must name who owes it",
  require_void_reason: "A voided line or bill has to say why",
  require_sales_rep: "Every sale records who made it — needed for commissions",
  block_sales_without_shift: "Nothing can be sold until the till is opened for the day",
  cash_round_to: "Cash totals round to this, for shops with no small change",
  round_off: "Round the invoice total to a whole figure",
  store_enabled: "Publishes a catalogue page you can send customers",
  store_whatsapp: "Orders from that page arrive on this number",
  store_note: "The line customers read at the top of your catalogue",
  price_lists_enabled: "Lets you keep more than one price for an item — trade, retail, staff",
  qty_decimals: "How many places quantities are shown to",
  inventory_valuation: "How stock is costed when it leaves the shelf",
  allow_duplicate_item_names: "Permit two items with the same name",
  enhanced_item_search: "Match search words in any order, not just from the start",
  inventory_tracking_default: "New products start with stock tracking on",
  stock_maintenance: "Keep a running stock figure for every item",
  reorder_lookback_days: "How far back the reorder suggestion looks at sales",
  reorder_cover_days: "How many days of stock the suggestion aims to keep",
  expiry_alert_days: "How far ahead to warn about stock going out of date",
  enable_credit_limit: "Cap how much a customer may owe at once",
  enable_shipping_address: "Keep a delivery address separate from the billing one",
  loyalty_earn_per: "Spend this much and the customer earns one point",
  loyalty_point_value: "What one point is worth when it is spent",
  loyalty_min_redeem: "Points cannot be spent below this many at once",
  loyalty_expiry_months: "Points lapse after this long. Zero means they never do",
  loyalty_earn_on_credit: "Points on sales not yet paid for, as well as on paid ones",
};
const noteFor = (c) => c.note || NOTES[c.key] || null;

/* Fields whose meaning depends on a master switch above them: key → the switch. */
const FIELD_GATES = {
  store_whatsapp: "store_enabled",
  store_note: "store_enabled",
  tax_on_pos: "taxes_enabled",
  tax_on_cash: "taxes_enabled",
  tax_on_credit: "taxes_enabled",
  vat_rule_name: "taxes_enabled",
  vat_due_day: "taxes_enabled",
};

/** One setting, whatever its type. Used by the field pages, by the relocated
 *  panels on Items, Parties and Loyalty, and by the search results — so a
 *  setting looks and behaves the same wherever it is reached from. */
export function SettingRow({ c, values, setVal, dirty, disabled }) {
  const note = noteFor(c);
  const gate = FIELD_GATES[c.key];
  const off = disabled || (gate && values[gate] !== "1");
  const changed = !!(dirty && dirty[c.key]);

  if (c.type === "bool") {
    return (
      <div className={`dk-setrow ${off ? "is-off" : ""} ${changed ? "is-dirty" : ""}`}>
        <div className="t">
          <div className="lb">{c.label}</div>
          {note && <div className="nt">{note}</div>}
        </div>
        <button className={`dk-switch ${values[c.key] === "1" ? "on" : ""}`} disabled={off}
                role="switch" aria-checked={values[c.key] === "1"} aria-label={c.label}
                onClick={() => setVal(c.key, values[c.key] === "1" ? "0" : "1")}><i /></button>
      </div>
    );
  }
  return (
    <div className={`dk-setrow ${off ? "is-off" : ""} ${changed ? "is-dirty" : ""}`}>
      <div className="t">
        <label className="lb" htmlFor={`set-${c.key}`}>{c.label}</label>
        {note && <div className="nt">{note}</div>}
      </div>
      {c.type === "select" ? (
        <select id={`set-${c.key}`} className="dk-input" value={values[c.key] ?? ""} disabled={off}
                onChange={(e) => setVal(c.key, e.target.value)}>
          {(c.options || []).map((o) => (
            <option key={typeof o === "string" ? o : o.value} value={typeof o === "string" ? o : o.value}>
              {typeof o === "string" ? o : o.label}
            </option>
          ))}
        </select>
      ) : (
        /* A setting whose value IS a date gets a date box. Typed as free text
           it was the one place in the app where a wrong keystroke meant the
           closing date of the books, and "30/06/2026" — which is how the rest
           of this app writes a date — is not a date SQLite can compare. */
        <input id={`set-${c.key}`} className={`dk-input ${c.type === "number" ? "dk-n" : ""}`}
               type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"} disabled={off}
               value={values[c.key] ?? ""} onChange={(e) => setVal(c.key, e.target.value)} />
      )}
    </div>
  );
}

/** A page section: a heading and rows. The only container besides the page. */
export function SettingSection({ title, hint, children }) {
  return (
    <section className="dk-setsec">
      {title && <h3>{title}</h3>}
      {hint && <p className="hint">{hint}</p>}
      <div className="rows">{children}</div>
    </section>
  );
}

/** Every live setting in a group, in catalogue order. */
export function settingsIn(catalog, group) {
  return (catalog || []).filter((c) => c.group === group && !c.unbuilt && !c.hidden);
}


/* ── Units and categories ─────────────────────────────────────────────────
   Units and item categories already have a proper editor on the Items screen,
   with usage counts, conversion pairs and colours. Keeping a second, thinner
   one here meant two places to add a unit and only one of them told you
   anything useful — so this points at the good one instead of duplicating it.

   Party groups used to sit here too, purely because they had nowhere else to
   go. They belong with the other party settings, so they now live on the
   Party defaults page. */
function Masters() {
  return (
    <div className="dk-card pad w-mid">
      <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>Units &amp; item categories</h3>
      <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
        These live on the Items screen, where they show how many items use each unit,
        which conversion pairs are actually in use, and what each category is worth in stock.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="dk-sbtn primary"
                onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "items", sub: "units" } }))}>
          Open units
        </button>
        <button className="dk-sbtn"
                onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: "items", sub: "categories" } }))}>
          Open categories
        </button>
      </div>
    </div>
  );
}

export function MasterList({ title, endpoint, withShort, note }) {
  const [rows, setRows] = useState([]);
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api.get(endpoint).then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await api.post(endpoint, withShort ? { name, short } : { name }); setName(""); setShort(""); load(); }
    catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  return (
    <div className="dk-card flush">
      <div className="dk-card-head">
        <h3>{title}</h3>
        <span className="n dk-n">{rows.length}</span>
      </div>
      {note && <div style={{ padding: "14px 20px 0", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>{note}</div>}
      <div className="dk-list dk-s" style={{ maxHeight: 300 }}>
        {rows.length === 0 ? <div className="dk-empty">Nothing here yet.</div> : rows.map((r) => (
          <div key={r.id} style={{ padding: "11px 20px", borderBottom: "1px solid var(--line)", fontSize: 13.5, fontWeight: 650 }}>
            {r.name}{r.short ? <span className="dim" style={{ fontWeight: 500 }}> · {r.short}</span> : null}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 14, borderTop: "1px solid var(--line)" }}>
        <input className="dk-input" style={{ flex: 1, height: 38 }} placeholder="Name" value={name}
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && add()} />
        {withShort && <input className="dk-input" style={{ width: 76, height: 38 }} placeholder="PCS" value={short}
                             onChange={(e) => setShort(e.target.value)} />}
        <button className="dk-addbtn" disabled={busy || !name.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}


/**
 * A block of settings on a screen that is not Settings.
 *
 * Fetches the catalogue itself, renders one group of it, and saves the whole
 * block in one request — the same contract the Settings page has, so a setting
 * that moved did not also change how it is saved. Somebody who set six things
 * and pressed Save once still sets six things and presses Save once.
 */
export function SettingsBlock({ group, title, hint, extra, onSaved }) {
  const [catalog, setCatalog] = useState([]);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = () => api.get("/settings")
    .then((d) => { setCatalog(d.catalog || []); setValues(d.values || {}); setDirty({}); setFailed(false); })
    .catch(() => setFailed(true));
  useEffect(() => { load(); }, []);

  const setVal = (k, v) => { setValues((s) => ({ ...s, [k]: v })); setDirty((d) => ({ ...d, [k]: true })); };
  const n = Object.keys(dirty).length;

  const save = async () => {
    setBusy(true);
    try {
      /* Only what changed is sent. The Settings page sends the whole values
         object; here the block holds one group out of nine, and posting all of
         them back would let a stale read on this screen overwrite a setting
         somebody changed on another. */
      await api.put("/settings", Object.fromEntries(Object.keys(dirty).map((k) => [k, values[k]])));
      toast(`Saved ${n} change${n === 1 ? "" : "s"}`);
      setDirty({});
      onSaved?.(values);
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const rows = settingsIn(catalog, group);
  if (failed) {
    return (
      <SettingSection title={title}>
        <div className="dk-empty">These settings could not be loaded. Nothing has been changed.</div>
      </SettingSection>
    );
  }
  return (
    <>
      <SettingSection title={title} hint={hint}>
        {rows.map((c) => <SettingRow key={c.key} c={c} values={values} setVal={setVal} dirty={dirty} />)}
      </SettingSection>
      {extra}
      <PageDock show={n > 0}>
        <span className="dk-dock-note">{n} unsaved change{n === 1 ? "" : "s"}</span>
        <button className="dk-sbtn" disabled={busy} onClick={load}>Discard</button>
        <button className="dk-sbtn primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : `Save ${n} change${n === 1 ? "" : "s"}`}
        </button>
      </PageDock>
    </>
  );
}
