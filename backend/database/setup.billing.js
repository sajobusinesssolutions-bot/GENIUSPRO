/**
 * setup.billing.js — core billing schema.
 *
 * Slots into the blueprint's idempotent boot strategy (§5.3):
 *   - Every statement is CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,
 *     so it runs safely on every boot against every existing DB.
 *   - New columns later go in server.js `addColumns[]` as guarded ALTER TABLE.
 *
 * Assumes the infrastructure tables from the blueprint already exist:
 *   users, roles, permissions, role_permissions, audit_logs,
 *   pending_approvals, sequences, institution_settings.
 *
 * Usage (inside database/setup.js):
 *   const { billingTables } = require("./setup.billing");
 *   for (const ddl of billingTables) await query(ddl);
 *
 * Conventions carried over from the blueprint (§7):
 *   - plural snake_case table names, surrogate INTEGER PK + human "no" reference
 *   - money stored as REAL, rounded to 2dp at write time
 *   - status columns drive both logic and the StatusPill UI
 *   - MULTI-FIRM: every domain row carries firm_id (one owner runs many firms).
 *     Scope EVERY query by firm_id. Decide this now — retrofitting is painful.
 */

const billingTables = [

  /* ──────────────────────────────────────────────────────────────
   * FIRMS — the tenant boundary. One login → many businesses.
   * Branding/white-label lives here per firm (vs blueprint's single org).
   * ────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS firms (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     name            TEXT    NOT NULL,
     legal_name      TEXT,
     gstin           TEXT,                      -- 15-char GST number; null if unregistered
     state_code      TEXT    NOT NULL,          -- 2-digit GST state code, e.g. '29' (KA)
     gst_scheme      TEXT    DEFAULT 'regular', -- regular | composition | unregistered
     pan             TEXT,
     address         TEXT,
     phone           TEXT,
     email           TEXT,
     logo_path       TEXT,
     invoice_prefix  TEXT    DEFAULT 'INV',
     financial_year_start_month INTEGER DEFAULT 4,  -- India FY starts April
     enable_inventory   INTEGER DEFAULT 1,
     round_off_invoices INTEGER DEFAULT 1,      -- round grand total to nearest rupee
     created_by      INTEGER,
     created_at      TEXT    DEFAULT (datetime('now')),
     status          TEXT    DEFAULT 'active'
   )`,

  /* ──────────────────────────────────────────────────────────────
   * TAX RATES — DATA-DRIVEN. Never hardcode 5/12/18/28; GST slabs are
   * rationalised periodically. Seed rows; the tax engine reads them.
   * cess_rate is ad-valorem %, cess_per_unit is fixed amount/unit.
   * ────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS tax_rates (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     name          TEXT    NOT NULL,            -- 'GST 18%', 'IGST 5%', 'Exempt', 'Nil'
     gst_rate      REAL    NOT NULL DEFAULT 0,  -- total GST %, split into CGST/SGST or IGST
     cess_rate     REAL    DEFAULT 0,           -- additional cess %
     cess_per_unit REAL    DEFAULT 0,           -- fixed cess per qty unit
     nature        TEXT    DEFAULT 'taxable',   -- taxable | exempt | nil_rated | non_gst
     is_active     INTEGER DEFAULT 1,
     created_at    TEXT    DEFAULT (datetime('now'))
   )`,

  /* ──────────────────────────────────────────────────────────────
   * PARTIES — customers + suppliers in ONE table (party_type flag),
   * mirroring SACCO 'customers'. balance is the running ledger balance:
   *   > 0 = they owe us (receivable),  < 0 = we owe them (payable).
   * ────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS parties (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id         INTEGER NOT NULL,
     party_no        TEXT,                      -- human ref, e.g. 'CUST-000123'
     name            TEXT    NOT NULL,
     party_type      TEXT    DEFAULT 'customer', -- customer | supplier | both
     gstin           TEXT,
     state_code      TEXT,                      -- place-of-supply driver for GST split
     phone           TEXT,
     email           TEXT,
     billing_address TEXT,
     shipping_address TEXT,
     opening_balance REAL    DEFAULT 0,
     balance         REAL    DEFAULT 0,         -- maintained inside txns (never trust a stale read)
     credit_limit    REAL    DEFAULT 0,
     credit_days     INTEGER DEFAULT 0,
     loyalty_points  REAL    DEFAULT 0,
     created_at      TEXT    DEFAULT (datetime('now')),
     status          TEXT    DEFAULT 'active'
   )`,
  `CREATE INDEX IF NOT EXISTS ix_parties_firm  ON parties(firm_id)`,
  `CREATE INDEX IF NOT EXISTS ix_parties_phone ON parties(firm_id, phone)`,

  /* ──────────────────────────────────────────────────────────────
   * ITEMS — products AND services. is_inventory=0 for services
   * (skipped by the stock poster, like the GL poster skips control accts).
   * ────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS items (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id        INTEGER NOT NULL,
     item_code      TEXT,                       -- SKU
     name           TEXT    NOT NULL,
     item_type      TEXT    DEFAULT 'product',  -- product | service
     is_inventory   INTEGER DEFAULT 1,
     hsn_sac        TEXT,                        -- HSN (goods) / SAC (services) for GST
     unit           TEXT    DEFAULT 'PCS',
     barcode        TEXT,
     sale_price     REAL    DEFAULT 0,
     purchase_price REAL    DEFAULT 0,
     price_inclusive INTEGER DEFAULT 0,          -- is sale_price tax-inclusive?
     tax_rate_id    INTEGER,                     -- FK -> tax_rates
     reorder_level  REAL    DEFAULT 0,           -- low-stock alert threshold
     created_at     TEXT    DEFAULT (datetime('now')),
     status         TEXT    DEFAULT 'active'
   )`,
  `CREATE INDEX IF NOT EXISTS ix_items_firm    ON items(firm_id)`,
  `CREATE INDEX IF NOT EXISTS ix_items_barcode ON items(firm_id, barcode)`,

  /* item_stock — current on-hand per item per batch.
   * Quantity is DERIVED from stock_movements (the second ledger) and cached here. */
  `CREATE TABLE IF NOT EXISTS item_stock (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     item_id     INTEGER NOT NULL,
     batch_no    TEXT    DEFAULT '',
     expiry_date TEXT,
     mfg_date    TEXT,
     quantity    REAL    DEFAULT 0,
     avg_cost    REAL    DEFAULT 0,
     UNIQUE(firm_id, item_id, batch_no)
   )`,

  /* stock_movements — the INVENTORY LEDGER. Mirror of journal_entry_lines.
   * Every sale writes 'out', every purchase writes 'in'. Stock = sum(in) - sum(out).
   * source_module/source_id link back to the invoice/purchase that caused it. */
  `CREATE TABLE IF NOT EXISTS stock_movements (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     item_id       INTEGER NOT NULL,
     batch_no      TEXT    DEFAULT '',
     direction     TEXT    NOT NULL,            -- in | out
     quantity      REAL    NOT NULL,
     unit_cost     REAL    DEFAULT 0,
     move_date     TEXT    DEFAULT (datetime('now')),
     source_module TEXT,                         -- 'sales' | 'purchases' | 'adjustment'
     source_id     INTEGER,
     created_by    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS ix_stockmove_item ON stock_movements(firm_id, item_id)`,
  `CREATE INDEX IF NOT EXISTS ix_stockmove_src  ON stock_movements(source_module, source_id)`,

  /* ──────────────────────────────────────────────────────────────
   * SALES — invoices. The transactional heart (parallels SACCO loans).
   * The same shape serves estimates/quotations/orders via doc_type +
   * status; keep one engine, branch on type. Here we model the invoice.
   * ────────────────────────────────────────────────────────────── */
  /* ── Payment reminders ────────────────────────────────────────────────
   * Who has been chased, when, over what channel, for how much.
   *
   * The log is the feature. Without it the cooldown cannot exist, and without
   * a cooldown a shopkeeper working down the list on Tuesday sends the same
   * customer the same message they sent on Monday — which is how a reminder
   * stops being read. It also answers "have we already asked?", which is the
   * question somebody has before they pick up the phone.
   */
  `CREATE TABLE IF NOT EXISTS payment_reminders (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     party_id    INTEGER NOT NULL,
     user_id     INTEGER,
     channel     TEXT,                          -- whatsapp | sms | call | note
     balance     REAL    DEFAULT 0,             -- what was owed at the time
     days        INTEGER DEFAULT 0,             -- how overdue the oldest bill was
     message     TEXT,
     created_at  TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_reminders_party ON payment_reminders(firm_id, party_id)`,

  `CREATE TABLE IF NOT EXISTS sale_invoices (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id         INTEGER NOT NULL,
     invoice_no      TEXT    NOT NULL,          -- 'INV-000123' via nextSeq, per firm
     doc_type        TEXT    DEFAULT 'invoice', -- invoice | estimate | sale_order
     party_id        INTEGER NOT NULL,
     invoice_date    TEXT    NOT NULL,
     due_date        TEXT,
     place_of_supply TEXT,                       -- state code; drives CGST+SGST vs IGST
     reverse_charge  INTEGER DEFAULT 0,
     -- money (all 2dp; computed by the tax engine, persisted for audit/GSTR):
     sub_total       REAL    DEFAULT 0,          -- sum of taxable values (post discount)
     discount_total  REAL    DEFAULT 0,
     cgst_total      REAL    DEFAULT 0,
     sgst_total      REAL    DEFAULT 0,
     igst_total      REAL    DEFAULT 0,
     cess_total      REAL    DEFAULT 0,
     round_off       REAL    DEFAULT 0,
     grand_total     REAL    DEFAULT 0,
     paid_amount     REAL    DEFAULT 0,
     balance_due     REAL    DEFAULT 0,
     -- e-invoice / e-way bill (filled fire-after-commit by the IRP integration):
     irn             TEXT,
     irn_ack_no      TEXT,
     eway_bill_no    TEXT,
     notes           TEXT,
     status          TEXT    DEFAULT 'unpaid',   -- unpaid | partial | paid | cancelled
     /* IDEMPOTENCY KEY. The till mints one UUID per sale ATTEMPT — not per
        retry — and sends the same value on every try, so a retry after a lost
        response is recognisable as the same intent rather than a new sale.
        The constraint that makes it a guarantee is the unique index created by
        ensureIdempotencyKeys() at the bottom of this file, not a table-level
        UNIQUE here: an existing shop's database already has this table, and a
        constraint declared in CREATE TABLE would only ever reach fresh
        installs. One mechanism, both paths. */
     client_ref      TEXT,
     created_by      INTEGER,
     created_at      TEXT    DEFAULT (datetime('now')),
     UNIQUE(firm_id, invoice_no)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_sinv_firm  ON sale_invoices(firm_id, invoice_date)`,
  `CREATE INDEX IF NOT EXISTS ix_sinv_party ON sale_invoices(firm_id, party_id)`,
  `CREATE INDEX IF NOT EXISTS ix_sinv_status ON sale_invoices(firm_id, status)`,

  `CREATE TABLE IF NOT EXISTS sale_invoice_lines (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     invoice_id    INTEGER NOT NULL,
     item_id       INTEGER,
     description   TEXT,
     hsn_sac       TEXT,
     batch_no      TEXT    DEFAULT '',
     quantity      REAL    NOT NULL DEFAULT 1,
     unit          TEXT,
     rate          REAL    NOT NULL DEFAULT 0,   -- per-unit price as entered
     discount_pct  REAL    DEFAULT 0,
     discount_amt  REAL    DEFAULT 0,
     taxable_value REAL    DEFAULT 0,            -- post-discount, exclusive of tax
     tax_rate_id   INTEGER,
     gst_rate      REAL    DEFAULT 0,            -- snapshot of rate at sale time
     cgst_amt      REAL    DEFAULT 0,
     sgst_amt      REAL    DEFAULT 0,
     igst_amt      REAL    DEFAULT 0,
     cess_amt      REAL    DEFAULT 0,
     line_total    REAL    DEFAULT 0             -- taxable + all taxes
   )`,
  `CREATE INDEX IF NOT EXISTS ix_sline_inv ON sale_invoice_lines(invoice_id)`,

  /* PURCHASES — mirror of sales (we are the buyer). Same line shape. */
  `CREATE TABLE IF NOT EXISTS purchase_invoices (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id         INTEGER NOT NULL,
     bill_no         TEXT    NOT NULL,          -- supplier's bill no (+ our PUR- seq)
     doc_type        TEXT    DEFAULT 'purchase',-- purchase | purchase_order
     party_id        INTEGER NOT NULL,
     bill_date       TEXT    NOT NULL,
     due_date        TEXT,
     place_of_supply TEXT,
     sub_total       REAL    DEFAULT 0,
     discount_total  REAL    DEFAULT 0,
     cgst_total      REAL    DEFAULT 0,
     sgst_total      REAL    DEFAULT 0,
     igst_total      REAL    DEFAULT 0,
     cess_total      REAL    DEFAULT 0,
     round_off       REAL    DEFAULT 0,
     grand_total     REAL    DEFAULT 0,
     paid_amount     REAL    DEFAULT 0,
     balance_due     REAL    DEFAULT 0,
     status          TEXT    DEFAULT 'unpaid',
     created_by      INTEGER,
     created_at      TEXT    DEFAULT (datetime('now')),
     UNIQUE(firm_id, bill_no)
   )`,
  `CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     bill_id       INTEGER NOT NULL,
     item_id       INTEGER,
     description   TEXT,
     hsn_sac       TEXT,
     batch_no      TEXT    DEFAULT '',
     quantity      REAL    NOT NULL DEFAULT 1,
     rate          REAL    NOT NULL DEFAULT 0,
     discount_amt  REAL    DEFAULT 0,
     taxable_value REAL    DEFAULT 0,
     tax_rate_id   INTEGER,
     cgst_amt      REAL    DEFAULT 0,
     sgst_amt      REAL    DEFAULT 0,
     igst_amt      REAL    DEFAULT 0,
     cess_amt      REAL    DEFAULT 0,
     line_total    REAL    DEFAULT 0
   )`,

  /* ──────────────────────────────────────────────────────────────
   * PAYMENTS — payment-in (from customer) and payment-out (to supplier).
   * Allocated against one or more invoices (penalty/interest/principal-style
   * allocation in SACCO becomes invoice-by-invoice allocation here).
   * ────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS payments (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     payment_no    TEXT    NOT NULL,            -- 'PAY-000123'
     direction     TEXT    NOT NULL,            -- in | out
     party_id      INTEGER NOT NULL,
     payment_date  TEXT    NOT NULL,
     amount        REAL    NOT NULL,
     mode          TEXT    DEFAULT 'cash',      -- cash | upi | card | cheque | bank
     reference     TEXT,                         -- UPI txn id / cheque no
     unallocated   REAL    DEFAULT 0,           -- advance not yet applied to an invoice
     notes         TEXT,
     created_by    INTEGER,
     created_at    TEXT    DEFAULT (datetime('now')),
     UNIQUE(firm_id, payment_no)
   )`,
  `CREATE TABLE IF NOT EXISTS payment_allocations (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     payment_id  INTEGER NOT NULL,
     doc_table   TEXT    NOT NULL,              -- 'sale_invoices' | 'purchase_invoices'
     doc_id      INTEGER NOT NULL,
     amount      REAL    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_payalloc_pay ON payment_allocations(payment_id)`,
  `CREATE INDEX IF NOT EXISTS ix_payalloc_doc ON payment_allocations(doc_table, doc_id)`,

  /* ──────────────────────────────────────────────────────────────
   * EXPENSES — categorised spend, posts to the GL like everything else.
   * ────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS expenses (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     expense_no    TEXT    NOT NULL,
     category      TEXT,                          -- rent | salary | utilities | ...
     party_id      INTEGER,                       -- optional vendor
     expense_date  TEXT    NOT NULL,
     amount        REAL    NOT NULL,
     tax_rate_id   INTEGER,                       -- input GST if claimable
     tax_amount    REAL    DEFAULT 0,
     mode          TEXT    DEFAULT 'cash',
     notes         TEXT,
     created_by    INTEGER,
     created_at    TEXT    DEFAULT (datetime('now')),
     UNIQUE(firm_id, expense_no)
   )`,
];

/* ──────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY KEYS — the migration path, for a database that already exists.
 *
 * Three documents can be posted twice by a retry after a lost response, and
 * each costs real money: a sale, a refund, a void. Each carries a client_ref
 * (a UUID the till mints once per attempt) and each is protected by
 * UNIQUE(firm_id, client_ref).
 *
 * Why this is a function rather than three more strings in billingTables:
 *
 *  - `sale_invoices` gains the column in its CREATE TABLE above, but only a
 *    brand-new install runs that. Every shop already trading has the table,
 *    and SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column has to be
 *    added conditionally — which needs a PRAGMA read first.
 *  - `sale_returns` and `void_log` are declared in setup.accounting.js, so
 *    they can only ever be reached by ALTER from here.
 *  - setup.js runs billingTables with no error handling, by design: a failing
 *    CREATE TABLE should stop the boot. An ALTER that is merely redundant
 *    should not, so it does not belong in that list.
 *
 * On NULLs: every row written before today has client_ref IS NULL, and SQLite
 * treats NULLs as distinct in a UNIQUE index (they compare unequal even to
 * each other), so the index builds over a full history of unreferenced rows
 * without a single conflict, and unreferenced rows can go on being written by
 * any caller that does not send a key. That is verified rather than assumed —
 * see the "history tolerates the constraint" assertion in
 * e2e/specs/concurrency.spec.mjs.
 *
 * Safe to call on every boot and on every request; the work is done once.
 * ────────────────────────────────────────────────────────────────────────── */
/* Every document a lost reply could post twice.
 *
 * The first three were here from the start — a sale, a refund, a void — on the
 * reasoning that those are the ones that cost money when they are duplicated.
 * That reasoning applies just as squarely to the rest of them, and the shops
 * this runs in are exactly the ones whose network drops mid-save:
 *
 *   - a payment taken twice clears two invoices with one customer's money;
 *   - an expense entered twice doubles a cost on the P&L;
 *   - a purchase bill posted twice puts stock on the shelf that never arrived
 *     and money in the payables that is not owed;
 *   - a debit note, a journal, a quotation — each one a document somebody has
 *     to find and unpick by hand.
 *
 * `journal_entries` is in the list because a hand-keyed journal is the one
 * posting with no document behind it, so a duplicate leaves nothing obvious to
 * notice. It has no firm-scoped uniqueness of its own to lean on.
 */
const IDEMPOTENT_DOCS = [
  { table: "sale_invoices",     index: "ux_sinv_client_ref" },   // POST /api/sales
  { table: "sale_returns",      index: "ux_sret_client_ref" },   // POST /api/returns/credit-notes
  { table: "void_log",          index: "ux_void_client_ref" },   // POST /api/pos/void
  { table: "payments",          index: "ux_pay_client_ref" },    // POST /api/payments
  { table: "expenses",          index: "ux_exp_client_ref" },    // POST /api/expenses
  { table: "purchase_invoices", index: "ux_pinv_client_ref" },   // POST /api/purchases
  { table: "purchase_returns",  index: "ux_pret_client_ref" },   // POST /api/returns/debit-notes
  { table: "journal_entries",   index: "ux_je_client_ref" },     // POST /api/accounting/journal
  { table: "estimates",         index: "ux_est_client_ref" },    // POST /api/estimates
];

let keysEnsured = false;

async function ensureIdempotencyKeys(query) {
  if (keysEnsured) return;
  for (const doc of IDEMPOTENT_DOCS) {
    try {
      const cols = (await query(`PRAGMA table_info(${doc.table})`)).rows;
      if (!cols.length) continue;                       // table not installed on this build
      if (!cols.some((c) => c.name === "client_ref")) {
        await query(`ALTER TABLE ${doc.table} ADD COLUMN client_ref TEXT`);
        console.log(`Added client_ref to ${doc.table}.`);
      }
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS ${doc.index} ON ${doc.table}(firm_id, client_ref)`);
    } catch (e) {
      /* Never let a migration stop the app from starting. Without the index a
         retry can still double-post, so this is loud rather than silent. */
      console.error(`IDEMPOTENCY KEY MISSING on ${doc.table}: ${e.message}`);
      return;                                           // retry on the next call
    }
  }
  keysEnsured = true;
}

module.exports = { billingTables, ensureIdempotencyKeys };
