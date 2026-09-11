// print.js — settings-aware invoice printing: regular A4 or thermal receipt
// (2"/3"), honoring the Settings → Print show/hide toggles.
import api, { currentFirm } from "./api.js";
import { inr, cur} from "./tax.js";
import { code128Svg } from "./barcode.js";
import { showPrintPreview } from "./ui.jsx";
import { parseTemplate, resolve, valuesFor, ITEM_COLUMNS } from "./template.js";

let cached = null;
async function printSettings() {
  if (cached) return cached;
  try {
    const s = await api.get("/settings");
    cached = s.values || {};
  } catch { cached = {}; }
  return cached;
}
export function invalidatePrintSettings() { cached = null; }

/* One setting, read through the same cache the templates use.
 *
 * The print prompt needs `print_after_save` before every save, and it must not
 * cost a round trip each time — a till rings a sale every few seconds. Reading
 * it through this cache also means the prompt and the templates can never
 * disagree about what the settings are, and `invalidatePrintSettings()` (which
 * Settings already calls on save) refreshes both at once. */
export async function printSetting(key, dflt = "") {
  const st = await printSettings();
  return st[key] ?? dflt;
}

/* Write a print setting back without making the caller know about the cache.
 * Used by the prompt's "don't ask again", which is the one place a setting is
 * changed from outside Settings. */
export async function savePrintSetting(key, value) {
  await api.put("/settings", { [key]: value });
  if (cached) cached[key] = value;
}

/* One label for a tax line, used by all three receipt templates.
 *
 * A deduct-mode tax was printed as "Less: VAT 18 (18%)", which is the rule's own
 * name with a subtraction verb in front of it — so the customer's copy called a
 * withholding deduction "VAT". The same figure was already reading three
 * different ways: "Withholding tax" on the till (Pos.jsx:719), "Less: VAT 18" on
 * the receipt, and "Tax Recoverable (WHT credit)" in the ledger. B5 fixed the
 * till and missed the printed copy, which is the one the customer keeps.
 *
 * The rule's name is user-configured, so it stays; only the verb changes, to
 * name what the deduction actually is. */
function taxLabel(t) {
  const name = esc(t.name);
  const rate = `${t.rate}%`;
  return t.mode === "deduct"
    ? `Withholding: ${name} (${rate})`
    : `Add: ${name} (${rate})`;
}

/**
 * Print a line-and-total document.
 *
 * `opts.docTitle` exists because this app could only ever print one kind of
 * paper. Purchases, credit notes, delivery challans and estimates all have the
 * same shape as an invoice — a party, a date, priced lines, a total — and all
 * four had no printable form at all; the only "Print" they offered was
 * `window.print()` on the whole screen, which round four proved renders the
 * navigation rail rather than the document. Rather than write four more
 * near-identical templates, the one that exists takes the document's name.
 *
 * The name is not cosmetic. A credit note printed under the heading "INVOICE"
 * is a document that says a customer owes money when they are owed it, and it
 * is the kind of mistake that is only found in an audit.
 */
export async function printInvoice(inv, partyName, context, opts = {}) {
  const st = await printSettings();
  const firm = currentFirm() || { name: "My Business" };
  const taxes = inv.taxes || (inv.tax_breakdown ? JSON.parse(inv.tax_breakdown) : []);
  // per-document default printer: pos → thermal by default, invoice/purchase → regular
  const ctxKey = context === "pos" ? "print_default_pos"
    : context === "purchase" ? "print_default_purchase"
    : context === "invoice" ? "print_default_invoice" : null;
  const ctxChoice = ctxKey ? st[ctxKey] : null;
  const paper = st.print_paper || (st.printer_type === "thermal-2in" ? "2in" : "3in");
  // resolve format: explicit context choice wins, else fall back to global printer_type
  let format;
  if (ctxChoice === "thermal") format = "thermal";
  else if (ctxChoice === "regular") format = "regular";
  else format = (st.printer_type || "regular").startsWith("thermal") ? "thermal" : "regular";
  const width = paper === "2in" ? "56mm" : paper === "4in" ? "108mm" : "76mm";
  const docTitle = opts.docTitle || null;
  const one = format === "thermal"
    ? thermalHtml({ inv, partyName, firm, taxes, st, width, docTitle })
    : regularHtml({ inv, partyName, firm, taxes, st, docTitle });
  const copies = Math.max(1, Number(st.print_copies) || 1);
  const html = copies > 1 && format === "thermal"
    ? one.replace("</body>", Array(copies - 1).fill(`<div style="page-break-before:always"></div>`).join("") + "</body>")
    : one;
  // Preview by default for A4 documents; the till prints straight through for speed.
  const mode = st.print_preview || "documents";
  const wantPreview = mode === "always" || (mode === "documents" && context !== "pos");
  if (wantPreview) {
    showPrintPreview(html, {
      title: `${opts.docTitle ? cap1(opts.docTitle) : (format === "thermal" ? "Receipt" : "Invoice")} preview`,
      subtitle: `${inv.invoice_no || ""} · ${format === "thermal" ? paper + " thermal" : "A4"}`,
    });
    return;
  }
  await sendToPrinter(html, {
    format, st,
    fallbackTitle: opts.docTitle ? cap1(opts.docTitle) : (format === "thermal" ? "Receipt" : "Invoice"),
  });
}

/**
 * Send a rendered document to a printer.
 *
 * In the desktop shell we can target the printer chosen in Settings and, if the
 * shop wants, skip the dialog entirely — which is what a till needs. In a
 * browser none of that is possible: window.print() hands over to the browser's
 * own dialog and no script may pick the printer for you. So there we open the
 * document and let the dialog do its job, exactly as before.
 */
