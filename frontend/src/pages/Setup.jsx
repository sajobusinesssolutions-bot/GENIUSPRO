import React, { useEffect, useState } from "react";
import api, { refreshFirm } from "../lib/api.js";
import { Field, toast } from "../lib/ui.jsx";
import { plural } from "../lib/plural.js";

/**
 * Setup.jsx — the first thing a new shop sees.
 *
 * Six short steps so the app is usable in a few minutes instead of opening onto
 * empty screens and a hundred settings: who you are, what kind of business you
 * run, where your money lands, how you charge tax, a few things you sell, and
 * logins for staff. Everything here can be changed later in Settings, and every
 * step can be skipped.
 *
 * Two things this wizard does that a list of settings cannot:
 *
 *   · **It asks what kind of business this is, and answers the rest itself.**
 *     A salon does not need batch numbers, a pharmacy does; a service business
 *     has nothing to count in a stock take. Asking one question and switching
 *     twenty settings is the difference between an app that fits the shop and
 *     an app the shopkeeper has to make fit.
 *   · **It offers to restore a backup instead.** Somebody moving to a new
 *     computer has already done all of this once. Making them do it again,
 *     then find Settings → Backup and undo it, is the wrong first impression.
 */

/* Everything the wizard has typed lives here between renders AND across a
   refresh. Previously only the item rows were kept, so a reload part-way
   through silently threw away the business details and staff login. */
const DRAFT_KEY = "vy_setup_draft";
const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}") || {}; } catch { return {}; } };

/* ── what kind of business this is ────────────────────────────────────────
 *
 * Each preset is the set of answers a shop of that kind would have given to
 * questions it should never have to be asked. They are written out in full,
 * one line per setting, rather than expressed as differences from a base:
 * somebody reading "pharmacy" needs to see what a pharmacy gets, not work it
 * out by diffing three objects.
 *
 * Only settings that already exist in the catalogue are listed. A key the
 * server does not know is ignored rather than rejected, but a typo that
 * silently does nothing is worse than one that fails, so these are checked
 * against settings.service.js when either changes.
 */
