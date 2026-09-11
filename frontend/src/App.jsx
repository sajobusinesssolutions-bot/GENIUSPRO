import { printInvoice } from "./lib/print.js";
import { cur, setCurrency, setDecimals, setDateFormat, dualQty } from "./lib/tax.js";
import AboutBox from "./AboutBox.jsx";
import React, { useEffect, useState } from "react";
import "./styles.css";
import api, { setSession, setPermissions, clearSession, currentUser, currentFirm, can, setErrorNotifier, onLicenceRefusal } from "./lib/api.js";
import { deviceToken } from "./lib/device.js";
import { needsServer } from "./lib/server.js";
/* Pages load on demand so the till isn't waiting behind reports, accounting
   and settings code it may never open. */
/**
 * lazyPage — React.lazy with recovery.
 *
 * After an update the browser may still be holding the previous build's module
 * map and ask for a chunk filename that no longer exists. That surfaces as
 * "Failed to fetch dynamically imported module" and leaves the screen dead.
 * One retry handles a transient network blip; if it fails again we reload once
 * (guarded by sessionStorage so it can never loop), which pulls the new
 * index.html and the correct chunk names.
 */
/* Shown while a screen is being fetched: a thin top bar plus a skeleton in the
   shape of a typical page, so the wait looks like the page arriving rather
   than the app hanging. */
/* The trial's last few days.
 *
 * Says nothing until then, then says it every day, and goes away the moment a
 * key is typed. A trial that ends without warning is a shop that opens one
 * morning and cannot sell. */
function TrialStrip({ licence, onGo }) {
  if (!licence || licence.state !== "trialing") return null;
  const left = licence.trialDaysLeft;
  if (left == null || left > 5) return null;
  return (
    <button className="trial-strip" onClick={onGo}>
      {left <= 0
        ? "The trial ends today — type your licence key to keep recording sales"
        : `Trial: ${left} day${left === 1 ? "" : "s"} left. Type your licence key to keep recording sales.`}
    </button>
  );
}

function RouteLoader() {
  return (
    <>
      <div className="top-progress"><i /></div>
      <div className="route-loader">
        <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
          <span className="sk" style={{ height: 20, width: 190 }} />
        </div>
        <div className="sum-bar" style={{ marginBottom: 20 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="sum-chip" style={{ minWidth: 150 }}>
              <span className="sk" style={{ height: 9, width: 62, marginBottom: 9 }} />
              <span className="sk" style={{ height: 16, width: 96 }} />
            </div>
          ))}
        </div>
        <div className="panel">
          <table className="tw">
            <tbody><SkeletonTable rows={7} cols={5} /></tbody>
          </table>
        </div>
      </div>
    </>
  );
}

const lazyPage = (loader) => React.lazy(() =>
  loader().catch(() =>
    new Promise((r) => setTimeout(r, 350)).then(loader).catch((err) => {
      const KEY = "vy_chunk_reloaded";
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, String(Date.now()));
        /* A plain reload() can be answered from cache — and if the cached copy
           is the stale index.html that named this missing chunk, we come back
           to the identical failure with the retry flag already spent, and the
           boundary shows for good. A changing query string forces the server. */
        const url = new URL(window.location.href);
        url.searchParams.set("_b", Date.now().toString(36));
        window.location.replace(url.toString());
        return new Promise(() => {});   // hold until the reload takes over
      }
      throw err;                        // already tried; let the boundary show it
    })
  )
);
/* A page that loads cleanly means we are on the current build again. */
if (typeof sessionStorage !== "undefined") {
  window.addEventListener("load", () => setTimeout(() => sessionStorage.removeItem("vy_chunk_reloaded"), 4000));
}

const Dashboard = lazyPage(() => import("./pages/Dashboard.jsx"));
const Parties = lazyPage(() => import("./pages/Parties.jsx"));
const Items = lazyPage(() => import("./pages/Items.jsx"));
const Invoices = lazyPage(() => import("./pages/Invoices.jsx"));
const Accounting = lazyPage(() => import("./pages/Accounting.jsx"));
const Companies = lazyPage(() => import("./pages/Companies.jsx"));
const Settings = lazyPage(() => import("./pages/Settings.jsx"));
const Staff = lazyPage(() => import("./pages/Staff.jsx"));
const Tax = lazyPage(() => import("./pages/Tax.jsx"));
const Purchases = lazyPage(() => import("./pages/Purchases.jsx"));
const Money = lazyPage(() => import("./pages/Money.jsx"));
const Reports = lazyPage(() => import("./pages/Reports.jsx"));
const Pos = lazyPage(() => import("./pages/Pos.jsx"));
const Utilities = lazyPage(() => import("./pages/Utilities.jsx"));
const Reminders = lazyPage(() => import("./pages/Reminders.jsx"));
const UsersRoles = lazyPage(() => import("./pages/Users.jsx"));
const Update = lazyPage(() => import("./pages/Update.jsx"));
const Cloud = lazyPage(() => import("./pages/Cloud.jsx"));
const Manufacturing = lazyPage(() => import("./pages/Manufacturing.jsx"));
const Offers = lazyPage(() => import("./pages/Offers.jsx"));
const Warranty = lazyPage(() => import("./pages/Warranty.jsx"));
const Setup = lazyPage(() => import("./pages/Setup.jsx"));
const LicencePage = lazyPage(() => import("./pages/Licence.jsx"));
const LicenceStop = React.lazy(() => import("./pages/Licence.jsx").then((m) => ({ default: m.LicenceStop })));
/* The screens somebody sees before they have an account. Split out of the
   sign-in bundle deliberately: every returning shopkeeper loads Login, and
   almost none of them are signing up again. */
const SignUpScreen = React.lazy(() => import("./pages/Onboarding.jsx").then((m) => ({ default: m.SignUp })));
const SignInCodeScreen = React.lazy(() => import("./pages/Onboarding.jsx").then((m) => ({ default: m.SignInCode })));
const ConnectServerScreen = React.lazy(() => import("./pages/Onboarding.jsx").then((m) => ({ default: m.ConnectServer })));
const ForgotScreen = React.lazy(() => import("./pages/Onboarding.jsx").then((m) => ({ default: m.Forgot })));
const InviteScreen = React.lazy(() => import("./pages/Onboarding.jsx").then((m) => ({ default: m.AcceptInvite })));
const StockTake = lazyPage(() => import("./pages/StockTake.jsx"));
const Shifts = lazyPage(() => import("./pages/Shifts.jsx"));
import { ToastHost, Modal, Field, toast , ErrorBoundary, ConnectionWatcher , ConfirmHost, PrintPreviewHost , confirmDialog, SkeletonTable, SheetHost, RowMenu } from "./lib/ui.jsx";
import { PrintPromptHost } from "./lib/printprompt.jsx";
import { Icon } from "./lib/icons.jsx";

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "▤", title: "Dashboard", sub: "Overview of your business" },
  { id: "pos", label: "POS", icon: "⌨", title: "POS billing", sub: "Fast keyboard billing — F1 to search", perm: ["sales", "create"], mod: "mod_pos" },
  { id: "invoices", label: "Sales", icon: "▦", title: "Sales", sub: "Invoices & billing", perm: ["sales", "view"], mod: "mod_sales" },
  { id: "purchases", label: "Purchases", icon: "▥", title: "Purchases", sub: "Supplier bills & stock in", perm: ["purchases", "view"], mod: "mod_purchases" },
  { id: "manufacturing", label: "Manufacturing", icon: "⚒", title: "Manufacturing", sub: "Recipes & production runs", perm: ["items", "view"], mod: "mod_manufacturing" },
  { id: "offers", label: "Offers", icon: "%", title: "Offers & promotions", sub: "Discount rules applied at billing", perm: ["sales", "view"], mod: "mod_offers" },
  { id: "warranty", label: "Warranty", icon: "⛨", title: "Warranty", sub: "Cover on what you sold, and claims", perm: ["sales", "view"], mod: "mod_insurance" },
  { id: "money", label: "Money", icon: "⇅", title: "Money", sub: "Payments, expenses & other income", perm: ["payments", "view"] },
  { id: "shifts", label: "Shifts", icon: "◷", title: "Shifts", sub: "Open & close the till, reconcile cash", perm: ["sales", "view"], mod: "mod_shifts" },
  { id: "parties", label: "Parties", icon: "◍", title: "Parties", sub: "Customers & suppliers", perm: ["parties", "view"] },
  { id: "items", label: "Items", icon: "▣", title: "Items", sub: "Products, services & stock", perm: ["items", "view"] },
  /* The page, its icon, its section and its route all existed — it was only
     ever missing from this list, so there was no way to reach it. */
  { id: "stocktake", label: "Stock take", icon: "☑", title: "Stock take", sub: "Count the shelf & post the variance", perm: ["items", "view"], mod: "mod_stocktake" },
  { id: "reports", label: "Reports", icon: "◫", title: "Reports", sub: "Tax, stock, party & profit reports", perm: ["reports", "view"] },
  { id: "accounting", label: "Accounting", icon: "▧", title: "Accounting", sub: "Ledgers, P&L & balance sheet", perm: ["accounting", "view"], mod: "mod_accounting" },
  { id: "reminders", label: "Reminders", icon: "✉", title: "Payment reminders", sub: "Who owes you, and the message to send them", perm: ["parties", "view"], mod: "mod_reminders" },
  { id: "utilities", label: "Utilities", icon: "⚒", title: "Utilities", sub: "Import, export & data checks", perm: ["settings", "view"] },
  { id: "tax", label: "Tax & URA", icon: "▤", title: "Tax & URA", sub: "VAT, EFRIS and staying out of trouble", perm: ["accounting", "view"], mod: "mod_tax_ura" },
  /* Two different subjects that used to share the id "users". The register of
     people and what they may do is now its own screen off the ⋯ menu; the
     figures about what those people sold are a report, reached from Reports. */
  { id: "users", label: "Users & roles", icon: "◎", title: "Users & roles", sub: "Who can sign in, and what they may do", perm: ["users", "view"] },
  { id: "staff", label: "Staff", icon: "◍", title: "Staff", sub: "Who is on, what they sold, and what they are owed", perm: ["users", "view"] },
  /* Companies sits directly above Settings: it is the thing you reach for when
     you want to be somewhere else, and Settings is the thing you reach for when
     you want this place to behave differently. Gated on `companies.view`, so a
     cashier never sees it — they have one business and no switcher. */
  { id: "companies", label: "Companies", icon: "▤", title: "Companies", sub: "Switch between your businesses, and say who may open them", perm: ["companies", "view"] },
  { id: "cloud", label: "Sync", icon: "⟳", title: "Sync", sub: "Keep this business on the server, or bring it back", perm: ["settings", "edit"] },
  { id: "update", label: "Updates", icon: "↑", title: "Updates", sub: "What version this is, and what is new" },
  { id: "settings", label: "Settings", icon: "⚙", title: "Settings", sub: "Business, tax & preferences", perm: ["settings", "view"] },
];

/* ── The deck's rail ──────────────────────────────────────────────────────
   Icon paths, order, grouping and wording are lifted straight from
   "POS Deck.dc.html" so the rail matches the design exactly. Two entries
   are renamed by the deck: POS is "Till", Money is "Cash & bank".

   `page` is the screen this opens; `sub` is passed through to it. Everything
   still goes through NAV for permissions and module switches, so a hidden
   feature stays hidden here too. */