export async function sendToPrinter(html, { format, st, fallbackTitle = "Print" }) {
  const bridge = typeof window !== "undefined" ? window.geniusPrint : null;
  const deviceName = (format === "thermal" ? st.print_printer_thermal : st.print_printer_regular) || "";

  if (bridge && bridge.available) {
    const res = await bridge.print(html, {
      deviceName: deviceName || undefined,
      silent: st.print_silent === "1" && !!deviceName,
      copies: format === "thermal" ? 1 : Math.max(1, Number(st.print_copies) || 1),
      thermal: format === "thermal",
    });
    if (res && res.ok) return;
    // A named printer that's off or unplugged shouldn't lose the receipt — and
    // "ask me each time" leaves no printer to name at all. Either way the
    // preview can still print it, so say plainly which of the two happened.
    showPrintPreview(html, {
      title: fallbackTitle,
      subtitle:
        (res && res.message) ? res.message
        : deviceName          ? `Couldn't reach "${deviceName}"${res && res.error ? ` — ${res.error}` : ""}`
        :                       "Printing failed",
    });
    return;
  }

  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {                                  // popup blocked — never fail silently
    showPrintPreview(html, { title: fallbackTitle, subtitle: "Your browser blocked the print window" });
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}

const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));


/**
 * customHtml — renders an invoice from a Custom Invoice Builder template.
 * Shared with the builder's live preview so what you design is what prints.
 */
export function customHtml({ inv, partyName, firm, taxes, st, tpl }) {
  const t = tpl || parseTemplate(st.print_custom_template);
  const party = inv.party || { name: partyName, organization: inv.party_organization,
    phone: inv.party_phone, email: inv.party_email, address: inv.party_address,
    tin: inv.party_tin, balance: inv.party_balance };
  const totals = {
    sub_total: inv.sub_total, discount_total: inv.discount_total, tax_total: inv.tax_total,
    grand_total: inv.grand_total, paid_amount: inv.paid_amount, balance_due: inv.balance_due,
  };
  const v = valuesFor({ inv, firm: firm || {}, party, totals });
  const L = t.labels || {};
  const stl = t.style || {};
  const accent = stl.accent || "#2F6FE0";
  const nl2br = (x) => esc(x).replace(/\n/g, "<br>");
  const block = (text) => nl2br(resolve(text, v));

  const cols = ITEM_COLUMNS.filter((c) => (t.columns || []).includes(c.key) || c.always);
  const head = cols.map((c) => `<th class="${["qty","rate","amount","discount","tax"].includes(c.key) ? "r" : ""}">${esc(c.label)}</th>`).join("");
  const body = (inv.lines || []).map((l, i) => cols.map((c) => {
    const right = ["qty","rate","amount","discount","tax"].includes(c.key);
    const val = {
      sn: i + 1, name: l.description, description: l.item_description || "",
      hsn: l.hsn_sac || "", qty: l.quantity, unit: l.unit || "",
      rate: inr(l.rate), discount: l.discount_pct ? l.discount_pct + "%" : "—",
      tax: l.gst_rate ? l.gst_rate + "%" : "—", amount: inr(l.line_total),
    }[c.key];
    return `<td class="${right ? "r" : ""}">${esc(val)}</td>`;
  }).join("")).map((tds) => `<tr>${tds}</tr>`).join("");

  const metaRows = (t.meta || []).map((k) =>
    `<tr><td class="mk">${esc(L[k] || k)}</td><td class="mv">${esc(v[k] || "—")}</td></tr>`).join("");
  const taxRows = st.print_show_taxes === "0" ? "" : (taxes || []).map((x) =>
    `<tr><td>${x.mode === "deduct" ? "Less" : "Add"}: ${esc(x.name)} (${x.rate}%)</td><td class="r">${x.mode === "deduct" ? "−" : ""}${inr(x.amount)}</td></tr>`).join("");

  return `<!doctype html><html><head><title>${esc(inv.invoice_no || "")}</title><style>
    @page{margin:14mm}
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:${stl.font || 12}px;color:#111;max-width:800px;margin:0 auto}
    h1{font-size:${(stl.font || 12) + 9}px;margin:0 0 4px;color:${accent}}
    .doctitle{font-size:${(stl.font || 12) + 6}px;font-weight:800;letter-spacing:.08em;color:${accent};text-align:center;margin:0 0 12px}
    .hd{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:14px}
    .logo{width:56px;height:56px;border:1px solid #ddd;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#aab;font-size:9px;margin-bottom:8px}
    .bill{background:#FAFBFF;border:1px solid #E4E8F2;border-radius:6px;padding:10px 12px;min-width:230px}
    .bill .lbl{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:${accent};font-weight:700;margin-bottom:4px}
    table{width:100%;border-collapse:collapse;margin:10px 0}
    td,th{padding:6px 9px;text-align:left}
    th{background:${stl.headerBg === false ? "transparent" : accent};color:${stl.headerBg === false ? "#111" : "#fff"};font-size:${(stl.font || 12) - 1.5}px;text-transform:uppercase;letter-spacing:.04em}
    ${stl.showGrid === false ? "td{border-bottom:1px solid #eee}" : "td,th{border:1px solid #D8DEEA}"}
    .r{text-align:right}
    .meta{width:270px;margin-left:auto;margin-top:0}
    .meta .mk{font-weight:700}.meta .mv{text-align:right}
    .sumtbl{width:300px;margin-left:auto}
    .tot td{font-weight:800;font-size:${(stl.font || 12) + 2}px;border-top:2px solid ${accent}}
    .band{padding:8px 0;color:#444}
    .foot{margin-top:20px;border-top:1px solid #E4E8F2;padding-top:10px;color:#444}
  </style></head><body>
    ${t.header ? `<div class="band">${block(t.header)}</div>` : ""}
    <div class="doctitle">${block(t.title) || "INVOICE"}</div>
    <div class="hd">
      <div>
        ${t.showLogo && st.print_show_logo !== "0" ? `<div class="logo">LOGO</div>` : ""}
        <h1>${esc(firm?.name || "")}</h1>
        <div>${block(t.business)}</div>
      </div>
      <div>
        <div class="bill"><div class="lbl">${esc(L.billTo || "Bill To")}</div>${block(t.client)}</div>
        ${metaRows ? `<table class="meta">${metaRows}</table>` : ""}
      </div>
    </div>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <table class="sumtbl">
      <tr><td>${esc(L.sub_total || "Sub Total")}</td><td class="r">${inr(inv.sub_total)}</td></tr>
      ${inv.discount_total ? `<tr><td>Discount</td><td class="r">−${inr(inv.discount_total)}</td></tr>` : ""}
      ${taxRows}
      <tr class="tot"><td>${esc(L.grand_total || "Total")}</td><td class="r">${inr(inv.grand_total)}</td></tr>
      ${st.print_show_received === "0" ? "" : `
      <tr><td>${esc(L.paid_amount || "Paid")}</td><td class="r">${inr(inv.paid_amount)}</td></tr>
      <tr><td>${esc(L.balance_due || "Balance Due")}</td><td class="r">${inr(inv.balance_due)}</td></tr>`}
    </table>
    ${t.notes ? `<div class="band">${block(t.notes)}</div>` : ""}
    ${t.footer ? `<div class="foot">${block(t.footer)}</div>` : ""}
  </body></html>`;
}