const BUSINESS_TYPES = [
  {
    id: "Retail",
    title: "Shop or retail counter",
    blurb: "You sell goods over a counter — a general store, boutique, electronics shop.",
    settings: {
      biz_you_sell: "Products Only", biz_invoicing_method: "Both", biz_client_type: "Individual Only",
      mod_pos: "1", mod_inventory: "1", mod_purchases: "1", stock_maintenance: "1",
      enable_items: "1", low_stock_alert: "1", enable_batches: "0", enable_wholesale: "0",
      mod_manufacturing: "0", mod_shifts: "1", mod_stocktake: "1",
      print_default_pos: "thermal", print_default_invoice: "regular",
    },
  },
  {
    id: "Wholesale",
    title: "Wholesale or distribution",
    blurb: "You sell in bulk to other businesses, mostly on invoice and often on credit.",
    settings: {
      biz_you_sell: "Products Only", biz_invoicing_method: "Invoices Only", biz_client_type: "Business Only",
      mod_pos: "0", mod_inventory: "1", mod_purchases: "1", stock_maintenance: "1",
      enable_items: "1", low_stock_alert: "1", enable_batches: "0", enable_wholesale: "1",
      mod_manufacturing: "0", mod_shifts: "0", mod_stocktake: "1",
      enable_due_date: "1", force_customer_on_credit: "1",
      print_default_invoice: "regular",
    },
  },
  {
    id: "Services",
    title: "Services",
    blurb: "You sell your time or your skill — salon, clinic, workshop, consultancy. Nothing to count in a store.",
    settings: {
      biz_you_sell: "Services Only", biz_invoicing_method: "Invoices Only", biz_client_type: "Both",
      mod_pos: "0", mod_inventory: "0", mod_purchases: "0", stock_maintenance: "0",
      enable_items: "1", low_stock_alert: "0", enable_batches: "0", enable_wholesale: "0",
      mod_manufacturing: "0", mod_shifts: "0", mod_stocktake: "0",
      enable_due_date: "1", prevent_negative_stock: "0",
      print_default_invoice: "regular",
    },
  },
  {
    id: "Restaurant",
    title: "Restaurant, bar or takeaway",
    blurb: "Orders at a till, printed on a receipt, all day. Shifts and a cash drawer matter here.",
    settings: {
      biz_you_sell: "Services & Products", biz_invoicing_method: "Point of Sale Only", biz_client_type: "Individual Only",
      mod_pos: "1", mod_inventory: "1", mod_purchases: "1", stock_maintenance: "1",
      enable_items: "1", low_stock_alert: "1", enable_batches: "0", enable_wholesale: "0",
      mod_manufacturing: "0", mod_shifts: "1", mod_stocktake: "1",
      prevent_negative_stock: "0",
      print_default_pos: "thermal", printer_type: "thermal-3in",
    },
  },
  {
    id: "Pharmacy",
    title: "Pharmacy or agro-vet",
    blurb: "Everything has a batch and an expiry date, and both have to appear on the receipt.",
    settings: {
      biz_you_sell: "Products Only", biz_invoicing_method: "Both", biz_client_type: "Individual Only",
      mod_pos: "1", mod_inventory: "1", mod_purchases: "1", stock_maintenance: "1",
      enable_items: "1", low_stock_alert: "1", enable_batches: "1", enable_wholesale: "0",
      mod_manufacturing: "0", mod_shifts: "1", mod_stocktake: "1",
      print_show_batch: "1", print_show_expiry: "1", expiry_alert_days: "90",
      print_default_pos: "thermal",
    },
  },
  {
    id: "Hardware",
    title: "Hardware or building supplies",
    blurb: "Counter sales and trade customers, retail and trade prices side by side.",
    settings: {
      biz_you_sell: "Products Only", biz_invoicing_method: "Both", biz_client_type: "Both",
      mod_pos: "1", mod_inventory: "1", mod_purchases: "1", stock_maintenance: "1",
      enable_items: "1", low_stock_alert: "1", enable_batches: "0", enable_wholesale: "1",
      mod_manufacturing: "0", mod_shifts: "1", mod_stocktake: "1",
      enable_due_date: "1",
    },
  },
  {
    id: "Manufacturer",
    title: "Manufacturing or workshop",
    blurb: "You buy materials and make what you sell, so a finished item costs what went into it.",
    settings: {
      biz_you_sell: "Products Only", biz_invoicing_method: "Invoices Only", biz_client_type: "Business Only",
      mod_pos: "0", mod_inventory: "1", mod_purchases: "1", stock_maintenance: "1",
      enable_items: "1", low_stock_alert: "1", enable_batches: "1", enable_wholesale: "1",
      mod_manufacturing: "1", mod_shifts: "0", mod_stocktake: "1",
      enable_due_date: "1",
    },
  },
  {
    id: "Other",
    title: "Something else",
    blurb: "Leave everything switched on and turn off what you do not use, under Settings → Modules.",
    settings: {},
  },
];

/* Does this kind of business sell things it has to count? Used to soften the
   items step rather than to hide it — a services business still has a price
   list, it just has no stock and no cost of goods. */
const sellsStock = (typeId) => {
  const t = BUSINESS_TYPES.find((x) => x.id === typeId);
  return !t || t.settings.stock_maintenance !== "0";
};

/* ── the accounts a shop actually uses ─────────────────────────────────────
 *
 * Cash in Hand exists from the moment the books are opened, so it is stated
 * rather than offered. A bank account and a mobile-money float are the two
 * every Ugandan shop either has or does not, and adding them here means the
 * money screens are true on day one instead of showing everything as cash.
 */
const MOMO_PROVIDERS = ["MTN MoMo", "Airtel Money", "Other"];

