import React, { useEffect, useMemo, useState } from "react";
import api, { refreshFirm, can } from "../lib/api.js";
import { Field, toast, SkeletonRows, Empty, RowMenu, confirmDialog } from "../lib/ui.jsx";
import { LoadFailed, useRead, PageDock } from "../lib/deckui.jsx";
import { SettingRow, SettingSection, settingsIn } from "../lib/settingsui.jsx";
/* Lazy: the licence screen is not on the path most people take through
   Settings, and it carries its own layout. */
const LicencePane = React.lazy(() => import("./Licence.jsx"));
const ConnectServerPane = React.lazy(() => import("./Onboarding.jsx").then((m) => ({ default: m.ConnectServer })));
import { isNative, savedServer } from "../lib/server.js";
import { inr, fmtDate, fmtDateTime } from "../lib/tax.js";
import { Icon } from "../lib/icons.jsx";
const InvoiceTemplateDesigner = React.lazy(() => import("./InvoiceTemplateDesigner.jsx"));



const ICN = {
  business: "M4 20V9l8-5 8 5v11|M9 20v-6h6v6|M4 20h16",
  modules: "M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z",
  loyalty: "M12 4l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z",
  sales: "M4 7h16M4 12h16M4 17h10|M18 15l3 2-3 2",
  item: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z|M12 3v18|M4 7.5l8 4.5 8-4.5",
  party: "M9 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6z|M3 20c1.3-3 3.5-4.5 6-4.5s4.7 1.5 6 4.5|M16 11l2 2 4-4",
  taxes: "M6 3h9l4 4v14H6z|M9 12h6|M9 16h4|M9 8h3",
  pricelists: "M4 6h16M4 12h16M4 18h16|M8 4v16",
  store: "M4 8l1-4h14l1 4|M4 8v11h16V8|M4 8h16|M9 19v-6h6v6",
  print: "M7 8V3h10v5|M5 8h14v9H5z|M8 21h8v-5H8z|M17 12h.01",
  users: "M9 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6z|M3 20c1.3-3 3.5-4.5 6-4.5s4.7 1.5 6 4.5|M17 8v6|M14 11h6",
  backup: "M12 3v10|M8 9l4 4 4-4|M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4",
  /* Licence had no glyph, and it is in the list — a key, because that is the
     word the screen itself uses for what it holds. */
  licence: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z|M9.5 12l1.8 1.8L15 10",
  signin: "M5 11h14v10H5z|M8 11V7a4 4 0 018 0v4|M12 15v2",
  about: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z|M12 11v5|M12 8h.01",
};



/* ── Settings shell, built to the design deck ──────────────────────────────
   A list of subjects down the left, one page open beside it. Replaces the
   grid of coloured tiles, which cost a click to reach anything and gave no
   sense of what else there was.

   The pages themselves are mostly the ones that were already here; this is
   the frame around them plus the Users page, which is new.  */

/* Nine pages, down from fourteen.
 *
 * Three of the old ones moved to the screen they configure rather than being
 * regrouped here — item settings to Items → Preferences, party settings to
 * Parties, loyalty to the Loyalty panel — because a setting that describes one
 * screen is findable from that screen and nowhere else is as obvious. Each
 * leaves a signpost below, so nobody who learned the old place is stranded.
 *
 * Two disappeared entirely: "Units & categories" was a page whose whole content
 * was a signpost to Items, and "General" and "Transaction" split between
 * Business, Sales & transactions, Taxes and Users — where each of their
 * settings is next to the thing it changes. `vat_rule_name` names a rule on the
 * Taxes page and used to be edited three pages away from it. */
const SETPAGES = [
  ["business",    "Business",        "Who you are, and how money and dates are written"],
  ["modules",     "Modules",         "Turn whole features on or off for this shop"],
  ["sales",       "Sales & transactions", "Numbering, rounding, and what a sale must have"],
  ["taxes",       "Taxes",           "Rates, what URA sees, and which of them is VAT"],
  ["print",       "Print",           "Receipt size, copies and what appears on the slip"],
  ["pricelists",  "Price lists",     "Retail, trade, staff and wholesale pricing"],
  ["backup",      "Backup",          "Local and off-site copies of everything"],
  ["signin",      "Sign-in security","Devices that skip the emailed code, and your backup codes"],
  ["licence",     "Licence",         "The key this till runs on, and what the plan allows"],
  ["about",       "About & updates", "Version and what changed"],
];

/* The list, in bands.
 *
 * Ten entries in one unbroken column is a list you read from the top every
 * time, because nothing tells you where in it to start looking. The bands are
 * the same device the main rail uses — a quiet heading over three or four
 * related destinations — and they answer the only question somebody arriving
 * here has: roughly whereabouts is the thing I want.
 *
 * The order inside each band is deliberate: the one most often opened first.
 * The bands themselves run from "about this shop" to "about this computer",
 * which is also roughly how often each is touched. */
const SETGROUPS = [
  ["Your shop",     ["business", "modules", "pricelists"]],
  ["Selling",       ["sales", "taxes", "print"]],
  ["This computer", ["backup", "signin", "licence", "about"]],
];

/* Settings that now live on another screen. Rendered at the foot of the list
   as links rather than pages, so the answer to "where did Item defaults go" is
   on the screen that used to hold it. */
const MOVED = [
  ["users",    "Users & roles",  "Now its own screen — ⋯ beside the business name"],
  ["items",    "Item defaults",  "Now on Items → Preferences"],
  ["parties",  "Party defaults", "Now on Parties → Preferences"],
  ["loyalty",  "Loyalty",        "Now on the Loyalty screen"],
];

/* Pages that keep their own save button, because they save one thing at a
   time — a tax rate, a price list, a role — rather than a page of fields. */
/* Pages that keep their own save button, because they save one thing at a
   time — a tax rate, a price list, a role — rather than a page of fields.
   Taxes and Users are no longer purely self-saving: each now carries a handful
   of catalogue fields alongside its editor, so they take the dock as well. */
const SELF_SAVING = ["pricelists", "print", "backup", "about", "signin"];

/* Pages whose remaining fields only mean anything while one master switch is
   on: page id → the key of that switch. */
/* Page-level gating. Only Price lists is gated as a whole page now: the online
   store folded into Modules as a section, and its fields are gated
   individually by FIELD_GATES in lib/settingsui.jsx.

   The loyalty gate that used to sit here tested `values.loyalty_enabled`, a key
   that is not in the catalogue — so the test was always true and the page was
   permanently visible. Round eight left that open, saying there was no correct
   key to point it at. There was: `mod_loyalty`, already in the catalogue and
   already used by Invoices.jsx to gate the loyalty sub-tab. The page has since
   moved to the Loyalty screen, which that same switch governs, so the wrong key
   is gone rather than repointed. */