function regularHtml({ inv, partyName, firm, taxes, st, docTitle: override }) {
  const on = (k, d = "1") => (st[k] ?? d) !== "0";
  const theme = st.print_theme_regular || "tally";
  /* The Custom Invoice Builder designs an *invoice* — its title is free text
     the shopkeeper typed, and it says "INVOICE" or their own wording. Printing
     a credit note through it would put that heading on a document that means
     the opposite, so a named document falls through to the built-in themes,
     which can be told what they are. */
  if (theme === "custom" && st.print_custom_template && !override) return customHtml({ inv, partyName, firm, taxes, st });
  const THEME_CSS = {
    tally: `.hd{border-bottom:2.5px solid #333}h1{font-size:20px}th{background:#f2f4fa}td,th{border:1px solid #ccc}`,
    modern: `.hd{background:#F47B20;color:#fff;border-radius:10px;padding:16px 18px;border:none}.hd .badge{background:#fff;color:#F47B20;padding:5px 12px;border-radius:20px}h1{font-size:22px}.doctitle{color:#F47B20}th{background:#FEF0E5;color:#8a4a12;border:none}td{border:none;border-bottom:1px solid #f0e6dc}tr:nth-child(even) td{background:#FDF8F3}.tot td{border-top:2px solid #F47B20}`,
    compacta4: `body{font-size:10.5px}.hd{border-bottom:1.5px solid #555;padding-bottom:6px}h1{font-size:15px}td,th{border:1px solid #ddd;padding:3px 6px !important}.doctitle{font-size:13px}`,
    taxinv: `.hd{border-bottom:3px solid #1E2430}h1{font-size:19px}.doctitle{background:#1E2430;color:#fff;display:inline-block;padding:4px 16px;letter-spacing:.1em}th{background:#1E2430;color:#fff;text-transform:uppercase;font-size:10px;letter-spacing:.06em}td,th{border:1px solid #bbb}`,
    classic: `body{font-family:Georgia,'Times New Roman',serif}.hd{text-align:center;border-bottom:3px double #333;display:block}.hd .badge{margin-top:6px}h1{font-size:24px;letter-spacing:1px}.doctitle{font-variant:small-caps;font-size:17px}th{border-bottom:2px solid #333;border-top:1px solid #333;background:none;font-style:italic}td{border-bottom:1px solid #ddd}`,
    minimal6: `.hd{border:none;border-bottom:1px solid #eee;padding-bottom:6px}h1{font-size:18px;font-weight:600}.doctitle{color:#999;font-weight:400;letter-spacing:.2em;font-size:11px}th{border:none;border-bottom:2px solid #111;background:none;text-transform:uppercase;font-size:10px}td{border:none;border-bottom:1px solid #f2f2f2}.tot td{border-top:1px solid #111}`,
  };
  /* A caller-supplied name wins over the theme's. The themes disagree about
     case ("Invoice" vs "INVOICE") and that is a deliberate part of each one's
     look, so an override is matched to the theme rather than shouted. */
  const themeTitle = { tally: "INVOICE", modern: "INVOICE", compacta4: "INVOICE", taxinv: "TAX INVOICE", classic: "Invoice", minimal6: "INVOICE" }[theme] || "INVOICE";
  const docTitle = override
    ? (themeTitle === themeTitle.toUpperCase() ? override.toUpperCase() : cap1(override))
    : themeTitle;
  const rows = (inv.lines || []).map((l, i) => {
    const meta = [];
    if (on("print_show_desc", "0") && l.hsn_sac) meta.push(l.hsn_sac);
    if (on("print_show_batch", "0") && l.batch_no) meta.push("Batch: " + l.batch_no);
    if (on("print_show_expiry", "0") && l.expiry) meta.push("Exp: " + l.expiry);
    return `
    <tr>${on("print_show_sno") ? `<td>${i + 1}</td>` : ""}<td>${esc(l.description)}${meta.length ? `<div style="font-size:10px;color:#666">${esc(meta.join(" · "))}</div>` : ""}</td>
    <td class="r">${l.quantity}${on("print_show_uom") && l.unit ? " " + esc(l.unit) : ""}</td><td class="r">${inr(l.rate)}</td>
    <td class="r">${inr(l.line_total)}</td></tr>`;
  }).join("");
  const taxRows = st.print_show_taxes === "0" ? "" : taxes.map((t) =>
    `<tr><td>${taxLabel(t)}</td><td class="r">${t.mode === "deduct" ? "−" : ""}${inr(t.amount)}</td></tr>`).join("");
  const recRows = st.print_show_received === "0" ? "" : `
    <tr><td>Received</td><td class="r">${inr(inv.paid_amount)}</td></tr>
    <tr><td>Balance due</td><td class="r">${inr(inv.balance_due)}</td></tr>`;
  return `<!doctype html><html><head><title>${esc(inv.invoice_no)}</title><style>
    @page{margin:14mm} body{font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;color:#111;max-width:800px;margin:0 auto}
    h1{font-size:20px;margin:0}
    .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2.5px solid #333;padding-bottom:10px;margin-bottom:12px}
    ${on("print_repeat_header") ? "thead{display:table-header-group}" : ""}
    table{width:100%;border-collapse:collapse;margin:8px 0}
    td,th{padding:6px 9px;text-align:left}
    .r{text-align:right}
    .tot td{font-weight:800;font-size:14px;border-top:2px solid #333}
    .sumtbl{width:290px;margin-left:auto}
    .badge{font-weight:800}
    ${THEME_CSS[theme] || THEME_CSS.tally}
  </style></head><body>
    <div class="hd">
      <div style="display:flex;gap:12px">
        ${on("print_show_logo", "0") ? `<div style="width:52px;height:52px;background:#eef0f5;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#99a;font-size:9px">LOGO</div>` : ""}
        <div>
          <h1>${esc(firm.name)}</h1>
          ${st.print_show_tin === "0" ? "" : `<div>TIN: ${esc(firm.gstin || "—")}</div>`}
          ${on("print_show_address") && (firm.address || st.firm_address) ? `<div>${esc(firm.address || st.firm_address)}</div>` : ""}
          ${st.print_show_phone === "0" || !firm.phone ? "" : `<div>Tel: ${esc(firm.phone)}</div>`}
          ${on("print_show_email", "0") && (firm.email || st.firm_email) ? `<div>${esc(firm.email || st.firm_email)}</div>` : ""}
        </div>
      </div>
      <div class="badge">${esc(docTitle)} ${esc(inv.invoice_no)}</div>
    </div>
    <div class="doctitle" style="text-align:center;font-weight:800;font-size:15px;margin:6px 0 10px">${esc(docTitle)}</div>
    <div style="margin-bottom:6px">Billed to <b>${esc(partyName)}</b> · ${esc(inv.invoice_date)} · ${inv.payment_type === "credit" ? "Credit" : "Cash"}</div>
    <table><thead><tr>${on("print_show_sno") ? "<th>#</th>" : ""}<th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <table class="sumtbl"><tbody>
      <tr><td><b>Subtotal</b></td><td class="r">${inr(inv.sub_total)}</td></tr>
      ${taxRows}
      ${inv.round_off ? `<tr><td>Round off</td><td class="r">${inr(inv.round_off)}</td></tr>` : ""}
      <tr class="tot"><td>Grand total</td><td class="r">${cur()} ${inr(inv.grand_total)}</td></tr>
      ${recRows}
    </tbody></table>
    ${st.print_terms ? `<div style="margin-top:14px;font-size:11px;color:#444"><b>Terms &amp; Conditions</b><br>${esc(st.print_terms)}</div>` : ""}
    ${inv.sales_rep_name ? `<div style="margin-top:12px;font-size:12px">Served by: ${esc(inv.sales_rep_name)}${inv.created_by_name && inv.created_by_name !== inv.sales_rep_name ? ` (entered by ${esc(inv.created_by_name)})` : ""}</div>` : ""}
    <div style="text-align:center;margin-top:18px">${esc(st.print_footer_note || "Thank you for doing business with us!")}</div>
  </body></html>`;
}