const DECK_IC = {
  dashboard:     "M4 13h7V4H4z|M13 20h7v-9h-7z|M4 20h7v-4H4z|M13 8h7V4h-7z",
  pos:           "M4 5h16v14H4z|M4 9h16|M8 13h4|M8 16h2",
  invoices:      "M6 3h9l4 4v14H6z|M9 12h6|M9 16h4|M14 3v5h5",
  parties:       "M9 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6z|M2.5 20c1.1-3 3.6-4.5 6.5-4.5s5.4 1.5 6.5 4.5|M17 11a2.6 2.6 0 1 0-1-5",
  builder:       "M18.5 3.5l2 2-9 9-2.6.6.6-2.6 9-9z|M19 14v6H5V4h6",
  items:         "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z|M12 3v18|M4 7.5l8 4.5 8-4.5",
  purchases:     "M3 4h2l2.4 12h10l2.2-8H6|M9 20a1 1 0 1 0 .01 0|M17 20a1 1 0 1 0 .01 0",
  stocktake:     "M9 11l3 3 5-5|M4 5h16v16H4z|M8 3v4|M16 3v4",
  money:         "M4 7h16v10H4z|M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5",
  accounting:    "M4 4h16v16H4z|M4 9h16|M9 9v11|M4 14h5",
  reports:       "M4 20V5|M4 20h16|M8 16v-5|M12 16V9|M16 16v-7",
  manufacturing: "M4 7l8-4 8 4v10l-8 4-8-4z|M4 7l8 4 8-4|M12 11v10",
  users:         "M16 20v-2a4 4 0 0 0-8 0v2|M12 11a3.2 3.2 0 1 0 0-6.4a3.2 3.2 0 0 0 0 6.4|M20 20v-1.6a3.4 3.4 0 0 0-2.6-3.3",
  /* Staff: a person with a clock, because the screen is about hours worked and
     what was sold in them, not about accounts. */
  staff:         "M9 11.5a3.2 3.2 0 1 0 0-6.4a3.2 3.2 0 0 0 0 6.4|M2.5 20c1-3.2 3.5-4.8 6.5-4.8|M17.5 13a4.5 4.5 0 1 0 0 9a4.5 4.5 0 0 0 0-9|M17.5 15.4v2.1l1.5 1",
  /* Two buildings, one behind the other — the rail's only glyph that has to
     say "more than one of these". */
  companies:     "M4 21V8l6-4v17|M10 21V11h10v10|M14 15h2|M14 18h2|M6.5 12h1|M6.5 16h1",
  loyalty:       "M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z",
  installments:  "M3 6h18v12H3z|M3 10h18|M7 14h4",
  offers:        "M4 12l8-8h8v8l-8 8z|M16 8h.01",
  recurring:     "M21 12a9 9 0 1 1-2.6-6.4|M21 3v6h-6",
  utilities:     "M4 6h16v9H4z|M9 19h6|M12 15v4|M7.5 10.5l2 2 4.5-4.5",
  /* Reminders was in the rail with no entry here, so it drew an empty 20×20
     box where every other row has a glyph — the one item in the list that
     looked broken. A bell, because that is what a reminder is. */
  reminders:     "M18 8a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8z|M13.7 20a2 2 0 0 1-3.4 0",
  /* Sync — two arrows going round, not a cloud. The page keeps a copy on the
     server AND brings one back, and a cloud says only "somewhere else". */
  cloud:         "M21 12a9 9 0 0 1-14.9 6.7L3 16|M3 12a9 9 0 0 1 14.9-6.7L21 8|M21 3v5h-5|M3 21v-5h5",
  tax:           "M6 3h9l4 4v14H6z|M9 12h6|M9 16h6|M9 8h3",
  warranty:      "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z|M9.5 12l1.8 1.8L15 10",
  shifts:        "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18|M12 7v5l3 2",
  settings:      "M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6z|M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.06-.06A2 2 0 1 1 8.57 5.2l.06.06a1.7 1.7 0 0 0 2.87-1.2V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.87h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.53 1z",
};

/* Four bands, each headed by a quiet label rather than separated by a hairline
   and a 12px gap on either side of it. Four separators cost ~100px of rail for
   no information — the label says what the hairline only implied, and costs
   less. */
const RAIL = [
  { title: "Sell", items: [
    { key: "dashboard", page: "dashboard", label: "Dashboard" },
    { key: "pos",       page: "pos",       label: "Till" },
    { key: "invoices",  page: "invoices",  label: "Sales" },
    { key: "parties",   page: "parties",   label: "Parties" },
    /* "Invoice builder" used to sit here, pointing at page "invoices" with
       sub "new" — i.e. the identical action as Sales → New invoice, one row
       below the thing it duplicated. Removed: the destination it implied does
       not exist, and the rail is for destinations. (The print-template
       designer, pages/InvoiceTemplateDesigner.jsx, is reached from
       Settings → Print, which is where a template designer belongs.) */
  ] },
  { title: "Stock", items: [
    { key: "items",     page: "items",     label: "Items" },
    { key: "purchases", page: "purchases", label: "Purchases" },
    { key: "stocktake", page: "stocktake", label: "Stock take" },
  ] },
  { title: "Money", items: [
    { key: "money",      page: "money",      label: "Cash & bank" },
    { key: "accounting", page: "accounting", label: "Accounting" },
    { key: "reports",    page: "reports",    label: "Reports" },
  ] },
  { title: "More", items: [
    { key: "manufacturing", page: "manufacturing", label: "Production", mod: true },
    /* Staff is gone from the rail. It was three tabs of figures about people —
       who is on, what they sold, what they are owed — which is the definition
       of a report, not a destination you go to in order to do something. It
       lives under Reports now, in its own band. */
    { key: "offers",        page: "offers",        label: "Offers", mod: true },
    /* Warranty and Shifts are not in the deck's rail. They are working
       screens, so they stay in the module band — a design that has not got
       to a feature yet is not the same as a design that removed it. */
    { key: "warranty",      page: "warranty",      label: "Warranty", mod: true },
    { key: "shifts",        page: "shifts",        label: "Shifts", mod: true },
    { key: "tax",           page: "tax",           label: "Tax & URA", mod: true },
    { key: "reminders",     page: "reminders",     label: "Reminders", mod: true },
    { key: "utilities",     page: "utilities",     label: "Data tools", mod: true },
    /* NAV governs permissions and module switches; RAIL governs what is on
       screen and in what order. An entry added to one and not the other is
       reachable but invisible — which is what happened here first.

       Companies is deliberately NOT here any more. It is not a place you go to
       work; it is a place you go to change which business you are working in,
       which is a handful of times a week at most and belongs beside the
       business name rather than in a list of daily destinations. It lives in
       the ⋯ at the top of the rail, with Settings. */
  ] },
];

/* Page headings, in the deck's words. Where the deck names a real shop the
   firm's own name is substituted at render. */
const DECK_META = {
  dashboard:     ["Today at %s", null],
  invoices:      ["Sales", "Invoices, payments and what is still owed"],
  items:         ["Items", "Products, stock and movements"],
  parties:       ["Parties", "Customers and suppliers"],
  reminders:     ["Reminders", "Who owes you, and the message to send them"],
  update:        ["Updates", "What version this is, and what is new"],
  cloud:         ["Sync", "Keep this business on the server, or bring it back"],
  purchases:     ["Purchases", "Bills, orders and what you owe suppliers"],
  money:         ["Cash & bank", "Every account, every movement"],
  reports:       ["Reports", "How the business actually did"],
  stocktake:     ["Stock take", "Count what is on the shelf, post the difference"],
  accounting:    ["Accounting", "Chart of accounts, journals and statements"],
  settings:      ["Settings", "How this shop runs"],
  manufacturing: ["Production", "Repacking, milling and what it costs to make a unit"],
  users:         ["Users & roles", "Who can sign in, and what they may do"],
  staff:         ["Staff", "Who is on, what they sold, and what they are owed"],
  offers:        ["Offers & discounts", "Price rules that fire at the till on their own"],
  /* Was "Sync & audit" / "Devices, who did what, and how you get your data
     back" over tabs for Import / Export / Barcode generator / Verify. There is
     no device list and no audit log, so the title promised two features the
     page does not have. Renamed to what the tabs actually do. */
  utilities:     ["Data tools", "Import items, export to Excel, print barcodes and check your data"],
  tax:           ["Tax & URA", "VAT, EFRIS and staying out of trouble"],
};