export default function Setup({ onDone }) {
  const draft = React.useRef(loadDraft()).current;
  const [step, setStep] = useState(Number(draft.step) || 0);
  const [busy, setBusy] = useState(false);

  /* step 1 — business */
  const [firm, setFirm] = useState(draft.firm || { name: "", phone: "", email: "", gstin: "", address: "" });
  const [loadedFirm, setLoadedFirm] = useState(false);
  useEffect(() => {
    api.get("/settings/firm").then((f) => {
      // A saved draft beats what's on the server — it's what the user just typed.
      setFirm((cur) => (cur.name ? cur : {
        name: f.name || "", phone: f.phone || "", email: f.email || "",
        gstin: f.gstin || "", address: f.address || "",
      }));
    }).catch(() => {}).finally(() => setLoadedFirm(true));
  }, []);

  /* step 2 — what kind of business */
  const [bizType, setBizType] = useState(draft.bizType || "Retail");

  /* step 3 — where the money lands */
  const [money, setMoney] = useState(draft.money || {
    bank: { on: false, name: "", account_no: "", opening: "" },
    momo: { on: false, provider: "MTN MoMo", number: "", opening: "" },
  });
  const setBank = (k, v) => setMoney((m) => ({ ...m, bank: { ...m.bank, [k]: v } }));
  const setMomo = (k, v) => setMoney((m) => ({ ...m, momo: { ...m.momo, [k]: v } }));

  /* step 4 — tax */
  const [taxMode, setTaxMode] = useState(draft.taxMode || "none");   // none | vat | full

  /* step 5 — items */
  const [rows, setRows] = useState(() => {
    const saved = draft.rows;
    if (Array.isArray(saved) && saved.length) return saved;
    return [
      { name: "", sale_price: "", purchase_price: "", stock: "" },
      { name: "", sale_price: "", purchase_price: "", stock: "" },
      { name: "", sale_price: "", purchase_price: "", stock: "" },
    ];
  });
  const setRow = (i, k, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const filled = rows.filter((r) => r.name.trim() && Number(r.sale_price) > 0);

  /* step 6 — staff */
  const [staff, setStaff] = useState(draft.staff || { full_name: "", username: "", password: "", pin: "", role: "cashier" });
  /* What went wrong creating that login, if anything. Kept in state rather than
     shouted through a toast that disappears, because the last step is where the
     wizard used to trap people: the staff login failed, the Finish button did
     nothing anyone could see, and the only way out was a "Skip setup" link that
     does not read like the way out. */
  const [staffError, setStaffError] = useState("");

  /* restoring instead of setting up */
  const [restoring, setRestoring] = useState(null);   // null | "picking" | preview object
  const [restoreError, setRestoreError] = useState("");

  // one place that mirrors the whole wizard to disk
  useEffect(() => {
    if (!loadedFirm) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        /* Never the password or the PIN: this lands in localStorage, which
           survives the wizard and is readable by anything running on the
           page. A half-finished draft is worth keeping; a stored credential
           is not. */
        step, firm, bizType, money, taxMode, rows, staff: { ...staff, password: "", pin: "" },
      }));
    } catch {}
  }, [step, firm, bizType, money, taxMode, rows, staff, loadedFirm]);

  /* Read back what the server actually stored. Every step used to assume a
     200 meant "applied", so a rejected field looked like a successful save. */
  const saveFirm = async () => {
    if (!firm.name.trim()) { toast("Enter your business name", "bad"); return false; }
    try {
      const saved = await api.put("/settings/firm", firm);
      if (!saved || (saved.name || "").trim() !== firm.name.trim()) {
        toast("The business name didn't save — check your permissions and try again", "bad");
        return false;
      }
      await refreshFirm();   // sidebar, receipts and headers pick it up immediately
      return true;
    } catch (e) { toast(e.message, "bad"); return false; }
  };

  /* One question, twenty answers. */
  const saveBizType = async () => {
    const preset = BUSINESS_TYPES.find((t) => t.id === bizType);
    if (!preset) return true;
    try {
      await api.put("/settings", { firm_business_type: preset.id, ...preset.settings });
      return true;
    } catch (e) {
      toast(`Couldn't apply those settings: ${e.message}. You can set them under Settings → Modules.`, "bad");
      return true;      /* deliberately not fatal — this step is a convenience */
    }
  };

  /* Bank and mobile money become real chart-of-accounts entries, flagged as
     money and told which kind they are, so the Cash & Bank screen groups them
     correctly instead of guessing from the name. */
  const saveMoney = async () => {
    const made = [];
    const wanted = [];
    if (money.bank.on && money.bank.name.trim()) {
      wanted.push({
        name: money.bank.account_no.trim()
          ? `${money.bank.name.trim()} — ${money.bank.account_no.trim()}`
          : money.bank.name.trim(),
        type: "asset", is_cash_bank: 1, kind: "bank",
        opening_balance: Number(money.bank.opening) || 0,
      });
    }
    if (money.momo.on && money.momo.number.trim()) {
      wanted.push({
        name: `${money.momo.provider} — ${money.momo.number.trim()}`,
        type: "asset", is_cash_bank: 1, kind: "mobile",
        opening_balance: Number(money.momo.opening) || 0,
      });
    }
    for (const a of wanted) {
      try { await api.post("/accounting/accounts", a); made.push(a.name); }
      catch (e) { toast(`${a.name}: ${e.message}`, "bad"); return false; }
    }
    if (made.length) toast(`${plural(made.length, "account")} added`);
    return true;
  };

  /* THE BIG ONE. This step used to write a single `taxes_enabled` flag and stop
     there — it never created the VAT or withholding rules, so picking "Add VAT
     (18%)" changed nothing at the till. Now the choice is materialised as real
     tax rules, replacing whatever the install shipped with. */
  const TAX_PRESETS = {
    none: [],
    vat: [{ name: "VAT", rate: 18, mode: "add", apply_order: 1 }],
    full: [
      { name: "Income Tax (WHT)", rate: 6, mode: "deduct", apply_order: 1 },
      { name: "VAT", rate: 18, mode: "add", apply_order: 2 },
    ],
  };
  const saveTax = async () => {
    try {
      await api.put("/settings", {
        taxes_enabled: taxMode === "none" ? "0" : "1",
        tax_on_pos: "1", tax_on_cash: "1", tax_on_credit: "1",
      });
      const existing = await api.get("/settings/tax-rules").catch(() => []);
      for (const r of existing || []) await api.delete(`/settings/tax-rules/${r.id}`).catch(() => {});
      for (const r of TAX_PRESETS[taxMode] || []) await api.post("/settings/tax-rules", r);
      const now = await api.get("/settings/tax-rules").catch(() => []);
      if ((now || []).length !== (TAX_PRESETS[taxMode] || []).length) {
        toast("Tax rules didn't save — you can set them under Settings → Taxes", "bad");
      } else if (taxMode !== "none") {
        toast(`${taxMode === "vat" ? "VAT 18%" : "WHT 6% then VAT 18%"} is now applied on sales`);
      }
      return true;
    } catch (e) { toast(e.message, "bad"); return false; }
  };

  const stocked = sellsStock(bizType);

  const saveItems = async () => {
    let made = 0, failed = 0;
    for (const r of filled) {
      try {
        // opening stock goes in with the item, in one transaction — the old
        // second call to /items/:id/adjust could fail on its own and leave the
        // item with no stock, with nothing shown to the user.
        await api.post("/items", {
          name: r.name.trim(), unit: stocked ? "PCS" : "HR",
          item_type: stocked ? "product" : "service",
          sale_price: Number(r.sale_price) || 0,
          purchase_price: stocked ? Number(r.purchase_price) || 0 : 0,
          opening_stock: stocked ? Number(r.stock) || 0 : 0,
        });
        made++;
      } catch (e) { failed++; toast(`${r.name}: ${e.message}`, "bad"); }
    }
    if (made) toast(`${plural(made, stocked ? "item" : "service")} added`);
    if (failed) return false;      // don't march past a step that half-failed
    if (made) setRows([{ name: "", sale_price: "", purchase_price: "", stock: "" }]);
    return true;
  };

  const saveStaff = async () => {
    setStaffError("");
    if (!staff.username.trim()) return true;          // skipping is fine
    if (staff.password.length < 6) {
      setStaffError("That password needs at least 6 characters.");
      return false;
    }
    const pin = String(staff.pin || "").trim();
    if (pin && !/^\d{4}$/.test(pin)) {
      setStaffError("A PIN is exactly four digits — or leave it blank.");
      return false;
    }
    try {
      const made = await api.post("/users", staff);
      /* A PIN is what makes the sign-in screen a till screen: pick your face,
         type four digits, start selling. Set here so the shop has one from the
         first morning rather than after somebody finds it under Users. */
      if (pin) {
        try {
          const who = (await api.get("/users")).find((u) => u.username === staff.username.trim());
          if (who) {
            await api.put(`/users/${who.id}/pin`, { pin });
            await api.put("/settings", { login_pin_enabled: "1", login_show_staff: "1" });
          }
        } catch (e) {
          /* The login exists; only the PIN did not. Say so rather than
             failing the whole step and losing the account they just made. */
          toast(`${staff.username} was created, but the PIN was refused: ${e.message}`, "bad");
        }
      }
      void made;
      toast(`Login created for ${staff.full_name || staff.username}`);
      return true;
    } catch (e) {
      setStaffError(e.message || "That login could not be created.");
      return false;
    }
  };

  /* ── restoring a backup instead ─────────────────────────────────────────
   *
   * Raw binary, not base64 in a JSON body: base64 inflates the file by a third
   * and then meets the JSON body limit, which turns a shopkeeper's recovery
   * into an unexplained failure at the worst possible moment. */
  const sendFile = (url, file) => {
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

  const pickBackup = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setRestoreError(""); setBusy(true);
    try {
      const look = await sendFile("/system/restore/preview", file);
      if (!look.restorable) {
        setRestoreError(look.blocked_reason || "That backup cannot be restored here.");
      } else {
        setRestoring({ file, look });
      }
    } catch (err) { setRestoreError(err.message); }
    setBusy(false);
  };

  const doRestore = async () => {
    if (!restoring) return;
    setBusy(true);
    try {
      await sendFile("/system/restore", restoring.file);
      try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem("vy_setup_items"); } catch {}
      /* A restore replaces the whole database, including the session table, so
         the token in this browser now names a session the server has never
         heard of. Signing out cleanly is the honest end to it. */
      try { localStorage.removeItem("vy_token"); localStorage.removeItem("vy_refresh"); } catch {}
      window.location.reload();
    } catch (err) { setRestoreError(err.message); setBusy(false); }
  };

  const finish = async () => {
    setBusy(true);
    try { await api.put("/settings", { setup_done: "1" }); }
    catch (e) { setBusy(false); toast(`Couldn't finish setup: ${e.message}`, "bad"); return; }
    try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem("vy_setup_items"); } catch {}
    /* Setup is finished the moment the server says so. Everything below is
       housekeeping, and none of it may leave the person looking at a wizard
       they have already completed — which is what happens when one of these
       throws and the reload never runs. */
    try { await refreshFirm(); } catch { /* the name will load with the app */ }
    setBusy(false);
    try { onDone(); } catch { /* the reload makes it moot */ }
    window.location.reload();       // pick up settings, tax rules and firm in one go
  };

  const LAST = 5;

  const next = async () => {
    setBusy(true);
    let ok = true;
    if (step === 0) ok = await saveFirm();
    if (step === 1) ok = await saveBizType();
    if (step === 2) ok = await saveMoney();
    if (step === 3) ok = await saveTax();
    if (step === 4) ok = await saveItems();
    if (step === LAST) ok = await saveStaff();
    setBusy(false);
    if (!ok) return;
    if (step === LAST) return finish();
    setStep(step + 1);
  };

  const STEPS = ["Account created", "Your business", "What you do", "Money", "Tax",
                 stocked ? "What you sell" : "Your services", "Staff logins"];

  const cta = busy ? "Saving…"
    : step === LAST ? (staff.username.trim() ? `Create ${staff.username.trim()} & finish` : "Finish setup")
    : step === 4 ? (filled.length
        ? `Add ${plural(filled.length, stocked ? "item" : "service")} & continue`
        : `Skip ${stocked ? "items" : "services"} & continue`)
    : "Continue";

  return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div className="setup-head">
          <div className="setup-logo">{(firm.name || "G")[0].toUpperCase()}</div>
          <div>
            <h1>Let's set up your business</h1>
            <p>Six short steps. Everything can be changed later in Settings.</p>
          </div>
        </div>

        {/* The login already exists, so step 1 is genuinely complete — showing it
            that way means nobody starts staring at an empty progress bar. */}
        <div className="setup-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`setup-step ${i === step + 1 ? "on" : ""} ${i <= step ? "done" : ""}`}>
              <span className="dot">{i <= step ? "✓" : i + 1}</span><span>{s}</span>
            </div>
          ))}
        </div>
        <div className="setup-progress"><div style={{ width: `${Math.round(((step + 1) / STEPS.length) * 100)}%` }} /></div>

        <div className="setup-body">
          {step === 0 && (
            <>
              {/* Somebody moving from another computer has done all of this
                  already. Offered first, before they start typing it again. */}
              <div className="setup-restore">
                <div>
                  <b>Moving from another computer?</b>
                  <small>Restore a Genius POS backup and skip the rest of this. Your items,
                         customers, sales and settings come back exactly as they were.</small>
                </div>
                <label className="btn btn-ghost">
                  Choose a backup file…
                  <input type="file" accept=".db,.sqlite,.sqlite3,application/octet-stream"
                         style={{ display: "none" }} onChange={pickBackup} disabled={busy} />
                </label>
              </div>
              {restoreError && (
                <div className="setup-error" role="alert">
                  <strong>That backup was not used.</strong>
                  <span>{restoreError}</span>
                  <span>Nothing has been changed. You can carry on setting up below.</span>
                </div>
              )}
              {restoring && (
                <div className="setup-restore-ready">
                  <b>Ready to restore</b>
                  <span>
                    {restoring.look.backup.invoices} invoice(s), {restoring.look.backup.items} item(s)
                    and {restoring.look.backup.parties} customer(s) from {restoring.look.backup.firm}.
                  </span>
                  <span className="setup-note" style={{ margin: 0 }}>
                    This replaces everything on this computer and signs you out, so you can
                    sign in with the login you used on the old one.
                  </span>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="btn btn-primary" onClick={doRestore} disabled={busy}>
                      {busy ? "Restoring…" : "Restore it"}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setRestoring(null)} disabled={busy}>Cancel</button>
                  </div>
                </div>
              )}

              <Field label="Business name *"><input value={firm.name} autoFocus
                     onChange={(e) => setFirm({ ...firm, name: e.target.value })} placeholder="Your business name" /></Field>
              <div className="row2">
                <Field label="Phone"><input value={firm.phone} onChange={(e) => setFirm({ ...firm, phone: e.target.value })} placeholder="07…" /></Field>
                <Field label="Tax number (TIN)"><input value={firm.gstin} onChange={(e) => setFirm({ ...firm, gstin: e.target.value })} /></Field>
              </div>
              <Field label="Address"><input value={firm.address} onChange={(e) => setFirm({ ...firm, address: e.target.value })} placeholder="Street, town" /></Field>
              <p className="setup-note">This is what prints at the top of every receipt and invoice.</p>
            </>
          )}

          {step === 1 && (
            <>
              <p className="setup-note" style={{ marginTop: 0 }}>
                What kind of business is this? We switch on what you need and leave out the rest,
                so you are not looking at screens that do not apply to you.
              </p>
              {BUSINESS_TYPES.map((t) => (
                <label key={t.id} className={`setup-choice ${bizType === t.id ? "on" : ""}`}>
                  <input type="radio" name="biztype" checked={bizType === t.id} onChange={() => setBizType(t.id)} />
                  <span><b>{t.title}</b><small>{t.blurb}</small></span>
                </label>
              ))}
              <p className="setup-note">Every one of these is a switch under Settings → Modules. Nothing here is permanent.</p>
            </>
          )}

          {step === 2 && (
            <>
              <p className="setup-note" style={{ marginTop: 0 }}>
                Where does your money sit? Cash in Hand is already there, and the float in
                the drawer is counted when you open a shift. Add the other accounts you use,
                so the money screens are right from the first day.
              </p>

              <label className={`setup-choice ${money.bank.on ? "on" : ""}`}>
                <input type="checkbox" checked={money.bank.on} onChange={(e) => setBank("on", e.target.checked)} />
                <span><b>A bank account</b><small>Deposits, cheques and anything paid straight into the bank.</small></span>
              </label>
              {money.bank.on && (
                <div className="setup-sub">
                  <div className="row2">
                    <Field label="Bank name *"><input value={money.bank.name} onChange={(e) => setBank("name", e.target.value)} placeholder="Stanbic, Centenary…" /></Field>
                    <Field label="Account number"><input value={money.bank.account_no} onChange={(e) => setBank("account_no", e.target.value)} /></Field>
                  </div>
                  <Field label="Balance today"><input type="number" value={money.bank.opening} onChange={(e) => setBank("opening", e.target.value)} placeholder="0" /></Field>
                </div>
              )}

              <label className={`setup-choice ${money.momo.on ? "on" : ""}`}>
                <input type="checkbox" checked={money.momo.on} onChange={(e) => setMomo("on", e.target.checked)} />
                <span><b>Mobile money</b><small>The float customers pay into. Kept separate from the drawer, because it is reconciled separately.</small></span>
              </label>
              {money.momo.on && (
                <div className="setup-sub">
                  <div className="row2">
                    <Field label="Provider">
                      <select value={money.momo.provider} onChange={(e) => setMomo("provider", e.target.value)}>
                        {MOMO_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </Field>
                    <Field label="Number *"><input value={money.momo.number} onChange={(e) => setMomo("number", e.target.value)} placeholder="07…" /></Field>
                  </div>
                  <Field label="Balance today"><input type="number" value={money.momo.opening} onChange={(e) => setMomo("opening", e.target.value)} placeholder="0" /></Field>
                </div>
              )}

              <p className="setup-note">More accounts — a safe, a second bank, a partner's float — can be added under Money.</p>
            </>
          )}

          {step === 3 && (
            <>
              <p className="setup-note" style={{ marginTop: 0 }}>How should the app handle tax on a sale?</p>
              {[["none", "No tax", "Prices are what the customer pays. Most small shops start here."],
                ["vat", "Add VAT (18%)", "VAT is added on top of the price at checkout."],
                ["full", "Withholding tax + VAT", "The Uganda chain: 6% WHT deducted, then 18% VAT on the reduced amount."]].map(([v, t, d]) => (
                <label key={v} className={`setup-choice ${taxMode === v ? "on" : ""}`}>
                  <input type="radio" name="tax" checked={taxMode === v} onChange={() => setTaxMode(v)} />
                  <span><b>{t}</b><small>{d}</small></span>
                </label>
              ))}
              <p className="setup-note">You can change the rates, or switch tax off for POS, cash or credit sales separately, under Settings → Taxes.</p>
            </>
          )}

          {step === 4 && (
            <>
              <p className="setup-note" style={{ marginTop: 0 }}>
                {stocked
                  ? "Add a few things you sell, just to get going. Leave blank to skip — you can import a full list later."
                  : "Add a few services you offer and what you charge. Leave blank to skip."}
              </p>
              <table className="setup-items">
                <thead>
                  <tr>
                    <th>{stocked ? "Item" : "Service"}</th>
                    <th>{stocked ? "Sells for" : "Charge"}</th>
                    {stocked && <th>Costs you</th>}
                    {stocked && <th>In stock</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td><input value={r.name} onChange={(e) => setRow(i, "name", e.target.value)}
                                 placeholder={stocked ? "What you sell" : "What you do"} /></td>
                      <td><input type="number" value={r.sale_price} onChange={(e) => setRow(i, "sale_price", e.target.value)} /></td>
                      {stocked && <td><input type="number" value={r.purchase_price} onChange={(e) => setRow(i, "purchase_price", e.target.value)} /></td>}
                      {stocked && <td><input type="number" value={r.stock} onChange={(e) => setRow(i, "stock", e.target.value)} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn btn-ghost" style={{ marginTop: 8 }}
                      onClick={() => setRows((r) => [...r, { name: "", sale_price: "", purchase_price: "", stock: "" }])}>
                + Another row
              </button>
              {filled.length > 0 && <p className="setup-note">{plural(filled.length, stocked ? "item" : "service")} ready to add.</p>}
            </>
          )}

          {step === LAST && (
            <>
              <p className="setup-note" style={{ marginTop: 0 }}>
                You're signed in as the owner. Add a login for someone who works the till, so sales are recorded
                against the right person. Leave blank to skip.
              </p>
              <div className="row2">
                <Field label="Full name"><input value={staff.full_name} onChange={(e) => setStaff({ ...staff, full_name: e.target.value })} placeholder="Their name" /></Field>
                <Field label="Username"><input value={staff.username} onChange={(e) => setStaff({ ...staff, username: e.target.value })} placeholder="A short name they will type" /></Field>
              </div>
              <div className="row2">
                <Field label="Password"><input type="password" value={staff.password} onChange={(e) => setStaff({ ...staff, password: e.target.value })} placeholder="at least 6 characters" /></Field>
                <Field label="Role">
                  <select value={staff.role} onChange={(e) => setStaff({ ...staff, role: e.target.value })}>
                    <option value="cashier">Cashier — till only</option>
                    <option value="manager">Manager — everything except users</option>
                  </select>
                </Field>
              </div>
              <Field label="Counter PIN (optional)">
                <input inputMode="numeric" maxLength={4} value={staff.pin} placeholder="4 digits"
                       onChange={(e) => setStaff({ ...staff, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
              </Field>
              <p className="setup-note" style={{ marginTop: 4 }}>
                With a PIN they sign in by pressing their name and typing four digits — which is
                what a busy counter needs. Without one they type a username and password.
              </p>
              {staffError && (
                <div className="setup-error" role="alert">
                  <strong>That login could not be created.</strong>
                  <span>{staffError}</span>
                  <span>
                    Fix it above and press the button again, or finish setup now —
                    staff logins can be added any time under Users.
                  </span>
                </div>
              )}
              <p className="setup-note">More logins and fine-grained permissions live under Users.</p>
            </>
          )}
        </div>

        <div className="setup-foot">
          <button className="btn btn-ghost" onClick={finish} disabled={busy}>
            {staffError ? "Finish without this login" : "Skip setup"}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && <button className="btn btn-ghost" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}
            <button className="btn btn-primary" onClick={next} disabled={busy}>{cta}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