function thermalHtml({ inv, partyName, firm, taxes, st, width, docTitle: override }) {
  const themes = {
    compact:  { f: 11.5, pad: 2, div: "dash",  tw: 800 },
    spacious: { f: 12.5, pad: 6, div: "dash",  tw: 800 },
    bold:     { f: 12,   pad: 3, div: "solid", tw: 900 },
    minimal:  { f: 11,   pad: 2, div: "none",  tw: 700 },
    stars:    { f: 11.5, pad: 3, div: "stars", tw: 800 },
    dotted:   { f: 11.5, pad: 3, div: "dot",   tw: 800 },
  };
  const T = themes[st.print_theme_thermal] || themes.compact;

  /* The "semantic" layout reproduces the uploaded reference receipt: a
     QTY / ITEM DESC. / AMOUNT three-column table, a "CASH SALE: n" header, and
     a SUB TOTAL / Levy / Tax / GRAND TOTAL / PAID / CHANGE block. It's distinct
     enough from the six line-by-line themes to be its own renderer. */
  if (st.print_theme_thermal === "semantic") {
    return semanticReceipt({ inv, partyName, firm, taxes, st, width });
  }
  const div =
    T.div === "stars" ? `<div class="stars">* * * * * * * * * * * * * * * *</div>` :
    T.div === "dash"  ? `<div style="border-top:1px dashed #000;margin:6px 0"></div>` :
    T.div === "dot"   ? `<div style="border-top:2px dotted #000;margin:6px 0"></div>` :
    T.div === "solid" ? `<div style="border-top:2px solid #000;margin:6px 0"></div>` :
                        `<div style="margin:7px 0"></div>`;
  const on = (k, d = "1") => (st[k] ?? d) !== "0";
  const rows = (inv.lines || []).map((l, i) => {
    const meta = [];
    if (on("print_show_batch", "0") && l.batch_no) meta.push("Batch: " + l.batch_no);
    if (on("print_show_expiry", "0") && l.expiry) meta.push("Exp: " + l.expiry);
    return `
    <div class="ln"><span>${on("print_show_sno") ? (i + 1) + ". " : ""}${esc(l.description)}</span><span>${inr(l.line_total)}</span></div>
    <div class="ln sub"><span>${l.quantity}${on("print_show_uom") && l.unit ? " " + esc(l.unit) : ""} × ${inr(l.rate)}</span></div>
    ${meta.length ? `<div class="ln sub"><span>${esc(meta.join(" · "))}</span></div>` : ""}`;
  }).join("");
  const taxRows = st.print_show_taxes === "0" ? "" : taxes.map((t) =>
    `<div class="ln"><span>${taxLabel(t)}</span><span>${t.mode === "deduct" ? "−" : ""}${inr(t.amount)}</span></div>`).join("");
  const rec = st.print_show_received === "0" ? "" :
    `<div class="ln"><span>Cash</span><span>${inr(inv.paid_amount)}</span></div>
     <div class="ln"><span>${inv.balance_due > 0 ? "Balance" : "Change"}</span><span>${inr(Math.abs(inv.balance_due || 0))}</span></div>`;
  return `<!doctype html><html><head><title>${esc(inv.invoice_no)}</title><style>
    @page{margin:2mm} body{font-family:'Segoe UI','Arial',sans-serif;width:${width};margin:0 auto;font-size:${T.f}px;color:#000}
    .c{text-align:center}
    .shop{font-size:16px;font-weight:${T.tw};letter-spacing:2.5px;text-transform:uppercase}
    .rtitle{font-weight:700;letter-spacing:3px;font-size:12.5px}
    .stars{text-align:center;letter-spacing:2px;margin:4px 0;font-size:10px}
    .ln{display:flex;justify-content:space-between;gap:6px;padding:${T.pad / 2}px 0}
    .sub{color:#333;font-size:${T.f - 1}px}
    .hdr{font-weight:700}
    .total{font-size:16px;font-weight:${T.tw}}
    .thanks{font-weight:${T.tw};letter-spacing:2px;margin:4px 0}
  </style></head><body>
    <div class="c">
      ${st.print_show_logo === "1" ? `<div style="font-size:9px;color:#777">[ LOGO ]</div>` : ""}
      <div class="shop">${esc(firm.name)}</div>
      ${st.print_show_address !== "0" && (firm.address || st.firm_address) ? `<div>Address: ${esc(firm.address || st.firm_address)}</div>` : ""}
      ${st.print_show_phone === "0" || !firm.phone ? "" : `<div>Telp. ${esc(firm.phone)}</div>`}
      ${st.print_show_email === "1" && (firm.email || st.firm_email) ? `<div>${esc(firm.email || st.firm_email)}</div>` : ""}
      ${st.print_show_tin === "0" ? "" : `<div>TIN: ${esc(firm.gstin || "—")}</div>`}
    </div>
    ${div}
    <div class="c rtitle">${override ? esc(override.toUpperCase()) : (inv.payment_type === "credit" ? "CREDIT RECEIPT" : "CASH RECEIPT")}</div>
    ${div}
    <div class="ln hdr"><span>Description</span><span>Price</span></div>
    <div class="ln sub"><span>${esc(inv.invoice_no)} · ${esc(inv.invoice_date)} · ${esc(partyName)}</span></div>
    ${rows}
    ${div}
    <div class="ln"><span class="hdr">Subtotal</span><span>${inr(inv.sub_total)}</span></div>
    ${taxRows}
    ${inv.round_off ? `<div class="ln"><span>Round off</span><span>${inr(inv.round_off)}</span></div>` : ""}
    <div class="ln total"><span>Total</span><span>${cur()} ${inr(inv.grand_total)}</span></div>
    ${rec}
    ${div}
    ${st.print_terms ? `<div style="white-space:pre-wrap;font-size:${T.f - 1.5}px">${esc(st.print_terms)}</div>${div}` : ""}
    ${inv.sales_rep_name ? `<div style="font-size:${T.f - 1}px">Served by: ${esc(inv.sales_rep_name)}</div>${div}` : ""}
    <div class="c thanks">${esc(st.print_footer_note || "THANK YOU!")}</div>
    ${st.print_show_barcode === "0" ? "" : `
    <div class="c" style="margin-top:8px">
      ${code128Svg(String(inv.invoice_no), { height: 58, scale: 2.4 })}
      <div style="font-size:12px;letter-spacing:2px;margin-top:3px">${esc(inv.invoice_no)}</div>
    </div>`}
  </body></html>`;
}

