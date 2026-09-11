/**
 * template.js — the Custom Invoice Builder's data model.
 *
 * A template is plain JSON held in the `print_custom_template` setting. Each
 * section is a block of text that may contain {%placeholders%}; `resolve()`
 * swaps them for real values at print time. Keeping the model here means the
 * builder and the printer can never drift apart.
 */

/* Every placeholder the builder offers, grouped the way the side rail shows them. */
export const PLACEHOLDERS = [
  { group: "Business", items: [
    ["business_name", "Business Name"], ["business_address", "Business Address"],
    ["business_phone", "Business Phone"], ["business_email", "Business Email"],
    ["business_tin", "Business TIN"],
  ] },
  { group: "Client", items: [
    ["client_organization", "Client Business Name"], ["client_name", "Client Name"],
    ["client_phone", "Client Phone"], ["client_email", "Client Email"],
    ["client_address", "Client Address"], ["client_tin", "Client TIN"],
    ["client_balance", "Client Balance"],
  ] },
  { group: "Document", items: [
    ["invoice_no", "Invoice No"], ["invoice_date", "Invoice Date"],
    ["due_date", "Due Date"], ["doc_title", "Document Title"],
    ["sales_rep", "Sales Rep"], ["reference", "Reference"],
  ] },
  { group: "Totals", items: [
    ["sub_total", "Sub Total"], ["discount_total", "Discount"],
    ["tax_total", "Tax"], ["grand_total", "Total"],
    ["paid_amount", "Paid"], ["balance_due", "Balance Due"],
    ["amount_words", "Total in Words"],
  ] },
];

/* Flat lookup used by the inserter and the highlighter. */
export const ALL_PLACEHOLDERS = PLACEHOLDERS.flatMap((g) => g.items.map(([k, label]) => ({ key: k, label, group: g.group })));

/* The item table's available columns. `always` ones cannot be switched off. */
export const ITEM_COLUMNS = [
  { key: "sn", label: "#", always: false },
  { key: "name", label: "Item name", always: true },
  { key: "description", label: "Description" },
  /* Column key stays `hsn` — it is the stored field. Ugandan VAT has no
     HSN/SAC classification, so the label is the commodity code a URA filer
     would actually recognise. */
  { key: "hsn", label: "Commodity code" },
  { key: "qty", label: "Qty", always: true },
  { key: "unit", label: "Unit" },
  { key: "rate", label: "Price", always: true },
  { key: "discount", label: "Discount" },
  { key: "tax", label: "Tax" },
  { key: "amount", label: "Subtotal", always: true },
];

/* A sensible starting point that already looks like a real invoice. */
export function defaultTemplate() {
  return {
    name: "My Invoice",
    title: "{%doc_title%}",
    showLogo: true,
    business: "{%business_name%}\n{%business_address%}\nTel {%business_phone%}\nTIN {%business_tin%}",
    client: "{%client_organization%}\n{%client_name%}\n{%client_address%}\nTel {%client_phone%}",
    meta: ["invoice_no", "invoice_date", "due_date"],
    columns: ["sn", "name", "qty", "rate", "amount"],
    labels: {
      invoice_no: "Invoice No", invoice_date: "Invoice Date", due_date: "Due Date",
      sub_total: "Sub Total", tax_total: "Tax", grand_total: "Total",
      paid_amount: "Paid", balance_due: "Balance Due", billTo: "Bill To",
    },
    header: "",
    footer: "Thank you for doing business with us.",
    notes: "",
    style: { accent: "#2F6FE0", font: 12, showGrid: true, headerBg: true },
  };
}

/* Merge a stored template over the defaults so older saves keep working when
   new fields are added. */
export function parseTemplate(json) {
  const d = defaultTemplate();
  if (!json) return d;
  try {
    const t = typeof json === "string" ? JSON.parse(json) : json;
    return { ...d, ...t, labels: { ...d.labels, ...(t.labels || {}) }, style: { ...d.style, ...(t.style || {}) } };
  } catch { return d; }
}

const esc = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/**
 * Swap {%placeholders%} for values. Unknown placeholders are dropped rather
 * than left on the page, and a line that ends up empty is removed entirely so
 * a missing TIN doesn't leave a blank gap on every invoice.
 */
export function resolve(text, values) {
  if (!text) return "";
  return String(text)
    .split("\n")
    .map((line) => {
      let had = false, filled = false;
      const out = line.replace(/\{%\s*([a-z0-9_]+)\s*%\}/gi, (_, key) => {
        had = true;
        const val = values[key];
        if (val != null && String(val).trim() !== "") { filled = true; return esc(val); }
        return "";
      });
      return { out, had, filled };
    })
    /* A line built from placeholders that all came back empty is dropped, so a
       missing TIN doesn't print a stranded "TIN" label. Lines of static text
       (no placeholders at all) are always kept. */
    .filter(({ had, filled }) => !had || filled)
    .map(({ out }) => out.replace(/\s+$/, ""))
    .join("\n");
}

/** Build the value bag a template resolves against. */
export function valuesFor({ inv, firm, party, totals }) {
  const money = (n) => `Sh ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    business_name: firm.name, business_address: firm.address, business_phone: firm.phone,
    business_email: firm.email, business_tin: firm.tin,
    client_organization: party.organization || party.name, client_name: party.name,
    client_phone: party.phone, client_email: party.email, client_address: party.address,
    client_tin: party.tin, client_balance: money(party.balance),
    invoice_no: inv.invoice_no || inv.bill_no, invoice_date: inv.invoice_date || inv.bill_date,
    due_date: inv.due_date, doc_title: inv.doc_title || "INVOICE",
    sales_rep: inv.sales_rep_name, reference: inv.reference,
    sub_total: money(totals.sub_total), discount_total: money(totals.discount_total),
    tax_total: money(totals.tax_total), grand_total: money(totals.grand_total),
    paid_amount: money(totals.paid_amount), balance_due: money(totals.balance_due),
    amount_words: totals.words || "",
  };
}
