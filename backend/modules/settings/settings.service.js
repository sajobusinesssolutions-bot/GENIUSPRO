/**
 * settings.service.js — per-firm key/value settings with a typed catalog.
 * The catalog is arranged as General / Transaction / Item / Party tabs.
 */
const { query } = require("../../database/db");

// group: general | transaction | item | party ; type: bool | text | select
const CATALOG = [
  // General
  { key: "taxes_enabled", label: "Apply invoice taxes (WHT / VAT chain)", group: "taxes", type: "bool", default: "1" },
  { key: "tax_on_pos", label: "Apply taxes on POS sales", group: "sales", type: "bool", default: "1" },
  { key: "tax_on_cash", label: "Apply taxes on cash sales", group: "sales", type: "bool", default: "1" },
  { key: "tax_on_credit", label: "Apply taxes on credit sales", group: "sales", type: "bool", default: "1" },
  { key: "currency_symbol", label: "Currency symbol", group: "business", type: "text", default: "Sh" },
  { key: "amount_decimals", label: "Amount decimal places", group: "business", type: "select", options: ["0","1","2","3"], default: "2" },
  { key: "date_format", label: "Date format", group: "business", type: "select", options: ["YYYY-MM-DD","DD/MM/YYYY","MM/DD/YYYY"], default: "DD/MM/YYYY" },
  { key: "enable_estimates", label: "Enable estimates / quotations", group: "general", type: "bool", default: "1", unbuilt: true },
  { key: "enable_multi_firm", label: "Enable multiple businesses", group: "general", type: "bool", default: "1", unbuilt: true },

  // Transaction
  { key: "invoice_prefix", label: "Invoice prefix", group: "sales", type: "text", default: "INV" },
  { key: "prevent_negative_stock", label: "Block selling below available stock", group: "sales", type: "bool", default: "1" },
  { key: "prevent_below_cost", label: "Block selling below cost price", group: "sales", type: "bool", default: "1" },
  { key: "force_customer_on_credit", label: "Credit sales require a saved customer", group: "sales", type: "bool", default: "1" },
  { key: "require_void_reason", label: "Require a reason when voiding", group: "sales", type: "bool", default: "1" },
  { key: "require_sales_rep", label: "Sales rep is required on every sale", group: "sales", type: "bool", default: "1" },
  { key: "block_sales_without_shift", label: "Block sales unless a shift is open", group: "sales", type: "bool", default: "0" },
  { key: "store_enabled", label: "Online store page (share the link with customers)", group: "modules", type: "bool", default: "0" },
  { key: "store_whatsapp", label: "WhatsApp number for orders (07xx…)", group: "modules", type: "text", default: "" },
  { key: "store_note", label: "Store welcome note", group: "modules", type: "text", default: "Order below — we confirm on WhatsApp." },
  { key: "printer_type", label: "Printer type", group: "print", type: "select", options: ["regular", "thermal-2in", "thermal-3in"], default: "regular" },
  { key: "print_show_tin", label: "Print firm TIN", group: "print", type: "bool", default: "1" },
  { key: "print_levy_pct", label: "Catering levy % on receipts (0 = off, Semantic theme)", group: "print", type: "text", default: "0" },
  { key: "print_show_phone", label: "Print firm phone", group: "print", type: "bool", default: "1" },
  { key: "print_show_taxes", label: "Print tax breakdown", group: "print", type: "bool", default: "1" },
  { key: "print_show_received", label: "Print received & balance", group: "print", type: "bool", default: "1" },
  { key: "print_footer_note", label: "Receipt footer note", group: "print", type: "text", default: "Thank you for doing business with us!" },
  { key: "print_terms", label: "Terms & conditions", group: "print", type: "text", default: "" },
  { key: "print_theme_regular", label: "A4 theme", group: "print", type: "text", default: "tally" },
  { key: "print_theme_thermal", label: "Thermal theme", group: "print", type: "text", default: "compact" },
  { key: "print_paper", label: "Thermal paper", group: "print", type: "select", options: ["2in", "3in", "4in"], default: "3in" },
  /* What happens the moment a transaction is saved.
     "ask" opens a yes/no dialog naming the document; "always" prints without
     asking; "never" is silent. Default "ask", because a shop that does not
     want paper should have to say so once rather than close a dialog all day,
     and a shop that does want paper should never lose a receipt to a missed
     click. The dialog itself writes this key when the shopkeeper ticks
     "don't ask again", so the setting is reachable without opening Settings. */
  { key: "print_after_save", label: "After saving a transaction", group: "print", type: "select", options: ["ask", "always", "never"], default: "ask" },
  { key: "print_default_pos", label: "POS sale — print as", group: "print", type: "select", options: ["thermal", "regular"], default: "thermal" },
  { key: "print_default_invoice", label: "Sales invoice — print as", group: "print", type: "select", options: ["regular", "thermal"], default: "regular" },
  { key: "print_default_purchase", label: "Purchase bill — print as", group: "print", type: "select", options: ["regular", "thermal"], default: "regular" },
  { key: "print_show_logo", label: "Print company logo", group: "print", type: "bool", default: "0" },
  /* Custom Invoice Builder — the whole layout as JSON. Empty means "use a
     built-in theme"; the builder writes this and print_theme_regular=custom. */
  /* Written by the Custom Invoice Builder, never typed. `hidden` keeps it out
     of the field pages and the search — a JSON blob in a text box is a
     template one stray keystroke from being unparseable — while leaving it a
     perfectly ordinary setting to everything that reads it. Distinct from
     `unbuilt`, which means nothing reads it at all. */
  { key: "print_custom_template", label: "Custom invoice template (JSON)", group: "print", type: "text", default: "", hidden: true },
  { key: "print_show_email", label: "Print firm email", group: "print", type: "bool", default: "0" },
  { key: "print_show_address", label: "Print firm address", group: "print", type: "bool", default: "1" },
  { key: "print_repeat_header", label: "Repeat header on every page (A4)", group: "print", type: "bool", default: "1" },
  { key: "print_show_barcode", label: "Print receipt barcode", group: "print", type: "bool", default: "1" },
  { key: "print_copies", label: "Number of copies", group: "print", type: "text", default: "1" },
  { key: "print_open_drawer", label: "Open cash drawer after printing", group: "print", type: "bool", default: "0" },
  /* Default printer, by document format. Only the desktop shell can honour
     these — a browser will not let a page choose the printer, so there it just
     records the preference. Empty means "ask me" (the normal print dialog). */
  { key: "print_printer_regular", label: "Default printer — A4 documents", group: "print", type: "text", default: "" },
  { key: "print_printer_thermal", label: "Default printer — thermal receipts", group: "print", type: "text", default: "" },
  { key: "print_silent", label: "Print without showing the dialog (desktop app only)", group: "print", type: "bool", default: "0" },
  { key: "setup_done", label: "First-run setup completed", group: "internal", type: "bool", default: "0" },

  /* Sign-in. The staff picker puts names on the sign-in screen before anyone
     has signed in — convenient at a counter, but it does tell whoever is
     standing there who works here. Off unless a shop asks for it. */
  { key: "login_show_staff", label: "Show staff names on the sign-in screen",
    note: "Quicker at a busy counter, but anyone can see who works here",
    group: "users", type: "bool", default: "1" },
  { key: "vat_rule_name", label: "Which of your taxes is VAT",
    note: "The name of the tax rule under Settings → Taxes that is VAT. Other taxes are left out of the VAT return",
    group: "taxes", type: "text", default: "VAT" },
  { key: "vat_due_day", label: "VAT return due on day",
    note: "Of the month after the period. Check the current URA deadline — this is only a reminder",
    group: "taxes", type: "number", default: "15" },
  { key: "efris_enabled", label: "Track EFRIS fiscalisation",
    note: "Record the fiscal number against each invoice so gaps show up before URA asks",
    group: "taxes", type: "bool", default: "0" },
  { key: "wht_rate", label: "Withholding tax rate",
    note: "Percent withheld on payments to designated suppliers",
    group: "taxes", type: "number", default: "6" },

  { key: "commission_default_pct", label: "Default commission rate",
    note: "Percent of net sales, used for anyone without a rate of their own",
    group: "users", type: "number", default: "0" },
  { key: "roster_grace_mins", label: "Minutes late before it counts as late",
    note: "A few minutes either side of a shift start is normal",
    group: "users", type: "number", default: "10" },

  { key: "login_pin_enabled", label: "Allow signing in with a 4-digit PIN",
    note: "Set each person's PIN under Users & roles",
    group: "users", type: "bool", default: "0" },
  { key: "reorder_lookback_days", label: "Measure sales over the last (days)", group: "item", type: "select", options: ["14", "30", "60", "90"], default: "30" },
  { key: "reorder_cover_days", label: "Keep this many days of stock", group: "item", type: "select", options: ["7", "14", "30", "45", "60"], default: "30" },
  { key: "expiry_alert_days", label: "Warn about stock expiring within (days)", group: "item", type: "select", options: ["7", "14", "30", "60", "90"], default: "30" },
  /* Zoho-style item preferences (Items → ⋯ → Preferences) */
  { key: "qty_decimals", label: "Decimal places for item quantity", group: "item", type: "select", options: ["0", "1", "2", "3", "4"], default: "2" },
  { key: "inventory_valuation", label: "Default inventory valuation method", group: "item", type: "select", options: ["FIFO (First In, First Out)", "Weighted Average"], default: "FIFO (First In, First Out)" },
  { key: "allow_duplicate_item_names", label: "Allow duplicate item names", group: "item", type: "bool", default: "0" },
  { key: "enhanced_item_search", label: "Enhanced item search (match keywords in any order)", group: "item", type: "bool", default: "0" },
  { key: "price_lists_enabled", label: "Enable price lists", group: "item", type: "bool", default: "1" },
  { key: "inventory_tracking_default", label: "Track inventory on new products by default", group: "item", type: "bool", default: "1" },

  /* ── Modules (Account Information + feature switches) ──
     Toggling a module off hides its screens; the data it owns is left alone so
     switching back on loses nothing. */
  { key: "biz_you_sell", label: "You sell", group: "modules", type: "select", options: ["Products Only", "Services Only", "Services & Products"], default: "Services & Products", unbuilt: true },
  { key: "biz_invoicing_method", label: "Invoicing method", group: "modules", type: "select", options: ["Invoices Only", "Point of Sale Only", "Both"], default: "Both", unbuilt: true },
  { key: "biz_client_type", label: "Client type", group: "modules", type: "select", options: ["Individual Only", "Business Only", "Both"], default: "Both", unbuilt: true },
  /* Sales management */
  { key: "mod_sales", label: "Sales", group: "modules", type: "bool", default: "1" },
  { key: "mod_pos", label: "Point of Sale", group: "modules", type: "bool", default: "1" },
  { key: "mod_targets", label: "Sales targets & commissions", group: "modules", type: "bool", default: "1", unbuilt: true },

  { key: "mod_installments", label: "Installments management", group: "modules", type: "bool", default: "0" },
  { key: "mod_tax_ura", label: "Tax & URA", note: "VAT working, EFRIS register and filing history", group: "modules", type: "bool", default: "1" },
  { key: "mod_offers", label: "Offers & promotions", group: "modules", type: "bool", default: "0" },
  { key: "mod_insurance", label: "Warranty cover & claims", group: "modules", type: "bool", default: "0" },
  { key: "mod_loyalty", label: "Client loyalty points", group: "modules", type: "bool", default: "0" },
  { key: "mod_recurring_sales", label: "Recurring sales", group: "modules", type: "bool", default: "0" },
  /* Inventory & purchases */
  { key: "mod_inventory", label: "Inventory management", group: "modules", type: "bool", default: "1" },
  { key: "mod_manufacturing", label: "Manufacturing", group: "modules", type: "bool", default: "0" },
  { key: "mod_purchases", label: "Purchase cycle", group: "modules", type: "bool", default: "1" },
  { key: "mod_recurring_purchases", label: "Recurring purchases", group: "modules", type: "bool", default: "0" },

  /* Loyalty scheme — only used when the Loyalty module is switched on. */
  { key: "loyalty_earn_per", label: "Customer earns 1 point per this many shillings spent", group: "loyalty", type: "number", default: "1000" },
  { key: "loyalty_point_value", label: "Each point is worth this many shillings when redeemed", group: "loyalty", type: "number", default: "10" },
  { key: "loyalty_min_redeem", label: "Fewest points that can be redeemed at once", group: "loyalty", type: "number", default: "100" },
  { key: "loyalty_expiry_months", label: "Points expire after this many months (0 = never)", group: "loyalty", type: "number", default: "12" },
  { key: "loyalty_earn_on_credit", label: "Award points on credit sales too, not just paid ones", group: "loyalty", type: "bool", default: "1" },
  /* Accounting & operations */
  { key: "mod_accounting", label: "Accounting & books", group: "modules", type: "bool", default: "1" },
  { key: "mod_expenses", label: "Expenses & other income", group: "modules", type: "bool", default: "1" },
  { key: "mod_reminders", label: "Payment reminders", note: "Chase unpaid balances over WhatsApp or SMS", group: "modules", type: "bool", default: "1" },
  { key: "mod_shifts", label: "Shifts & cash drawer", group: "modules", type: "bool", default: "1" },
  { key: "mod_stocktake", label: "Stock takes", group: "modules", type: "bool", default: "1" },
  { key: "cash_round_to", label: "Round cash totals to nearest", group: "sales", type: "select", options: ["1", "50", "100"], default: "1" },
  { key: "print_preview", label: "Show print preview", group: "print", type: "select", options: ["documents", "always", "never"], default: "documents" },
  { key: "print_show_sno", label: "Print serial numbers (S.No)", group: "print", type: "bool", default: "1" },
  { key: "print_show_uom", label: "Print unit of measure", group: "print", type: "bool", default: "1" },
  { key: "print_show_desc", label: "Print item descriptions", group: "print", type: "bool", default: "0" },
  { key: "print_show_batch", label: "Print batch numbers", group: "print", type: "bool", default: "0" },
  { key: "print_show_expiry", label: "Print expiry dates", group: "print", type: "bool", default: "0" },
  /* ── Payment reminders ─────────────────────────────────────────────────
   * The message goes out from the shopkeeper's own phone, over WhatsApp or
   * SMS, because that is where their customers already answer them. The app
   * writes it and opens it; a person presses send. Nothing is sent silently
   * on a shop's behalf — a debt chased by a robot is a customer lost. */
  { key: "remind_channel", label: "Send reminders by", group: "reminders", type: "select",
    options: ["whatsapp", "sms"], default: "whatsapp" },
  { key: "remind_grace_days", label: "Wait this many days past due before chasing",
    group: "reminders", type: "number", default: "0" },
  { key: "remind_min_balance", label: "Do not chase balances under",
    group: "reminders", type: "number", default: "0" },
  { key: "remind_cooldown_days", label: "Leave this many days between reminders to one customer",
    group: "reminders", type: "number", default: "7" },
  { key: "remind_signature", label: "Signed off with", group: "reminders", type: "text", default: "" },
  { key: "remind_tpl_gentle", label: "Message — not yet overdue", group: "reminders", type: "text",
    default: "Hello {name}, this is {business}. Our records show a balance of {balance} on your account. Whenever you are ready, we would be grateful for settlement. Thank you for your business." },
  { key: "remind_tpl_due", label: "Message — overdue", group: "reminders", type: "text",
    default: "Hello {name}, a reminder from {business}: {balance} is now due on your account ({bills} open). Kindly settle at your convenience. Call {phone} if anything looks wrong." },
  { key: "remind_tpl_late", label: "Message — thirty days or more", group: "reminders", type: "text",
    default: "Hello {name}. {business} here. Your balance of {balance} is now {days} days past due. Please arrange payment or call {phone} so we can agree a plan. Thank you." },
  { key: "remind_country_code", label: "Country code for phone numbers starting 0",
    group: "reminders", type: "text", default: "256" },

  { key: "firm_email", label: "Business email", group: "business", type: "text", default: "" },
  { key: "firm_address", label: "Business address", group: "business", type: "text", default: "" },
  { key: "firm_business_type", label: "Business type", group: "general", type: "select", options: ["Retail","Wholesale","Distributor","Manufacturer","Services","Restaurant","Pharmacy","Hardware","Other"], default: "Retail", unbuilt: true },
  { key: "firm_category", label: "Business category", group: "general", type: "text", default: "", unbuilt: true },
  { key: "firm_pincode", label: "Pincode / postal code", group: "general", type: "text", default: "", unbuilt: true },
  { key: "firm_signature", label: "Signature label (printed on invoices)", group: "general", type: "text", default: "", unbuilt: true },
  { key: "invoice_numbering", label: "Invoice numbering", group: "transaction", type: "select", options: ["auto","manual"], default: "auto", unbuilt: true },
  { key: "round_off", label: "Round off invoice total", group: "sales", type: "bool", default: "1" },
  /* Books closed up to and including this date.
   *
   * Nothing stopped a sale, a bill or a journal being dated into a month
   * already filed with URA. That is not a hypothetical: correcting last
   * week's mistake with today's date is right, and correcting it with LAST
   * MONTH's date quietly changes a return that has already been submitted —
   * and nobody finds out until the next audit.
   *
   * Empty means no lock, which is what every existing shop gets: a setting
   * that starts switched on would refuse the first thing anybody tried to
   * post after the upgrade. */
  { key: "books_locked_upto", label: "Books closed up to (nothing may be dated on or before this)",
    group: "transaction", type: "date", default: "" },
  { key: "round_off_mode", label: "Round off method", group: "transaction", type: "select", options: ["nearest","up","down"], default: "nearest", unbuilt: true },
  /* "Include" only means anything for a tax added on top. A deduct rule —
     Uganda's withholding tax, and VAT as the default chain applies it — is
     taken out of the price the customer pays, so an entered price already is
     the gross and there is nothing to include. The label says which. */
  { key: "tax_inclusive_default", label: "Prices already include add-on tax (VAT)", group: "transaction", type: "bool", default: "0" },
  { key: "enable_due_date", label: "Enable due date & payment terms", group: "transaction", type: "bool", default: "1", unbuilt: true },
  { key: "show_received_amount", label: "Show received / balance on invoice", group: "transaction", type: "bool", default: "1" },
  { key: "transaction_discount", label: "Allow transaction-level discount", group: "transaction", type: "bool", default: "1", unbuilt: true },

  /* ── Off-site copy (Settings → Backup) ──
     Every automatic backup this app takes sits on the same disk as the live
     database, so one dead drive takes the books and all seven copies. These
     four keys are the second destination — a USB stick or a folder on another
     machine on the shop LAN — that the app copies to by itself. The Backup
     screen renders them by hand rather than through FieldPage, because a path
     that has never worked needs to be tested and said out loud, not saved
     quietly with the rest of a page. */
  { key: "offsite_enabled", label: "Keep a copy on a USB drive or another computer",
    note: "The app copies there by itself whenever the drive is connected",
    group: "backup", type: "bool", default: "0" },
  { key: "offsite_path", label: "Folder to copy to",
    note: "A USB drive (E:\\genius-backups) or a shared folder on another computer (\\\\officepc\\backups)",
    group: "backup", type: "text", default: "" },
  { key: "offsite_keep", label: "Copies kept on that drive",
    note: "The oldest is deleted to make room — a small USB stick fills up otherwise",
    group: "backup", type: "number", default: "5" },
  { key: "offsite_warn_days", label: "Warn if nothing has been copied for (days)",
    note: "How long the drive can stay unplugged before the Backup screen says so",
    group: "backup", type: "number", default: "7" },

  // Item
  { key: "enable_items", label: "Enable items", group: "item", type: "bool", default: "1", unbuilt: true },
  { key: "stock_maintenance", label: "Maintain stock", group: "item", type: "bool", default: "1" },
  { key: "item_wise_discount", label: "Item-wise discount", group: "item", type: "bool", default: "1", unbuilt: true },
  { key: "barcode_scan", label: "Barcode scanning", group: "item", type: "bool", default: "0", unbuilt: true },
  /* Default "1", not "0": the batch columns have been on every purchase
     bill since the feature shipped, and a switch that took them away from
     every shop on upgrade would be a worse fault than the one it fixes. */
  { key: "enable_batches", label: "Batch / expiry tracking", group: "item", type: "bool", default: "1" },
  { key: "enable_wholesale", label: "Wholesale price", group: "item", type: "bool", default: "0", unbuilt: true },
  { key: "low_stock_alert", label: "Low stock alerts", group: "item", type: "bool", default: "1" },
  { key: "default_unit", label: "Default unit", group: "item", type: "text", default: "PCS" },

  // Party
  { key: "enable_party_groups", label: "Enable party grouping", group: "party", type: "bool", default: "1", unbuilt: true },
  { key: "enable_credit_limit", label: "Enable credit limit", group: "party", type: "bool", default: "0" },
  { key: "enable_shipping_address", label: "Party shipping address", group: "party", type: "bool", default: "0" },
  { key: "enable_payment_reminder", label: "Payment reminders", group: "party", type: "bool", default: "0", unbuilt: true },
];

const DEFAULTS = Object.fromEntries(CATALOG.map((c) => [c.key, c.default]));

async function getSetting(firmId, key, fallback) {
  const row = (await query("SELECT svalue FROM firm_settings WHERE firm_id = ? AND skey = ?", [firmId, key])).rows[0];
  if (row && row.svalue != null) return row.svalue;
  return DEFAULTS[key] != null ? DEFAULTS[key] : fallback;
}

async function getAllSettings(firmId) {
  const out = { ...DEFAULTS };
  for (const r of (await query("SELECT skey, svalue FROM firm_settings WHERE firm_id = ?", [firmId])).rows) out[r.skey] = r.svalue;
  return out;
}

async function setSetting(firmId, key, value) {
  await query(
    "INSERT INTO firm_settings (firm_id, skey, svalue) VALUES (?,?,?) " +
    "ON CONFLICT(firm_id, skey) DO UPDATE SET svalue = excluded.svalue",
    [firmId, key, String(value)]
  );
}

module.exports = { CATALOG, DEFAULTS, getSetting, getAllSettings, setSetting };