/**
 * semanticReceipt — the uploaded reference layout.
 *
 * QTY | ITEM DESC. | AMOUNT table, a "CASH SALE: n" header, then a
 * SUB TOTAL / Catering Levy / Tax / GRAND TOTAL / PAID / CHANGE block and the
 * served-by line. Levy % comes from print_levy_pct (0 = hidden).
 */
function semanticReceipt({ inv, partyName, firm, taxes, st, width }) {
  const dash = `<div style="border-top:1px dashed #000;margin:5px 0"></div>`;
  const on = (k, d = "1") => (st[k] ?? d) !== "0";
  const saleNo = String(inv.invoice_no || "").replace(/^\D*/, "") || inv.invoice_no;
  const kind = inv.payment_type === "credit" ? "CREDIT SALE" : "CASH SALE";

  const rows = (inv.lines || []).map((l) => `
    <tr>
      <td style="vertical-align:top;padding-right:6px">${inr(l.quantity)}</td>
      <td style="vertical-align:top">${esc(l.description)}${on("print_show_uom") && l.unit ? ` <span style="color:#555">(${esc(l.unit)})</span>` : ""}</td>
      <td style="text-align:right;vertical-align:top;white-space:nowrap">${inr(l.line_total)}</td>
    </tr>`).join("");

  const levyPct = Number(st.print_levy_pct) || 0;
  const levyAmt = levyPct > 0 ? Math.round(inv.sub_total * levyPct) / 100 : 0;
  const taxRows = (st.print_show_taxes === "0" ? "" : taxes.map((t) =>
    `<div class="ln"><span>${taxLabel(t)}</span><span>${t.mode === "deduct" ? "−" : ""}${inr(t.amount)}</span></div>`).join(""));

  const change = inv.balance_due < 0 ? Math.abs(inv.balance_due) : 0;
  const paid = Number(inv.paid_amount) || 0;

  return `<!doctype html><html><head><title>${esc(inv.invoice_no)}</title><style>
    @page{margin:2mm} body{font-family:'Segoe UI','Arial',sans-serif;width:${width};margin:0 auto;font-size:12px;color:#000}
    .c{text-align:center}
    .shop{font-size:15px;font-weight:800;letter-spacing:1px;text-transform:uppercase}
    table.items{width:100%;border-collapse:collapse;font-size:12px}
    table.items th{border-bottom:1px solid #000;border-top:1px dashed #000;text-align:left;padding:3px 0;font-size:11px;letter-spacing:.5px}
    table.items th.r{text-align:right}
    table.items td{padding:2px 0}
    .ln{display:flex;justify-content:space-between;gap:6px;padding:1px 0}
    .ln.big{font-size:15px;font-weight:800}
    .kv{margin:1px 0}
  </style></head><body>
    <div class="c">
      <div class="shop">${esc(firm.name)}</div>
      ${st.print_show_email === "1" && (firm.email || st.firm_email) ? `<div>${esc(firm.email || st.firm_email)}</div>` : ""}
      ${st.print_show_address !== "0" && (firm.address || st.firm_address) ? `<div>${esc(firm.address || st.firm_address)}</div>` : ""}
      ${st.print_show_phone === "0" || !firm.phone ? "" : `<div>${esc(firm.phone)}</div>`}
      ${st.print_show_tin === "0" ? "" : `<div>TIN: ${esc(firm.gstin || "—")}</div>`}
    </div>
    <div style="margin-top:8px"><b>${kind}:  ${esc(saleNo)}</b></div>
    <div class="kv">CUSTOMER: ${esc(partyName)}</div>
    <div class="kv">DATE: ${esc(inv.invoice_date)}${inv.payment_type !== "credit" ? "  ·  Express Cash Sale" : ""}</div>
    <table class="items">
      <thead><tr><th>QTY</th><th>ITEM DESC.</th><th class="r">AMOUNT</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${dash}
    <div class="ln"><span>SUB TOTAL</span><span>${inr(inv.sub_total)}</span></div>
    ${levyPct > 0 ? `<div class="ln"><span>Catering Levy (${levyPct}%)</span><span>${inr(levyAmt)}</span></div>` : ""}
    ${taxRows}
    ${inv.round_off ? `<div class="ln"><span>Round off</span><span>${inr(inv.round_off)}</span></div>` : ""}
    <div class="ln big"><span>GRAND TOTAL</span><span>${inr(inv.grand_total)}</span></div>
    ${dash}
    ${on("print_show_received") ? `<div class="ln"><span>PAID</span><span>${inr(paid)}</span></div>
    <div class="ln"><span>${inv.balance_due > 0 ? "BALANCE" : "CHANGE"}</span><span>${inr(inv.balance_due > 0 ? inv.balance_due : change)}</span></div>` : ""}
    ${dash}
    ${inv.sales_rep_name ? `<div>Served by: ${esc(inv.sales_rep_name)}</div>` : ""}
    <div class="c" style="margin-top:10px">${esc(st.print_footer_note || "Thank you and Come Again!")}</div>
    ${st.print_show_barcode === "0" ? "" : `<div class="c" style="margin-top:8px">${code128Svg(String(inv.invoice_no), { height: 50, scale: 2.2 })}</div>`}
  </body></html>`;
}


