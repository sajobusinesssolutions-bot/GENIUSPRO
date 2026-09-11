/**
 * setup.accounting.js — accounting engine tables + settings + master data.
 * Idempotent CREATE IF NOT EXISTS, firm-scoped. Extends the billing schema.
 */

const accountingTables = [

  /* ── Chart of accounts (double-entry GL) ───────────────────────── */
  `CREATE TABLE IF NOT EXISTS chart_of_accounts (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     code        TEXT    NOT NULL,              -- '1001' cash, '1010' debtors...
     name        TEXT    NOT NULL,
     type        TEXT    NOT NULL,              -- asset | liability | equity | income | expense
     is_cash_bank INTEGER DEFAULT 0,           -- shows in cash/bank list
     is_control  INTEGER DEFAULT 0,            -- system account (debtors/creditors/stock)
     opening_balance REAL DEFAULT 0,
     status      TEXT    DEFAULT 'active',
     UNIQUE(firm_id, code)
   )`,

  `CREATE TABLE IF NOT EXISTS journal_entries (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     entry_no      TEXT    NOT NULL,            -- 'JE-000123'
     entry_date    TEXT    NOT NULL,
     description   TEXT,
     reference     TEXT,
     source_module TEXT,                        -- 'sales' | 'purchases' | 'payments' | 'manual'
     source_id     INTEGER,
     created_by    INTEGER,
     created_at    TEXT    DEFAULT (datetime('now')),
     UNIQUE(firm_id, entry_no)
   )`,
  `CREATE TABLE IF NOT EXISTS journal_entry_lines (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     entry_id    INTEGER NOT NULL,
     account_code TEXT   NOT NULL,
     debit       REAL    DEFAULT 0,
     credit      REAL    DEFAULT 0,
     narration   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ix_jel_entry ON journal_entry_lines(entry_id)`,
  `CREATE INDEX IF NOT EXISTS ix_jel_acct  ON journal_entry_lines(firm_id, account_code)`,

  `CREATE TABLE IF NOT EXISTS account_balances (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     account_code TEXT    NOT NULL,
     balance      REAL    DEFAULT 0,            -- signed: debit positive
     UNIQUE(firm_id, account_code)
   )`,

  /* ── Firm settings: key/value per firm (general/transaction/item/party) ── */
  `CREATE TABLE IF NOT EXISTS firm_settings (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id  INTEGER NOT NULL,
     skey     TEXT    NOT NULL,
     svalue   TEXT,
     UNIQUE(firm_id, skey)
   )`,

  /* ── Master data referenced by item/party setup ────────────────── */
  `CREATE TABLE IF NOT EXISTS item_units (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER NOT NULL,
     name    TEXT NOT NULL,        -- 'Pieces'
     short   TEXT NOT NULL,        -- 'PCS'
     UNIQUE(firm_id, short)
   )`,
  `CREATE TABLE IF NOT EXISTS item_categories (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER NOT NULL,
     name    TEXT NOT NULL,
     UNIQUE(firm_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS party_groups (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER NOT NULL,
     name    TEXT NOT NULL,
     UNIQUE(firm_id, name)
   )`,

  /* ── Configurable tax rules (Uganda chain: WHT 6% deduct, VAT 18% deduct) ── */
  `CREATE TABLE IF NOT EXISTS tax_rules (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     name        TEXT    NOT NULL,           -- 'Income Tax (WHT)', 'VAT'
     rate        REAL    NOT NULL DEFAULT 0, -- percent
     mode        TEXT    NOT NULL DEFAULT 'deduct',  -- deduct | add
     apply_order INTEGER NOT NULL DEFAULT 1, -- applied sequentially on running total
     is_active   INTEGER DEFAULT 1
   )`,

  /* ── Multiple barcodes per item (group same-price flavours) ── */
  `CREATE TABLE IF NOT EXISTS item_barcodes (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER NOT NULL,
     item_id INTEGER NOT NULL,
     barcode TEXT NOT NULL,
     UNIQUE(firm_id, barcode)
   )`,

  /* ── Price lists (retail / wholesale…): absolute price per item ── */
  `CREATE TABLE IF NOT EXISTS price_lists (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER NOT NULL,
     name    TEXT NOT NULL,
     UNIQUE(firm_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS price_list_items (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id  INTEGER NOT NULL,
     list_id  INTEGER NOT NULL,
     item_id  INTEGER NOT NULL,
     price    REAL NOT NULL,
     UNIQUE(firm_id, list_id, item_id)
   )`,

  /* ── Held (parked) POS bills — resumable, lockable ── */
  `CREATE TABLE IF NOT EXISTS held_sales (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id    INTEGER NOT NULL,
     label      TEXT,
     payload    TEXT NOT NULL,           -- JSON: lines, party_id, discounts
     total_hint REAL DEFAULT 0,
     locked     INTEGER DEFAULT 0,
     created_by INTEGER,
     created_at TEXT DEFAULT (datetime('now')),
     /* Who is resuming this bill, and from which till. claimed_by alone was
        not enough: a shop that signs both counters in as the same account had
        two cashiers resume one parked bill and both delete it, so a table's
        order was rung up twice with neither cashier told. claimed_client holds
        the browser's X-Client-Id, so the claim identifies a till rather than a
        login. Declared here so a fresh install has them; pos.routes.js still
        ALTERs them in for databases created before this. */
     claimed_by     INTEGER,
     claimed_at     TEXT,
     claimed_client TEXT
   )`,

  /* ── Void audit trail (Voided items report) ── */
  `CREATE TABLE IF NOT EXISTS item_serials (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     item_id INTEGER,
     serial TEXT,
     status TEXT DEFAULT 'in_stock',
     purchase_id INTEGER,
     sale_id INTEGER,
     party_id INTEGER,
     received_at TEXT DEFAULT CURRENT_TIMESTAMP,
     sold_at TEXT,
     note TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_unique ON item_serials(firm_id, serial)`,
  `CREATE INDEX IF NOT EXISTS idx_serial_item ON item_serials(item_id, status)`,
  `CREATE TABLE IF NOT EXISTS repacks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     reference TEXT,
     from_item_id INTEGER,
     from_qty REAL,
     to_item_id INTEGER,
     to_qty REAL,
     cost_consumed REAL DEFAULT 0,
     extra_cost REAL DEFAULT 0,
     unit_cost_out REAL DEFAULT 0,
     note TEXT,
     created_by INTEGER,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS purchase_orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     po_no TEXT,
     party_id INTEGER,
     order_date TEXT,
     expected_date TEXT,
     status TEXT DEFAULT 'draft',
     note TEXT,
     total REAL DEFAULT 0,
     created_by INTEGER,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS purchase_order_lines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     po_id INTEGER,
     item_id INTEGER,
     quantity REAL DEFAULT 0,
     rate REAL DEFAULT 0,
     received_qty REAL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pol_po ON purchase_order_lines(po_id)`,
  `CREATE TABLE IF NOT EXISTS stock_takes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     reference TEXT,
     scope TEXT,
     status TEXT DEFAULT 'draft',
     note TEXT,
     variance_value REAL DEFAULT 0,
     counted_lines INTEGER DEFAULT 0,
     created_by INTEGER,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP,
     posted_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS stock_take_lines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     take_id INTEGER,
     item_id INTEGER,
     system_qty REAL DEFAULT 0,
     counted_qty REAL,
     unit_cost REAL DEFAULT 0,
     note TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_stl_take ON stock_take_lines(take_id)`,
  `CREATE TABLE IF NOT EXISTS app_updates (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     version_from TEXT,
     version_to TEXT,
     filename TEXT,
     size_bytes INTEGER,
     status TEXT DEFAULT 'applied',
     note TEXT,
     backup_dir TEXT,
     applied_by INTEGER,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS void_log (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id    INTEGER NOT NULL,
     user_id    INTEGER,
     scope      TEXT DEFAULT 'item',     -- item | bill
     item_name  TEXT,
     quantity   REAL DEFAULT 0,
     amount     REAL DEFAULT 0,
     reason     TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,

  /* ── Party-wise item rates (special prices per customer/supplier) ── */
  `CREATE TABLE IF NOT EXISTS party_item_rates (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id  INTEGER NOT NULL,
     party_id INTEGER NOT NULL,
     item_id  INTEGER NOT NULL,
     rate     REAL NOT NULL,
     UNIQUE(firm_id, party_id, item_id)
   )`,

  /* ── Estimates / Quotations & Sale Orders (no stock, no GL until converted) ── */
  `CREATE TABLE IF NOT EXISTS estimates (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     doc_no        TEXT NOT NULL,              -- 'EST-000001' / 'SO-000001'
     doc_type      TEXT NOT NULL DEFAULT 'estimate',  -- estimate | order
     party_id      INTEGER NOT NULL,
     doc_date      TEXT NOT NULL,
     valid_until   TEXT,
     sub_total     REAL DEFAULT 0,
     tax_breakdown TEXT,
     tax_total     REAL DEFAULT 0,
     grand_total   REAL DEFAULT 0,
     status        TEXT DEFAULT 'open',        -- open | converted | cancelled
     converted_invoice_id INTEGER,
     notes         TEXT,
     created_by    INTEGER,
     created_at    TEXT DEFAULT (datetime('now')),
     UNIQUE(firm_id, doc_no)
   )`,
  `CREATE TABLE IF NOT EXISTS estimate_lines (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     estimate_id INTEGER NOT NULL,
     item_id     INTEGER,
     description TEXT,
     quantity    REAL NOT NULL DEFAULT 1,
     rate        REAL NOT NULL DEFAULT 0,
     taxable_value REAL DEFAULT 0,
     line_total  REAL DEFAULT 0
   )`,

  /* ── Returns: credit notes (sale returns) & debit notes (purchase returns) ── */
  `CREATE TABLE IF NOT EXISTS sale_returns (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     note_no      TEXT NOT NULL,               -- 'CN-000123'
     invoice_id   INTEGER,                     -- original invoice (optional)
     party_id     INTEGER NOT NULL,
     return_date  TEXT NOT NULL,
     refund_mode  TEXT DEFAULT 'adjust',       -- adjust (against balance) | cash
     sub_total    REAL DEFAULT 0,
     cgst_total   REAL DEFAULT 0,
     sgst_total   REAL DEFAULT 0,
     igst_total   REAL DEFAULT 0,
     grand_total  REAL DEFAULT 0,
     reason       TEXT,
     created_by   INTEGER,
     created_at   TEXT DEFAULT (datetime('now')),
     UNIQUE(firm_id, note_no)
   )`,
  `CREATE TABLE IF NOT EXISTS sale_return_lines (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     return_id   INTEGER NOT NULL,
     item_id     INTEGER,
     description TEXT,
     hsn_sac     TEXT,
     quantity    REAL NOT NULL DEFAULT 1,
     rate        REAL NOT NULL DEFAULT 0,
     taxable_value REAL DEFAULT 0,
     gst_rate    REAL DEFAULT 0,
     cgst_amt    REAL DEFAULT 0,
     sgst_amt    REAL DEFAULT 0,
     igst_amt    REAL DEFAULT 0,
     line_total  REAL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS purchase_returns (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     note_no      TEXT NOT NULL,               -- 'DN-000123'
     bill_id      INTEGER,
     party_id     INTEGER NOT NULL,
     return_date  TEXT NOT NULL,
     sub_total    REAL DEFAULT 0,
     cgst_total   REAL DEFAULT 0,
     sgst_total   REAL DEFAULT 0,
     igst_total   REAL DEFAULT 0,
     grand_total  REAL DEFAULT 0,
     reason       TEXT,
     created_by   INTEGER,
     created_at   TEXT DEFAULT (datetime('now')),
     UNIQUE(firm_id, note_no)
   )`,
  `CREATE TABLE IF NOT EXISTS purchase_return_lines (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     return_id   INTEGER NOT NULL,
     item_id     INTEGER,
     description TEXT,
     hsn_sac     TEXT,
     quantity    REAL NOT NULL DEFAULT 1,
     rate        REAL NOT NULL DEFAULT 0,
     taxable_value REAL DEFAULT 0,
     gst_rate    REAL DEFAULT 0,
     cgst_amt    REAL DEFAULT 0,
     sgst_amt    REAL DEFAULT 0,
     igst_amt    REAL DEFAULT 0,
     line_total  REAL DEFAULT 0
   )`,

  /* ── Delivery challans (no GL/stock impact until converted) ── */
  `CREATE TABLE IF NOT EXISTS challans (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     challan_no   TEXT NOT NULL,               -- 'DC-000123'
     party_id     INTEGER NOT NULL,
     challan_date TEXT NOT NULL,
     vehicle_no   TEXT,
     notes        TEXT,
     status       TEXT DEFAULT 'open',         -- open | delivered | invoiced
     created_by   INTEGER,
     created_at   TEXT DEFAULT (datetime('now')),
     UNIQUE(firm_id, challan_no)
   )`,
  `CREATE TABLE IF NOT EXISTS challan_lines (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     challan_id  INTEGER NOT NULL,
     item_id     INTEGER,
     description TEXT,
     quantity    REAL NOT NULL DEFAULT 1,
     unit        TEXT
   )`,
];

/* Columns to add to existing tables (guarded ALTERs run from setup.js) */
const accountingAlters = [
  // warranties — cover given on something sold, and claims against it
  `ALTER TABLE items ADD COLUMN warranty_months INTEGER DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS warranties (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id    INTEGER NOT NULL,
     item_id    INTEGER NOT NULL,
     serial     TEXT,                       -- when the item is serialised
     quantity   REAL    DEFAULT 1,          -- when it is not
     party_id   INTEGER,
     invoice_id INTEGER,
     starts_on  TEXT    NOT NULL,
     months     INTEGER NOT NULL,
     expires_on TEXT    NOT NULL,
     status     TEXT    DEFAULT 'active',   -- active | void
     notes      TEXT,
     created_by INTEGER,
     created_at TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS warranty_claims (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     warranty_id  INTEGER NOT NULL,
     claim_date   TEXT    NOT NULL,
     fault        TEXT,
     outcome      TEXT,                     -- repaired | replaced | refunded | rejected
     status       TEXT    DEFAULT 'open',   -- open | closed
     cost         REAL    DEFAULT 0,
     closed_on    TEXT,
     notes        TEXT,
     created_by   INTEGER,
     created_at   TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_warranty_live ON warranties(firm_id, status, expires_on)`,
  `CREATE INDEX IF NOT EXISTS ix_warranty_serial ON warranties(firm_id, serial)`,
  // loyalty — one row per points movement; a balance is the sum of them
  `CREATE TABLE IF NOT EXISTS loyalty_ledger (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id    INTEGER NOT NULL,
     party_id   INTEGER NOT NULL,
     direction  TEXT    NOT NULL,          -- earn | redeem | adjust | expire
     points     REAL    NOT NULL,          -- always positive; direction says which way
     value      REAL    DEFAULT 0,         -- shillings, on redemptions
     doc_table  TEXT,
     doc_id     INTEGER,
     earned_on  TEXT,
     expires_on TEXT,
     note       TEXT,
     created_by INTEGER,
     created_at TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_loyalty_party ON loyalty_ledger(firm_id, party_id, id)`,
  // offers & promotions — discount rules evaluated at billing time
  `CREATE TABLE IF NOT EXISTS offers (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     name        TEXT    NOT NULL,
     scope       TEXT    NOT NULL DEFAULT 'item',   -- item | bill
     offer_type  TEXT    NOT NULL DEFAULT 'percent',-- percent | amount | bxgy
     value       REAL    DEFAULT 0,                 -- % or shillings, by type
     item_id     INTEGER,                           -- item scope: which item
     category    TEXT,                              -- item scope: whole category
     min_qty     REAL    DEFAULT 0,
     min_amount  REAL    DEFAULT 0,
     buy_qty     REAL,                              -- bxgy: buy this many
     get_qty     REAL,                              -- bxgy: get this many free
     starts_on   TEXT,
     ends_on     TEXT,
     priority    INTEGER DEFAULT 0,                 -- lower wins when two clash
     is_active   INTEGER DEFAULT 1,
     notes       TEXT,
     created_by  INTEGER,
     created_at  TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_offers_live ON offers(firm_id, is_active, starts_on, ends_on)`,
  // manufacturing — a recipe (BOM) and the production runs made from it
  `CREATE TABLE IF NOT EXISTS boms (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     name          TEXT    NOT NULL,
     item_id       INTEGER NOT NULL,          -- what this recipe produces
     output_qty    REAL    DEFAULT 1,         -- how many it yields per batch
     labour_cost   REAL    DEFAULT 0,
     overhead_cost REAL    DEFAULT 0,
     notes         TEXT,
     is_active     INTEGER DEFAULT 1,
     created_by    INTEGER,
     created_at    TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS bom_components (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     bom_id   INTEGER NOT NULL,
     item_id  INTEGER NOT NULL,
     quantity REAL    NOT NULL DEFAULT 1,
     note     TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS production_runs (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id         INTEGER NOT NULL,
     reference       TEXT,
     bom_id          INTEGER,
     item_id         INTEGER NOT NULL,
     quantity        REAL    NOT NULL,
     cost_components REAL    DEFAULT 0,
     cost_labour     REAL    DEFAULT 0,
     cost_overhead   REAL    DEFAULT 0,
     unit_cost       REAL    DEFAULT 0,
     run_date        TEXT,
     note            TEXT,
     created_by      INTEGER,
     created_at      TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS production_consumed (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id    INTEGER NOT NULL,
     item_id   INTEGER NOT NULL,
     quantity  REAL,
     unit_cost REAL,
     cost      REAL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_bom_item ON boms(firm_id, item_id, is_active)`,
  // installment plans — a payment timetable laid over a credit invoice
  `CREATE TABLE IF NOT EXISTS installment_plans (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     invoice_id   INTEGER NOT NULL,
     party_id     INTEGER NOT NULL,
     plan_total   REAL    NOT NULL,
     down_payment REAL    DEFAULT 0,
     count_n      INTEGER NOT NULL,
     frequency    TEXT    DEFAULT 'monthly',
     interval_n   INTEGER DEFAULT 1,
     start_date   TEXT    NOT NULL,
     status       TEXT    DEFAULT 'active',   -- active | cancelled
     notes        TEXT,
     created_by   INTEGER,
     created_at   TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS installment_lines (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id   INTEGER NOT NULL,
     seq       INTEGER NOT NULL,
     due_date  TEXT    NOT NULL,
     amount    REAL    NOT NULL,
     label     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ix_installment_inv ON installment_plans(firm_id, invoice_id, status)`,
  // recurring documents — a saved template plus its schedule
  `CREATE TABLE IF NOT EXISTS recurring_docs (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id       INTEGER NOT NULL,
     name          TEXT    NOT NULL,
     doc_type      TEXT    NOT NULL DEFAULT 'sale',   -- sale | purchase
     party_id      INTEGER NOT NULL,
     payment_type  TEXT    DEFAULT 'credit',          -- cash | credit
     sales_rep_id  INTEGER,
     frequency     TEXT    NOT NULL DEFAULT 'monthly',-- daily | weekly | monthly | yearly
     interval_n    INTEGER DEFAULT 1,                 -- every N periods
     start_date    TEXT    NOT NULL,
     next_run      TEXT,                              -- NULL once ended
     end_type      TEXT    DEFAULT 'never',           -- never | count | until
     end_count     INTEGER,
     end_until     TEXT,
     generated     INTEGER DEFAULT 0,
     last_run      TEXT,
     auto_generate INTEGER DEFAULT 1,                 -- 0 = only on demand
     status        TEXT    DEFAULT 'active',          -- active | paused | ended
     notes         TEXT,
     created_by    INTEGER,
     created_at    TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS recurring_lines (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     recurring_id INTEGER NOT NULL,
     item_id      INTEGER,
     description  TEXT,
     quantity     REAL DEFAULT 1,
     rate         REAL DEFAULT 0,
     discount_pct REAL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS recurring_runs (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     recurring_id INTEGER NOT NULL,
     run_date     TEXT,
     doc_table    TEXT,
     doc_id       INTEGER,
     doc_no       TEXT,
     status       TEXT,                               -- created | failed
     message      TEXT,
     created_at   TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_recurring_next ON recurring_docs(firm_id, status, next_run)`,

  /* ── Repeating expenses ─────────────────────────────────────────────────
   *
   * Rent, wages, power and the internet bill are the same amount on the same
   * day every month, and until now every one of them had to be typed in by
   * hand — which means the month somebody is busy is the month the books show
   * a profit the shop did not make.
   *
   * A table of its own rather than a row in `recurring_docs`: that table
   * requires a party (an expense often has none), and carries item lines,
   * which an expense does not have at all. Sharing it would have meant a
   * NOT NULL party_id filled with a placeholder and a lines table left empty
   * — two lies to save one table.
   */
  `CREATE TABLE IF NOT EXISTS recurring_expenses (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id           INTEGER NOT NULL,
     name              TEXT    NOT NULL,             -- 'Shop rent', 'MTN internet'
     category          TEXT,
     party_id          INTEGER,                      -- optional: the landlord, the supplier
     amount            REAL    NOT NULL,
     tax_amount        REAL    DEFAULT 0,
     mode              TEXT    DEFAULT 'cash',
     cash_account_code TEXT,
     notes             TEXT,
     frequency         TEXT    NOT NULL DEFAULT 'monthly',  -- daily | weekly | monthly | yearly
     interval_n        INTEGER DEFAULT 1,            -- every N periods
     start_date        TEXT    NOT NULL,
     next_run          TEXT,                         -- NULL once ended
     end_until         TEXT,                         -- stop after this date, NULL = never
     auto              INTEGER DEFAULT 1,            -- 0 = only when asked
     status            TEXT    DEFAULT 'active',     -- active | paused | ended
     generated         INTEGER DEFAULT 0,
     last_run          TEXT,
     created_by        INTEGER,
     created_at        TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_recexp_next ON recurring_expenses(firm_id, status, next_run)`,
  /* Which schedule raised which expense. Without it a repeated expense is
     indistinguishable from one somebody typed, and "did the rent go in twice
     this month?" has no answer. */
  `ALTER TABLE expenses ADD COLUMN recurring_id INTEGER`,
  // payments: Zoho-style fields — bank charges, withheld tax, deposit account, draft state
  `ALTER TABLE payments ADD COLUMN bank_charges REAL DEFAULT 0`,
  `ALTER TABLE payments ADD COLUMN tax_deducted REAL DEFAULT 0`,
  `ALTER TABLE payments ADD COLUMN deposit_code TEXT`,
  `ALTER TABLE payments ADD COLUMN received_on TEXT`,
  `ALTER TABLE payments ADD COLUMN status TEXT DEFAULT 'paid'`,
  // sales: cash vs credit + which cash/bank account received the money
  /* A real edit rewrites the invoice in place, so the document has to be able
     to say it was changed and how often — otherwise a corrected total is
     indistinguishable from an original one. */
  `ALTER TABLE sale_invoices ADD COLUMN edited_at TEXT`,
  `ALTER TABLE sale_invoices ADD COLUMN edit_count INTEGER DEFAULT 0`,
  `ALTER TABLE sale_invoices ADD COLUMN payment_type TEXT DEFAULT 'credit'`,
  `ALTER TABLE sale_invoices ADD COLUMN cash_account_code TEXT`,
  // items: richer item-setup fields
  `ALTER TABLE items ADD COLUMN category_id INTEGER`,
  `ALTER TABLE items ADD COLUMN wholesale_price REAL DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN mrp REAL DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN description TEXT`,
  // parties: richer party-setup fields
  `ALTER TABLE parties ADD COLUMN group_id INTEGER`,
  // purchase lines: rate snapshot (parity with sale lines)
  `ALTER TABLE purchase_invoice_lines ADD COLUMN gst_rate REAL DEFAULT 0`,
  // Uganda tax chain persisted per document: JSON breakdown + total levied
  `ALTER TABLE sale_invoices ADD COLUMN tax_breakdown TEXT`,
  `ALTER TABLE sale_invoices ADD COLUMN tax_total REAL DEFAULT 0`,
  `ALTER TABLE purchase_invoices ADD COLUMN tax_breakdown TEXT`,
  `ALTER TABLE purchase_invoices ADD COLUMN tax_total REAL DEFAULT 0`,
  `ALTER TABLE sale_returns ADD COLUMN tax_breakdown TEXT`,
  `ALTER TABLE sale_returns ADD COLUMN tax_total REAL DEFAULT 0`,
  `ALTER TABLE purchase_returns ADD COLUMN tax_breakdown TEXT`,
  `ALTER TABLE purchase_returns ADD COLUMN tax_total REAL DEFAULT 0`,
  // Aronium-style item controls + pricing metadata
  `ALTER TABLE items ADD COLUMN markup_pct REAL DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN price_change_allowed INTEGER DEFAULT 1`,
  `ALTER TABLE items ADD COLUMN is_active INTEGER DEFAULT 1`,
  `ALTER TABLE items ADD COLUMN color TEXT`,
  `ALTER TABLE items ADD COLUMN default_qty REAL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS day_closes (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     close_date  TEXT NOT NULL,
     scope       TEXT NOT NULL,
     user_id     INTEGER,
     totals_json TEXT NOT NULL,
     created_at  TEXT DEFAULT (datetime('now'))
   )`,
  /* A cashier's till session. Opened with a starting float, closed with the
     cash physically counted; the app works out what SHOULD be there and the
     variance. One user has at most one 'open' shift at a time (enforced in the
     route, not the schema, so a stuck row can still be force-closed). */
  `CREATE TABLE IF NOT EXISTS shifts (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id        INTEGER NOT NULL,
     user_id        INTEGER NOT NULL,       -- whose shift
     opened_by      INTEGER,                -- who opened it (usually the same)
     closed_by      INTEGER,                -- who closed it (a manager may)
     opened_at      TEXT DEFAULT (datetime('now')),
     closed_at      TEXT,
     opening_float  REAL DEFAULT 0,         -- cash in the drawer at start
     counted_cash   REAL,                   -- cash physically counted at close
     expected_cash  REAL,                   -- float + cash sales − cash paid out (computed at close)
     variance       REAL,                   -- counted − expected
     open_note      TEXT,
     close_note     TEXT,
     status         TEXT DEFAULT 'open'     -- open | closed
   )`,
  `CREATE INDEX IF NOT EXISTS ix_shifts_open ON shifts(firm_id, user_id, status)`,
  `ALTER TABLE parties ADD COLUMN price_list_id INTEGER`,
  // batch expiry tracking (FEFO: first-expiry-first-out on sales)
  `ALTER TABLE item_stock ADD COLUMN expiry_date TEXT`,
  `ALTER TABLE purchase_invoice_lines ADD COLUMN expiry_date TEXT`,
  // unit conversion: 1 <base unit> = conversion_rate <secondary_unit> (e.g. 1 BAG = 50 KG)
  `ALTER TABLE items ADD COLUMN secondary_unit TEXT`,
  `ALTER TABLE items ADD COLUMN conversion_rate REAL DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN secondary_price REAL DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN track_serials INTEGER DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN image TEXT`,
  `ALTER TABLE items ADD COLUMN sales_account_code TEXT`,
  `ALTER TABLE items ADD COLUMN cogs_account_code TEXT`,
  `ALTER TABLE parties ADD COLUMN account_code TEXT`,
  `ALTER TABLE purchase_invoices ADD COLUMN po_id INTEGER`,
  `ALTER TABLE purchase_invoices ADD COLUMN landed_costs TEXT`,
  `ALTER TABLE purchase_invoices ADD COLUMN landed_total REAL DEFAULT 0`,
  // users: richer profile
  `ALTER TABLE users ADD COLUMN email TEXT`,
  `ALTER TABLE users ADD COLUMN phone TEXT`,
  /* A PIN for signing in at a counter. Hashed like a password — a four-digit
     number is weak enough already without storing it in the clear. */
  `ALTER TABLE users ADD COLUMN pin_hash TEXT`,
  /* Dual-unit costing.
     A sale line stores quantity in the unit it was SOLD in (10 KG), while
     items.purchase_price is per BASE unit (35,000 per BAG). Every profit report
     multiplied one by the other, so selling 10 KG of a 50 KG bag was costed as
     10 whole bags — a 340,000 "loss" on a profitable sale. The stock ledger
     always converted correctly, so this never touched the books; it corrupted
     the reports only. base_quantity is that conversion, written once at save
     time, so nothing downstream has to guess. */
  `ALTER TABLE sale_invoice_lines ADD COLUMN base_quantity REAL`,
  `ALTER TABLE sale_return_lines ADD COLUMN base_quantity REAL`,
  /* Sales rep — who the sale is CREDITED to, which is not always who typed it.
     A cashier at the till can attribute a sale to the waiter or floor staff who
     actually made it. created_by still records the operator for the audit
     trail; sales_rep_id drives commission and the per-rep reports. Nullable,
     backfilled from created_by so existing sales stay attributed. */
  `ALTER TABLE sale_invoices ADD COLUMN sales_rep_id INTEGER`,
  `ALTER TABLE purchase_invoices ADD COLUMN sales_rep_id INTEGER`,
  /* A category carries a colour so the Items screen can dot each row with it,
     as the design does. Null means "not chosen yet" — the UI falls back to a
     stable colour derived from the name, so nothing is ever colourless. */
  `ALTER TABLE item_categories ADD COLUMN color TEXT`,

  /* A stock count now records WHY it differed and where the write-off was
     posted. Without these every count landed in one bucket, so "the shop is
     losing stock" and "somebody keyed a delivery wrong" were indistinguishable
     after the fact. */
  `ALTER TABLE stock_takes ADD COLUMN reason TEXT`,
  `ALTER TABLE stock_takes ADD COLUMN post_account TEXT`,

  /* Commission is a rate per person, not a number typed into a report each
     time. A report parameter cannot be paid out, cannot be audited, and is
     gone the moment the page closes. NULL means "use the shop default". */
  `ALTER TABLE users ADD COLUMN commission_pct REAL`,
  /* Rostered hours, so "late" and "absent" mean something. Without a rostered
     start there is nothing to be late for. */
  `ALTER TABLE users ADD COLUMN roster_start TEXT`,
  `ALTER TABLE users ADD COLUMN roster_end TEXT`,

  /* ── Tax & URA ────────────────────────────────────────────────────────
   * What was filed, and when. Without this, "filed on time" is something a
   * shop remembers rather than something the app can show — and a penalty is
   * usually the first reminder that a memory was wrong.
   */
  `CREATE TABLE IF NOT EXISTS tax_filings (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id      INTEGER NOT NULL,
     tax_type     TEXT    NOT NULL,             -- vat | wht | paye | other
     period       TEXT    NOT NULL,             -- 'YYYY-MM'
     due_date     TEXT,
     filed_date   TEXT,
     amount       REAL    DEFAULT 0,
     paid_amount  REAL    DEFAULT 0,
     reference    TEXT,                         -- URA acknowledgement number
     note         TEXT,
     created_by   INTEGER,
     created_at   TEXT    DEFAULT (datetime('now')),
     UNIQUE(firm_id, tax_type, period)
   )`,

  /* Fiscalisation state per invoice. This app does not talk to EFRIS — it
   * records what happened there, so the two can be reconciled and a missing
   * fiscal number is visible before URA asks about it. */
  /* pending | sent | rejected | exempt */
  `ALTER TABLE sale_invoices ADD COLUMN efris_status TEXT`,
  /* the fiscal document number EFRIS returns */
  `ALTER TABLE sale_invoices ADD COLUMN efris_fdn TEXT`,
  `ALTER TABLE sale_invoices ADD COLUMN efris_at TEXT`,
  `ALTER TABLE sale_invoices ADD COLUMN efris_note TEXT`,
  `CREATE INDEX IF NOT EXISTS ix_efris ON sale_invoices(firm_id, efris_status)`,

  /* cash_movements — money into or out of the till drawer that is not a sale
   * and not a supplier payment: the opening float, an owner top-up, a run to
   * the bank, fuel for a delivery.
   *
   * These have to exist as their own thing. Expected cash was previously
   * "float + cash sales − payments out − expenses", which has no term for
   * money handed INTO the drawer mid-shift, so a float top-up made the till
   * read as over at close every time. */
  `CREATE TABLE IF NOT EXISTS cash_movements (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id     INTEGER NOT NULL,
     user_id     INTEGER NOT NULL,
     direction   TEXT    NOT NULL,          -- in | out
     amount      REAL    NOT NULL,
     reason      TEXT    NOT NULL,
     note        TEXT,
     created_at  TEXT    DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_cashmove ON cash_movements(firm_id, user_id, created_at)`,

  /* Cash or bank, stated instead of guessed.
   *
   * `is_cash_bank` says an account holds money; it does not say whether that
   * money is in a drawer or at a bank, and the Cash & bank tiles have to group
   * the two separately. Until now they were told apart by a regex on the name
   * (/cash|till|drawer|petty|float|safe/), which puts "Cash at Stanbic" in the
   * drawer and an account somebody named "Front counter" at the bank.
   *
   * Left NULL on purpose rather than backfilled. NULL means "nobody has said",
   * and money.routes.js falls back to the old name test for exactly those
   * rows — so every account in a database that predates this column keeps the
   * grouping it had this morning. Only accounts saved through the editor from
   * now on carry a stored answer. */
  `ALTER TABLE chart_of_accounts ADD COLUMN kind TEXT`,

  /* ── Vouchers that could be written but never corrected ────────────────
   *
   * Expenses, payments, credit and debit notes, challans and manual journals
   * could all be created and none of them could be changed or cancelled. The
   * only remedy for a mistyped expense was a second, opposite expense — which
   * leaves two wrong documents on the P&L instead of one, and no way to tell
   * a correction from a real payment.
   *
   * A posted voucher is never deleted. It is VOIDED: its journal is reversed,
   * its side effects are unwound, and the document stays in the book saying
   * so. That is what these columns are for. Editing is the same operation
   * followed by a re-post under the SAME document number, so a corrected
   * expense keeps the reference somebody wrote on the paper receipt — with
   * `edit_count` so a changed document can never be mistaken for an original.
   *
   * `status` defaults to the posted state rather than NULL, so every row that
   * already exists reads as live without a backfill pass.
   */
  `ALTER TABLE expenses ADD COLUMN status TEXT DEFAULT 'posted'`,
  `ALTER TABLE expenses ADD COLUMN void_reason TEXT`,
  `ALTER TABLE expenses ADD COLUMN voided_at TEXT`,
  `ALTER TABLE expenses ADD COLUMN edited_at TEXT`,
  `ALTER TABLE expenses ADD COLUMN edit_count INTEGER DEFAULT 0`,
  `ALTER TABLE expenses ADD COLUMN cash_account_code TEXT`,

  `ALTER TABLE payments ADD COLUMN void_reason TEXT`,
  `ALTER TABLE payments ADD COLUMN voided_at TEXT`,
  `ALTER TABLE payments ADD COLUMN edited_at TEXT`,
  `ALTER TABLE payments ADD COLUMN edit_count INTEGER DEFAULT 0`,

  `ALTER TABLE sale_returns ADD COLUMN status TEXT DEFAULT 'posted'`,
  `ALTER TABLE sale_returns ADD COLUMN void_reason TEXT`,
  `ALTER TABLE sale_returns ADD COLUMN voided_at TEXT`,
  `ALTER TABLE purchase_returns ADD COLUMN status TEXT DEFAULT 'posted'`,
  `ALTER TABLE purchase_returns ADD COLUMN void_reason TEXT`,
  `ALTER TABLE purchase_returns ADD COLUMN voided_at TEXT`,

  /* Journals made by hand are the one voucher with no document behind them,
     so they carry their own edit trail on the entry itself. */
  `ALTER TABLE journal_entries ADD COLUMN edited_at TEXT`,
  `ALTER TABLE journal_entries ADD COLUMN edit_count INTEGER DEFAULT 0`,

  /* Stamped the moment an entry is reversed, so it cannot be reversed twice.
     See the long note on reverseJournal in shared/accounting.poster.js: an
     amended document leaves an already-reversed entry filed under the same
     source, and voiding it later reversed that entry a second time. The books
     still balanced — a double reversal is two balanced entries — so nothing
     caught it. */
  `ALTER TABLE journal_entries ADD COLUMN reversed_at TEXT`,
  `CREATE INDEX IF NOT EXISTS ix_journal_source ON journal_entries(firm_id, source_module, source_id)`,
];

module.exports = { accountingTables, accountingAlters };