export default function Settings() {
  const [tab, setTab] = useState("general");
  const [catalog, setCatalog] = useState([]);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState({});
  const [firm, setFirm] = useState({});
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [q, setQ] = useState("");

  const load = () => api.get("/settings").then((d) => { setCatalog(d.catalog); setValues(d.values); setDirty({}); }).catch(() => {});
  useEffect(() => { load(); api.get("/settings/firm").then((f) => setFirm(f || {})).catch(() => {}); }, []);

  const setVal = (k, v) => { setValues((s) => ({ ...s, [k]: v })); setDirty((d) => ({ ...d, [k]: true })); setJustSaved(false); };
  const hasChanges = Object.keys(dirty).length > 0;

  const save = async () => {
    setBusy(true);
    try {
      await api.put("/settings", values);
      /* Module switches change which screens exist, so the shell has to
         rebuild its menu. */
      window.dispatchEvent(new CustomEvent("vy-settings-saved"));
      setDirty({});
      setJustSaved(true);
      toast("Settings saved");
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const discard = async () => {
    if (!hasChanges) return;
    if (!(await confirmDialog({
      title: "Discard changes?",
      message: `${Object.keys(dirty).length} change${Object.keys(dirty).length === 1 ? "" : "s"} on this page will be thrown away.`,
      danger: true, confirmLabel: "Discard",
    }))) return;
    load();
  };

  const page = SETPAGES.find((p) => p[0] === tab) || SETPAGES[0];
  const selfSaving = SELF_SAVING.includes(tab);

  /* A page nobody can reach is worse than one that says why it is empty. */
  const visible = SETPAGES.filter(([id]) =>
    (id !== "pricelists" || values.price_lists_enabled !== "0"));

  /* ── Search ──────────────────────────────────────────────────────────────
     124 settings behind nine pages. Whatever the grouping, the fastest way to
     one you can name is to type its name, and it means the regrouping does not
     have to be perfect for the page to be usable — nobody has to guess which
     page a setting is on.

     Searches the label, the explanatory note and the key itself. The key
     because the people who go looking hardest are the ones who read it in a
     support message. */
  const found = q.trim().length < 2 ? [] : (() => {
    const needle = q.trim().toLowerCase();
    const pageOf = (g) => SETPAGES.find(([id]) => id === g);
    return catalog
      .filter((c) => !c.unbuilt && c.group !== "internal")
      .filter((c) => [c.label, c.note, c.key].some((f) => f && f.toLowerCase().includes(needle)))
      .map((c) => ({ ...c, page: pageOf(c.group), moved: MOVED.find(([, , ]) => false) }))
      .slice(0, 40);
  })();

  return (
    <div className="dk-set">
      <div className="dk-card flush">
        <div className="dk-set-cap">Settings</div>
        <div className="dk-set-find">
          <input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Search settings…" aria-label="Search every setting" />
          {q && <button onClick={() => setQ("")} aria-label="Clear the search">✕</button>}
        </div>
        <nav className="dk-list dk-s" aria-label="Settings sections">
          {/* Banded, and each entry carries the glyph for its subject. The
              glyphs were already written at the top of this file and had never
              been drawn — a list of ten identical rows of text is one you have
              to read end to end every time, and a shape beside each is what
              lets somebody go back to the one they were on yesterday without
              reading any of them. */}
          {SETGROUPS.map(([band, ids]) => {
            const rows = ids
              .map((id) => visible.find(([vid]) => vid === id))
              .filter(Boolean);
            if (!rows.length) return null;
            return (
              <div className="dk-set-band" key={band}>
                <div className="cap">{band}</div>
                {rows.map(([id, name, sub]) => (
                  /* aria-label spelled out because the chevron is the only
                     other child and these were surfacing to assistive tech as
                     a bare "button". */
                  <button key={id} className={`dk-set-item ${tab === id ? "on" : ""}`}
                          aria-label={name} aria-current={tab === id ? "true" : undefined}
                          title={sub}
                          onClick={() => { setTab(id); setQ(""); }}>
                    <span className="ic" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                           strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        {(ICN[id] || "").split("|").map((dd, i) => <path key={i} d={dd} />)}
                      </svg>
                    </span>
                    <span className="nm">{name}</span>
                    <span className="go" aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            );
          })}
          {/* Where the three relocated pages went. Links, not pages — the point
              is to answer "it used to be here" in one glance. */}
          <div className="dk-set-moved">
            <div className="cap">Now kept on their own screen</div>
            {MOVED.map(([id, name, where]) => (
              <button key={id} className="dk-set-item is-link"
                      aria-label={`${name} — ${where}`}
                      onClick={() => window.dispatchEvent(new CustomEvent("vy-nav", { detail: { page: id } }))}>
                <span className="nm">{name}<em>{where}</em></span>
                <span className="go" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </nav>
      </div>

      <div className="dk-set-body dk-s">
        {/* The banner that used to sit here — a card carrying the firm initial,
            the page title and its subtitle — is gone. It restated the entry
            already highlighted in the list beside it, cost a card of height on
            every page, and was the third container in a stack §2 of the design
            review named as the worst in the app. The page title now sits as a
            heading on the section itself. */}

        {/* Discard and Save, docked at the foot of the window for as long as
            there is unsaved work. Somebody who scrolls to the bottom of
            Modules to flip one switch still never has to scroll back up to
            save it — and the bar sits below the scrolling area rather than over
            it, so it cannot hide the control being read. */}
        <PageDock show={!selfSaving && hasChanges}>
          <span className="dk-dock-note">
            {Object.keys(dirty).length} unsaved change{Object.keys(dirty).length === 1 ? "" : "s"} in {page[1]}
          </span>
          <button className="dk-sbtn" disabled={busy} onClick={discard}>Discard</button>
          <button className="dk-sbtn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : `Save ${Object.keys(dirty).length} change${Object.keys(dirty).length === 1 ? "" : "s"}`}
          </button>
        </PageDock>

        {q.trim().length >= 2 ? (
          <SearchResults q={q} found={found} values={values} setVal={setVal} dirty={dirty}
                         onGo={(g) => { setTab(g); setQ(""); }} />
        ) : (
          <>
            <div className="dk-set-title">
              <h2>{page[1]}</h2>
              <p>{page[2]}</p>
              {!selfSaving && !hasChanges && justSaved && (
                <span className="dk-set-saved" role="status">✓ Saved</span>
              )}
            </div>
            {tab === "taxes" ? <TaxesPage catalog={catalog} values={values} setVal={setVal} dirty={dirty} />
              : tab === "pricelists" ? <PriceLists />
              /* Was <SkeletonRows n={4} />. That component returns <tr>
                 elements and takes `rows`, not `n` — so outside a <table> it
                 rendered nothing at all, and the licence pane appeared to
                 hang on a blank card while it loaded. */
              : tab === "licence" ? <React.Suspense fallback={<div className="dk-empty">Reading your licence…</div>}><LicencePane /></React.Suspense>
              : tab === "signin" ? <SignInSecurity />
              : tab === "about" ? <About />
              : tab === "backup" ? <Backup />
              : tab === "print" ? <PrintSettings />
              : <FieldPage tab={tab} catalog={catalog} values={values} setVal={setVal} dirty={dirty} />}
          </>
        )}
      </div>
    </div>
  );
}

/* ── A page of settings fields ────────────────────────────────────────────
 *
 * Driven by the catalogue the server returns, so a new setting appears here the
 * moment the server knows about it. Three changes from the version this
 * replaces:
 *
 * **Two container levels, not four.** §2 of the design review named Settings
 * the worst offender in the app — "a card containing a card containing a row
 * that is itself boxed" — and counted 32–48px of horizontal space lost per
 * level plus a border the eye has to parse. There is now a page section, and
 * rows within it. Nothing else.
 *
 * **Every setting says what it does.** Roughly half carried a `note`; the rest
 * had only a label. "Round off invoice total", with nothing under it, is a
 * switch nobody dares touch, so the ones that were bare are written below.
 *
 * **Nothing inert is rendered.** 25 settings in this catalogue are read by no
 * line of code anywhere in the app. They saved, they persisted, and they
 * changed nothing, which is worse than not offering them — the shop believes
 * them. They are marked `unbuilt` on the server and skipped here. The stored
 * values are untouched, so wiring one up later is a one-line change.
 */

/* ── Subforms ─────────────────────────────────────────────────────────────
 *
 * A page of twelve unrelated switches in one undivided column is a page nobody
 * reads: there is no shape to it, so finding the third one down means reading
 * the first two. Every page here is now cut into named subforms of three to
 * five rows — one heading, one sentence saying what the group is for, then the
 * rows.
 *
 * Keys are named rather than pattern-matched, so the order within a group is
 * the order that reads best rather than whatever order the server's catalogue
 * happens to be written in. Anything the server sends that is not named here
 * still appears, in a final untitled group — a new setting must never be
 * invisible because this file has not caught up with it. */
const SUBFORMS = {
  business: [
    ["Who you are", "Printed on invoices and receipts, where Settings → Print is set to show them.",
      ["firm_email", "firm_address"]],
    ["How money and dates are written", "Applies everywhere — on screen, on paper and in exports.",
      ["currency_symbol", "amount_decimals", "date_format"]],
  ],
  sales: [
    ["Numbering", "The letters and figures that identify a document.",
      ["invoice_prefix"]],
    ["What a sale must have", "Each of these stops a sale being finished until the detail is there.",
      ["force_customer_on_credit", "require_sales_rep", "require_void_reason", "block_sales_without_shift"]],
    ["When to refuse a sale", "Hard stops at the till. Turn one on and the sale cannot be completed at all.",
      ["prevent_negative_stock", "prevent_below_cost"]],
    ["Rounding", "For shops with no small change, and for totals that should end in a whole figure.",
      ["cash_round_to", "round_off"]],
    ["Tax on a sale", "Which kinds of sale the tax rules are applied to. The rules themselves are on the Taxes page.",
      ["tax_on_pos", "tax_on_cash", "tax_on_credit"]],
  ],
  taxes: [
    ["The master switch", "Off means no tax is calculated anywhere in the app.",
      ["taxes_enabled"]],
    ["VAT", "Which of your rules is the one URA calls VAT, and when the return is due.",
      ["vat_rule_name", "vat_due_day"]],
    ["Other deductions", "EFRIS invoicing and withholding tax.",
      ["efris_enabled", "wht_rate"]],
  ],
  modules: [
    ["Features", "Switching one off hides it from the sidebar and from every menu. Nothing is deleted.",
      null],   // null = everything not claimed by another group on this page
    ["Online store", "A catalogue page you can send to customers. The rest of this group only means anything while it is on.",
      ["store_enabled", "store_whatsapp", "store_note"]],
  ],
  backup: [
    ["Off-site copy", "A second copy, written somewhere that is not this computer.",
      ["offsite_enabled", "offsite_path", "offsite_keep", "offsite_warn_days"]],
  ],
};

function FieldPage({ tab, catalog, values, setVal, dirty }) {
  const rows = settingsIn(catalog, tab);
  if (!rows.length) {
    return <SettingSection><div className="dk-empty">Nothing to set here yet.</div></SettingSection>;
  }

  const plan = SUBFORMS[tab];
  if (!plan) {
    return (
      <SettingSection>
        {rows.map((c) => <SettingRow key={c.key} c={c} values={values} setVal={setVal} dirty={dirty} />)}
      </SettingSection>
    );
  }

  const by = new Map(rows.map((c) => [c.key, c]));
  /* Claimed by an explicitly-listed group. Whatever is left over goes to the
     group whose key list is null, or to an untitled group at the foot. */
  const claimed = new Set(plan.flatMap(([, , keys]) => keys || []));
  const rest = rows.filter((c) => !claimed.has(c.key));
  const hasCatchAll = plan.some(([, , keys]) => keys === null);

  return (
    <>
      {plan.map(([title, hint, keys]) => {
        const list = keys === null ? rest : keys.map((k) => by.get(k)).filter(Boolean);
        /* A group whose every setting is unbuilt, hidden or not in this
           catalogue is a heading over nothing. Do not draw it. */
        if (!list.length) return null;
        return (
          <SettingSection key={title} title={title} hint={hint}>
            {list.map((c) => <SettingRow key={c.key} c={c} values={values} setVal={setVal} dirty={dirty} />)}
          </SettingSection>
        );
      })}
      {!hasCatchAll && rest.length > 0 && (
        <SettingSection title="Everything else"
                        hint="Settings this screen has not yet found a home for. They work exactly as the ones above do.">
          {rest.map((c) => <SettingRow key={c.key} c={c} values={values} setVal={setVal} dirty={dirty} />)}
        </SettingSection>
      )}
    </>
  );
}

/* Taxes and Users each pair an editor with a few catalogue fields. Keeping the
   fields on the same page as the thing they name is the whole point of the
   regrouping: `vat_rule_name` names a rule in the table below it, and used to
   be edited three pages away from it. */
/* The tax fields, then the rules themselves.
 *
 * A `remove` function used to sit here — a copy of the staff-removal handler
 * from the Users page, on the Taxes page, calling a `load` that is not in
 * scope. Nothing ever called it, so it never threw; it was left behind by a
 * copy-and-paste and has been deleted rather than left to be found later by
 * somebody wiring up a delete button. */
function TaxesPage({ catalog, values, setVal, dirty }) {
  return (
    <>
      <FieldPage tab="taxes" catalog={catalog} values={values} setVal={setVal} dirty={dirty} />
      <TaxRules />
    </>
  );
}

/* UsersPage was here. The whole subject is pages/Users.jsx now. */

/* Search results. Each row is the real control, editable in place, with the
   page it belongs to named beside it — so finding a setting and changing it
   are the same action rather than two. */
function SearchResults({ q, found, values, setVal, dirty, onGo }) {
  if (!found.length) {
    return (
      <SettingSection>
        <div className="dk-empty">
          Nothing matches “{q}”.<br />
          Try the name of the setting, or a word from what it does.
        </div>
      </SettingSection>
    );
  }
  return (
    <SettingSection title={`${found.length} setting${found.length === 1 ? "" : "s"} matching “${q}”`}>
      {found.map((c) => (
        <div key={c.key} className="dk-setfound">
          <SettingRow c={c} values={values} setVal={setVal} dirty={dirty} />
          {c.page && (
            <button className="where" onClick={() => onGo(c.group)}>
              in {c.page[1]} <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
      ))}
    </SettingSection>
  );
}

/* Users & roles moved out of Settings entirely — it is its own screen now,
   reached from the ⋯ beside the business name. See pages/Users.jsx. A
   register of the people who work here is not a preference about how the
   shop runs, and burying it four levels down was the reason nobody could
   find it. The signpost below is on the list, where the page used to be. */

function Toggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width: 44, height: 24, borderRadius: 999, border: "none", cursor: "pointer",
      background: on ? "var(--primary)" : "#cbd0dc", position: "relative", transition: ".15s", padding: 0,
    }} aria-pressed={on}>
      <span style={{ position: "absolute", top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: ".15s", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }} />
    </button>
  );
}

function Backup() {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  /* Asks the server for a fresh, consistent copy of the database and hands it
     to the browser as a file — the only copy that leaves this machine. */
  const download = () => {
    const token = localStorage.getItem("vy_token");
    setSaving(true);
    fetch("/api/system/backup", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error("failed"); return r.blob(); })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `genius-backup-${new Date().toISOString().slice(0, 10)}.db`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("Backup downloaded");
      })
      .catch(() => toast("Backup failed", "bad"))
      .finally(() => setSaving(false));
  };
  /* The file goes up as raw binary, not base64 inside a JSON body.
   *
   * Base64 inflates it by a third and then meets express.json's 50mb limit on
   * the server, so any shop past roughly 37 MB — a few years of ordinary
   * trading — got a bare 413 that the error handler turns into "Something went
   * wrong. Reference: k3f9a2" at the exact moment they are trying to recover
   * their books. It also held the whole database twice over in the browser. */
  const send = (url, file) => {
    const token = localStorage.getItem("vy_token");
    return fetch(`/api${url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: file,
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.success === false) throw new Error(body.message || "The server could not read that file.");
      return body.data;
    });
  };

  /* Read the backup, show what's inside it, and only then offer to restore. */
  const restore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    setBusy(true);
    let info;
    try { info = await send("/system/restore/preview", file); }
    catch (err) { toast(err.message, "bad"); setBusy(false); return; }
    setBusy(false);

    const bk = info.backup, live = info.live;
    /* The preview already knows whether this restore would be refused — the
       same checks run on both routes. Saying so here, rather than offering the
       button and failing after it is pressed, is the difference between "you
       cannot do this, and here is why" and "it did not work". */
    if (!info.restorable) {
      await confirmDialog({
        title: "This backup cannot be restored here",
        message: info.blocked_reason,
        detail: `The file holds ${bk.invoices} invoice(s) for ${(bk.firm_names || []).join(", ") || bk.firm}. Nothing has been changed.`,
        confirmLabel: "Close", danger: true,
      });
      return;
    }
    const detail = [
      `Backup holds: ${bk.invoices} invoice(s), ${bk.parties} parties, ${bk.items} items, ${bk.payments} payments.`,
      `Covers ${bk.first_invoice_date} to ${bk.last_invoice_date} (last: ${bk.last_invoice_no}).`,
      `Right now you have: ${live.invoices} invoice(s), ${live.parties} parties, ${live.items} items (last: ${live.last_invoice_no}).`,
      live.invoices > bk.invoices
        ? `⚠ You would LOSE ${live.invoices - bk.invoices} invoice(s) recorded since this backup.`
        : "No invoices would be lost.",
      ...(info.warnings || []),
      "A copy of what you have now is taken first and listed with the automatic backups, so this can be undone.",
    ].join("\n");
    const okGo = await confirmDialog({
      title: `Restore backup of ${bk.firm}?`,
      message: "This replaces all current data with the contents of this file.",
      detail, confirmLabel: "Restore backup", danger: true,
    });
    if (!okGo) return;
    setBusy(true);
    try {
      await send(`/system/restore?filename=${encodeURIComponent(file.name.slice(0, 120))}`, file);
      toast("Backup restored — reloading");
      setTimeout(() => window.location.reload(), 900);
    } catch (err) { toast(err.message, "bad"); setBusy(false); }
  };
  return (
    <>
    <OffsiteCopy />
    <div className="dk-two">
      <div className="dk-card pad">
        <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>Take a copy</h3>
        <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
          Your entire business — invoices, parties, stock and books — lives in one file.
          Download it regularly and keep a copy somewhere that is not this computer.
        </p>
        {/* Downloading is harmless, so it does not need the loudest button on
            the page; restoring — which replaces everything — carries the weight.
            One download control, not two: the automatic copies below are
            restored in place, this is the one that leaves the machine. */}
        <button className="dk-sbtn" onClick={download} disabled={saving}
                style={{ opacity: saving ? .5 : 1, cursor: saving ? "default" : "pointer" }}>
          {saving ? "Preparing…" : "Download a backup"}
        </button>
        <AutoBackups />
      </div>

      <div className="dk-card pad">
        <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>Put one back</h3>
        <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
          Restoring replaces everything currently in the app with what is in the file.
          You will be shown what the backup holds, and what you would lose, before anything happens.
          A dated copy of the data you have now is taken first — every time, never overwritten —
          and appears in the list of automatic backups, so a restore can itself be undone.
        </p>
        <label className="dk-sbtn" style={{ cursor: busy ? "default" : "pointer", display: "inline-flex", alignItems: "center", opacity: busy ? .5 : 1, color: "var(--danger)", borderColor: "var(--danger)", background: "var(--danger-soft)", fontWeight: 700 }}>
          {busy ? "Reading the file…" : "Restore from a backup file…"}
          <input type="file" accept=".db" style={{ display: "none" }} onChange={restore} disabled={busy} />
        </label>
        <RestoreHistory />
      </div>

      <StartFresh />
    </div>
    </>
  );
}

/* ── Start fresh ──────────────────────────────────────────────────────────
 *
 * A demonstration copy that has been sold, or an installation that arrived
 * with somebody else's test trading in it, is not a shop's books. Emptying it
 * used to mean finding a file in AppData.
 *
 * It sits under Backup deliberately: the safety copy is taken automatically
 * before anything is destroyed, and it lands in the same list of backups
 * directly above, so undoing this is the same three clicks as undoing a
 * restore. */
function StartFresh() {
  const [open, setOpen] = useState(false);
  const [pre, setPre] = useState(null);
  const [confirm, setConfirm] = useState("");
  const [alsoCatalogue, setAlsoCatalogue] = useState(false);
  const [alsoTaxRules, setAlsoTaxRules] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.get("/system/start-fresh").then(setPre).catch((e) => toast(e.message, "bad"));
  useEffect(() => { if (open && !pre) load(); }, [open]);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post("/system/start-fresh", { confirm, alsoCatalogue, alsoTaxRules });
      toast(r.message || "The books are empty", "ok");
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };

  const n = (pre && (alsoCatalogue ? pre.withCatalogue : pre.trading)) || {};
  const ready = pre && confirm.trim() === (pre.firm || "").trim();

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="lic-state-t" style={{ fontSize: 15 }}>Format business data</div>
      <p style={{ margin: "6px 0 12px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
        Empties this business and runs the setup wizard again — for a copy that
        came with demonstration data, or a shop starting its books over. The
        business, its people, its chart of accounts and its roles all stay.
        A dated copy of everything is taken first, automatically, and appears in
        the list above.
      </p>

      {!open ? (
        <button className="dk-sbtn" onClick={() => setOpen(true)}>Format…</button>
      ) : !pre ? (
        <div className="dk-empty">Counting what is in this business…</div>
      ) : (
        <>
          <div className="lic-kv"><span>Invoices</span><b>{n.invoices}</b></div>
          <div className="lic-kv"><span>Purchases</span><b>{n.purchases}</b></div>
          <div className="lic-kv"><span>Payments</span><b>{n.payments}</b></div>
          <div className="lic-kv"><span>Expenses</span><b>{n.expenses}</b></div>
          <div className="lic-kv"><span>Ledger entries</span><b>{n.journal}</b></div>
          <div className="lic-kv"><span>Items</span>
            <b>{alsoCatalogue ? n.items : `${n.items} kept`}</b></div>
          <div className="lic-kv"><span>Customers and suppliers</span>
            <b>{alsoCatalogue ? n.parties : `${n.parties} kept`}</b></div>

          <label style={{ display: "block", marginTop: 12, fontSize: 13 }}>
            <input type="checkbox" checked={alsoCatalogue}
                   onChange={(e) => setAlsoCatalogue(e.target.checked)} style={{ marginRight: 8 }} />
            Remove the items and customers too
          </label>
          <label style={{ display: "block", marginTop: 6, fontSize: 13 }}>
            <input type="checkbox" checked={alsoTaxRules}
                   onChange={(e) => setAlsoTaxRules(e.target.checked)} style={{ marginRight: 8 }} />
            Remove the tax rules as well — the wizard asks about tax again
          </label>

          <div className="lic-hint" style={{ marginTop: 12 }}>
            The walk-in customer stays: the till cannot ring a sale without one.
          </div>

          <label className="lic-l" style={{ marginTop: 14 }}>
            Type <b>{pre.firm}</b> to confirm
          </label>
          <input className="lic-key" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                 placeholder={pre.firm} spellCheck={false} />

          <div className="lic-row">
            <button className="dk-sbtn" onClick={() => { setOpen(false); setConfirm(""); }}>Cancel</button>
            <button className="dk-sbtn" disabled={!ready || busy} onClick={go}
                    style={{ color: "var(--danger)", borderColor: "var(--danger)",
                             background: "var(--danger-soft)", fontWeight: 700,
                             opacity: ready && !busy ? 1 : .45 }}>
              {busy ? "Formatting…" : "Format this business"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── The copy that leaves the machine ─────────────────────────────────────
 *
 * Everything else on this screen writes to the same disk the live database is
 * on. This card is the only thing here that answers "if this computer is
 * stolen tonight, what is left?", and it answers it with a date rather than a
 * reassurance. It is placed above the other two on purpose.
 *
 * The colour is not decoration: `level` comes from the server and is "alarm"
 * when nothing has left the machine for three weeks. A screen that stays calm
 * about that is lying to the person reading it. */
function OffsiteCopy() {
  const [s, setS] = useState(null);
  const [failed, read] = useRead();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => read(api.get("/system/offsite"), (d) => {
    setS(d);
    setForm((f) => f || { enabled: !!d.enabled, path: d.path || "", keep: String(d.keep), warn_days: String(d.warn_days) });
  }, null);
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true);
    try {
      const d = await api.put("/system/offsite", form);
      setS(d);
      const a = d.attempt || {};
      if (a.status === "ok" || a.status === "current") toast(a.message);
      else if (a.status === "waiting") toast(a.message + " The copy is taken as soon as it is.", "bad");
      else if (a.status === "error") toast(a.message, "bad");
      else toast("Off-site copy settings saved");
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const testNow = async () => {
    setBusy(true);
    try { const d = await api.post("/system/offsite/test", {}); setS(d); toast((d.attempt || {}).message || "Copied"); }
    catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  if (failed) return <div className="dk-card pad w-mid" style={{ marginBottom: 20 }}><LoadFailed what="the off-site copy status" onRetry={load} compact /></div>;
  if (!s || !form) return null;

  /* Four states, three colours. "waiting" is deliberately not a warning: a USB
     stick spends most of its life out of the machine and saying so in red
     every day is how a real warning stops being read. */
  const bad = s.level === "alarm" || s.level === "error" || s.level === "never";
  const warn = s.level === "warn" || s.level === "off";
  const tone = bad ? "var(--danger)" : warn ? "var(--warnc)" : "var(--good)";

  return (
    <div className="dk-card pad w-mid" style={{ marginBottom: 20, borderLeft: `3px solid ${tone}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 650 }}>A copy somewhere that is not this computer</h3>
        <span className="n dk-n" style={{ fontSize: 11.5, color: tone, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em" }}>
          {s.level === "ok" ? "protected" : s.level === "waiting" ? "drive not connected"
            : s.level === "off" ? "not set up" : s.level === "never" ? "never worked"
            : s.level === "warn" ? "out of date" : s.level === "alarm" ? "unprotected" : "problem"}
        </span>
      </div>
      {/* The one sentence somebody came to this screen for: when did a copy
          last leave, and where did it go. */}
      <p style={{ margin: "0 0 4px", fontSize: 13.5, fontWeight: bad ? 700 : 600, color: bad ? "var(--danger)" : "var(--ink)", lineHeight: 1.55 }}>
        {s.headline}
      </p>
      <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>{s.detail}</p>

      <label className="dk-check" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span className="box" />
        <span style={{ fontSize: 13.5 }}>Copy automatically to a USB drive or another computer</span>
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, opacity: form.enabled ? 1 : 0.55 }}>
        <label className="dk-field">
          <span>Folder to copy to</span>
          <input className="dk-input" disabled={!form.enabled} value={form.path}
                 placeholder="E:\genius-backups   or   \\officepc\backups"
                 onChange={(e) => setForm({ ...form, path: e.target.value })} />
          <span style={{ letterSpacing: 0, textTransform: "none", fontWeight: 500, color: "var(--faint)", fontSize: 11.5 }}>
            The full path. A USB stick does not always get the same drive letter — if the copy stops working, check that first.
          </span>
        </label>
        <div style={{ display: "flex", gap: 14 }}>
          <label className="dk-field" style={{ width: 190 }}>
            <span>Copies kept there</span>
            <input className="dk-input dk-n" type="number" disabled={!form.enabled} value={form.keep}
                   onChange={(e) => setForm({ ...form, keep: e.target.value })} />
          </label>
          <label className="dk-field" style={{ width: 230 }}>
            <span>Say something after (days)</span>
            <input className="dk-input dk-n" type="number" disabled={!form.enabled} value={form.warn_days}
                   onChange={(e) => setForm({ ...form, warn_days: e.target.value })} />
          </label>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="dk-sbtn primary" onClick={save} disabled={busy}>
          {busy ? "Working…" : "Save and copy now"}
        </button>
        <button className="dk-sbtn" onClick={testNow} disabled={busy || !s.enabled}
                title={s.enabled ? "" : "Save a folder first"}>
          Copy now
        </button>
      </div>

      <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--faint)", lineHeight: 1.6 }}>
        The app looks for the drive every {s.poll_minutes} minutes and takes one copy a day, so it does not have to be
        plugged in at any particular time. Each copy is opened and read back after it is written — a file on a stick that
        cannot be opened is worse than no file, because it looks like insurance.
      </p>

      {s.copies && s.copies.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div className="l" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>
            On {s.path}
          </div>
          {s.copies.map((c) => (
            <div key={c} className="dk-n" style={{ fontSize: 12.5, color: "var(--faint)", padding: "3px 0" }}>{c}</div>
          ))}
        </div>
      )}

      {s.events && s.events.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div className="l" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>
            What has happened
          </div>
          {/* Only things worth reading: a copy that landed, or a problem.
              "Not plugged in" happens ninety-six times a day and is not news. */}
          {s.events.slice(0, 5).map((e, i) => (
            <div key={i} style={{ fontSize: 12.5, color: e.status === "error" ? "var(--danger)" : "var(--faint)", padding: "5px 0", lineHeight: 1.5 }}>
              <span style={{ color: "var(--soft)" }}>{fmtDateTime(e.at)}</span>{" · "}{e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/* ── Uganda tax chain configuration ── */
function TaxRules() {
  const [rules, setRules] = useState([]);
  const [f, setF] = useState({ name: "", rate: "", mode: "deduct" });
  const [sample, setSample] = useState(100000);
  const load = () => api.get("/settings/tax-rules").then(setRules).catch(() => {});
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!f.name.trim() || f.rate === "") return toast("Enter a name and rate", "bad");
    try { await api.post("/settings/tax-rules", f); setF({ name: "", rate: "", mode: "deduct" }); load(); toast("Tax rule added"); }
    catch (e) { toast(e.message, "bad"); }
  };
  const update = async (r, patch) => {
    try { await api.put(`/settings/tax-rules/${r.id}`, { ...r, ...patch }); load(); }
    catch (e) { toast(e.message, "bad"); }
  };
  const remove = async (r) => {
    if (!(await confirmDialog({ message: `Remove "${r.name}" from the tax chain?`, danger: true, confirmLabel: "Proceed" }))) return;
    await fetch(`/api/settings/tax-rules/${r.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${localStorage.getItem("vy_token")}` } });
    load(); toast("Tax rule removed");
  };

  // Live worked example on the sample amount
  const active = rules.filter((r) => r.is_active).sort((a, b) => a.apply_order - b.apply_order);
  let running = Number(sample) || 0;
  const steps = active.map((r) => {
    const amount = Math.round(running * r.rate) / 100;
    running = Math.round((r.mode === "add" ? running + amount : running - amount) * 100) / 100;
    return { ...r, amount, after: running };
  });

  return (
    <div className="dk-money-grid wide">
      <div className="dk-card flush">
        <div className="dk-card-head"><h3>Tax chain</h3><span className="n dk-n">applied in order</span></div>
        <table className="dk-table">
          <thead><tr><th>#</th><th>Tax</th><th className="r">Rate</th><th>Effect</th><th>Active</th><th style={{ width: 46 }} /></tr></thead>
          <tbody>
            {rules.sort((a, b) => a.apply_order - b.apply_order).map((r, i) => (
              <tr key={r.id}>
                <td className="dk-n dim">{i + 1}</td>
                <td className="strong">{r.name}</td>
                <td className="r dk-n">
                  <input type="number" defaultValue={r.rate} onBlur={(e) => Number(e.target.value) !== r.rate && update(r, { rate: e.target.value })}
                         className="dk-countcell dk-n" style={{ width: 74 }} />%
                </td>
                <td>
                  <select value={r.mode} onChange={(e) => update(r, { mode: e.target.value })}
                          className="dk-input" style={{ height: 34, width: 118, fontSize: 13.5 }}>
                    <option value="deduct">Deduct −</option>
                    <option value="add">Add +</option>
                  </select>
                </td>
                <td>
                  <label className="dk-check">
                    <input type="checkbox" checked={!!r.is_active} onChange={(e) => update(r, { is_active: e.target.checked ? 1 : 0 })} />
                    <span className="box" />
                  </label>
                </td>
                <td className="r"><button className="dk-iconbtn danger" aria-label={`Remove ${r.name}`} onClick={() => remove(r)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, padding: 14, borderTop: "1px solid var(--line)" }}>
          <input className="dk-input" style={{ flex: 2, height: 38 }} placeholder="Tax name — e.g. Local Levy"
                 value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="dk-input dk-n" style={{ width: 96, height: 38 }} type="number" placeholder="Rate %"
                 value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          <select className="dk-input" style={{ width: 118, height: 38 }} value={f.mode}
                  onChange={(e) => setF({ ...f, mode: e.target.value })}>
            <option value="deduct">Deduct</option><option value="add">Add</option>
          </select>
          <button className="dk-addbtn" onClick={add}>Add</button>
        </div>
      </div>

      <div className="dk-card pad" style={{ alignSelf: "start" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 13.5, fontWeight: 650 }}>What that does to a bill</h3>
        <label className="dk-field" style={{ marginBottom: 16 }}>
          <span>Invoice sub total</span>
          <input className="dk-input dk-n" type="number" value={sample} onChange={(e) => setSample(e.target.value)} />
        </label>
        <div>
          <div className="totals-box" style={{ borderTop: "none", paddingTop: 0 }}>
            <div className="totals-row"><span className="lbl">Sub total</span><span className="num">Sh {Number(sample || 0).toLocaleString()}</span></div>
            {steps.map((s, i) => (
              <div className="totals-row" key={i}>
                <span className="lbl">{s.mode === "deduct" ? "−" : "+"} {s.name} ({s.rate}%)</span>
                <span className="num">{s.mode === "deduct" ? "−" : "+"}Sh {s.amount.toLocaleString()}</span>
              </div>
            ))}
            <div className="totals-row grand"><span>Grand total</span><span className="num">Sh {running.toLocaleString()}</span></div>
          </div>
          <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
            Rules apply top-to-bottom on the running total — exactly how every invoice, purchase, and return is computed.
            The chain used at transaction time is stored on each document, so changing rules never rewrites history.
          </p>
        </div>
      </div>
    </div>
  );
}


/* What has been restored into this database, and by whom.
 *
 * A restore used to leave no trace anywhere: no row, no file, no line on any
 * screen. "Everything from last week has gone" and "somebody put Tuesday's
 * backup back on Friday" look identical from the outside and have opposite
 * remedies, and the shopkeeper is the only person who can tell you which it
 * was — but only if the app shows them that it happened. */
function RestoreHistory() {
  const [entries, setEntries] = useState([]);
  const [failed, read] = useRead();
  const load = () => read(api.get("/system/restore-log"), (d) => setEntries(d.entries || []), { entries: [] });
  useEffect(() => { load(); }, []);

  if (failed) return <div style={{ marginTop: 18 }}><LoadFailed what="the restore history" onRetry={load} compact /></div>;
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
      <div className="l" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 10 }}>
        Restores on this machine
      </div>
      {entries.slice(0, 5).map((r, i) => (
        <div key={i} style={{ fontSize: 12.5, color: "var(--faint)", padding: "6px 0", borderBottom: i < 4 && i < entries.length - 1 ? "1px solid var(--line)" : "none" }}>
          <span style={{ color: "var(--soft)" }}>{fmtDateTime(r.at)}</span>
          {" · "}{r.by}{" · from "}<span className="dk-n">{r.source}</span>
          {r.safety_copy && (
            <div className="dk-n" style={{ fontSize: 11.5, fontWeight: 500 }}>
              the data replaced that day is kept as {r.safety_copy}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AutoBackups() {
  const [list, setList] = useState([]);
  useEffect(() => { api.get("/system/backups").then(setList).catch(() => {}); }, []);
  const restore = async (b) => {
    if (!(await confirmDialog({ message: `Restore ${b.name}? Current data will be replaced (a safety copy is kept).`, danger: true, confirmLabel: "Proceed" }))) return;
    try {
      await api.post("/system/restore-file", { name: b.name });
      toast("Restored — reloading");
      setTimeout(() => window.location.reload(), 800);
    } catch (e) { toast(e.message, "bad"); }
  };
  if (!list.length) return null;
  const keep = list.find((b) => b.keep)?.keep || 0;
  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
      <div className="l" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 10 }}>
        Automatic daily backups{keep ? ` — last ${keep} kept` : ""}
      </div>
      {/* "Last 7 kept" over a list of 3 on non-consecutive dates reads as four
         missing backups. A copy is only taken the first time the app runs on a
         given day, so gaps are days the shop never opened it. Say so. */}
      <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: -4, marginBottom: 10 }}>
        {list.length} held. A copy is taken the first time the app runs each day, so days
        it was not opened have no backup.
      </div>
      {/* These sit on the same disk as the live database, so one disk failure
          takes the data and every copy of it with it. Say it once, plainly. */}
      <div style={{ fontSize: 12.5, color: "var(--faint)", marginBottom: 12 }}>
        They are kept on this machine, next to the live data, so one failed disk takes all of
        them together — only the off-site copy above, or a download, survives that.
      </div>
      {list.map((b) => (
        <div key={b.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
          <div style={{ minWidth: 0 }}>
            {/* The day it covers first — that is what someone restoring is
                looking for — with the file name kept underneath so it can be
                matched against the folder on disk. */}
            {/* A pre-restore copy is the state of the books immediately before
                somebody restored, and on the day a restore turns out to have
                been the wrong one it is the most valuable file in this list.
                It must not read as an anonymous "made by hand" copy. */}
            <span style={{ fontSize: 12.5, color: "var(--soft)" }}>
              {b.day ? fmtDate(b.day) : b.name}
              {b.kind === "pre-restore" ? " · the data replaced by a restore" : b.automatic === false ? " · made by hand" : ""}
            </span>
            <div className="dk-n" style={{ fontSize: 11.5, color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis" }}>
              {b.name} · {(b.size / 1024).toFixed(0)} KB{b.taken_at ? ` · taken ${fmtDateTime(b.taken_at)}` : ""}
            </div>
            {/* A missing day is not a lost backup — the shop simply did not
                open the app — but the list should say so rather than look
                like a hole. */}
            {b.gap_before && (
              <div style={{ fontSize: 11.5, color: "var(--faint)" }}>no copy for the day before — the app was not opened</div>
            )}
          </div>
          <button className="dk-minibtn ghost" onClick={() => restore(b)}
                  style={{ color: "var(--danger)", borderColor: "var(--danger)", background: "var(--danger-soft)" }}>Restore</button>
        </div>
      ))}
    </div>
  );
}


/* ── Price lists ───────────────────────────────────────────────────────────
 *
 * A price book is a sheet, and it used to be a form: choose an item from a
 * dropdown of four hundred, type a price, press Set. Building a wholesale list
 * that way is an afternoon of scrolling, and the one figure a person needs
 * while doing it — what the thing cost — appeared nowhere. Setting a selling
 * price without the cost in front of you is guessing.
 *
 * So the whole catalogue comes down at once and is edited in place: search,
 * type over the prices you want to change, save the lot. Cost and the ordinary
 * price sit beside each box, along with the margin the number you are typing
 * would give — which is the question actually being asked.
 *
 * Deactivated items are not here. A price book for things nobody may sell is a
 * longer list to read for no gain.
 */
function PriceLists() {
  const [lists, setLists] = useState([]);
  const [selId, setSelId] = useState(null);
  const [sheet, setSheet] = useState(null);        // {list, rows}
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  /* item_id → what is in the box. Only what has been touched, so saving sends
     the edits and not four hundred unchanged rows. */
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = () => api.get("/settings/price-lists").then((ls) => {
    setLists(ls);
    setSelId((cur) => (cur && ls.some((l) => l.id === cur) ? cur : (ls[0] ? ls[0].id : null)));
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const loadSheet = () => {
    if (!selId) { setSheet(null); return; }
    setFailed(false); setEdits({});
    api.get(`/settings/price-lists/${selId}/sheet`)
      .then(setSheet).catch(() => { setSheet(null); setFailed(true); });
  };
  useEffect(loadSheet, [selId]);

  const create = async () => {
    if (!name.trim()) return toast("Name the price list", "bad");
    try {
      await api.post("/settings/price-lists", { name: name.trim() });
      setName(""); toast("Price list created"); load();
    } catch (e) { toast(e.message, "bad"); }
  };

  const rows = useMemo(() => {
    const all = (sheet && sheet.rows) || [];
    const t = q.trim().toLowerCase();
    return all
      .filter((r) => !onlySet || r.list_price != null || edits[r.item_id] !== undefined)
      .filter((r) => !t || `${r.name} ${r.item_code || ""} ${r.category || ""}`.toLowerCase().includes(t));
  }, [sheet, q, onlySet, edits]);

  const dirty = Object.keys(edits).length;

  const save = async () => {
    if (!dirty) return;
    setBusy(true);
    try {
      const prices = Object.entries(edits).map(([item_id, v]) => ({
        item_id: Number(item_id),
        price: String(v).trim() === "" ? null : Number(v),
      }));
      const r = await api.put(`/settings/price-lists/${selId}/items`, { prices });
      toast(r.message || "Saved");
      loadSheet();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  /* What the number in the box would earn on each one sold. The reason the
     cost is on screen at all. */
  const marginOf = (r) => {
    const raw = edits[r.item_id] !== undefined ? edits[r.item_id] : r.list_price;
    const price = Number(raw === null || raw === "" ? r.default_price : raw) || 0;
    const cost = Number(r.cost) || 0;
    if (!cost || !price) return null;
    return Math.round(((price - cost) / cost) * 100);
  };

  return (
    <div className="dk-md">
      <div className="dk-card flush">
        <div className="dk-listhead">
          <input className="dk-input" placeholder="Name a new list…" value={name}
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && create()} />
          <button className="dk-addbtn" onClick={create}>+ Add</button>
        </div>
        <div className="dk-list dk-s">
          {lists.length === 0 ? (
            <div className="dk-empty">
              No price lists yet. A list is a set of prices you give to some customers —
              wholesale, staff, a big account — and it applies to everything they buy.
            </div>
          ) : lists.map((l) => (
            <div key={l.id} role="button" tabIndex={0}
                 className={`dk-row ${selId === l.id ? "on" : ""}`}
                 onClick={() => setSelId(l.id)}
                 onKeyDown={(e) => { if (e.key === "Enter") setSelId(l.id); }}>
              <div className="main"><div className="nm">{l.name}</div></div>
              <button className="icon-btn" title={`Delete ${l.name}`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!(await confirmDialog({
                          title: `Delete ${l.name}?`,
                          message: "The prices in it go with it.",
                          detail: "Customers on this list go back to ordinary prices. Nothing already invoiced changes.",
                          danger: true, confirmLabel: "Delete",
                        }))) return;
                        try { await api.delete(`/settings/price-lists/${l.id}`); toast("Price list removed"); load(); }
                        catch (err) { toast(err.message, "bad"); }
                      }}>✕</button>
            </div>
          ))}
        </div>
      </div>

      <div className="dk-detail dk-s">
        {failed ? (
          <div className="dk-card"><LoadFailed what="this price list" onRetry={loadSheet} /></div>
        ) : !selId ? (
          <div className="dk-card"><div className="dk-empty">Make a list on the left to start.</div></div>
        ) : !sheet ? (
          <div className="dk-card"><div className="dk-empty">Reading the catalogue…</div></div>
        ) : (
          <div className="dk-card flush">
            <div className="dk-card-head">
              <h3>{sheet.list.name}</h3>
              <span className="sub" style={{ marginLeft: 10 }}>
                {sheet.rows.filter((r) => r.list_price != null).length} of {sheet.rows.length} priced
              </span>
            </div>

            <div className="list-filters no-print">
              <input placeholder="Find an item…" value={q} onChange={(e) => setQ(e.target.value)} />
              <label className="dk-inactive-toggle">
                <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
                <span>Only the ones I have priced</span>
              </label>
              <div className="spacer" style={{ flex: 1 }} />
              {dirty > 0 && (
                <button className="btn btn-ghost" onClick={() => setEdits({})}>Undo {dirty} change{dirty === 1 ? "" : "s"}</button>
              )}
              <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
                {busy ? "Saving…" : dirty ? `Save ${dirty} price${dirty === 1 ? "" : "s"}` : "Saved"}
              </button>
            </div>

            <div className="dk-scrollx">
              <table className="dk-table pl-sheet">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="amt">Cost</th>
                    <th className="amt">Ordinary price</th>
                    <th className="amt">This list</th>
                    <th className="amt">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={5}><Empty icon="○" title="Nothing matches"
                          sub={onlySet ? "Nothing on this list has a price yet." : "No item matches that search."} /></td></tr>
                  ) : rows.map((r) => {
                    const val = edits[r.item_id] !== undefined ? edits[r.item_id]
                      : (r.list_price == null ? "" : r.list_price);
                    const m = marginOf(r);
                    return (
                      <tr key={r.item_id} className={edits[r.item_id] !== undefined ? "is-dirty" : ""}>
                        <td>
                          <b>{r.name}</b>
                          <div style={{ fontSize: 12, color: "var(--faint)" }}>
                            {[r.item_code, r.category, r.unit].filter(Boolean).join(" · ") || "—"}
                          </div>
                        </td>
                        <td className="amt dk-n" style={{ color: "var(--faint)" }}>{inr(r.cost)}</td>
                        <td className="amt dk-n" style={{ color: "var(--faint)" }}>{inr(r.default_price)}</td>
                        <td className="amt">
                          <input className="cell-input dk-n" type="number" value={val}
                                 placeholder={String(inr(r.default_price))}
                                 aria-label={`Price of ${r.name} on this list`}
                                 onChange={(e) => setEdits((x) => ({ ...x, [r.item_id]: e.target.value }))} />
                        </td>
                        <td className={`amt dk-n ${m == null ? "" : m < 0 ? "amt-overdue" : m < 10 ? "amt-owed" : "amt-received"}`}>
                          {m == null ? "—" : `${m}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="cp-foot-note">
              An empty box means the ordinary price — which is not the same as typing the ordinary
              price in, and behaves differently the day that price changes.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


/* ── About & updates: version, environment, how to update ── */
function AppUpdater() {
  const [data, setData] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const load = () => api.get("/system/updates").then(setData).catch(() => setData({ history: [] }));
  useEffect(() => { load(); }, []);

  const install = async () => {
    if (!file) return toast("Choose a release .zip first", "bad");
    if (!/\.zip$/i.test(file.name)) return toast("The update must be a .zip file", "bad");
    if (!(await confirmDialog({ message: `Install ${file.name}?\n\nYour data (invoices, stock, settings) is never touched, and the files being replaced are backed up so you can roll back.`, danger: true, confirmLabel: "Proceed" }))) return;
    setBusy(true); setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const token = localStorage.getItem("vy_token");
      const r = await fetch(`/api/system/update?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip", Authorization: "Bearer " + token },
        body: buf,
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.message || "Update failed");
      setResult(j.data);
      toast(`Updated to ${j.data.version_to}`);
      setFile(null);
      load();
    } catch (e) { toast(e.message, "bad"); setResult({ error: e.message }); }
    setBusy(false);
  };

  const rollback = async (row) => {
    if (!(await confirmDialog({ message: `Roll back to version ${row.version_from}? The files from that update will be restored.`, danger: true, confirmLabel: "Proceed" }))) return;
    try { const r = await api.post(`/system/updates/${row.id}/rollback`, {}); toast(r.message || "Rolled back"); load(); }
    catch (e) { toast(e.message, "bad"); }
  };

  const STATUS = { applied: "pill-ok", failed: "pill-bad", rolled_back: "pill-muted" };

  return (
    <>
      <div className="dk-card w-mid" style={{ marginBottom: 20 }}>
        <div className="dk-card-head"><h3>Update this app</h3></div>
        <div style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 13.5, marginBottom: 12 }}>
            Currently running <b className="num">version {data?.current_version || "…"}</b>.
            Choose the release <b>.zip</b> you were sent and install it here — no command line needed.
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="btn btn-ghost" style={{ cursor: "pointer" }}>
              📁 Choose file…
              <input type="file" accept=".zip,application/zip" style={{ display: "none" }}
                     onChange={(e) => { setFile(e.target.files[0] || null); setResult(null); }} />
            </label>
            <span style={{ fontSize: 13.5, color: file ? "var(--text)" : "var(--muted)" }}>
              {file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : "No file chosen"}
            </span>
            <button className="btn btn-primary" onClick={install} disabled={!file || busy} style={{ marginLeft: "auto" }}>
              {busy ? "Installing…" : "Install update"}
            </button>
          </div>

          {result && !result.error && (
            <div style={{ marginTop: 14, background: "var(--ok-bg)", border: "1px solid var(--ok)", borderRadius: 10, padding: "12px 14px" }}>
              <b>✓ Updated {result.version_from} → {result.version_to}</b>
              <div style={{ fontSize: 13.5, marginTop: 4 }}>{result.files} file(s) replaced. {result.note}</div>
              {result.deps_changed && (
                <div style={{ fontSize: 13.5, marginTop: 6, fontWeight: 700, color: "var(--warn)" }}>
                  ⚠ This release changed its dependencies — close the app and run <span className="num">update.bat</span> before starting again.
                </div>
              )}
            </div>
          )}
          {result?.error && (
            <div style={{ marginTop: 14, background: "var(--bad-bg)", border: "1px solid var(--bad)", borderRadius: 10, padding: "12px 14px", fontSize: 13.5 }}>
              <b>Update failed.</b> {result.error} — nothing was changed.
            </div>
          )}

          <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
            Your business data lives in <b>backend/data</b> and is never overwritten by an update.
            The replaced files are backed up first, so any update on the list below can be rolled back.
          </p>
        </div>
      </div>

      <div className="dk-card flush w-mid">
        <div className="dk-card-head"><h3>Update history</h3></div>
        <table className="dk-table">
          <thead><tr><th>When</th><th>Version</th><th>File</th><th>By</th><th>Status</th><th style={{ width: 44 }} /></tr></thead>
          <tbody>
            {!data ? <SkeletonRows rows={3} cols={6} /> : data.history.length === 0 ? (
              <tr><td colSpan={6}><Empty icon="⬆" title="No updates yet" hint="Installed updates will be listed here." /></td></tr>
            ) : data.history.map((h) => (
              <tr key={h.id} className="hl">
                <td className="num">{String(h.created_at).slice(0, 16).replace("T", " ")}</td>
                <td className="num">{h.version_from || "—"} → <b>{h.version_to || "—"}</b></td>
                <td style={{ fontSize: 12.5, fontWeight: 500 }}>{h.filename}{h.size_bytes ? <span style={{ color: "var(--muted)" }}> · {(h.size_bytes / 1048576).toFixed(1)} MB</span> : null}
                  {h.note ? <div style={{ color: "var(--muted)", fontSize: 11.5 }}>{h.note}</div> : null}</td>
                <td style={{ fontSize: 12.5, fontWeight: 500 }}>{h.applied_by_name || "—"}</td>
                <td><span className={`pill ${STATUS[h.status] || "pill-muted"}`}>{String(h.status).replace("_", " ")}</span></td>
                <td style={{ textAlign: "right" }}>
                  <RowMenu actions={[
                    { icon: <Icon n="undo" />, label: "Roll back", disabled: h.status !== "applied" || !h.backup_dir,
                      hint: !h.backup_dir ? "no backup kept" : h.status !== "applied" ? "already rolled back" : "",
                      onClick: () => rollback(h) },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Sign-in security ─────────────────────────────────────────────────────
 *
 * Two things live here, and they are the two halves of the same mechanism.
 *
 * **Devices** are what makes the emailed code bearable: it is asked for once
 * per machine, not once per morning. That is also the risk, so this is the
 * screen where somebody who has lost a laptop takes its trust away — and it
 * has to be usable in a hurry, by somebody upset, which is why "Sign out
 * everything" is a single button and not a walk through a list.
 *
 * **Backup codes** are the way in when the email does not arrive. The count is
 * shown rather than the codes, because the codes cannot be shown: they are
 * stored hashed and the server genuinely cannot read them back. Printing a new
 * sheet is therefore a replacement, never a reminder, and the screen says so
 * before anybody presses it.
 */
function SignInSecurity() {
  const { data, err, reload } = useRead("/auth/devices");
  const [codes, setCodes] = useState(null);
  const [pw, setPw] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (err) return <LoadFailed what="your sign-in security" onRetry={reload} />;
  if (!data) return <div className="dk-empty">Reading…</div>;
  if (!data.supported) {
    /* Counter staff sign in with a username or a PIN against one shop; the
       second factor belongs to an account, which is the thing that owns
       businesses and has an address to send a code to. Saying which is more
       use than an empty list. */
    return (
      <SettingSection title="Sign-in security">
        <div className="dk-empty">
          This is for the account that owns the business — the one that signs in with an email
          address. You are signed in as counter staff on this shop, so there is nothing here.
        </div>
      </SettingSection>
    );
  }

  const revoke = async (d) => {
    const ok = await confirmDialog({
      title: "Sign this device out?",
      message: `${d.label} will be asked for an emailed code the next time it signs in.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try { await api.delete(`/auth/devices/${d.id}`); toast("Device removed"); reload(); }
    catch (e) { toast(e.message || "That did not work"); }
  };

  const revokeAll = async () => {
    const ok = await confirmDialog({
      title: "Ask every device for a code?",
      message: "Every computer and phone, including this one, will need a code from your email the next time it signs in.",
      detail: "Do this if a device has been lost or stolen.",
      danger: true,
      confirmLabel: "Sign out everything",
    });
    if (!ok) return;
    try { await api.post("/auth/devices/revoke-all", {}); toast("Every device will be asked for a code"); reload(); }
    catch (e) { toast(e.message || "That did not work"); }
  };

  const makeCodes = async () => {
    setBusy(true);
    try {
      const d = await api.post("/auth/backup-codes", { password: pw });
      setCodes(d.codes); setAsking(false); setPw(""); reload();
    } catch (e) { toast(e.message || "That did not work"); }
    setBusy(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <SettingSection title="Devices that do not need a code"
        hint={`A device is asked for an emailed code the first time it signs in, then trusted for ${data.trust_days || 30} days. Remove any you do not recognise.`}>
        {!data.rows.length ? (
          <div className="dk-empty">No device has been remembered yet.</div>
        ) : (
          <table className="dk-table">
            <thead><tr><th>Device</th><th>Last used</th><th>Trusted until</th><th /></tr></thead>
            <tbody>
              {data.rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.label || "Unknown device"}</td>
                  <td className="dk-n">{d.last_seen_at ? fmtDateTime(d.last_seen_at) : "—"}</td>
                  <td className="dk-n">{d.expired ? "Expired" : fmtDate(d.expires_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="dk-btn ghost sm" onClick={() => revoke(d)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.rows.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button className="dk-btn danger" onClick={revokeAll}>Sign out every device</button>
          </div>
        )}
      </SettingSection>

      <SettingSection title="Backup codes"
        hint="Single-use codes that let you sign in when your email is unavailable. Keep the printed sheet where you keep the shop's papers.">
        {codes ? (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: 14.5, fontWeight: 650, letterSpacing: ".04em",
                          background: "var(--sunk, rgba(127,127,127,.08))", borderRadius: 10,
                          padding: "14px 16px", maxWidth: 340 }}>
              {codes.map((c) => <div key={c}>{c}</div>)}
            </div>
            <p className="dk-hint" style={{ marginTop: 10 }}>
              This is the only time these can be shown. Print them now — the codes you had before no longer work.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="dk-btn" onClick={() => window.print()}>Print</button>
              <button className="dk-btn ghost" onClick={() => setCodes(null)}>Done</button>
            </div>
          </div>
        ) : asking ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 340 }}>
            {/* The password is asked for again even though this session is already
                signed in: printing a sheet hands over ten ways past the code step,
                and a till left open on a counter should not be one of them. */}
            <Field label="Your password" hint="Asked again because these codes get past the sign-in code.">
              <input type="password" value={pw} autoFocus autoComplete="current-password"
                     onChange={(e) => setPw(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && pw && makeCodes()} />
            </Field>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="dk-btn primary" disabled={!pw || busy} onClick={makeCodes}>
                {busy ? "Working…" : "Print new codes"}
              </button>
              <button className="dk-btn ghost" onClick={() => { setAsking(false); setPw(""); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div>
            <p className="dk-hint" style={{ marginTop: 0 }}>
              {data.backup_codes_left > 0
                ? `${data.backup_codes_left} of 10 unused.`
                : "None left. Print a new sheet, or a mail problem will leave you locked out."}
            </p>
            <button className="dk-btn" onClick={() => setAsking(true)}>
              {data.backup_codes_left > 0 ? "Print a new sheet" : "Print backup codes"}
            </button>
            {data.backup_codes_left > 0 && (
              <p className="dk-hint">Printing a new sheet stops the old one working.</p>
            )}
          </div>
        )}
      </SettingSection>
    </div>
  );
}

/* Which server this copy talks to — shown only in the packaged phone app,
   because that is the only build where it is a question. A browser and the
   desktop were served by the server they talk to. It lives on this page
   rather than under sign-in because it is a fact about this installation, and
   because somebody looking for "why can this phone not see today's sales"
   comes to About before anywhere else. */
function ServerAddress() {
  const [editing, setEditing] = useState(false);
  if (!isNative()) return null;
  if (editing) {
    return (
      <div className="dk-card w-mid" style={{ marginBottom: 16 }}>
        <div style={{ padding: 18 }}>
          <React.Suspense fallback={<div className="dk-empty">Loading…</div>}>
            <ConnectServerPane
              current={savedServer()}
              onDone={() => window.location.reload()}
              onCancel={() => setEditing(false)}
            />
          </React.Suspense>
        </div>
      </div>
    );
  }
  return (
    <div className="dk-card w-mid" style={{ marginBottom: 16 }}>
      <div className="dk-card-head"><h3>This phone talks to</h3></div>
      <div style={{ padding: "18px 24px" }}>
        <div className="dk-n" style={{ fontWeight: 650, wordBreak: "break-all" }}>
          {savedServer() || "Not set"}
        </div>
        <p className="dk-hint" style={{ marginTop: 8 }}>
          Your shop's server. It is the server that holds the books — this app only shows them.
        </p>
        <button className="dk-btn" onClick={() => setEditing(true)}>Change</button>
      </div>
    </div>
  );
}

function About() {
  const [info, setInfo] = useState(null);
  useEffect(() => { api.get("/system/info").then(setInfo).catch(() => setInfo({})); }, []);
  if (!info) return null;
  return (
    <>
      <ServerAddress />
      <AppUpdater />
    <div className="dk-card w-mid">
      <div className="dk-card-head"><h3>About this software</h3></div>
      <div style={{ padding: "22px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <div style={{ width: 54, height: 54, borderRadius: 14, background: "var(--accent)", color: "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--disp)", fontWeight: 750, fontSize: 19 }}>S</div>
          <div>
            <div style={{ fontWeight: 750, fontSize: 19, letterSpacing: "-.015em" }}>{info.app || "Genius POS"}</div>
            <div style={{ color: "var(--faint)", fontSize: 13.5 }} className="dk-n">
              Version {info.version} · Node {info.node} · {info.platform === "win32" ? "Windows" : info.platform}
              {info.db_size ? <> · data {(info.db_size / 1024).toFixed(0)} KB</> : null}
            </div>
          </div>
        </div>
        {info.lan_ip && (
          <div style={{ background: "var(--accent-soft)", borderRadius: 11, padding: "13px 15px", marginBottom: 16, fontSize: 13.5 }}>
            <b>Use on other devices on the same Wi-Fi</b>
            <div className="dk-n" style={{ marginTop: 5, fontWeight: 650 }}>http://{info.lan_ip}:{info.port}</div>
            <div className="num">Online store for customers: http://{info.lan_ip}:{info.port}/store</div>
            <div style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 6, lineHeight: 1.55 }}>Enable the store under Settings → Online store. If other devices can't connect, allow Node.js in Windows Firewall.</div>
          </div>
        )}
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 10 }}>How to update</div>
        {(info.update_howto || []).map((s, i) => (
          <div key={i} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 13.5 }}>{s}</div>
        ))}
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 12 }}>
          Updates never touch your data — invoices, stock, and settings live in <b>backend/data</b>,
          which <b>update.bat</b> backs up and restores automatically. A daily auto-backup (last 7 kept)
          also runs under Settings → Backup.
        </p>
      </div>
    </div>
    </>
  );
}
const A4_THEMES = [
  { id: "tally", name: "Tally" }, { id: "modern", name: "Modern" },
  { id: "compacta4", name: "Compact" }, { id: "taxinv", name: "Tax" },
  { id: "classic", name: "Classic" }, { id: "minimal6", name: "Minimal" },
];
const TH_THEMES = [
  { id: "compact", name: "Compact" }, { id: "spacious", name: "Spacious" },
  { id: "bold", name: "Bold" }, { id: "minimal", name: "Minimal" },
  { id: "stars", name: "Stars ✦" }, { id: "dotted", name: "Dotted" },
  { id: "semantic", name: "Semantic" },
];

/**
 * ThemeThumb — a small drawing of what each layout actually looks like.
 *
 * Every theme card used to render the same five grey bars, so all six looked
 * identical and there was no way to tell the layouts apart before picking one.
 * These mirror the real headers, rules and table styling of each theme.
 */
function ThemeThumb({ id }) {
  const bar = (style) => <i style={style} />;
  const A4 = {
    tally: (
      <><i className="t" style={{ borderBottom: "2px solid #444", height: 6, width: "100%", background: "none" }} />
        <i style={{ background: "#dfe3ec", height: 5 }} /><i /><i /><i className="r" /></>),
    modern: (
      <><i className="t" style={{ background: "#F47B20", height: 11, width: "100%", borderRadius: 3 }} />
        <i style={{ background: "#FCE3CE", height: 5 }} /><i /><i /><i className="r" style={{ background: "#FBE0C6" }} /></>),
    compacta4: (
      <><i className="t" style={{ height: 4, width: "45%", margin: 0 }} />
        <i style={{ height: 2.5 }} /><i style={{ height: 2.5 }} /><i style={{ height: 2.5 }} />
        <i style={{ height: 2.5 }} /><i style={{ height: 2.5 }} /><i className="r" style={{ height: 5 }} /></>),
    taxinv: (
      <><i className="t" style={{ background: "#1E2430", height: 8, width: "70%", borderRadius: 2 }} />
        <i style={{ background: "#1E2430", height: 5 }} /><i /><i /><i className="r" /></>),
    classic: (
      <><i className="t" style={{ height: 5, width: "55%", background: "#8a92a6" }} />
        <i style={{ height: 1.5, background: "#444" }} /><i style={{ height: 1.5, background: "#444", marginTop: -1 }} />
        <i /><i /><i className="r" /></>),
    minimal6: (
      <><i className="t" style={{ height: 3, width: "38%", background: "#c9ced9", margin: "2px auto 6px" }} />
        <i style={{ height: 2, background: "#111" }} /><i style={{ height: 2 }} /><i style={{ height: 2 }} />
        <i className="r" style={{ background: "#f2f3f7" }} /></>),
  };
  const TH = {
    compact: (<><i className="t" style={{ width: "70%" }} /><i /><i /><i /><i className="r" /></>),
    spacious: (<><i className="t" style={{ width: "70%", marginBottom: 3 }} />
      <i style={{ marginBottom: 3 }} /><i style={{ marginBottom: 3 }} /><i className="r" /></>),
    bold: (<><i className="t" style={{ height: 8, width: "80%", background: "#5b6377" }} />
      <i style={{ height: 5, background: "#8a92a6" }} /><i style={{ height: 5, background: "#8a92a6" }} />
      <i className="r" style={{ height: 9, background: "#c9ced9" }} /></>),
    minimal: (<><i className="t" style={{ height: 3, width: "50%" }} />
      <i style={{ height: 2 }} /><i style={{ height: 2 }} /><i style={{ height: 2 }} /><i className="r" style={{ background: "#f2f3f7" }} /></>),
    stars: (<><i className="t" style={{ width: "60%" }} />
      <span className="tt-txt">✦ ✦ ✦</span><i /><i /><i className="r" /></>),
    dotted: (<><i className="t" style={{ width: "65%" }} />
      <i style={{ background: "none", borderTop: "2px dotted #b9c0cf", height: 0 }} /><i />
      <i style={{ background: "none", borderTop: "2px dotted #b9c0cf", height: 0 }} /><i className="r" /></>),
    semantic: (<><i className="t" style={{ height: 4, width: "70%", background: "#333", margin: "0 auto 2px" }} />
      <i style={{ height: 2, background: "#111" }} /><i style={{ height: 2 }} /><i style={{ height: 2 }} />
      <i style={{ background: "none", borderTop: "1px dashed #999", height: 0, margin: "2px 0" }} />
      <i className="r" style={{ height: 6, background: "#5b6377" }} /></>),
  };
  return <div className="theme-thumb">{(A4[id] || TH[id]) ?? <><i className="t" /><i /><i /><i className="r" /></>}</div>;
}

function PrintSettings() {
  const [mode, setMode] = useState("regular");
  const [v, setV] = useState(null);
  const [saved, setSaved] = useState(false);
  // NOTE: every hook must run on every render. Keeping this above the `if (!v)`
  // guard below — it used to sit further down, so the hook count changed once
  // the fetch resolved and React threw #310.
  const [builder, setBuilder] = useState(false);
  useEffect(() => { api.get("/settings").then((d) => setV(d.values || {})).catch(() => setV({})); }, []);
  if (!v) return null;
  const set = (k, val) => { setV((s) => ({ ...s, [k]: val })); setSaved(false); };
  const on = (k, dflt) => (v[k] ?? dflt) === "1" || (v[k] ?? dflt) === true;
  const save = async () => {
    await api.put("/settings", v);
    // keep printer_type consistent with the chosen mode + paper
    const pt = mode === "thermal" ? (v.print_paper === "2in" ? "thermal-2in" : "thermal-3in") : "regular";
    await api.put("/settings", { printer_type: pt });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const Toggle2 = ({ k, label, dflt = "0" }) => (
    <label className="switch"><input type="checkbox" checked={on(k, dflt)} onChange={(e) => set(k, e.target.checked ? "1" : "0")} /><span className="sw-track" /><span>{label}</span></label>
  );

  return (
    <div className="dk-card flush" style={{ overflow: "hidden" }}>
      <div className="dk-tablehead">
        <div className="dk-seg2">
          <button className={mode === "regular" ? "on" : ""} onClick={() => setMode("regular")}>Regular printer</button>
          <button className={mode === "thermal" ? "on" : ""} onClick={() => setMode("thermal")}>Thermal printer</button>
        </div>
        <div className="spacer" />
        <button className="dk-sbtn primary" onClick={save}>{saved ? "Saved" : "Save changes"}</button>
      </div>

      {builder && (
        <React.Suspense fallback={null}>
          <InvoiceTemplateDesigner onClose={() => setBuilder(false)} onSaved={() => api.get("/settings").then((d) => setV(d.values || {})).catch(() => {})} />
        </React.Suspense>
      )}
      <div className="print-wrap" style={{ border: "none", borderRadius: 0 }}>
        <div className="print-side">
          {mode === "regular" && (
            <>
              <h4>Custom layout</h4>
              <button className="dk-sbtn primary" style={{ width: "100%", justifyContent: "center", marginBottom: 8 }}
                      onClick={() => setBuilder(true)}>
                ✎ Custom Invoice Builder
              </button>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
                {v.print_theme_regular === "custom"
                  ? "Your custom template is what invoices print with. Pick a theme below to go back to a built-in one."
                  : "Design your own layout — sections, placeholders, columns and colours, with a live preview."}
              </div>
            </>
          )}
          <h4>Change layout</h4>
          <div className="themes">
            {(mode === "regular" ? A4_THEMES : TH_THEMES).map((t) => {
              const key = mode === "regular" ? "print_theme_regular" : "print_theme_thermal";
              const active = (v[key] || (mode === "regular" ? "tally" : "compact")) === t.id;
              return (
                <button key={t.id} className={`theme-card ${active ? "on" : ""}`} onClick={() => set(key, t.id)}>
                  <ThemeThumb id={t.id} />
                  <span>{t.name}</span>
                </button>
              );
            })}
          </div>

          <h4>Default printer</h4>
          <PrinterPicker v={v} set={set} mode={mode} />

          {mode === "thermal" && (
            <>
              <h4>Paper size</h4>
              <div className="seg-paper">
                {[["2in", "2 inch", "58mm"], ["3in", "3 inch", "80mm"], ["4in", "4 inch", "112mm"]].map(([id, a, b]) => (
                  <button key={id} className={(v.print_paper || "3in") === id ? "on" : ""} onClick={() => set("print_paper", id)}>{a}<small>{b}</small></button>
                ))}
              </div>
            </>
          )}

          <h4>Company info / header</h4>
          <Toggle2 k="print_show_logo" label="Company logo" />
          <Toggle2 k="print_show_phone" label="Phone number" dflt="1" />
          <Toggle2 k="print_show_email" label="Email" />
          <Toggle2 k="print_show_address" label="Address" dflt="1" />
          <Toggle2 k="print_show_tin" label="Tax number (TIN)" dflt="1" />
          {mode === "regular" && <Toggle2 k="print_repeat_header" label="Repeat header on every page" dflt="1" />}

          <h4>Body</h4>
          <Toggle2 k="print_show_taxes" label="Tax breakdown" dflt="1" />
          <Toggle2 k="print_show_received" label="Received & balance" dflt="1" />
          <Toggle2 k="print_show_barcode" label="Receipt barcode (for scan lookup)" dflt="1" />
          <Toggle2 k="print_show_sno" label="Serial numbers (S.No)" dflt="1" />
          <Toggle2 k="print_show_uom" label="Unit of measure" dflt="1" />
          <Toggle2 k="print_show_desc" label="Item descriptions (code / notes)" />
          <Toggle2 k="print_show_batch" label="Batch numbers" />
          <Toggle2 k="print_show_expiry" label="Expiry dates" />

          <h4>Footer</h4>
          <Field label="Footer note">
            <input value={v.print_footer_note || ""} onChange={(e) => set("print_footer_note", e.target.value)} />
          </Field>
          <Field label="Terms & conditions">
            <textarea rows={2} value={v.print_terms || ""} onChange={(e) => set("print_terms", e.target.value)} />
          </Field>

          <h4>Test</h4>
          <button className="dk-sbtn" onClick={async () => {
            const { printInvoice } = await import("../lib/print.js");
            printInvoice({
              invoice_no: "TEST-0001", invoice_date: new Date().toISOString().slice(0, 10),
              payment_type: "cash", sub_total: 97500, grand_total: 75153, paid_amount: 75153, balance_due: 0,
              round_off: 0, taxes: [{ name: "Income Tax (WHT)", rate: 6, mode: "deduct", amount: 5850 },
                                    { name: "VAT", rate: 18, mode: "add", amount: 16497 }],
              lines: [
                { description: "Cement 50kg Bag", quantity: 2, unit: "BAG", rate: 42000, line_total: 84000 },
                { description: "Sugar 1kg", quantity: 3, unit: "KG", rate: 4500, line_total: 13500 },
              ],
            }, "Sample Customer", mode === "regular" ? "invoice" : "pos");
          }}><Icon n="print" size={15} /> Test print this layout</button>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "6px 2px 0" }}>
            Prints a sample {mode === "regular" ? "A4 invoice" : "thermal receipt"} using the settings above — handy when setting up a new printer.
          </p>

          <h4>Default printer per document</h4>
          <Field label="POS sale — print as">
            <select value={v.print_default_pos || "thermal"} onChange={(e) => set("print_default_pos", e.target.value)}>
              <option value="thermal">Thermal receipt</option><option value="regular">A4 / regular</option>
            </select>
          </Field>
          <Field label="Sales invoice — print as">
            <select value={v.print_default_invoice || "regular"} onChange={(e) => set("print_default_invoice", e.target.value)}>
              <option value="regular">A4 / regular</option><option value="thermal">Thermal receipt</option>
            </select>
          </Field>
          <Field label="Purchase bill — print as">
            <select value={v.print_default_purchase || "regular"} onChange={(e) => set("print_default_purchase", e.target.value)}>
              <option value="regular">A4 / regular</option><option value="thermal">Thermal receipt</option>
            </select>
          </Field>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "2px 2px 0" }}>Controls which format each screen prints — e.g. the POS sends thermal to the counter printer while sales invoices go to A4.</p>

          <h4>Printing</h4>
          {/* Two settings that had no control anywhere. `print_preview` decides
              whether a document is shown before it goes to paper — it is read
              by lib/print.js on every single print — and `print_levy_pct` adds
              a service levy line to receipts. Both were in the catalogue,
              honoured by the code, and unreachable from any screen. */}
          <Field label="Show a preview before printing">
            <select value={v.print_preview || "documents"} onChange={(e) => set("print_preview", e.target.value)}>
              <option value="documents">For invoices and vouchers, not at the till</option>
              <option value="always">Always</option>
              <option value="never">Never — send straight to the printer</option>
            </select>
          </Field>
          <Field label="Service levy % on receipts">
            <input type="number" min="0" value={v.print_levy_pct || "0"}
                   onChange={(e) => set("print_levy_pct", e.target.value)} />
          </Field>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "2px 2px 12px" }}>
            Zero switches the levy off. It appears on the receipt themes that carry one.
          </p>
          {/* Where the "print this?" prompt is turned off, and the only place
              it can be turned back on. The dialog writes this key itself when
              somebody ticks "don't ask again", so a shopkeeper who switches it
              off by accident has one findable way back. */}
          <Field label="After saving a transaction">
            <select value={v.print_after_save || "ask"} onChange={(e) => set("print_after_save", e.target.value)}>
              <option value="ask">Ask whether to print</option>
              <option value="always">Print straight away</option>
              <option value="never">Never print</option>
            </select>
          </Field>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "2px 2px 12px" }}>
            Applies to every saved sale, purchase, payment and expense. The till's
            own “Confirm &amp; print” always prints, whatever this says.
          </p>
          <div className="row2">
            <Field label="Number of copies">
              <input type="number" min="1" value={v.print_copies || "1"} onChange={(e) => set("print_copies", e.target.value)} />
            </Field>
            <div style={{ alignSelf: "end", paddingBottom: 8 }}>
              <Toggle2 k="print_open_drawer" label="Open drawer after print" />
            </div>
          </div>
        </div>

        <div className="print-preview">
          {mode === "regular" ? <PreviewA4 v={v} on={on} /> : <PreviewThermal v={v} on={on} />}
        </div>
      </div>
    </div>
  );
}

/**
 * PrinterPicker — choose which printer this format goes to.
 *
 * The desktop app can list the real printers and print straight to the one you
 * pick. A browser cannot: window.print() hands over to the browser's own
 * dialog, and no page is allowed to choose the printer for you. Rather than
 * showing a control that quietly does nothing, we say so and let you set the
 * preference for when the shop moves to the desktop app.
 */
function PrinterPicker({ v, set, mode }) {
  const key = mode === "regular" ? "print_printer_regular" : "print_printer_thermal";
  const [printers, setPrinters] = useState(null);   // null = still asking
  const bridge = typeof window !== "undefined" ? window.geniusPrint : null;

  useEffect(() => {
    if (!bridge) { setPrinters([]); return; }
    bridge.listPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [bridge]);

  const chosen = v[key] || "";

  if (!bridge) {
    return (
      <div className="printer-note">
        <select value={chosen} onChange={(e) => set(key, e.target.value)}>
          <option value="">Ask me each time (browser print dialog)</option>
          {chosen && <option value={chosen}>{chosen}</option>}
        </select>
        <p>
          You're running in a web browser, which doesn't let a page choose the
          printer — the browser's own dialog decides. Your choice is saved and
          will be used automatically in the desktop app.
        </p>
      </div>
    );
  }

  return (
    <div className="printer-note">
      <select value={chosen} onChange={(e) => set(key, e.target.value)}>
        <option value="">Ask me each time (show the print dialog)</option>
        {(printers || []).map((p) => (
          <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? " — system default" : ""}</option>
        ))}
      </select>
      {printers === null && <p>Looking for printers…</p>}
      {printers && printers.length === 0 && <p>No printers found. Check the printer is installed and switched on.</p>}
      {chosen && (
        <label className="printer-silent">
          <input type="checkbox" checked={v.print_silent === "1"}
                 onChange={(e) => set("print_silent", e.target.checked ? "1" : "0")} />
          <span>Print straight away, no dialog <small>— best for a busy till</small></span>
        </label>
      )}
    </div>
  );
}

function PreviewA4({ v, on }) {
  const line = { display: "flex", justifyContent: "space-between", padding: "2px 0" };
  const theme = v.print_theme_regular || "tally";
  const TH = {
    tally:     { hd: { borderBottom: "2.5px solid #333" }, th: { background: "#f2f4fa", color: "#333" }, title: "TAX INVOICE", titleStyle: {} },
    modern:    { hd: { background: "#F47B20", color: "#fff", borderRadius: 8, padding: "12px 14px" }, th: { background: "#FEF0E5", color: "#8a4a12" }, title: "INVOICE", titleStyle: { color: "#F47B20" } },
    compacta4: { hd: { borderBottom: "1.5px solid #555" }, th: { background: "#eee", color: "#333" }, title: "INVOICE", titleStyle: { fontSize: 13.5 }, small: true },
    taxinv:    { hd: { borderBottom: "3px solid #1E2430" }, th: { background: "#1E2430", color: "#fff" }, title: "TAX INVOICE", titleStyle: { background: "#1E2430", color: "#fff", display: "inline-block", padding: "3px 12px", letterSpacing: 1 } },
    classic:   { hd: { borderBottom: "3px double #333", textAlign: "center" }, th: { borderBottom: "2px solid #333", fontStyle: "italic" }, title: "Invoice", titleStyle: { fontVariant: "small-caps" }, serif: true },
    minimal6:  { hd: { borderBottom: "1px solid #eee" }, th: { borderBottom: "2px solid #111", textTransform: "uppercase" }, title: "INVOICE", titleStyle: { color: "#999", fontWeight: 400, letterSpacing: 3, fontSize: 11.5 } },
  }[theme] || {};
  const headerCenter = theme === "classic";
  return (
    <div className="pp-paper pp-a4" style={{ fontFamily: TH.serif ? "Georgia,serif" : undefined, fontSize: TH.small ? 10.5 : undefined }}>
      <div style={{ display: headerCenter ? "block" : "flex", justifyContent: "space-between", gap: 10, paddingBottom: 8, marginBottom: 8, textAlign: headerCenter ? "center" : "left", ...TH.hd }}>
        <div style={{ display: "flex", gap: 10, justifyContent: headerCenter ? "center" : "flex-start" }}>
          {on("print_show_logo", "0") && <div style={{ width: 46, height: 46, background: "rgba(255,255,255,.3)", borderRadius: 4, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 }}>LOGO</div>}
          <div>
            <div style={{ fontWeight: 750, fontSize: 15 }}>{v.firm_name || "Kampala Traders"}</div>
            {on("print_show_phone", "1") && <div>Tel: {v.firm_phone || "0700 000 000"}</div>}
            {on("print_show_email", "0") && <div>{v.firm_email || "shop@example.com"}</div>}
            {on("print_show_address", "1") && <div>{v.firm_address || "Kampala, Uganda"}</div>}
            {on("print_show_tin", "1") && <div>TIN: {v.firm_gstin || "1000123456"}</div>}
          </div>
        </div>
      </div>
      <div style={{ textAlign: "center", fontWeight: 750, fontSize: 15, margin: "4px 0 10px", ...TH.titleStyle }}>{TH.title || "INVOICE"}</div>
      <div style={{ display: "none" }}></div>
      <div style={{ fontSize: 11.5, marginBottom: 8 }}>Billed to <b>Sample Customer</b> · {new Date().toLocaleDateString()}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: TH.small ? 10 : 11 }}>
        <thead><tr style={TH.th}>
          <th style={{ textAlign: "left", padding: 5, ...TH.th }}>Item</th>
          <th style={{ padding: 5, ...TH.th }}>Qty</th>
          <th style={{ padding: 5, ...TH.th }}>Rate</th>
          <th style={{ padding: 5, ...TH.th }}>Amount</th>
        </tr></thead>
        <tbody>
          <tr><td style={{ padding: 5, borderBottom: "1px solid #eee" }}>Cement 50kg Bag</td><td style={{ textAlign: "center", borderBottom: "1px solid #eee" }}>2</td><td style={{ textAlign: "right", padding: 5, borderBottom: "1px solid #eee" }}>42,000</td><td style={{ textAlign: "right", padding: 5, borderBottom: "1px solid #eee" }}>84,000</td></tr>
          <tr><td style={{ padding: 5, borderBottom: "1px solid #eee" }}>Sugar 1kg</td><td style={{ textAlign: "center", borderBottom: "1px solid #eee" }}>3</td><td style={{ textAlign: "right", padding: 5, borderBottom: "1px solid #eee" }}>4,500</td><td style={{ textAlign: "right", padding: 5, borderBottom: "1px solid #eee" }}>13,500</td></tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10, marginLeft: "auto", width: 180 }}>
        <div style={line}><span>Subtotal</span><span>97,500</span></div>
        {on("print_show_taxes", "1") && <><div style={line}><span>− WHT 6%</span><span>5,850</span></div><div style={line}><span>+ VAT 18%</span><span>16,497</span></div></>}
        <div style={{ ...line, fontWeight: 750, borderTop: `2px solid ${theme === "modern" ? "#F47B20" : "#333"}`, marginTop: 4, paddingTop: 4 }}><span>Total</span><span>Sh 75,153</span></div>
        {on("print_show_received", "1") && <><div style={line}><span>Received</span><span>75,153</span></div><div style={line}><span>Balance</span><span>0</span></div></>}
      </div>
      {v.print_terms && <div style={{ marginTop: 12, fontSize: 10.5, color: "#555" }}><b>Terms:</b> {v.print_terms}</div>}
      <div style={{ textAlign: "center", marginTop: 12, fontSize: 11.5 }}>{v.print_footer_note || "Thank you for doing business with us!"}</div>
    </div>
  );
}

function PreviewThermal({ v, on }) {
  const w = v.print_paper === "2in" ? "w2" : v.print_paper === "4in" ? "w4" : "w3";
  const dash = <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />;
  const ln = { display: "flex", justifyContent: "space-between" };
  return (
    <div className={`pp-paper pp-thermal ${w}`}>
      <div style={{ textAlign: "center" }}>
        {on("print_show_logo", "0") && <div style={{ fontSize: 9, color: "#888" }}>[ LOGO ]</div>}
        <div style={{ fontWeight: 750, fontSize: 15, letterSpacing: 2.5, textTransform: "uppercase" }}>{v.firm_name || "Kampala Traders"}</div>
        {on("print_show_address", "1") && <div>{v.firm_address || "Kampala, Uganda"}</div>}
        {on("print_show_phone", "1") && <div>Tel: {v.firm_phone || "0700 000 000"}</div>}
        {on("print_show_email", "0") && <div>{v.firm_email || "shop@example.com"}</div>}
        {on("print_show_tin", "1") && <div>TIN: {v.firm_gstin || "1000123456"}</div>}
      </div>
      {dash}
      <div style={{ textAlign: "center", fontWeight: 700, letterSpacing: 3, fontSize: 12.5, fontWeight: 500 }}>CASH RECEIPT</div>
      {dash}
      <div style={ln}><span>INV-000123</span><span>{new Date().toLocaleDateString()}</span></div>
      {dash}
      <div style={ln}><span>Cement 50kg Bag</span></div>
      <div style={{ ...ln, color: "#333" }}><span>2 BAG × 42,000</span><span>84,000</span></div>
      <div style={ln}><span>Sugar 1kg</span></div>
      <div style={{ ...ln, color: "#333" }}><span>3 PCS × 4,500</span><span>13,500</span></div>
      {dash}
      <div style={ln}><span>Sub total</span><span>97,500</span></div>
      {on("print_show_taxes", "1") && <><div style={ln}><span>Less WHT 6%</span><span>−5,850</span></div><div style={ln}><span>Add VAT 18%</span><span>16,497</span></div></>}
      <div style={{ ...ln, fontWeight: 750, fontSize: 13.5 }}><span>TOTAL</span><span>Sh 75,153</span></div>
      {on("print_show_received", "1") && <><div style={ln}><span>Received</span><span>75,153</span></div><div style={ln}><span>Balance</span><span>0</span></div></>}
      {dash}
      {v.print_terms && <div style={{ whiteSpace: "pre-wrap", fontSize: 10.5 }}>{v.print_terms}</div>}
      <div style={{ textAlign: "center" }}>{v.print_footer_note || "Thank you!"}</div>
      {on("print_show_barcode", "1") && (
        <><div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "monospace", letterSpacing: -2, fontSize: 40, lineHeight: 0.9, fontWeight: 750 }}>█ ▌▐█ ▌█▐ ▌▐ █▌█ ▐█</div>
          <div style={{ fontFamily: "monospace", fontSize: 11.5 }}>INV-000123</div>
        </div></>
      )}
    </div>
  );
}