/* ── Money vouchers ────────────────────────────────────────────────────────
 *
 * Payments in and out, expenses and other income had no printable form at all.
 * Every other transaction in this app produces a piece of paper and these did
 * not, which is the wrong way round: a customer handing over cash against an
 * invoice is exactly the moment somebody wants a slip, and a supplier being
 * paid expects one.
 *
 * A voucher is not an invoice with fewer rows. It has one amount rather than a
 * priced line table, it names a payer or payee rather than a bill-to, and it
 * carries a signature line, because its job is to be evidence that money
 * changed hands. So it is its own template rather than `regularHtml` with the
 * items hidden.
 *
 * It reuses the firm header toggles, the currency helper and `sendToPrinter`,
 * so a shop that has set up its letterhead once does not set it up again, and
 * `print_copies` still means what it says — two copies is the normal ask here
 * (one for the payer, one for the book).
 */
export async function printVoucher(v) {
  const st = await printSettings();
  const firm = currentFirm() || { name: "My Business" };
  const on = (k, d = "1") => (st[k] ?? d) !== "0";

  /* Which paper. The shop's printer decides by default — a thermal till
     prints thermal — and `v.format` overrides it for the one case that needs
     to differ: a receipt handed over the counter is a slip, and the same
     receipt emailed to a business customer is a page. The preview offers both,
     so nobody has to change a setting to print one differently. */
  const format = v.format === "regular" ? "regular"
    : v.format === "thermal" ? "thermal"
    : (st.printer_type || "regular").startsWith("thermal") ? "thermal" : "regular";
  const paper = st.print_paper || (st.printer_type === "thermal-2in" ? "2in" : "3in");
  const width = paper === "2in" ? "56mm" : paper === "4in" ? "108mm" : "76mm";

  const rows = (v.rows || []).filter((r) => r && r[1] != null && r[1] !== "");
  const money = `${cur()} ${inr(v.amount)}`;

  const head = `
    <div class="vh">
      <div>
        <div class="fn">${esc(firm.name)}</div>
        ${st.print_show_tin === "0" ? "" : `<div>TIN: ${esc(firm.gstin || "—")}</div>`}
        ${on("print_show_address") && (firm.address || st.firm_address) ? `<div>${esc(firm.address || st.firm_address)}</div>` : ""}
        ${st.print_show_phone === "0" || !firm.phone ? "" : `<div>Tel: ${esc(firm.phone)}</div>`}
        ${on("print_show_email", "0") && (firm.email || st.firm_email) ? `<div>${esc(firm.email || st.firm_email)}</div>` : ""}
      </div>
      <div class="vno">${esc(v.title || "VOUCHER")}<br><b>${esc(v.number || "")}</b></div>
    </div>`;

  /* ── what this money was for ────────────────────────────────────────────
   *
   * A receipt that says only "Allocated 200,000" is not something a customer
   * with four open bills can check against their own file. These are the bills
   * it actually settled, what went to each, and what is left on each — which
   * is the whole reason they asked for a receipt.
   */
  const applied = (v.applied || []).filter((a) => a && a.doc_no);
  const settled = applied.length ? `
    <table class="alloc">
      <thead><tr><th>Against</th><th class="r">Applied</th><th class="r">Still due</th></tr></thead>
      <tbody>${applied.map((a) => `<tr>
        <td>${esc(a.doc_no)}</td>
        <td class="r">${cur()} ${inr(a.amount)}</td>
        <td class="r">${Number(a.balance_after) > 0.005
          ? `${cur()} ${inr(a.balance_after)}`
          : "settled"}</td>
      </tr>`).join("")}</tbody>
    </table>` : "";

  const body = `
    <div class="who">${esc(v.direction || "Received from")} <b>${esc(v.party || "—")}</b></div>
    <div class="amt">${money}</div>
    ${settled}
    <table class="kv">${rows.map(([k, val]) =>
      `<tr><td>${esc(k)}</td><td class="r">${esc(val)}</td></tr>`).join("")}</table>
    ${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}
    <div class="sig"><span>Received by</span><span>Authorised by</span></div>
    <div class="ft">${esc(st.print_footer_note || "Thank you for doing business with us!")}</div>`;

  const html = format === "thermal"
    ? `<!doctype html><html><head><title>${esc(v.number || "Voucher")}</title><style>
        @page{size:${width} auto;margin:0}
        /* box-sizing, because a 76mm width plus 7px of padding each side is
           76mm + 14px of paper, and a thermal roll has no 14px to give. On a
           300px roll that measured 301px — one pixel of the amount over the
           edge, which is the same defect round five found in the barcode:
           an intrinsic width that ignores the paper it is printed on.
           (No backticks in this comment: it lives inside a template literal,
           and a stray one ends the string. That is how this file broke once.) */
        *{box-sizing:border-box}
        body{font-family:'Courier New',monospace;font-size:11px;width:${width};max-width:100%;margin:0;padding:5px 7px;color:#000}
        .vh{text-align:center;margin-bottom:6px}.vh>div:last-child{margin-top:4px}
        .fn{font-size:14px;font-weight:800}
        .vno{border-top:1px dashed #000;border-bottom:1px dashed #000;padding:3px 0;margin-top:5px}
        .who{margin:6px 0 2px}
        .amt{font-size:17px;font-weight:800;text-align:center;margin:6px 0;letter-spacing:.02em}
        .kv{width:100%;border-collapse:collapse;margin:4px 0}
        .kv td{padding:1px 0}.r{text-align:right}
        /* What the money settled, on a roll: two dashed rules and nothing else,
           because a bordered table on 76mm is mostly border. */
        .alloc{width:100%;border-collapse:collapse;margin:5px 0;font-size:10px}
        .alloc th{text-align:left;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:2px 0;font-weight:700}
        .alloc td{padding:1px 0}
        .note{margin-top:5px;border-top:1px dashed #000;padding-top:4px}
        .sig{display:flex;justify-content:space-between;margin-top:22px;font-size:10px}
        .sig span{border-top:1px solid #000;padding-top:2px;width:46%;text-align:center}
        .ft{text-align:center;margin-top:10px;font-size:10px}
      </style></head><body>${head}${body}</body></html>`
    : `<!doctype html><html><head><title>${esc(v.number || "Voucher")}</title><style>
        @page{margin:14mm}
        body{font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;color:#111;max-width:800px;margin:0 auto}
        .vh{display:flex;justify-content:space-between;align-items:flex-start;
            border-bottom:2.5px solid #333;padding-bottom:10px;margin-bottom:14px}
        .fn{font-size:20px;font-weight:800}
        .vno{text-align:right;font-weight:700;letter-spacing:.06em}
        .who{margin:4px 0 2px;font-size:14px}
        /* The figure is the whole point of the document, so it gets §3's
           Figure treatment — big, heavy, tabular, and alone on its line. */
        .amt{font-size:27px;font-weight:800;margin:10px 0 16px;
             font-variant-numeric:tabular-nums;letter-spacing:-.01em}
        .kv{width:340px;border-collapse:collapse;margin:0 0 6px}
        .kv td{padding:5px 8px;border-bottom:1px solid #e6e6e6}
        .alloc{width:100%;border-collapse:collapse;margin:12px 0}
        .alloc th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
          color:#555;border-bottom:1px solid #999;padding:4px 8px}
        .alloc td{padding:5px 8px;border-bottom:1px solid #e6e6e6}
        .r{text-align:right;font-variant-numeric:tabular-nums}
        .note{margin-top:12px;font-size:11.5px;color:#444;max-width:520px}
        .sig{display:flex;gap:60px;margin-top:52px;font-size:12px}
        .sig span{border-top:1px solid #333;padding-top:4px;width:210px;text-align:center}
        .ft{text-align:center;margin-top:26px;font-size:11.5px;color:#555}
      </style></head><body>${head}${body}</body></html>`;

  /* Copies: a voucher is the one document routinely wanted in duplicate, and
     the existing setting already says how many the shop wants. Same page-break
     idiom as printInvoice, so thermal rolls cut between copies. */
  const copies = Math.max(1, Number(st.print_copies) || 1);
  const doc = copies > 1
    ? html.replace("</body>", Array(copies - 1).fill(
        `<div style="page-break-before:always"></div>${head}${body}`).join("") + "</body>")
    : html;

  const mode = st.print_preview || "documents";
  if (mode === "always" || mode === "documents") {
    showPrintPreview(doc, {
      title: `${v.title || "Voucher"} preview`,
      subtitle: `${v.number || ""} · ${money} · ${format === "thermal" ? "till slip" : "A4 page"}`,
      thermal: format === "thermal",
      /* The same receipt, the other way round. A slip goes over the counter
         and a page goes in an envelope, and which one is wanted is a decision
         made when the customer is standing there — not a setting to go and
         change and then change back. */
      alsoPrint: {
        label: format === "thermal" ? "Print as an A4 page" : "Print as a till slip",
        run: () => printVoucher({ ...v, format: format === "thermal" ? "regular" : "thermal" }),
      },
    });
    return;
  }
  await sendToPrinter(doc, { format, st, fallbackTitle: v.title || "Voucher" });
}