function DeckIc({ id, size }) {
  return (
    <svg width={size || 20} height={size || 20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(DECK_IC[id] || "").split("|").map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/* Recurring moved into Sales and Purchases as a tab. Old links still point
   here, so send them to the Sales tab rather than a dead page. */
const MOVED = {
  recurring: ["invoices", "recurring"],
  installments: ["invoices", "instalments"],
  loyalty: ["invoices", "loyalty"],
};

const PAGES = { stocktake: StockTake, dashboard: Dashboard, pos: Pos, invoices: Invoices, purchases: Purchases, money: Money, shifts: Shifts, parties: Parties, companies: Companies, items: Items, reports: Reports, accounting: Accounting, users: UsersRoles, staff: Staff, settings: Settings, utilities: Utilities, reminders: Reminders, update: Update, cloud: Cloud, tax: Tax, manufacturing: Manufacturing, offers: Offers, warranty: Warranty };

export default function App() {
  const [user, setUser] = useState(currentUser());
  /* Only ever true in the packaged Android app, and only until it has been
     told once. Held in state rather than read inline so that saving the
     address moves the app on without a reload. */
  const [askServer, setAskServer] = useState(needsServer);
  const [page, setPage] = useState("dashboard");
  /* Module switches, read once at load and refreshed when Settings saves. */
  const [mods, setMods] = useState({});
  useEffect(() => {
    const load = () => api.get("/settings").then((d) => {
      const values = d.values || {};
      /* Push the configured symbol into the money formatter before anything
         renders a total, and again whenever Settings saves. */
      setCurrency(values.currency_symbol);
      /* These two were configurable but unread, so a shop could set them and see
         no change anywhere. Pushed into the formatters alongside the symbol. */
      setDecimals(values.amount_decimals);
      setDateFormat(values.date_format);
      setMods(values);
    }).catch(() => {});
    load();
    window.addEventListener("vy-settings-saved", load);
    return () => window.removeEventListener("vy-settings-saved", load);
    /* Depends on `user`, not [] — this effect first runs while the sign-in
       screen is up, where GET /settings answers 401 and the .catch swallows it.
       App does not remount on sign-in (it only sets `user`), so with [] deps the
       fetch never happened again and currency_symbol, amount_decimals and
       date_format were silently never applied for the whole session: totals read
       "Sh 1,695,200" instead of the configured "Sh 1,695,200.00" until the user
       happened to reload, at which point the stored token made the same request
       succeed. Re-running on `user` also re-reads settings after Switch user,
       which is correct — they are per firm. */
  }, [user]);
  const [needsSetup, setNeedsSetup] = useState(null);
  useEffect(() => {
    if (!currentUser()) return;
    api.get("/settings")
      .then((d) => setNeedsSetup((d.values || {}).setup_done !== "1"))
      .catch(() => setNeedsSetup(false));
  }, [user]);

  /* The licence.
   *
   * Asked once at sign-in, and again whenever the server refuses a write —
   * the api layer hands that refusal here rather than every caller having to
   * recognise it. A till that goes stale in the middle of the afternoon
   * therefore stops at the door on its next sale, not on its next reload. */
  const [licence, setLicence] = useState(null);
  useEffect(() => {
    if (!currentUser()) return;
    api.get("/licence").then(setLicence).catch(() => setLicence(null));
  }, [user]);
  useEffect(() => { onLicenceRefusal((s) => setLicence(s)); }, []);
  /* Check in quietly while the shop trades, so a renewal or a block is picked
     up the same day rather than at the next restart. */
  useEffect(() => {
    if (!currentUser()) return;
    const t = setInterval(() => {
      api.post("/licence/check", {}).then(setLicence).catch(() => {});
    }, 6 * 3600 * 1000);
    return () => clearInterval(t);
  }, [user]);
  const [appTheme, setAppTheme] = useState(() => localStorage.getItem("vy_app_theme") || "light");
  /* The till keeps its own theme so a bright counter can stay light while the
     back office is dark — but it now inherits the app theme until someone
     actually chooses one, rather than silently defaulting to light. */
  const [posTheme, setPosTheme] = useState(
    () => localStorage.getItem("vy_pos_theme") || localStorage.getItem("vy_app_theme") || "light"
  );
  const [navOpen, setNavOpen] = useState(() => localStorage.getItem("vy_nav_open") !== "0");
  /* The deck ships four accents. They are pure token swaps, so the choice can
     live in the browser rather than needing a column in settings. */
  const [accent, setAccent] = useState(() => localStorage.getItem("vy_accent") || "blue");
  useEffect(() => { document.body.setAttribute("data-accent", accent); }, [accent]);
  const setAccentPref = (a) => { setAccent(a); localStorage.setItem("vy_accent", a); };
  useEffect(() => { document.body.setAttribute("data-theme", appTheme); }, [appTheme]);
  /* The till has its own top bar drawn over this one, so it carries its own
     copy of the appearance switch (see TillThemeButton in pages/Pos.jsx).
     It writes the same key and announces the change; without this, coming
     back out of the till would snap the theme back to whatever this state
     still held. */
  useEffect(() => {
    const h = (e) => setAppTheme((e.detail && e.detail.theme) || "light");
    window.addEventListener("vy-theme", h);
    return () => window.removeEventListener("vy-theme", h);
  }, []);
  /* Keep the till in step while it has no explicit preference of its own. */
  useEffect(() => {
    if (!localStorage.getItem("vy_pos_theme")) setPosTheme(appTheme);
  }, [appTheme]);
  useEffect(() => { setErrorNotifier((m) => toast(m, "bad")); }, []);
  const [badges, setBadges] = useState({});
  useEffect(() => {
    /* Not before somebody has signed in. The old version fired on the sign-in
       screen, where it answered 401 and was swallowed — and because its only
       dependency was `page`, and signing in lands on the page already
       selected, the effect did not run again: the rail's counts stayed empty
       until the first navigation. Depending on `user` as well is what makes
       them appear when the shop opens. */
    if (!user) return undefined;
    let alive = true;
    const load = () => api.get("/dashboard/badges").then((b) => { if (alive) setBadges(b || {}); }).catch(() => {});
    load();
    const iv = setInterval(load, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [page, user]);
  useEffect(() => { document.body.setAttribute("data-pos-theme", posTheme); }, [posTheme]);
  const [pageSub, setPageSub] = useState(null);

  /* Navigation history. Routing is by state rather than by URL, so there was
     no browser back to fall back on and every drill-down was a one-way trip.
     One shallow stack gives every screen a back affordance without pulling in
     a router. Re-selecting the page you are already on is not a move. */
  const [aboutOpen, setAboutOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const navigate = (rawId, rawSub = null) => {
    /* Screens that moved keep working from old links and search results. */
    const moved = MOVED[rawId];
    const id = moved ? moved[0] : rawId;
    const sub = moved ? moved[1] : rawSub;
    setPage((prev) => {
      if (prev !== id) setHistory((h) => [...h.slice(-19), { page: prev, sub: pageSub }]);
      return id;
    });
    setPageSub(sub);
  };
  const goBack = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      setPage(last.page);
      setPageSub(last.sub || null);
      return h.slice(0, -1);
    });
  };
  const [ready, setReady] = useState(false);
  const [palette, setPalette] = useState(false);

  // Cross-page navigation events (dashboard shortcuts, palette results)
  useEffect(() => {
    const onNav = (e) => { navigate(e.detail.page, e.detail.sub || null); };
    const onKey = (e) => { if (e.ctrlKey && e.key.toLowerCase() === "f" && page !== "pos") { e.preventDefault(); setPalette(true); } };
    window.addEventListener("vy-nav", onNav);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("vy-nav", onNav); window.removeEventListener("keydown", onKey); };
  }, [page]);

  useEffect(() => {
    if (!user) return setReady(true);
    // Permissions are stored at login; refresh them here for returning sessions.
    api.get("/auth/me")
      .then((d) => {
        if (!d.permissions || !d.permissions.length) throw new Error("no permissions");
        setPermissions(d.permissions);
        setReady(true);
      })
      .catch(() => {
        // Stale or broken session: never render an empty shell — go back to login.
        clearSession();
        setUser(null);
        setReady(true);
      });
  }, [user]);

  /* The packaged Android app does not know which shop it belongs to until
     somebody tells it: the pages come from the app bundle, so its own origin
     is the phone. Asked once, checked, then never again. A browser and the
     desktop skip this entirely — they were served by the server they talk to. */
  if (askServer) {
    return (
      <div className="dk-login">
        <div className="dk-login-form" style={{ margin: "auto" }}>
          <React.Suspense fallback={<div className="dk-login-box"><div className="who">Loading…</div></div>}>
            <ConnectServerScreen onDone={() => setAskServer(false)} />
          </React.Suspense>
        </div>
      </div>
    );
  }

  if (!user) return <Login onIn={(u) => { setUser(u); setPage("dashboard"); }} />;

  /* Before the setup wizard: a till that may not record anything has no
     business being asked to set itself up. */
  if (licence && licence.blocks) return (
    <React.Suspense fallback={<RouteLoader />}>
      <LicenceStop state={licence} onCleared={() => api.get("/licence").then(setLicence)} />
    </React.Suspense>
  );

  if (needsSetup === true) return (
    <React.Suspense fallback={<RouteLoader />}>
      <Setup onDone={() => setNeedsSetup(false)} />
    </React.Suspense>
  );
  if (!ready) return <div className="login-wrap"><div style={{ color: "#fff" }}>Loading…</div></div>;

  const firm = currentFirm() || {};
  /* A module switched off in Settings → Modules hides its screen. Its data is
     untouched, so switching it back on brings everything straight back. */
  const modOn = (k) => k && mods[k] === "1";
  const nav = NAV.filter((n) => (!n.perm || can(n.perm[0], n.perm[1]))
    && (!n.mod || (n.altMod ? (modOn(n.mod) || modOn(n.altMod)) : mods[n.mod] !== "0")));
  const active = NAV.find((n) => n.id === page) || nav[0] || NAV[0];
  const Page = PAGES[page] || Dashboard;
  const logout = () => { clearSession(); setUser(null); };

  if (page === "pos") {
    return (
      <div className="pos-full" data-pt={posTheme}>
        <div className="pos-topbar">
          <button className="pos-back" onClick={() => navigate("dashboard")}>
            <PosVecIc d={POSVEC.back} /> Back
          </button>
          <span className="pos-title">{firm.name || "POS"}</span>
          <div className="spacer" />
          <div className="pt-icons">
            <button className="pt-ic" title={posTheme === "dark" ? "Light mode" : "Dark mode"}
                    onClick={() => { const t = posTheme === "dark" ? "light" : "dark"; setPosTheme(t); localStorage.setItem("vy_pos_theme", t); }}>
              <PosVecIc d={posTheme === "dark" ? POSVEC.sun : POSVEC.moon} />
            </button>
            <PosDots onGo={(pg, sub) => navigate(pg, sub || null)} onLogout={logout} />
          </div>
        </div>
        <div className="pos-body">
          <ErrorBoundary key="pos-boundary">
            <React.Suspense fallback={<div className="page-loading"><span className="spin" /> Opening the till…</div>}>
              <Pos key="pos" />
            </React.Suspense>
          </ErrorBoundary>
        </div>
        <ToastHost /><ConfirmHost /><PrintPreviewHost /><PrintPromptHost />
      </div>
    );
  }

  const toggleTheme = () => { const t = appTheme === "dark" ? "light" : "dark"; setAppTheme(t); localStorage.setItem("vy_app_theme", t); };
  const toggleNav = () => { const v = !navOpen; setNavOpen(v); localStorage.setItem("vy_nav_open", v ? "1" : "0"); };
  /* Deck headings. The dashboard takes the shop's own name and today's date,
     as the deck does with its demo shop. */
  const dm = DECK_META[page];
  const headTitle = dm
    ? (dm[0].includes("%s") ? dm[0].replace("%s", firm.name || "the shop") : dm[0])
    : active.title;
  const headSub = page === "dashboard"
    ? new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : (dm ? dm[1] : active.sub);

  /* A rail entry is shown only if its underlying NAV entry survived the
     permission and module filters. */
  const shown = new Set(nav.map((n) => n.id));
  const railBands = RAIL
    .map((band) => ({ ...band, items: band.items.filter((r) => shown.has(r.via || r.page)) }))
    .filter((band) => band.items.length);

  const userName = (user && (user.full_name || user.username)) || "User";
  const initials = userName.split(/\s+/).filter(Boolean).slice(0, 2)
    .filter(Boolean).map((w) => w[0].toUpperCase()).join("") || "U";

  return (
    <div className={`dk-shell ${navOpen ? "" : "rail-shut"}`}>
      <ConnectionWatcher />
      <TrialStrip licence={licence} onGo={() => navigate("settings", "licence")} />

      <aside className="dk-rail dk-s">
        {/* The business you are in, and the two things you do ABOUT the
            business rather than in it: change which one is open, and change
            how it runs. Both were competing for attention in a list of places
            you go to sell things; neither is one. */}
        <div className="dk-brand">
          <div className="dk-brand-mark">{(firm.name || "S")[0].toUpperCase()}</div>
          <span className="dk-brand-name">{firm.name || "Genius POS"}</span>
          {/* The four things you do ABOUT the business rather than in it.
              None of them is a place you go to sell something, and a list of
              daily destinations is the wrong home for any of them: Sync
              is touched when you set it up and then never again, and Updates
              is read when something has gone wrong or a version is due. */}
          <RowMenu label="Businesses and settings" items={[
            can("companies", "view") && { label: "Manage companies", hint: "Switch business, and who may open it",
                                          onClick: () => navigate("companies") },
            /* Users & roles was a page inside Settings, which put "who may
               sign in" three levels down: rail → Settings → Users & roles →
               a tab. It is not a preference about how the shop runs, it is a
               register of people, and it belongs beside the other things you
               do ABOUT the business rather than in it. */
            can("users", "view") && { label: "Users & roles", hint: "Who can sign in, and what they may do",
                                      onClick: () => navigate("users") },
            can("settings", "view") && { label: "Settings", hint: "How this shop runs",
                                         onClick: () => navigate("settings") },
            can("settings", "edit") && { label: "Sync", hint: "Keep this business on the server",
                                         onClick: () => navigate("cloud") },
            { label: "Updates", hint: "What version this is, and what is new",
              onClick: () => navigate("update") },
          ].filter(Boolean)} />
        </div>

        {/* Only the nav list scrolls: the brand above and the settings / user
            block below are pinned, so every destination is reachable at laptop
            height without scrolling the brand and the top items out of view. */}
        <nav className="dk-railnav dk-s" aria-label="Main">
        {railBands.map((band, bi) => (
          <React.Fragment key={bi}>
            {/* aria-hidden: the label is a visual grouping cue, and the buttons
                below it are already reachable and named. */}
            <div className="dk-navgroup" aria-hidden="true">{band.title}</div>
            {band.items.map((r) => (
              <button
                key={r.key}
                className={`dk-nav ${r.mod ? "mod" : ""} ${page === r.page && (!r.sub || pageSub === r.sub) ? "on" : ""}`}
                onClick={() => navigate(r.page, r.sub || null)}
                title={r.label}
              >
                <DeckIc id={r.key} size={r.mod ? 19 : 20} />
                {badges[r.page] > 0 && (
                  <span className={`dk-badge ${r.page === "items" ? "warn" : ""}`}>{badges[r.page]}</span>
                )}
                <span className="lbl">{r.label}</span>
              </button>
            ))}
          </React.Fragment>
        ))}
        </nav>

        <div className="dk-railfoot">
        <button className="dk-user" onClick={logout} title="Switch user / sign out">
          <span className="dk-avatar">{initials}</span>
          <span className="lbl">{userName}</span>
        </button>
        </div>
      </aside>

      <main className="dk-main">
        <div className="dk-top">
          <div className="dk-top-head">
            <button className="dk-rail-toggle" onClick={toggleNav} title="Hide or show the menu" aria-label="Hide or show the menu">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 5h16v14H4z" /><path d="M10 5v14" /><path d="M7.2 10l-1.7 2 1.7 2" />
              </svg>
            </button>
            <div style={{ minWidth: 0 }}>
              {/* Kept from v1.21 — the deck has no breadcrumb, but a way back
                  to Home on every screen was asked for and is still useful. */}
              {/* Always drawn, so the bar is the same height on Home as on
                  every other screen. On the dashboard it is a hidden
                  placeholder rather than a trail reading "Home / Home". */}
              {page !== "dashboard" ? (
                <div className="dk-crumbs">
                  <button onClick={() => navigate("dashboard")}>Home</button>
                  <span>/</span>
                  <span className="now">{headTitle}</span>
                </div>
              ) : (
                <div className="dk-crumbs is-ghost" aria-hidden="true"><span className="now">&nbsp;</span></div>
              )}
              <h1>{headTitle}</h1>
              <div className="sub">{headSub}</div>
            </div>
          </div>

          <div className="dk-top-acts">
            {history.length > 0 && (
              <button className="dk-btn icon hide-sm" onClick={goBack} title="Back" aria-label="Back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            {/* Not in the deck, which sets theme and accent from props. Both
                are shipped features, so they keep one home together. */}
            <AppearanceMenu theme={appTheme} onTheme={toggleTheme} accent={accent} onAccent={setAccentPref} />
            <button className="dk-btn icon hide-sm" onClick={() => setAboutOpen(true)}
                    title="About this app" aria-label="About this app">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
              </svg>
            </button>
            <button className="dk-btn hide-sm" onClick={() => setPalette(true)} title="Find anything (Ctrl+F)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14" /><path d="M20 20l-3.5-3.5" />
              </svg>
              Find anything
            </button>
            {can("sales", "create") && (
              /* Straight to the till when there is one. A shop that has turned
                 the till off — a wholesaler, a workshop — was sent to a screen
                 its own settings had removed from the rail, so "New sale" went
                 nowhere it could use. It opens a new invoice instead, which is
                 how that shop sells. */
              <button className="dk-btn primary"
                      onClick={() => (mods.mod_pos === "0" ? navigate("invoices", "new") : navigate("pos"))}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14" /><path d="M5 12h14" />
                </svg>
                New sale
              </button>
            )}
          </div>
        </div>

        <div className="dk-content dk-s">
          <ErrorBoundary key={pageSub || page}>
            <React.Suspense fallback={<div className="page-loading"><span className="spin" /> Loading…</div>}>
              <Page initial={pageSub} />
            </React.Suspense>
          </ErrorBoundary>
        </div>

        {/* The page action dock. A page that has unsaved work portals its
            Save/Discard buttons in here (see PageDock in lib/deckui.jsx).

            It is a *sibling* of .dk-content, not a child, and that is the whole
            point: .dk-content is the scrollport, so a bar docked out here
            shortens the scrollport rather than floating over it. A bar pinned
            *inside* the scroll area is exactly the reported fault — the
            Settings section header sat on top of the switch row you were
            trying to read, and no amount of scrolling would move it, because a
            sticky element travels with you. Out here it cannot cover anything.

            With nothing in it the div has no height, so a page with nothing to
            save loses no room to it. */}
        <div className="dk-dock" id="dk-dock" />
      </main>

      {aboutOpen && <AboutBox onClose={() => setAboutOpen(false)} />}
      {palette && <Palette onClose={() => setPalette(false)} onGo={(pg, sub) => { navigate(pg, sub || null); setPalette(false); }} />}
      <ToastHost /><ConfirmHost /><SheetHost /><PrintPreviewHost /><PrintPromptHost />
    </div>
  );
}


/* ── Sign in, built to the design deck ────────────────────────────────────
   Two panels: what this thing is on the left, getting into it on the right.

   The staff picker and PIN sign-in are both off until a shop turns them on
   under Settings → General. The picker puts names on a screen nobody has
   signed in to yet, which is convenient at a counter and a disclosure
   everywhere else; that is the shop's call to make, not ours.  */
const LOGIN_POINTS = [
  ["M4 5h16v14H4z|M4 9h16|M8 13h4",
   "Sell at the till, post to the books",
   "Every receipt lands in sales, stock and the ledger at once."],
  ["M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18|M3.5 9h17|M3.5 15h17|M12 3c2.5 3 2.5 15 0 18|M12 3c-2.5 3-2.5 15 0 18",
   "Works offline, syncs when back",
   "Counters keep billing through an outage; nothing is lost."],
  ["M6 3h9l4 4v14H6z|M9 13h6|M9 17h4",
   "Tax-ready without extra typing",
   "VAT and e-invoice files come out of the same records."],
];

/* An invitation link is the one URL this application answers to that a
   stranger may arrive on. `#/invitation/<token>` rather than a path, because
   the app is served as a single file from Electron as well as from a server,
   and a path would 404 on one of them. */
function inviteTokenFromUrl() {
  const m = /#\/invitation\/([A-Za-z0-9_-]+)/.exec(window.location.hash || "");
  return m ? m[1] : null;
}

/* ── The first screen a new installation shows ────────────────────────────
 *
 * There are no logins yet. Rather than generating a password, printing it in
 * a console window and hoping somebody reads it back correctly, the person
 * setting the till up says who they are and chooses their own.
 *
 * The server only answers this while nobody exists, and only on the machine
 * it is running on. Both of those matter more than anything on this screen. */
function FirstRun({ opts, onIn }) {
  const [business, setBusiness] = useState(opts.firm || "");
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  /* A username suggests itself from the name, because "what should I call
     myself" is the step people stall on and it does not matter much. */
  const suggest = (name) => {
    const first = String(name).trim().toLowerCase().split(/\s+/)[0] || "";
    return first.replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  };

  const go = async () => {
    setErr("");
    if (password !== again) return setErr("The two passwords are not the same");
    setBusy(true);
    try {
      const d = await api.post("/auth/first-user", {
        business: business.trim(), full_name: fullName.trim(),
        username: username.trim().toLowerCase(), password,
      });
      setSession(d);
      setPermissions(d.permissions);
      onIn(d.user);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!opts.here) {
    return (
      <div className="dk-login-box">
        <div><h2>Set this up at the till</h2><div className="who">{opts.firm || "\u00a0"}</div></div>
        <div style={{ fontSize: 13, color: "var(--soft)", lineHeight: 1.7 }}>
          This copy of Genius POS has not been set up yet, and the first account
          can only be made at the computer it is installed on — otherwise anyone
          on this network could claim it first.
          <br /><br />
          Go to that computer and open Genius POS there.
        </div>
      </div>
    );
  }

  const ready = business.trim() && fullName.trim() && username.trim().length >= 3
    && password.length >= 8 && again.length > 0;

  return (
    <div className="dk-login-box">
      <div>
        <h2>Welcome to Genius POS</h2>
        <div className="who">Let us set this till up. It takes a minute.</div>
      </div>

      {err && <div className="dk-login-err">{err}</div>}

      <label className="dk-login-field">
        <span>What is the business called?</span>
        <input value={business} autoFocus placeholder="Your business name"
               onChange={(e) => setBusiness(e.target.value)} />
      </label>

      <label className="dk-login-field">
        <span>Your name</span>
        <input value={fullName} placeholder="Your full name"
               onChange={(e) => {
                 setFullName(e.target.value);
                 if (!username) setUsername(suggest(e.target.value));
               }} />
      </label>

      <label className="dk-login-field">
        <span>The name you will sign in with</span>
        <input value={username} spellCheck={false} placeholder="A short sign-in name"
               autoComplete="username"
               onChange={(e) => setUsername(e.target.value.toLowerCase())} />
      </label>

      <label className="dk-login-field">
        <span>Choose a password</span>
        <input type={show ? "text" : "password"} value={password}
               placeholder="at least 8 characters" autoComplete="new-password"
               onChange={(e) => setPassword(e.target.value)} />
      </label>

      <label className="dk-login-field">
        <span>And again, to be sure</span>
        <input type={show ? "text" : "password"} value={again} autoComplete="new-password"
               onChange={(e) => setAgain(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && ready && !busy) go(); }} />
      </label>

      <label style={{ fontSize: 12.5, color: "var(--soft)", display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        Show the passwords
      </label>

      <button className="dk-login-go" disabled={!ready || busy} onClick={go}>
        {busy ? "Setting up…" : "Set up this till"}
      </button>

      <div style={{ fontSize: 12, color: "var(--soft)", lineHeight: 1.6 }}>
        This account is the owner: it can do everything, including adding the
        rest of your staff. You can add them in the next few steps, or later
        under Settings › Users.
      </div>
    </div>
  );
}

function Login({ onIn }) {
  const [screen, setScreen] = useState(() => (inviteTokenFromUrl() ? "invite" : null));
  const [inviteToken] = useState(inviteTokenFromUrl);
  const [mode, setMode] = useState("password");
  const [opts, setOpts] = useState(null);
  const [picked, setPicked] = useState(null);
  const [username, setU] = useState("admin");
  const [email, setEmail] = useState("");
  const [password, setP] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState("");
  /* The shop this screen is for.
   *
   * A desktop installation has one company and is never asked: the server
   * answers with it and `needs_shop` never arrives. A hosted installation
   * cannot answer "which shop" for somebody who has only a username and a PIN,
   * so the screen asks once and remembers — a cashier should type a shop code
   * on their first morning and never again. */
  const [shop, setShop] = useState(() => localStorage.getItem("vy_shop") || "");
  const [shopTyped, setShopTyped] = useState("");
  /* An owner does not have a shop code and should never be stopped by the shop
     step — their account names its own businesses. Without this the screen was
     a dead end for the one person who could fix it: the hint said "an owner
     signs in with an email address" while offering nowhere to type one. */
  const [ownerMode, setOwnerMode] = useState(false);
  /* Set when the password was right but this device has not signed in before.
     Holding it in state rather than routing to another screen keeps the typed
     email and password out of the URL and out of a second component. */
  const [codeStep, setCodeStep] = useState(null);

  const loadOptions = (code) => api
    .get(`/auth/signin-options${code ? `?shop=${encodeURIComponent(code)}` : ""}`)
    .then((d) => {
      setOpts(d); setVer(d.version || "");
      if (d.pinEnabled) setMode("pin");
      /* Only remembered once it is known to work. Storing a code the server
         did not recognise would greet them with the same dead end tomorrow. */
      if (code && !d.needs_shop) localStorage.setItem("vy_shop", code);
      if (d.unknown_shop) localStorage.removeItem("vy_shop");
    })
    .catch(() => setOpts({ showStaff: false, pinEnabled: false, staff: [] }));

  useEffect(() => { loadOptions(shop); }, []);

  const pick = (u) => {
    setPicked(u.id); setU(u.username); setErr("");
    setMode(u.has_pin && opts.pinEnabled ? "pin" : "password");
    setPin(""); setP("");
  };

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      /* The shop rides along with both staff tiers. An owner signing in by
         email does not need it — an account names its own companies. */
      const data = mode === "pin"
        ? await api.post("/auth/login-pin", { username, pin, shop })
        : mode === "email"
        ? await api.post("/auth/login-email", { email, password, device_token: deviceToken() })
        : await api.post("/auth/login", { username, password, shop });
      /* The password was right, but this device has to prove itself as well.
         Nothing is stored and no session exists yet — the second step decides. */
      if (data.needs_code) {
        setCodeStep({ challenge: data.challenge, sentTo: data.sent_to,
                      backupCodesLeft: data.backup_codes_left || 0 });
        setBusy(false); setP("");
        return;
      }
      setSession(data);
      onIn(data.user);
    } catch (e) { setErr(e.message); setBusy(false); setPin(""); }
  };

  /* The PIN cells are a display; a real input sits behind them so keyboards,
     number pads and paste all work without being re-implemented. */
  useEffect(() => {
    if (mode !== "pin") return;
    if (pin.length === 4 && !busy) submit();
  }, [pin, mode]);

  const canGo = mode === "pin" ? pin.length === 4
    : mode === "email" ? email.trim() && password
    : username.trim() && password;

  return (
    <div className="dk-login">
      <div className="dk-login-pitch">
        <div className="dk-login-brand">
          <div className="mark">{(opts && opts.firm ? opts.firm : "S")[0].toUpperCase()}</div>
          <div className="nm">{opts && opts.firm ? opts.firm : "Genius POS"}</div>
          {ver && <span className="ver dk-n">v{ver}</span>}
        </div>

        <div className="dk-login-mid">
          <h1>Everything the shop did today, already added up.</h1>
          <p>Bills, stock, debts and tax in one book that keeps working when the network does not.</p>
          <div className="dk-login-points">
            {LOGIN_POINTS.map(([d, t, s], i) => (
              <div className="dk-login-point" key={i}>
                <span className="ic">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {d.split("|").map((p, k) => <path key={k} d={p} />)}
                  </svg>
                </span>
                <div>
                  <div className="t">{t}</div>
                  <div className="s">{s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="dk-login-foot">
          <span>SALJO TECH</span><span>·</span>
          <span>Billing, stock and books for Ugandan shops</span>
        </div>
      </div>

      <div className="dk-login-form">
        {screen ? (
          <React.Suspense fallback={<div className="dk-login-box"><div className="who">Loading…</div></div>}>
            {screen === "invite" ? (
              <InviteScreen token={inviteToken} onIn={onIn} onBack={() => { window.location.hash = ""; setScreen(null); }} />
            ) : screen === "signup" ? (
              <SignUpScreen onIn={onIn} onBack={() => setScreen(null)} />
            ) : (
              <ForgotScreen onBack={() => setScreen(null)} />
            )}
          </React.Suspense>
        ) : codeStep ? (
          <React.Suspense fallback={<div className="dk-login-box"><div className="who">Loading…</div></div>}>
            <SignInCodeScreen
              challenge={codeStep.challenge}
              sentTo={codeStep.sentTo}
              backupCodesLeft={codeStep.backupCodesLeft}
              onDone={(d) => onIn(d.user)}
              onBack={(msg) => { setCodeStep(null); setErr(msg || ""); setBusy(false); }}
            />
          </React.Suspense>
        ) : opts && opts.needs_first_user ? (
          <FirstRun opts={opts} onIn={onIn} />
        ) : (
        <div className="dk-login-box">
          <div>
            <h2>{opts && opts.needs_shop ? "Which shop?" : "Sign in to your shop"}</h2>
            <div className="who">{opts && opts.firm ? opts.firm : "\u00a0"}</div>
          </div>

          {/* The shop step. Shown only when the server could not work out which
              shop this is — which on every desktop installation is never, since
              there is one company and it says so. */}
          {opts && opts.needs_shop && !ownerMode ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {opts.unknown_shop && (
                <div className="dk-login-err">
                  We could not find that shop code. Check it with the owner — it is not your password.
                </div>
              )}
              {/* Several businesses on this computer: offered as buttons.
                  Asking a cashier for a "shop code" is asking for something
                  nobody ever gave them, and it was the dead end on every
                  multi-business installation. The typed code stays for hosted
                  installations, where the list is every shop on the server. */}
              {opts.businesses && opts.businesses.length > 0 ? (
                <>
                  <div style={{ fontSize: 12.5, color: "var(--soft)", lineHeight: 1.6 }}>
                    Which business are you opening?
                  </div>
                  <div className="dk-bizpick">
                    {opts.businesses.map((b) => (
                      <button key={b.id} onClick={() => {
                        const code = b.shop_code || String(b.id);
                        setShop(code); loadOptions(code);
                      }}>
                        {/* A business named with nothing but spaces is a row
                            the schema allows, and `"".trim()[0]` is undefined,
                            which throws on .toUpperCase() and blanks the whole
                            sign-in screen. */}
                        <span className="av">{(String(b.name || "").trim() || "?")[0].toUpperCase()}</span>
                        <span className="nm">{b.name}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
              <div style={{ fontSize: 12.5, color: "var(--soft)", lineHeight: 1.6 }}>
                Type the shop code the owner gave you. You only have to do this once on this device.
              </div>
              )}
              <label className="dk-login-field"
                     style={{ display: opts.businesses && opts.businesses.length ? "none" : undefined }}>
                <span>Shop code</span>
                <input value={shopTyped} autoFocus autoCapitalize="none" autoCorrect="off"
                       placeholder="e.g. kampala-hardware"
                       onChange={(e) => setShopTyped(e.target.value.trim().toLowerCase())}
                       onKeyDown={(e) => {
                         if (e.key === "Enter" && shopTyped) { setShop(shopTyped); loadOptions(shopTyped); }
                       }} />
              </label>
              {!(opts.businesses && opts.businesses.length) && (
                <button className="dk-login-go" disabled={!shopTyped}
                        onClick={() => { setShop(shopTyped); loadOptions(shopTyped); }}>
                  Continue
                </button>
              )}
              <button style={{ alignSelf: "center", background: "none", border: 0, padding: 4, cursor: "pointer",
                               fontSize: 12.5, fontWeight: 600, color: "var(--soft)", textDecoration: "underline" }}
                      onClick={() => { setOwnerMode(true); setMode("email"); setErr(""); }}>
                I'm the owner — sign in with my email instead
              </button>
            </div>
          ) : (
          <>

          {opts && opts.showStaff && opts.staff.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div className="dk-login-cap">Who is signing in</div>
              <div className="dk-staff">
                {opts.staff.slice(0, 6).map((u) => (
                  <button key={u.id} className={picked === u.id ? "on" : ""} onClick={() => pick(u)}>
                    <span className="av">
                      {String(u.full_name || u.username).trim().split(/\s+/).slice(0, 2)
                        .filter(Boolean).map((w) => w[0].toUpperCase()).join("")}
                    </span>
                    <span className="nm">{(u.full_name || u.username).split(/\s+/)[0]}</span>
                    <span className="rl">{u.role_name || "Staff"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Two tiers, and the screen says which is which rather than making
              somebody guess. An owner has an email address and may hold several
              businesses; counter staff have a username and a PIN, belong to one
              business, and should never be asked for an email they do not have.
              The segmented control is always shown now — before, it appeared
              only when PINs were enabled, so the email tier would have been
              unreachable on a shop that had not turned PINs on. */}
          <div className="dk-login-seg">
            <button className={mode === "email" ? "on" : ""}
                    onClick={() => { setMode("email"); setErr(""); }}>Owner — email</button>
            {opts && opts.pinEnabled && (
              <button className={mode === "pin" ? "on" : ""}
                      onClick={() => { setMode("pin"); setErr(""); }}>Staff — PIN</button>
            )}
            <button className={mode === "password" ? "on" : ""}
                    onClick={() => { setMode("password"); setErr(""); }}>Username</button>
          </div>

          {err && <div className="dk-login-err">{err}</div>}

          {/* One block of fixed height for all three tiers (.dk-login-creds).
              Each tier is a different number of rows tall, and letting the box
              resize made the whole form jump up and down as somebody tried the
              tabs — the thing they clicked moved out from under the pointer. */}
          {mode === "pin" ? (
            <div className="dk-login-creds" style={{ gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 650, color: "var(--soft)" }}>
                {picked ? `Enter ${(opts.staff.find((s) => s.id === picked) || {}).full_name || username}'s PIN` : "Enter PIN"}
              </span>
              <div style={{ position: "relative" }}>
                <div className="dk-pin dk-n" onClick={() => document.getElementById("dk-pin-input")?.focus()}>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className={`cell ${i === pin.length ? "here" : ""}`}>
                      {i < pin.length ? "•" : i === pin.length ? <i /> : ""}
                    </div>
                  ))}
                </div>
                <input id="dk-pin-input" inputMode="numeric" autoComplete="off" autoFocus
                       aria-label="PIN" value={pin}
                       onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                       style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%" }} />
              </div>
              {!picked && (
                <label className="dk-login-field" style={{ marginTop: 4 }}>
                  <span>Username</span>
                  <input value={username} onChange={(e) => setU(e.target.value)} />
                </label>
              )}
            </div>
          ) : mode === "email" ? (
            <div className="dk-login-creds">
              <label className="dk-login-field">
                <span>Email address</span>
                <input type="email" value={email} autoFocus autoComplete="username"
                       onChange={(e) => setEmail(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && canGo && submit()} />
              </label>
              <label className="dk-login-field">
                <span>Password</span>
                <input type="password" value={password} autoComplete="current-password"
                       onChange={(e) => setP(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && canGo && submit()} />
              </label>
            </div>
          ) : (
            <div className="dk-login-creds">
              <label className="dk-login-field">
                <span>Username</span>
                <input value={username} autoFocus onChange={(e) => setU(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && canGo && submit()} />
              </label>
              <label className="dk-login-field">
                <span>Password</span>
                <input type="password" value={password} onChange={(e) => setP(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && canGo && submit()} />
              </label>
            </div>
          )}

          <button className="dk-login-go" onClick={submit} disabled={busy || !canGo}>
            {busy ? "Opening…" : "Open shop"}
          </button>

          {/* Offered only on the owner tier. Counter staff do not have an
              email address and cannot create an account; showing them a
              "create one" link would send them looking for something their
              shop deliberately did not give them. */}
          {/* The row keeps its space on every tier and is only made invisible
              off the owner one, so choosing a tab never adds or removes a row
              and shunts the rest of the box. */}
          <div className={`dk-login-links ${mode === "email" ? "" : "is-hidden"}`} aria-hidden={mode !== "email"}>
            <button className="dk-sbtn" style={{ background: "none", border: 0, padding: 0 }}
                    tabIndex={mode === "email" ? 0 : -1}
                    onClick={() => setScreen("forgot")}>Forgotten your password?</button>
            <button className="dk-sbtn" style={{ background: "none", border: 0, padding: 0 }}
                    tabIndex={mode === "email" ? 0 : -1}
                    onClick={() => setScreen("signup")}>Create an account</button>
          </div>

          {/* This used to print "admin / admin123 · sales / sales123". Two
              things wrong with that: it is an advertisement for a shipped
              password on a screen that may face a shop's Wi-Fi, and since the
              first run started asking people to choose their own it is not
              even true. */}
          <div className="dk-login-hint">
            {opts && opts.pinEnabled
              ? "A PIN is set for each person under Settings → Users & roles."
              : "Forgotten it? The owner can reset it under Settings → Users."}
          </div>

          {/* Only offered when a code was actually used to get here. On a
              one-company machine there is nothing to change to, and the link
              would be a way to lock yourself out of the only shop there is. */}
          {ownerMode && opts && opts.needs_shop && (
            <button style={{ alignSelf: "center", background: "none", border: 0, padding: 4, cursor: "pointer",
                             fontSize: 12, fontWeight: 600, color: "var(--soft)", textDecoration: "underline" }}
                    onClick={() => { setOwnerMode(false); setErr(""); }}>
              I work at the counter — enter a shop code
            </button>
          )}

          {shop && opts && opts.shop_code && (
            <button style={{ alignSelf: "center", background: "none", border: 0, padding: 4, cursor: "pointer",
                             fontSize: 12, fontWeight: 600, color: "var(--soft)", textDecoration: "underline" }}
                    onClick={() => {
                      localStorage.removeItem("vy_shop");
                      setShop(""); setShopTyped("");
                      loadOptions("");
                    }}>
              Not {opts.firm}? Use a different shop
            </button>
          )}
          </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}


/* ── "Open Anything" (Ctrl+F): search pages, parties, items, invoices ── */
/* ── Appearance ───────────────────────────────────────────────────────────
   Light or dark, and which of the deck's four accents. Both are token swaps,
   so the whole app changes on click with nothing to save. */
const ACCENTS = [
  ["blue", "Blue", "#2563EB"],
  ["teal", "Teal", "#0F766E"],
  ["violet", "Violet", "#7C3AED"],
  ["amber", "Amber", "#B4530A"],
];

function AppearanceMenu({ theme, onTheme, accent, onAccent }) {
  const [open, setOpen] = useState(false);
  const wrapRef = React.useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="dk-appear" ref={wrapRef}>
      <button className="dk-btn icon" onClick={() => setOpen((v) => !v)}
              aria-haspopup="menu" aria-expanded={open} title="Appearance" aria-label="Appearance">
        <PosVecIc d={theme === "dark" ? POSVEC.sun : POSVEC.moon} size={17} />
      </button>
      {open && (
        <div className="dk-appear-pop" role="menu">
          <div className="cap">Theme</div>
          <div className="dk-seg">
            <button className={theme !== "dark" ? "on" : ""} onClick={() => { if (theme === "dark") onTheme(); }}>Light</button>
            <button className={theme === "dark" ? "on" : ""} onClick={() => { if (theme !== "dark") onTheme(); }}>Dark</button>
          </div>
          <div className="cap">Accent</div>
          <div className="dk-swatches">
            {ACCENTS.map(([id, label, hex]) => (
              <button key={id} className={`dk-swatch ${accent === id ? "on" : ""}`}
                      style={{ "--sw": hex }} title={label} aria-label={label}
                      onClick={() => onAccent(id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Palette({ onClose, onGo }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState({ parties: [], items: [], invoices: [] });
  useEffect(() => {
    const t = setTimeout(() => {
      if (!q.trim()) return setRes({ parties: [], items: [], invoices: [] });
      api.get(`/dashboard/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const pages = NAV.filter((n) => (!n.perm || can(n.perm[0], n.perm[1])) && n.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{ alignItems: "flex-start", paddingTop: "12vh", display: "flex", justifyContent: "center" }}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Open anything — pages, parties, items, invoices…" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ width: "100%", padding: "16px 18px", border: "none", borderBottom: "1px solid var(--border)", fontSize: 15, outline: "none", borderRadius: "14px 14px 0 0" }} />
        <div style={{ maxHeight: 380, overflow: "auto", padding: "6px 0" }}>
          {pages.map((n) => (
            <button key={n.id} className="pal-row" onClick={() => onGo(n.id)}>
              <span>{n.icon} {n.label}</span><span className="pal-kind">page</span>
            </button>
          ))}
          {res.parties.map((p) => (
            <button key={`p${p.id}`} className="pal-row" onClick={() => onGo("parties")}>
              <span>◍ {p.name}</span><span className="pal-kind">party</span>
            </button>
          ))}
          {res.items.map((i) => (
            <button key={`i${i.id}`} className="pal-row" onClick={() => onGo("items")}>
              {/* Raw base quantity with no unit at all; dualQty matches the rest
                 of the app and keeps dual-unit items readable. */}
              <span>▣ {i.name}</span><span className="pal-kind">{dualQty(i.on_hand, i.unit || "", i.secondary_unit, i.conversion_rate)} in stock</span>
            </button>
          ))}
          {res.invoices.map((s) => (
            <button key={`s${s.id}`} className="pal-row" onClick={() => onGo("invoices")}>
              <span>▭ {s.invoice_no} · {s.party_name}</span><span className="pal-kind">invoice</span>
            </button>
          ))}
          {!q && <div style={{ padding: "18px 20px", color: "var(--muted)", fontSize: 13 }}>Type to search… Esc to close.</div>}
        </div>
      </div>
    </div>
  );
}


/* ── single-colour vector icons (Aronium style) ── */
function Ic({ d, size = 22 }) {
  return (
    <svg className="ic" style={{ width: size, height: size }} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}
const IC = {
  history: "M12 8v4l3 2|M3.5 12a8.5 8.5 0 1 1 2.5 6|M3 13l.5 5 4.5-2",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14|M20 20l-4-4",
  cash: "M2 6h20v12H2z|M12 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4|M5.5 12h.01|M18.5 12h.01",
  credit: "M6 3h9l4 4v14H6z|M14 3v5h5|M9 13h6|M9 17h4",
  chart: "M4 20V5|M4 20h16|M8 16v-4|M12 16V8|M16 16v-6",
  door: "M13 4h7v16h-7|M3 12h11|M10 8l4 4-4 4",
  home: "M3 11l9-8 9 8|M5 10v10h14V10|M10 20v-6h4v6",
  out: "M15 4h5v16h-5|M3 12h12|M11 8l4 4-4 4",
  user: "M12 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7|M5 20c1.6-3.4 4-5 7-5s5.4 1.6 7 5",
  users: "M9 6a3 3 0 1 0 0 6a3 3 0 1 0 0-6|M3 20c1.3-2.9 3.3-4.3 6-4.3s4.7 1.4 6 4.3|M15.5 7a2.5 2.5 0 1 1 1 4.8|M17.5 15.6c2 .6 3.3 1.9 3.9 4.4",
  x: "M6 6l12 12|M18 6L6 18",
};

/* ── POS topbar vector icons ── */
const POSVEC = {
  back: "M15 6l-6 6 6 6",
  moon: "M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z",
  sun: "M12 5V3|M12 21v-2|M5 12H3|M21 12h-2|M6.3 6.3L4.9 4.9|M19.1 19.1l-1.4-1.4|M6.3 17.7l-1.4 1.4|M19.1 4.9l-1.4 1.4|M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8",
};
function PosVecIc({ d, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle" }}>
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

/* ── POS ⋮ — full-height slide-in drawer with working actions ── */
function PosDots({ onGo, onLogout }) {
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState(false);
  const [panel, setPanel] = useState(null); // 'x' | 'z' | 'credit'
  const user = currentUser() || {};
  const row = (ic, label, fn) => (
    <button className="dr-item" onClick={() => { setOpen(false); fn(); }}>
      <span className="ic">{ic}</span>{label}
    </button>
  );
  return (
    <div className="pos-dots">
      <button onClick={() => setOpen(true)} title="Menu">⋮</button>
      {open && (
        <div className="pos-drawer-veil" onClick={() => setOpen(false)}>
          <div className="pos-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dr-head">
              <h2>POS — {user.full_name || user.username || ""}</h2>
              <button className="icon-btn" style={{ color: "#C9D1E0", fontSize: 18 }} onClick={() => setOpen(false)}>→</button>
            </div>
            <div className="dr-body">
              <div className="dr-sec">Drawer & payments</div>
              {row(<Ic d={IC.cash} />, "Cash in / out", () => setCash(true))}
              {row(<Ic d={IC.credit} />, "Credit payments — collect debts", () => setPanel("credit"))}
              {row(<Ic d={IC.search} />, "Find receipt — scan barcode", () => setPanel("find"))}
              {row(<Ic d={IC.history} />, "Previous sales — view & reprint", () => setPanel("prev"))}
              <div className="dr-sec">Reports</div>
              {row(<Ic d={IC.chart} />, "X report — today so far", () => setPanel("x"))}
              {row(<Ic d={IC.door} />, "End of day", () => setPanel("eod"))}
              <div className="dr-sec">User</div>
              {row(<Ic d={IC.home} />, "Back to dashboard", () => onGo("dashboard"))}
              {row(<Ic d={IC.out} />, "Sign out", onLogout)}
            </div>
            <div className="dr-foot"><span>{new Date().toLocaleDateString()}</span><span>Genius POS</span></div>
          </div>
        </div>
      )}
      {cash && <CashDlg onClose={() => setCash(false)} />}
      {panel === "x" && <DayPanel mode="x" onClose={() => setPanel(null)} />}
      {panel === "eod" && <EndOfDayPanel onClose={() => setPanel(null)} />}
      {panel === "credit" && <CreditPanel onClose={() => setPanel(null)} />}
      {panel === "find" && <FindReceiptPanel onClose={() => setPanel(null)} />}
      {panel === "prev" && <PrevSalesPanel onClose={() => setPanel(null)} />}
    </div>
  );
}

/* ── Aronium-format slips ── */
function slipCss() {
  return `body{font-family:'Arial','Segoe UI',sans-serif;font-size:13px;margin:0;padding:14px;width:300px;color:#111}
    h1{font-size:19px;text-align:center;margin:0 0 10px;font-weight:800}
    .r{display:flex;justify-content:space-between;padding:1.5px 0}
    .r b{font-weight:700}
    .sec{border-top:1px dashed #444;margin:7px 0 4px;padding-top:5px}
    .rt{text-align:right}
    .big{font-weight:800;font-size:14px}
    .ind{padding-left:10px}`;
}
function zSlipHtml(d, kind) {
  const inr = (n) => "USh" + Number(n || 0).toLocaleString("en-UG");
  const now = new Date();
  const dt = (x) => x.toLocaleDateString("en-GB");
  const users = d.by_user.map((u) => `
    <div class="r"><span>${u.user}</span></div>
    ${(u.modes || []).map((m) => `<div class="r ind"><span style="text-transform:capitalize">${m.mode}:</span><span>${inr(m.total)}</span></div>`).join("")}
  `).join("");
  const tenders = d.rows.map((r) => `<div class="r"><span style="text-transform:capitalize">${r.mode}:</span><span>${inr(r.total)}</span></div>`).join("");
  return `<html><head><title>${kind} Report</title><style>${slipCss()}</style></head><body>
    <h1>${kind.toUpperCase()} REPORT</h1>
    <div class="r"><span>POS #:</span><span>POS</span></div>
    <div class="r"><span>Date:</span><span>${dt(now)} 00:00:00</span></div>
    <div class="r"><span>Time:</span><span>${dt(now)} ${now.toLocaleTimeString("en-GB")}</span></div>
    <div class="r"><span>Report #:</span><span>${d.report_no || 1}</span></div>
    <div class="sec"></div>
    <div class="r"><span>From document:</span><span>${d.from_doc}</span></div>
    <div class="r"><span>To document:</span><span>${d.to_doc}</span></div>
    <div class="sec"><div class="r"><b>User sales:</b><b>${d.totals.bills}</b></div></div>
    ${users}
    <div class="r rt"><span></span><b>= ${inr(d.totals.received)}</b></div>
    <div class="sec"><div class="r"><b>Tender types:</b><span></span></div></div>
    ${tenders}
    <div class="r"><span>Total tendered:</span><b>${inr(d.totals.received)}</b></div>
    <div class="sec"><div class="r"><b>Discounts granted:</b><span>${inr(d.totals.discounts)}</span></div></div>
    ${d.totals.tax || d.totals.taxable !== d.totals.gross
      ? `<div class="r"><span>Taxable total:</span><span>${inr(d.totals.taxable)}</span></div>
         <div class="r"><span>Tax:</span><span>${inr(d.totals.tax)}</span></div>`
      : ""}
    <div class="r big"><span>Total:</span><span>${inr(d.totals.gross)}</span></div>
    <div class="sec"></div>
    <div class="r big"><span>Total payment received:</span><span>${inr(d.totals.received)}</span></div>
    ${d.totals.refunds ? `<div class="r"><span>Refunds (${d.totals.refunds}):</span><span>${inr(d.totals.refund_total)}</span></div>` : ""}
    ${d.totals.voids ? `<div class="r"><span>Voided (${d.totals.voids}):</span><span>${inr(d.totals.void_total)}</span></div>` : ""}
    <script>setTimeout(()=>print(),300)<\/script></body></html>`;
}
function itemsSlipHtml(d) {
  const now = new Date();
  const dt = (x) => x.toLocaleDateString("en-GB");
  return `<html><head><title>Items report</title><style>${slipCss()}</style></head><body>
    <h1>ITEMS REPORT</h1>
    <div class="r"><span>Date:</span><span>${dt(now)}</span></div>
    <div class="r"><span>Time:</span><span>${dt(now)} ${now.toLocaleTimeString("en-GB")}</span></div>
    <div class="r"><span>Report #:</span><span>${d.report_no || 1}</span></div>
    <div class="sec"><div class="r"><b>PRODUCT GROUPS</b><span></span></div></div>
    ${d.groups.map((g) => `<div class="r"><span>${g.name}</span><span>${g.qty}</span></div>`).join("")}
    <div class="sec"><div class="r"><b>PRODUCTS</b><span></span></div></div>
    ${d.items.map((i) => `<div class="r"><span>${i.name}</span><span>${i.qty}</span></div>`).join("")}
    <div class="sec"></div>
    <div class="r big"><span>Items count:</span><span>${d.items.length}</span></div>
    <script>setTimeout(()=>print(),300)<\/script></body></html>`;
}
function openSlip(html) {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html); w.document.close();
}

/* ── X / Z report panel: live day-close data, printable ── */
function DayPanel({ mode, onClose }) {
  const [d, setD] = useState(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const inr = (n) => Number(n || 0).toLocaleString("en-UG");
  const load = (dt) => (mode === "x" ? api.get("/pos/day-close/preview?scope=cashout_all") : api.get(`/reports/day-close?date=${dt}`)).then(setD).catch(() => setD({ rows: [], by_user: [], totals: {} }));
  useEffect(() => { load(date); }, [date]);
  const doPrint = () => {
    if (!d) return;
    if (mode === "x" && d.report_no) return openSlip(zSlipHtml(d, "X"));
    const w = window.open("", "_blank");
    if (!w) return;
    const rows = d.rows.map((r) => `<tr><td>${r.mode}</td><td style="text-align:right">${r.bills}</td><td style="text-align:right">${inr(r.total)}</td></tr>`).join("");
    const users = d.by_user.map((u) => `<tr><td>${u.user}</td><td style="text-align:right">${u.bills}</td><td style="text-align:right">${inr(u.total)}</td></tr>`).join("");
    w.document.write(`<html><head><title>${mode === "z" ? "Z report" : "X report"} ${d.date}</title>
      <style>body{font-family:'Segoe UI',monospace;margin:26px;font-size:13px}h2{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{padding:5px 8px;border-bottom:1px solid #ccc;text-align:left}</style></head><body>
      <h2>${mode === "z" ? "END OF DAY — Z REPORT" : "X REPORT (day still open)"}</h2>
      <div>${d.date} · printed ${new Date().toLocaleTimeString()}</div>
      <table><tr><th>Tender</th><th style="text-align:right">Bills</th><th style="text-align:right">${cur()}</th></tr>${rows}</table>
      <table><tr><th>Cashier</th><th style="text-align:right">Bills</th><th style="text-align:right">${cur()}</th></tr>${users}</table>
      <div>Gross: ${cur()} ${inr(d.totals.gross)} · Refunds: ${cur()} ${inr(d.totals.refund_total)} · Voids: ${d.totals.voids || 0} · <b>Net: ${cur()} ${inr(d.totals.net)}</b></div>
      <script>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  };
  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={onClose}>← Back</button>
        <h2>{mode === "z" ? "End of day — Z report" : "X report · today so far"}</h2>
        {mode === "z" && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ marginLeft: "auto", width: 160 }} />}
      </div>
      <div className="p-body">
        {!d ? "Loading…" : (
          <>
            <div className="zchips">
              <div className="zchip"><div className="l">Bills</div><div className="v">{d.totals.bills || 0}</div></div>
              <div className="zchip g"><div className="l">Gross sales</div><div className="v">{cur()} {inr(d.totals.gross)}</div></div>
              <div className="zchip y"><div className="l">Unpaid (credit)</div><div className="v">{cur()} {inr(d.totals.unpaid)}</div></div>
              <div className="zchip r"><div className="l">Refunds ({d.totals.refunds || 0})</div><div className="v">{cur()} {inr(d.totals.refund_total)}</div></div>
              <div className="zchip r"><div className="l">Voids ({d.totals.voids || 0})</div><div className="v">{cur()} {inr(d.totals.void_total)}</div></div>
              <div className="zchip g"><div className="l">Net</div><div className="v">{cur()} {inr(d.totals.net)}</div></div>
            </div>
            <table className="zt"><thead><tr><th>Tender</th><th style={{ textAlign: "right" }}>Bills</th><th style={{ textAlign: "right" }}>Received (Sh)</th></tr></thead>
              <tbody>{d.rows.length === 0 ? <tr><td colSpan={3} style={{ color: "#8B94A6" }}>No sales on this day yet.</td></tr> :
                d.rows.map((r, i) => <tr key={i}><td style={{ textTransform: "capitalize" }}>{r.mode}</td><td style={{ textAlign: "right" }} className="num">{r.bills}</td><td style={{ textAlign: "right" }} className="num">{inr(r.received ?? r.total)}</td></tr>)}
              </tbody></table>
            <table className="zt"><thead><tr><th>Cashier</th><th style={{ textAlign: "right" }}>Bills</th><th style={{ textAlign: "right" }}>Total (Sh)</th></tr></thead>
              <tbody>{d.by_user.map((u, i) => <tr key={i}><td>{u.user}</td><td style={{ textAlign: "right" }} className="num">{u.bills}</td><td style={{ textAlign: "right" }} className="num">{inr(u.total)}</td></tr>)}</tbody></table>
            {mode === "z" && <p style={{ color: "#8B94A6", fontSize: 12.5 }}>Print this, count the drawer against the Cash row, and keep the slip with the day's money.</p>}
          </>
        )}
      </div>
      <div className="p-foot">
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={doPrint}><Icon n="print" size={15} /> Print {mode === "z" ? "Z report" : "X report"}</button>
      </div>
    </div>
  );
}

/* ── Credit payments: open balances → record a payment (oldest invoices cleared first) ── */
function CreditPanel({ onClose }) {
  const [rows, setRows] = useState(null);
  const [pick, setPick] = useState(null); // {party, balance, party_id?}
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("cash");
  const [busy, setBusy] = useState(false);
  const inr = (n) => Number(n || 0).toLocaleString("en-UG");
  const load = () => Promise.all([api.get("/reports/unpaid-sales"), api.get("/parties")])
    .then(([u, ps]) => {
      const by = {};
      u.rows.forEach((r) => {
        if (!by[r.party]) by[r.party] = { party: r.party, balance: 0, oldest: r.invoice_date, invoices: 0 };
        by[r.party].balance += r.balance_due; by[r.party].invoices++;
        if (r.invoice_date < by[r.party].oldest) by[r.party].oldest = r.invoice_date;
      });
      const list = Object.values(by).map((x) => ({ ...x, party_id: (ps.find((p) => p.name === x.party) || {}).id }));
      setRows(list.sort((a, b) => b.balance - a.balance));
    }).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const collect = async () => {
    if (!pick?.party_id || !(Number(amount) > 0)) return toast("Enter the amount received", "bad");
    setBusy(true);
    try {
      await api.post("/payments", { party_id: pick.party_id, direction: "in", amount: Number(amount), mode });
      toast(`${cur()} ${inr(amount)} from ${pick.party} — oldest invoices cleared first`);
      setPick(null); setAmount(""); load();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={onClose}>← Back</button>
        <h2>Credit payments — collect debts</h2>
      </div>
      <div className="p-body">
        {rows === null ? "Loading…" : rows.length === 0 ? (
          <p style={{ color: "#8B94A6" }}>No outstanding credit — every invoice is paid. 🎉</p>
        ) : (
          <table className="zt"><thead><tr><th>Customer</th><th style={{ textAlign: "right" }}>Invoices</th><th>Oldest</th><th style={{ textAlign: "right" }}>Owes (Sh)</th><th /></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}>
                <td><b>{r.party}</b></td>
                <td style={{ textAlign: "right" }} className="num">{r.invoices}</td>
                <td className="num">{r.oldest}</td>
                <td style={{ textAlign: "right" }} className="num">{inr(r.balance)}</td>
                <td><button className="btn btn-primary" onClick={() => { setPick(r); setAmount(String(r.balance)); }}>Receive</button></td>
              </tr>))}
            </tbody></table>
        )}
        {pick && (
          <div style={{ background: "#2B313A", border: "1px solid #3A4150", borderRadius: 12, padding: 18, maxWidth: 420 }}>
            <h3 style={{ margin: "0 0 10px", fontFamily: "var(--disp)" }}>{pick.party} — owes {cur()} {inr(pick.balance)}</h3>
            <Field label="Amount received (Sh)">
              <input type="number" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && collect()} style={{ fontSize: 18, textAlign: "right" }} />
            </Field>
            <Field label="Paid by">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="cash">Cash</option><option value="mobile">Mobile Money</option>
                <option value="card">Card</option><option value="bank">Bank</option>
              </select>
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setPick(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={collect}>{busy ? "Saving…" : "Record payment"}</button>
            </div>
          </div>
        )}
      </div>
      <div className="p-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
    </div>
  );
}

/* ── drawer money: cash in (other income) / cash out (expense) with GL postings ── */
function CashDlg({ onClose }) {
  const [dir, setDir] = useState("in");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const inr = (n) => Number(n || 0).toLocaleString("en-UG");
  const save = async () => {
    if (!(Number(amount) > 0)) return toast("Enter an amount", "bad");
    setBusy(true);
    try {
      if (dir === "in") {
        await api.post("/expenses/other-income", { amount: Number(amount), description: reason || "Cash in (drawer)" });
        toast(`${cur()} ${inr(amount)} added to Cash in Hand`);
      } else {
        await api.post("/expenses", { amount: Number(amount), category: "Cash out (drawer)", mode: "cash", notes: reason || "Cash out at POS" });
        toast(`${cur()} ${inr(amount)} taken out of the drawer`);
      }
      onClose();
    } catch (e) { toast(e.message, "bad"); setBusy(false); }
  };
  const chips = dir === "in"
    ? ["Float from the safe", "Opening float", "Owner top-up"]
    : ["Airtime", "Fuel", "Lunch", "Transport", "Supplier cash", "Owner drawing"];
  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={onClose}>← Back</button>
        <h2>Cash in / out — drawer</h2>
      </div>
      <div className="p-body" style={{ maxWidth: 560, width: "100%", margin: "0 auto" }}>
        <div className="seg" style={{ marginBottom: 22 }}>
          {[["in", "＋ Cash in"], ["out", "− Cash out"]].map(([v, label]) => (
            <button key={v} className={dir === v ? "on" : ""} style={{ padding: "16px 8px", fontSize: 15 }}
                    onClick={() => setDir(v)}>{label}</button>
          ))}
        </div>
        <Field label="Amount (Sh)">
          <input className="cash-big" type="number" autoFocus value={amount}
                 onChange={(e) => setAmount(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && save()} placeholder="0" />
        </Field>
        <Field label="Reason">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder={dir === "in" ? "Float from the safe…" : "Airtime, fuel, lunch…"} />
        </Field>
        <div className="chiprow">
          {chips.map((c) => <button key={c} onClick={() => setReason(c)}>{c}</button>)}
        </div>
        <p style={{ fontSize: 12.5, color: "#8B94A6", marginTop: 16 }}>
          Posted straight into the books — Cash in Hand {dir === "in" ? "increases (other income)" : "decreases (expense)"}.
          It shows on Drawer cash entries, Cash flow and the Z report.
        </p>
      </div>
      <div className="p-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" style={{ padding: "12px 30px", fontSize: 15 }} disabled={busy} onClick={save}>
          {busy ? "Saving…" : dir === "in" ? "Record cash in" : "Record cash out"}
        </button>
      </div>
    </div>
  );
}


/* ── End of day — Aronium flow: option squares → big totals → Continue; History tab ── */
function EndOfDayPanel({ onClose }) {
  const [tab, setTab] = useState("eod");
  const [scope, setScope] = useState(null); // 'cashout' | 'cashout_all' | 'close_register'
  const [prev, setPrev] = useState(null);
  const [hist, setHist] = useState(null);
  const [histOpen, setHistOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const inr = (n) => Number(n || 0).toLocaleString("en-UG");
  const SCOPES = { cashout: "Cash out (me)", cashout_all: "Cash out all users", close_register: "Close register" };

  useEffect(() => {
    if (!scope) return setPrev(null);
    setPrev(null);
    api.get(`/pos/day-close/preview?scope=${scope}`).then(setPrev).catch(() => setPrev(null));
  }, [scope]);
  useEffect(() => {
    if (tab === "history") api.get("/pos/day-close/history").then(setHist).catch(() => setHist([]));
  }, [tab]);

  const [closePop, setClosePop] = useState(false);
  const [prItems, setPrItems] = useState(true);
  const [prZ, setPrZ] = useState(true);
  const printSlip = (d, scopeLabel) => {
    if (d.report_no) return openSlip(zSlipHtml(d, "Z"));
    openSlip(zSlipHtml({ ...d, report_no: 1, from_doc: d.from_doc || "—", to_doc: d.to_doc || "—",
      by_user: (d.by_user || []).map((u) => ({ ...u, modes: u.modes || [] })),
      totals: { received: d.totals.gross - (d.totals.unpaid || 0), discounts: 0, taxable: d.totals.gross, tax: 0, ...d.totals } }, "Z"));
  };


  const commit = async (opts) => {
    // Closing with bills still on hold loses them — say so plainly, with the count.
    if (scope === "close_register" && !opts) {
      let heldCount = 0;
      try { heldCount = (await api.get("/pos/held")).length; } catch {}
      if (heldCount > 0) {
        const go = await confirmDialog({
          title: `${heldCount} bill${heldCount > 1 ? "s are" : " is"} still on hold`,
          message: "Closing the register now leaves those bills unfinished — nothing is rung up and no money is taken for them.",
          detail: "Resume and complete them at the till first, or close anyway if they were abandoned.",
          danger: true, confirmLabel: "Close anyway", cancelLabel: "Go back to the till",
        });
        if (!go) return;
      }
      return setClosePop(true);
    }
    setBusy(true); setClosePop(false);
    try {
      const r = await api.post("/pos/day-close", { scope });
      toast("Day close saved to history");
      if (!opts || opts.z) openSlip(zSlipHtml(r, "Z"));
      if (opts && opts.items) setTimeout(() => openSlip(itemsSlipHtml(r)), 500);
      setScope(null); setPrev(null);
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={onClose}>← Back</button>
        <h2>End of day</h2>
      </div>
      <div className="eod-tabs">
        <button className={`eod-tab ${tab === "eod" ? "on" : ""}`} onClick={() => setTab("eod")}>End of day</button>
        <button className={`eod-tab ${tab === "history" ? "on" : ""}`} onClick={() => setTab("history")}>History</button>
      </div>

      {closePop && (
        <div className="pos-drawer-veil" style={{ alignItems: "center", justifyContent: "center", display: "flex" }} onClick={() => setClosePop(false)}>
          <div style={{ background: "#2B313A", border: "1px solid #3A4150", padding: "26px 30px", width: 480, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 8px", fontFamily: "var(--disp)", fontSize: 18 }}>Print closing reports</h3>
            <p style={{ color: "#8B94A6", fontSize: 13, margin: "0 0 16px" }}>Please select reports to print. Make sure your printer is available and operational.</p>
            <label className="switch"><input type="checkbox" checked={prItems} onChange={(e) => setPrItems(e.target.checked)} /><span className="sw-track" /><span>Print items report</span></label>
            <label className="switch"><input type="checkbox" checked={prZ} onChange={(e) => setPrZ(e.target.checked)} /><span className="sw-track" /><span>Print Z report</span></label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 20 }}>
              <button className="btn" style={{ background: "#3D8B40", color: "#fff", padding: "11px 24px" }} disabled={busy}
                      onClick={() => commit({ items: prItems, z: prZ })}>✓ Continue</button>
              <button className="btn" style={{ background: "#C0392B", color: "#fff", padding: "11px 24px" }} onClick={() => setClosePop(false)}>✕ Cancel</button>
            </div>
          </div>
        </div>
      )}
      {tab === "eod" ? (
        <>
          <div className="p-body">
            <div style={{ color: "#8B94A6", fontSize: 13, marginBottom: 12 }}>Select cash out option</div>
            <div className="eod-opts">
              <button className={`eod-opt ${scope === "cashout" ? "on" : ""}`} onClick={() => setScope("cashout")}>
                <Ic d={IC.user} size={32} />Cash out
              </button>
              <button className={`eod-opt ${scope === "cashout_all" ? "on" : ""}`} onClick={() => setScope("cashout_all")}>
                <Ic d={IC.users} size={32} />Cash out all users
              </button>
              <button className={`eod-opt ${scope === "close_register" ? "on" : ""}`} onClick={() => setScope("close_register")}>
                <Ic d={IC.door} size={32} />Close register
              </button>
              <button className="eod-opt xr" onClick={() => { setScope("cashout_all"); }} title="Preview without closing">
                <Ic d={IC.x} size={32} />X REPORT
              </button>
            </div>

            {!scope ? (
              <div style={{ textAlign: "center", color: "#8B94A6", marginTop: 90 }}>
                <b style={{ display: "block", fontSize: 16, color: "#B7C0D1", marginBottom: 6 }}>Cash out option not selected</b>
                Choose one of the options above to continue.
              </div>
            ) : !prev ? <div style={{ marginTop: 40, color: "#8B94A6" }}>Loading…</div> : (
              <>
                <div className="eod-big">
                  <div className="l">{SCOPES[scope]} · {prev.date} · net takings</div>
                  <div className="v">{cur()} {inr(prev.totals.net)}</div>
                </div>
                <div className="eod-tenders">
                  {prev.rows.length === 0 ? <div style={{ color: "#8B94A6" }}>No sales yet for this day.</div> :
                    prev.rows.map((r, i) => (
                      <div className="tr" key={i}><span className="m">{r.mode}</span><span className="a">{cur()} {inr(r.total)}</span></div>
                    ))}
                  <div className="tr" style={{ borderBottom: "none", color: "#8B94A6", fontSize: 13 }}>
                    <span>Gross {inr(prev.totals.gross)} · Refunds {inr(prev.totals.refund_total)} · Voids {prev.totals.voids || 0} · Unpaid {inr(prev.totals.unpaid)}</span>
                  </div>
                </div>
                {scope !== "cashout" && prev.by_user.length > 0 && (
                  <table className="zt" style={{ maxWidth: 520, marginTop: 10 }}>
                    <thead><tr><th>Cashier</th><th style={{ textAlign: "right" }}>Bills</th><th style={{ textAlign: "right" }}>{cur()}</th></tr></thead>
                    <tbody>{prev.by_user.map((u, i) => (
                      <tr key={i}><td>{u.user}</td><td style={{ textAlign: "right" }} className="num">{u.bills}</td><td style={{ textAlign: "right" }} className="num">{inr(u.total)}</td></tr>
                    ))}</tbody>
                  </table>
                )}
              </>
            )}
          </div>
          <div className="p-foot">
            <button className="btn" style={{ background: "#8E2F2F", color: "#FFD9D9" }} onClick={onClose}>✕ Cancel</button>
            <button className="btn" style={{ background: "#3D8B40", color: "#fff", padding: "11px 28px" }}
                    disabled={!scope || !prev || busy} onClick={() => commit()}>
              {busy ? "Saving…" : "✓ Continue — save & print"}
            </button>
          </div>
        </>
      ) : (
        <div className="p-body" style={{ padding: 0 }}>
          {hist === null ? <div style={{ padding: 24, color: "#8B94A6" }}>Loading…</div> :
            hist.length === 0 ? <div style={{ padding: 24, color: "#8B94A6" }}>No day closes yet — run your first End of day.</div> :
            hist.map((h) => (
              <div key={h.id}>
                <button className="eod-hist-row" onClick={() => setHistOpen(histOpen === h.id ? null : h.id)}>
                  <span className="num" style={{ minWidth: 92 }}>{h.close_date}</span>
                  <span style={{ minWidth: 150, color: "#B7C0D1" }}>{SCOPES[h.scope] || h.scope}</span>
                  <span style={{ minWidth: 120, color: "#8B94A6" }}>{h.by_user}</span>
                  <span className="num" style={{ marginLeft: "auto", color: "#8FD06A", fontWeight: 700 }}>{cur()} {inr(h.net)}</span>
                  <span style={{ color: "#8B94A6" }}>{histOpen === h.id ? "▲" : "▼"}</span>
                </button>
                {histOpen === h.id && (
                  <div style={{ padding: "10px 20px 18px", background: "#262B33" }}>
                    <div className="eod-tenders">
                      {h.data.rows.map((r, i) => (
                        <div className="tr" key={i}><span className="m">{r.mode}</span><span className="a">{cur()} {inr(r.total)}</span></div>
                      ))}
                    </div>
                    <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => printSlip(h.data, SCOPES[h.scope] || h.scope)}><Icon n="print" size={15} /> Reprint slip</button>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}


/* ── Find receipt: scan the barcode on a printed slip (or type the number) ── */
function FindReceiptPanel({ onClose }) {
  const [q, setQ] = useState("");
  const [inv, setInv] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inr = (n) => Number(n || 0).toLocaleString("en-UG");
  const norm = (s) => {
    s = String(s).trim().toUpperCase();
    if (/^\d+$/.test(s)) s = "INV-" + s.padStart(6, "0"); // bare digits from a scanner
    return s;
  };
  const find = async (val) => {
    const no = norm(val ?? q);
    if (!no) return;
    setBusy(true); setErr(""); setInv(null);
    try {
      const r = await api.get(`/sales/by-number/${encodeURIComponent(no)}`);
      setInv(r);
    } catch (e) { setErr(e.message || "Not found"); }
    setBusy(false);
  };
  const reprint = () => { if (inv) printInvoice(inv, inv.party_name || "Customer", "pos"); };
  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={onClose}>← Back</button>
        <h2>Find receipt</h2>
      </div>
      <div className="p-body" style={{ maxWidth: 620, width: "100%", margin: "0 auto" }}>
        <p style={{ color: "#8B94A6", fontSize: 13.5, marginTop: 0 }}>
          Scan the barcode at the bottom of a printed receipt, or type the receipt number and press Enter.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && find()}
                 placeholder="Scan barcode or type INV-000002…" style={{ flex: 1, fontSize: 16 }} />
          <button className="btn btn-primary" disabled={busy} onClick={() => find()}>{busy ? "…" : "Find"}</button>
        </div>
        {err && <div className="cred-note" style={{ marginTop: 14 }}>{err}</div>}
        {inv && (
          <div style={{ background: "#2B313A", border: "1px solid #3A4150", borderRadius: 6, padding: 18, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h3 style={{ margin: 0, fontFamily: "var(--disp)" }}>{inv.invoice_no}</h3>
              <span style={{ color: "#8B94A6", fontSize: 13 }}>{inv.invoice_date}</span>
            </div>
            <div style={{ color: "#B7C0D1", fontSize: 13.5, margin: "6px 0 12px" }}>
              {inv.party_name} · {inv.payment_type === "credit" ? "Credit" : "Cash"} · Total <b style={{ color: "#E8EAEE" }}>{cur()} {inr(inv.grand_total)}</b>
              {inv.balance_due > 0 ? <span style={{ color: "#E3B15C" }}> · Due {cur()} {inr(inv.balance_due)}</span> : null}
            </div>
            <table className="zt" style={{ marginBottom: 12 }}>
              <thead><tr><th>Item</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>{(inv.lines || []).map((l, i) => (
                <tr key={i}><td>{l.description}</td><td style={{ textAlign: "right" }} className="num">{l.quantity}</td><td style={{ textAlign: "right" }} className="num">{cur()} {inr(l.line_total)}</td></tr>
              ))}</tbody>
            </table>
            <button className="btn btn-primary" onClick={reprint}><Icon n="print" size={15} /> Reprint receipt</button>
          </div>
        )}
      </div>
      <div className="p-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
    </div>
  );
}


/* ── Previous sales: recent bills, tap to view & reprint ── */
function PrevSalesPanel({ onClose }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null); // full invoice
  const inr = (n) => Number(n || 0).toLocaleString("en-UG");
  useEffect(() => { api.get("/sales").then((r) => setRows(r.slice(0, 60))).catch(() => setRows([])); }, []);
  const view = async (id) => {
    try { setOpen(await api.get(`/sales/${id}`)); } catch (e) { toast(e.message, "bad"); }
  };
  return (
    <div className="dr-panel">
      <div className="p-head">
        <button className="pos-back" onClick={() => open ? setOpen(null) : onClose()}>← Back</button>
        <h2>{open ? open.invoice_no : "Previous sales"}</h2>
      </div>
      <div className="p-body" style={{ maxWidth: 760, width: "100%", margin: "0 auto" }}>
        {!open ? (
          rows === null ? <div style={{ color: "var(--dmut)" }}>Loading…</div> :
          rows.length === 0 ? <div style={{ color: "var(--dmut)" }}>No sales yet.</div> :
          rows.map((s) => (
            <button key={s.id} className="eod-hist-row" onClick={() => view(s.id)}>
              <span className="num" style={{ minWidth: 110, fontWeight: 700 }}>{s.invoice_no}</span>
              <span style={{ minWidth: 90, color: "var(--dmut)" }} className="num">{s.invoice_date}</span>
              <span style={{ flex: 1, textAlign: "left", color: "var(--dtext)" }}>{s.party_name || "Cash Sale"}</span>
              {s.balance_due > 0 && <span style={{ color: "#E3B15C", fontSize: 12.5 }}>due {inr(s.balance_due)}</span>}
              <span className="num" style={{ color: "var(--gn)", fontWeight: 800 }}>{cur()} {inr(s.grand_total)}</span>
            </button>
          ))
        ) : (
          <div style={{ background: "var(--dsurf)", border: "1px solid var(--dline)", borderRadius: 12, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--dmut)", fontSize: 13, marginBottom: 10 }}>
              <span>{open.party_name || "Cash Sale"} · {open.invoice_date}</span>
              <span>{open.payment_type === "credit" ? "Credit" : "Cash"}</span>
            </div>
            <table className="zt">
              <thead><tr><th>Item</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>{(open.lines || []).map((l, i) => (
                <tr key={i}><td>{l.description}</td><td style={{ textAlign: "right" }} className="num">{l.quantity}</td>
                  <td style={{ textAlign: "right" }} className="num">{inr(l.rate)}</td>
                  <td style={{ textAlign: "right" }} className="num">{inr(l.line_total)}</td></tr>
              ))}</tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, padding: "10px 4px 0" }}>
              <span>Total</span><span className="num">{cur()} {inr(open.grand_total)}</span>
            </div>
            <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => printInvoice(open, open.party_name || "Customer", "pos")}><Icon n="print" size={15} /> Reprint</button>
              <button className="btn btn-ghost" onClick={() => setOpen(null)}>Back to list</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