/* ── Printing a report ─────────────────────────────────────────────────────
 *
 * Reports used to print by calling `window.print()` on the app itself. That is
 * why every printed report came out with a URL, a page title and a date across
 * the top and bottom: those are the *browser's* header and footer, drawn
 * outside the page and impossible to remove from inside it. A shopkeeper
 * handing a customer a statement was handing them a screenshot of a web
 * browser.
 *
 * So a report is now built as its own document, exactly like an invoice, and
 * goes down the same path: through the desktop shell's printer bridge, which
 * has no browser chrome to add, and through the preview when the shop wants to
 * look before it commits. What comes out is a business document — the firm's
 * name, the report's title, the period it covers, the figures, and who printed
 * it when.
 *
 * The report's own screen markup is reused rather than re-rendered. Every one
 * of the 58 reports would otherwise need a second implementation of itself,
 * and the two would drift the first time somebody added a column.
 */
function reportCss() {
  return `
  @page{margin:14mm 12mm}
  *{box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#111;background:#fff;margin:0;font-size:9.5pt}
  .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
      border-bottom:1.5px solid #173A6B;padding-bottom:8px;margin-bottom:4px}
  .hd .firm{font-size:15pt;font-weight:700;color:#173A6B;line-height:1.2}
  .hd .meta{font-size:8pt;color:#444;line-height:1.5;margin-top:3px}
  .hd .right{text-align:right;font-size:8pt;color:#444;line-height:1.5;white-space:nowrap}
  .ttl{margin:10px 0 2px;font-size:12.5pt;font-weight:700}
  .cap{font-size:8.5pt;color:#555;margin-bottom:10px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:8pt;text-transform:uppercase;letter-spacing:.03em;color:#333;
     border-bottom:1.2px solid #666;padding:4px 6px;white-space:normal}
  td{padding:2.5px 6px;line-height:1.35;border-bottom:1px solid #D2D2D2;overflow-wrap:break-word}
  td.amt,td.num,th.amt,th.num,tfoot td{text-align:right;white-space:nowrap}
  tfoot td{border-top:1.2px solid #555;border-bottom:none;font-weight:600}
  thead{display:table-header-group}          /* repeat headings on every page */
  tr{page-break-inside:avoid}
  /* The totals a person opened the report for, kept together above the detail. */
  .rpt-totals,.sum-chip,.ha-card{border:1px solid #9A9A9A;padding:6px 10px;margin:0 0 10px;
     display:inline-block;font-size:9pt}
  .rpt-totals{display:flex;gap:22px;flex-wrap:wrap;width:100%}
  .sort-mark,.no-print,.dk-rp-head,.dk-tablehead,.rpt-actions,.dk-ledger-foot,
  input,select,button{display:none !important}
  .ft{margin-top:14px;padding-top:6px;border-top:1px solid #CCC;
      display:flex;justify-content:space-between;font-size:7.5pt;color:#666}`;
}

/**
 * Print what a report screen is showing.
 *
 * @param {HTMLElement} node   the element wrapping the report's header, totals
 *                             and table — everything that belongs on paper
 * @param {object} o
 * @param {string} o.title     the report's name
 * @param {string} [o.caption] the period, or whatever names this run of it
 * @param {object} [o.firm]    the business, for the letterhead
 * @param {string} [o.user]    who is printing it
 */
export async function printReportNode(node, { title, caption = "", firm = null, user = "" } = {}) {
  const st = await printSettings();
  const f = firm || currentFirm() || {};
  const on = (k, dflt = "1") => (st[k] ?? dflt) !== "0";

  /* A copy, so stripping the controls out cannot touch the live screen. */
  const copy = node ? node.cloneNode(true) : null;
  if (copy) {
    copy.querySelectorAll(
      ".no-print, .rpt-actions, .dk-tablehead, .dk-ledger-foot, .rpt-print-head, button, input, select"
    ).forEach((el) => el.remove());
    /* Sort arrows are a screen affordance; on paper they are two stray
       characters in the middle of a heading. */
    copy.querySelectorAll(".sort-mark").forEach((el) => el.remove());
  }

  const bits = [
    on("print_show_address") && (f.address || st.firm_address),
    on("print_show_phone") && (f.phone || st.firm_phone) && `Tel ${f.phone || st.firm_phone}`,
    on("print_show_email", "0") && (f.email || st.firm_email),
    on("print_show_tin") && (f.gstin || f.tin || st.firm_tin) && `TIN ${f.gstin || f.tin || st.firm_tin}`,
  ].filter(Boolean).map(esc);

  const now = new Date();
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <title>${esc(title || "Report")}</title><style>${reportCss()}</style></head><body>
    <div class="hd">
      <div>
        <div class="firm">${esc(f.name || st.firm_name || "")}</div>
        <div class="meta">${bits.join(" &nbsp;·&nbsp; ")}</div>
      </div>
      <div class="right">
        Printed ${esc(now.toLocaleDateString())} ${esc(now.toLocaleTimeString())}
        ${user ? `<br>by ${esc(user)}` : ""}
      </div>
    </div>
    <div class="ttl">${esc(title || "Report")}</div>
    ${caption ? `<div class="cap">${esc(caption)}</div>` : ""}
    ${copy ? copy.innerHTML : ""}
    <div class="ft">
      <span>${esc(f.name || st.firm_name || "")} — ${esc(title || "Report")}</span>
      <span>Powered by SALJO TECH</span>
    </div>
  </body></html>`;

  const mode = st.print_preview || "documents";
  if (mode === "always" || mode === "documents") {
    showPrintPreview(html, { title: `${title || "Report"} preview`, subtitle: caption, paper: "A4" });
    return;
  }
  await sendToPrinter(html, { format: "regular", st, fallbackTitle: title || "Report" });
}
