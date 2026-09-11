/**
 * setup.js — idempotent schema bootstrap (blueprint §5.3).
 * Infra + billing + accounting tables, then guarded ALTER migrations.
 */
const { query } = require("./db");
const { billingTables, ensureIdempotencyKeys } = require("./setup.billing");
const { accountingTables, accountingAlters } = require("./setup.accounting");

const infraTables = [
  `CREATE TABLE IF NOT EXISTS users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     username      TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     full_name     TEXT,
     role_id       INTEGER,
     active_firm_id INTEGER,
     status        TEXT DEFAULT 'active',
     created_at    TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS roles (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     firm_id INTEGER,
     name   TEXT NOT NULL,
     is_system INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     role_id  INTEGER NOT NULL,
     module   TEXT NOT NULL,
     action   TEXT NOT NULL,
     UNIQUE(role_id, module, action)
   )`,
  `CREATE TABLE IF NOT EXISTS sequences (
     name  TEXT PRIMARY KEY,
     value INTEGER NOT NULL DEFAULT 0
   )`,
  /* ── Settings that belong to the installation, not to a company ────────
   * `firm_settings` is per company, which is the right home for a currency
   * symbol and the wrong one for the PIN that guards the panel showing every
   * company at once: stored there it would have to live in one of the
   * businesses it protects, and restoring that business would restore or
   * clear the lock on all the others.
   *
   * Never travels in a backup, for the same reason `accounts` does not: it is
   * about who may see what right now.
   */
  `CREATE TABLE IF NOT EXISTS app_settings (
     skey       TEXT PRIMARY KEY,
     svalue     TEXT,
     updated_at TEXT DEFAULT (datetime('now'))
   )`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id    INTEGER,
     module     TEXT,
     action     TEXT,
     entity_id  INTEGER,
     detail     TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,

  /* ────────────────────────────────────────────────────────────────────────
   * IDENTITY — two tiers, deliberately.
   *
   * A shop has an owner with an email address and cashiers who do not. Making
   * every counter staff member hold an email means the owner invents
   * `shop1cashier2@gmail.com`, or — worse, and commonly — shares one login
   * between two counters, which is exactly the case round eleven had to fix
   * with per-till `X-Client-Id` because it corrupts held bills.
   *
   *   accounts      owner / admin / accountant — email + password, verified.
   *                 GLOBAL: one account, many companies.
   *   users         counter staff — username + PIN, created by the owner.
   *                 Per company, and unchanged from what shipped.
   *   memberships   which account may enter which company, in what role.
   *   invitations   the only way a membership is created.
   *
   * `firms` is the company. It already existed and is already the tenant
   * boundary threaded through 56 tables; nothing about that changes.
   * ──────────────────────────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS accounts (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     email           TEXT NOT NULL,
     password_hash   TEXT NOT NULL,
     full_name       TEXT,
     status          TEXT DEFAULT 'active',      -- active | suspended
     email_verified_at TEXT,
     /* Billing, carried from the first migration and read by nothing yet.
        Adding columns to an identity table after real shops depend on it is
        the expensive version of this decision. */
     plan            TEXT DEFAULT 'free',
     plan_status     TEXT DEFAULT 'active',
     company_limit   INTEGER DEFAULT 3,
     trial_ends_at   TEXT,
     created_at      TEXT DEFAULT (datetime('now')),
     last_seen_at    TEXT
   )`,
  /* Case-insensitive, because nobody remembers whether they signed up as
     Sam@ or sam@, and two accounts one capital letter apart is a support call
     that ends in "which one has my books". */
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_email ON accounts(lower(email))`,

  `CREATE TABLE IF NOT EXISTS memberships (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id  INTEGER NOT NULL,
     firm_id     INTEGER NOT NULL,
     role_id     INTEGER,
     is_owner    INTEGER DEFAULT 0,        -- the company's owner, not a role
     status      TEXT DEFAULT 'active',    -- active | revoked
     created_at  TEXT DEFAULT (datetime('now')),
     UNIQUE(account_id, firm_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_memberships_firm ON memberships(firm_id)`,

  `CREATE TABLE IF NOT EXISTS invitations (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     token       TEXT NOT NULL UNIQUE,
     email       TEXT NOT NULL,
     firm_id     INTEGER NOT NULL,
     role_id     INTEGER,
     invited_by  INTEGER,
     expires_at  TEXT NOT NULL,
     accepted_at TEXT,
     created_at  TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_invitations_email ON invitations(lower(email))`,

  /* Refresh tokens are recorded so a session can be ENDED. Without this,
     `signRefresh` mints a token with no server-side record and nothing can
     revoke it: suspending a company or removing somebody's access would take
     effect whenever their token happened to expire, which is not what either
     word means. */
  `CREATE TABLE IF NOT EXISTS sessions (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id  INTEGER,
     user_id     INTEGER,
     jti         TEXT NOT NULL UNIQUE,
     issued_at   TEXT DEFAULT (datetime('now')),
     revoked_at  TEXT
   )`,

  /* ────────────────────────────────────────────────────────────────────────
   * ONBOARDING — codes, throttling and the record of what was sent.
   * ──────────────────────────────────────────────────────────────────────── */

  /* Six-digit codes for verifying an address and for resetting a password.
   *
   * A code, not a link: on Android the verification email frequently opens on
   * a laptop, and a code crosses devices where a deep link does not.
   *
   * The code is stored HASHED. It is a six-digit secret that grants an account
   * — read access to this table on a plaintext design would be read access to
   * every account being created that quarter-hour. `attempts` is what stops
   * a million guesses against a million-to-one secret; `consumed_at` is what
   * makes it single-use. */
  `CREATE TABLE IF NOT EXISTS auth_codes (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     purpose     TEXT NOT NULL,            -- verify | reset
     email       TEXT NOT NULL,
     account_id  INTEGER,
     code_hash   TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     attempts    INTEGER DEFAULT 0,
     consumed_at TEXT,
     created_at  TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_auth_codes_email ON auth_codes(lower(email), purpose)`,

  /* Devices this account has already proved itself on.
   *
   * A code emailed on every single sign-in would be the strongest thing to
   * build and the wrong one: a cashier opening the till at seven in the
   * morning would wait on a mail server, and a shop with no signal could not
   * open at all. So the code is asked for once per device and that device is
   * remembered — which is what actually defends the thing worth defending, a
   * password stolen and used from somewhere else.
   *
   * `token_hash` is SHA-256, not bcrypt, and that is deliberate on both
   * counts. The token is 256 bits from the OS random source, so there is no
   * dictionary to slow an attacker down and nothing for bcrypt's cost factor
   * to buy; and a hash that can be looked up by value is what lets a sign-in
   * find the row in one indexed query rather than bcrypt-comparing every
   * device the account has ever used. The codes people type are a different
   * problem and are hashed differently — see backup_codes below. */
  `CREATE TABLE IF NOT EXISTS trusted_devices (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id   INTEGER NOT NULL,
     token_hash   TEXT NOT NULL,
     label        TEXT,                     -- "Windows · Chrome", for the list
     created_at   TEXT DEFAULT (datetime('now')),
     last_seen_at TEXT,
     expires_at   TEXT NOT NULL,
     revoked_at   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ix_trusted_devices_hash ON trusted_devices(token_hash)`,
  `CREATE INDEX IF NOT EXISTS ix_trusted_devices_acct ON trusted_devices(account_id)`,

  /* The way back in when the email does not arrive.
   *
   * Ten single-use codes, shown once, to be printed and kept where the shop
   * keeps its papers. Without them a mail outage on the provider's side — or a
   * shopkeeper who has changed phone and lost the address — is a business that
   * cannot open its own books, and the support call has no good answer. With
   * them it is an inconvenience.
   *
   * bcrypt here, unlike the device tokens above: these are short enough to be
   * typed off a printed sheet, so the cost factor is doing real work. There
   * are only ten per account, so comparing them all costs nothing. */
  `CREATE TABLE IF NOT EXISTS backup_codes (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id INTEGER NOT NULL,
     code_hash  TEXT NOT NULL,
     used_at    TEXT,
     created_at TEXT DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ix_backup_codes_acct ON backup_codes(account_id)`,

  /* Sign-in attempts, in the database rather than in a Map.
   *
   * `loginThrottle`'s own header predicted this: in-memory counters are the
   * right trade for one process, and each of several processes would see only
   * its own share of an attack. Going online is the condition it named. It is
   * also what makes a restart stop clearing an attacker's slate. */
  `CREATE TABLE IF NOT EXISTS login_attempts (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     kind      TEXT NOT NULL,              -- ip | who
     keyv      TEXT NOT NULL,
     at        INTEGER NOT NULL            -- epoch ms
   )`,
  `CREATE INDEX IF NOT EXISTS ix_login_attempts ON login_attempts(kind, keyv, at)`,

  /* Every message the system tried to send.
   *
   * Not a queue — it is a record. "The code never arrived" is the single most
   * common onboarding support call, and without this the only honest answer is
   * a shrug. With it, somebody can see that the message was accepted by the
   * provider at 14:02, or that it failed with a reason. The code itself is
   * never stored here; the body holds it only when there is no provider
   * configured, which is the development case. */
  `CREATE TABLE IF NOT EXISTS email_outbox (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     to_email    TEXT NOT NULL,
     subject     TEXT,
     purpose     TEXT,
     provider    TEXT,
     status      TEXT DEFAULT 'queued',    -- queued | sent | failed
     error       TEXT,
     body        TEXT,
     created_at  TEXT DEFAULT (datetime('now')),
     sent_at     TEXT
   )`,
];

/**
 * Indexes that only matter once a shop has traded for a while.
 *
 * Each of these was found by timing the real endpoints against a generated
 * two-year shop (`seed-large.js`) rather than by reading the schema. On six
 * invoices every one of them is a rounding error; on a hundred thousand they
 * are the difference between a report and a hang. Measured at 300,000
 * invoices / 5.6M rows, before → after:
 *
 *   GET /api/accounting/integrity      220s → 5.7s
 *   GET /api/reports/stock-summary      42s → 0.4s
 *
 * Why the existing composite indexes did not cover these: nearly every one is
 * a correlated subquery that filters on the *child* key alone —
 * `WHERE s.party_id = p.id`, `WHERE st.item_id = i.id` — with no firm_id in
 * scope. A composite `(firm_id, party_id)` cannot serve a lookup that does not
 * mention firm_id, so SQLite scanned the whole table once per parent row. The
 * single-column indexes below are what those lookups can actually use.
 *
 * They cost disk and insert time; that trade is worth making explicitly. They
 * are invisible against the per-sale write cost, which is dominated by the
 * export in db.js. Measured on that shop the file grew 486 MB → 555 MB, 14%.
 */
const scaleIndexes = [
  /* Customer/supplier balance reconciliation walks invoices per party. */
  `CREATE INDEX IF NOT EXISTS ix_sinv_party_only ON sale_invoices(party_id)`,
  `CREATE INDEX IF NOT EXISTS ix_pinv_party_only ON purchase_invoices(party_id)`,
  /* On-hand per item: item_stock's UNIQUE is (firm_id, item_id, batch_no), so
     the many callers that look up by item_id alone got a full table scan. */
  `CREATE INDEX IF NOT EXISTS ix_item_stock_item ON item_stock(item_id)`,
  /* Per-item sales history: profit margin, item sales, fast/slow moving. */
  `CREATE INDEX IF NOT EXISTS ix_sline_item ON sale_invoice_lines(item_id)`,
  `CREATE INDEX IF NOT EXISTS ix_pline_item ON purchase_invoice_lines(item_id)`,
  `CREATE INDEX IF NOT EXISTS ix_pline_bill ON purchase_invoice_lines(bill_id)`,
  /* Party statements and the payments list. */
  `CREATE INDEX IF NOT EXISTS ix_payments_party ON payments(firm_id, party_id)`,
  `CREATE INDEX IF NOT EXISTS ix_payments_date  ON payments(firm_id, payment_date)`,
  /* The ledger, by date — general ledger, trial balance, day close. */
  `CREATE INDEX IF NOT EXISTS ix_je_date ON journal_entries(firm_id, entry_date)`,
  /* Stock movement report and the item ledger. */
  `CREATE INDEX IF NOT EXISTS ix_stockmove_date ON stock_movements(firm_id, move_date)`,
];

/* Columns added to tables that already ship. Guarded the same way the
   accounting ALTERs are: a duplicate column means the migration has already
   run, which is not an error. */
const infraAlters = [
  /* Links a counter-staff row to the global account that owns it. Every
     `req.user.id` in this application is a `users.id` — audit rows, sales
     reps, held-bill claims — so an account signing in has to resolve to one,
     and this is the link. NULL for staff who have no account, which is most
     of them. */
  `ALTER TABLE users ADD COLUMN account_id INTEGER`,

  /* Which business this account opens when it signs in. NULL means "whichever
     was last used", which is what every installation did before this and is
     still the right answer for somebody with one shop. An owner with four
     spends most days in one of them, and opening the last-used one is right
     until the evening they check another branch — after which every morning
     starts in the wrong shop. */
  `ALTER TABLE accounts ADD COLUMN default_firm_id INTEGER`,

  /* An invitation can be withdrawn. Session 4 shipped the table without this,
     which meant the only way to take back an invitation sent to the wrong
     address was to wait seven days for it to expire. */
  `ALTER TABLE invitations ADD COLUMN revoked_at TEXT`,
  /* Invited as an owner, or as staff on a role. Carried on the invitation
     rather than decided at acceptance, so what the sender chose is what the
     accepter gets. */
  `ALTER TABLE invitations ADD COLUMN is_owner INTEGER DEFAULT 0`,
  `ALTER TABLE invitations ADD COLUMN full_name TEXT`,

  /* Which company this account had open last.
     It used to be read off the account's `users` row (`active_firm_id`). Once
     counter staff live in the company's own database that row cannot be found
     until the company is already chosen — so the thing that chooses has to
     live beside the account. */
  `ALTER TABLE accounts ADD COLUMN last_firm_id INTEGER`,

  /* How counter staff say which shop they are signing in to.
   *
   * A cashier has a username and a PIN and no email address, and once each
   * company keeps its own database (session 4.5) "find the user called james"
   * is a question no single file can answer on an installation hosting more
   * than one shop — and two shops may both employ a James. So the shop is
   * named first, by a short code the owner can write on the counter.
   *
   * It is not a secret and is not treated as one. It is the name of the door,
   * not the key: knowing it gets somebody as far as a username and password
   * prompt, exactly as knowing a company's web address does. */
  `ALTER TABLE firms ADD COLUMN shop_code TEXT`,
];

/* Unique across the installation, case-insensitively — a code that differed
   from another by one capital letter would send somebody's cashier into the
   wrong shop's till. Created after the ALTER, so it is listed here rather than
   with the tables. */
const infraIndexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_firms_shop_code ON firms(lower(shop_code))`,
];

async function setup() {
  for (const ddl of [...infraTables, ...billingTables, ...accountingTables]) await query(ddl);
  for (const alter of infraAlters) {
    try { await query(alter); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  for (const alter of accountingAlters) {
    try { await query(alter); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  /* After the ALTERs: some of these index columns arrive by migration. An
     index over a table or column this build does not have is not a reason to
     refuse to start — the app is correct without it, only slower. */
  for (const ddl of infraIndexes) {
    try { await query(ddl); } catch (e) { console.error(`index skipped: ${e.message}`); }
  }
  await backfillShopCodes();
  for (const ddl of scaleIndexes) {
    try { await query(ddl); } catch (e) { console.error(`index skipped: ${e.message}`); }
  }
  /* The idempotency columns and their unique indexes.
   *
   * These used to be installed lazily, the first time a route that needed one
   * was called — with a note on `idempotency.js` saying setup() was the tidier
   * home. It became more than tidiness when every money document gained a
   * reference: `postJournal` writes `client_ref` on every journal it posts, so
   * a database built by a tool that never serves a request — `seed-large.js`,
   * which runs the schema itself to generate two years of trading — had no
   * such column and died on the first entry. Installed here, every database
   * gets them the moment it exists. */
  try { await ensureIdempotencyKeys(query); } catch (e) { console.error(`idempotency keys: ${e.message}`); }
  await backfillBaseQuantity();
  await backfillReversals();
  await backfillSalesRep();
  await adoptExistingUsers();
  await topUpAdminRoles();
}

/**
 * Grant existing Admin roles the permissions invented since they were seeded.
 *
 * An installation seeded before `companies` existed has an Admin role holding
 * the forty pairs of the old grid. Nothing would ever add the new ones: the
 * roles screen can only tick what the catalogue offers against a role that
 * already has them, and seeding runs once. So the owner of a shop that
 * upgrades would find the Companies screen refusing them by permission —
 * on their own business.
 *
 * Scoped to roles named Admin and marked `is_system`, so a hand-built role
 * called "Manager" that was deliberately given less is left exactly as it is.
 */
/**
 * Give every company that has not got one a shop code.
 *
 * Derived from the name, because a code somebody has to memorise is a code
 * that gets written on a sticky note: "Kampala Hardware" becomes
 * `kampala-hardware`, which a cashier can be told over the phone. A collision
 * gets a numeric suffix rather than a random string, for the same reason.
 *
 * Runs on the central database only — `firms` lives there — and is a no-op on
 * the second boot.
 */
async function backfillShopCodes() {
  try {
    const rows = (await query("SELECT id, name FROM firms WHERE shop_code IS NULL OR shop_code = ''")).rows;
    for (const f of rows) {
      await query("UPDATE firms SET shop_code = ? WHERE id = ?", [await freeShopCode(f.name, f.id), f.id]);
    }
    if (rows.length) console.log(`Shop codes assigned to ${rows.length} compan${rows.length === 1 ? "y" : "ies"}.`);
  } catch (e) {
    /* An older database mid-migration, or a build without the column. Not a
       reason to refuse to start: only email sign-in needs no shop code. */
    console.error("shop codes skipped:", e.message);
  }
}

/** A slug of `name` that no other company is using. */
async function freeShopCode(name, selfId = 0) {
  const root = String(name || "shop").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "shop";
  const taken = async (c) => (await query(
    "SELECT id FROM firms WHERE lower(shop_code) = lower(?) AND id <> ?", [c, selfId])).rows.length > 0;
  if (!await taken(root)) return root;
  for (let i = 2; i < 500; i++) if (!await taken(`${root}-${i}`)) return `${root}-${i}`;
  return `${root}-${selfId}`;
}

async function topUpAdminRoles() {
  try {
    const { everyPair } = require("../shared/provision");
    for (const role of (await query("SELECT id FROM roles WHERE name = 'Admin' AND is_system = 1")).rows) {
      const have = new Set((await query("SELECT module, action FROM role_permissions WHERE role_id = ?", [role.id]))
        .rows.map((r) => `${r.module}.${r.action}`));
      for (const [m, a] of everyPair()) {
        if (have.has(`${m}.${a}`)) continue;
        await query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [role.id, m, a]);
      }
    }
  } catch (e) {
    console.error("admin role top-up skipped:", e.message);
  }
}

/**
 * Give every shop already running an account, and give that account its firm.
 *
 * This is the migration that decides whether an upgrade is uneventful or
 * catastrophic. Every installation in the field today has `users` rows, one
 * `firms` row, and no `accounts` or `memberships` at all. If sign-in starts
 * requiring a membership before those rows exist, **everybody is locked out of
 * their own books by an update they did not ask for.**
 *
 * So: each existing user becomes an account, keeping their username as a local
 * identity, and gets a membership for the firm they were already using. The
 * account's email is left NULL-ish — a placeholder derived from the username,
 * marked unverified — because we do not have their real one and inventing a
 * plausible address would be worse than an obvious placeholder. They can set a
 * real one from Companies once they are in.
 *
 * Existing username+PIN sign-in is untouched, so the shop that upgrades on a
 * Tuesday morning opens the till exactly as it did on Monday.
 *
 * Runs once: the WHERE clauses only match what is missing, so every later
 * start is a no-op.
 */
async function adoptExistingUsers() {
  try {
    const firm = (await query("SELECT id FROM firms ORDER BY id LIMIT 1")).rows[0];
    if (!firm) return;                       // brand-new install; seed.js handles it
    const users = (await query("SELECT * FROM users WHERE status = 'active'")).rows;
    if (!users.length) return;

    for (const u of users) {
      const placeholder = `${u.username}@local.invalid`;
      let acct = (await query("SELECT id FROM accounts WHERE lower(email) = lower(?)", [placeholder])).rows[0];
      if (!acct) {
        await query(
          `INSERT INTO accounts (email, password_hash, full_name, status, email_verified_at)
           VALUES (?,?,?,?,NULL)`,
          [placeholder, u.password_hash, u.full_name || u.username, u.status || "active"]);
        acct = (await query("SELECT id FROM accounts WHERE lower(email) = lower(?)", [placeholder])).rows[0];
      }
      /* Link the staff row to its new account, so signing in by email finds
         the same identity the app has always recorded against. */
      await query("UPDATE users SET account_id = ? WHERE id = ? AND account_id IS NULL", [acct.id, u.id]);

      const firmId = u.active_firm_id || firm.id;
      const has = (await query("SELECT id FROM memberships WHERE account_id = ? AND firm_id = ?",
        [acct.id, firmId])).rows[0];
      if (!has) {
        /* The first user of the existing firm becomes its owner. Somebody has
           to be able to manage the company, and on a single-firm installation
           that has always been whoever set it up. */
        const anyOwner = (await query("SELECT id FROM memberships WHERE firm_id = ? AND is_owner = 1",
          [firmId])).rows[0];
        await query(
          `INSERT INTO memberships (account_id, firm_id, role_id, is_owner, status)
           VALUES (?,?,?,?, 'active')`,
          [acct.id, firmId, u.role_id, anyOwner ? 0 : 1]);
      }
    }
  } catch (e) {
    /* A failed adoption must not stop the app booting — the shop can still
       sign in with username and PIN, which is the path this migration does not
       touch. Loud, though: an installation running without memberships cannot
       reach the Companies screen, and somebody needs to know why. */
    console.error("account adoption skipped:", e.message);
  }
}

/**
 * Backfill sales_rep_id from created_by on rows written before the column
 * existed, so a shop's history doesn't suddenly show every past sale as
 * "unattributed" in the new per-rep reports. Runs once — the WHERE only matches
 * NULLs — and is a no-op on later starts.
 */
async function backfillSalesRep() {
  for (const table of ["sale_invoices", "purchase_invoices"]) {
    try {
      const pending = (await query(`SELECT COUNT(*) c FROM ${table} WHERE sales_rep_id IS NULL`)).rows[0].c;
      if (!pending) continue;
      await query(`UPDATE ${table} SET sales_rep_id = created_by WHERE sales_rep_id IS NULL`);
      console.log(`Backfilled sales_rep_id on ${pending} ${table} row(s).`);
    } catch (e) {
      console.error(`sales_rep backfill skipped for ${table}: ${e.message}`);
    }
  }
}

/**
 * Backfill base_quantity on sale lines written before the column existed.
 *
 * Runs once — the WHERE clause only matches NULLs, so later starts are no-ops.
 * A line was sold in the secondary unit if its stored unit matches the item's
 * secondary_unit; everything else was already in base units. Matching on the
 * unit text is only reliable for history (the column is written directly from
 * now on), and the fallback is the safe one: quantity unchanged, which is what
 * the old code assumed anyway.
 */
/**
 * Mark entries that were already reversed before `reversed_at` existed.
 *
 * Without this, the first void of any document that had ever been amended in
 * an older build would reverse its original entry a second time — the exact
 * fault the column was added to stop, arriving on the upgrade rather than
 * before it.
 *
 * The pairing is by count, not by identity, because nothing recorded which
 * reversal belonged to which entry: for each source, the number of `*_void`
 * entries is the number of reversals that were posted, so that many of its
 * oldest entries are already accounted for. Oldest-first is the right order —
 * reversals are posted in id order by the loop that makes them.
 *
 * Runs once. After it, `reversed_at` is set and the WHERE clause skips them.
 */
async function backfillReversals() {
  try {
    const pending = (await query("SELECT COUNT(*) c FROM journal_entries WHERE reversed_at IS NULL")).rows[0].c;
    if (!pending) return;
    const sources = (await query(
      `SELECT firm_id, source_module, source_id, COUNT(*) n
         FROM journal_entries
        WHERE source_module LIKE '%\_void' ESCAPE '\\' AND source_id IS NOT NULL
        GROUP BY firm_id, source_module, source_id`)).rows;
    let marked = 0;
    for (const v of sources) {
      const origin = v.source_module.replace(/_void$/, "");
      const rows = (await query(
        `SELECT id FROM journal_entries
          WHERE firm_id=? AND source_module=? AND source_id=? AND reversed_at IS NULL
          ORDER BY id LIMIT ?`, [v.firm_id, origin, v.source_id, v.n])).rows;
      for (const r of rows) {
        await query("UPDATE journal_entries SET reversed_at = datetime('now') WHERE id = ?", [r.id]);
        marked++;
      }
    }
    if (marked) console.log(`Marked ${marked} journal entries as already reversed.`);
  } catch (e) {
    /* A database from before the column exists, or one with no journals yet.
       Neither is a reason to refuse to start. */
    if (!/no such column|no such table/i.test(e.message)) throw e;
  }
}

async function backfillBaseQuantity() {
  for (const table of ["sale_invoice_lines", "sale_return_lines"]) {
    try {
      const pending = (await query(`SELECT COUNT(*) c FROM ${table} WHERE base_quantity IS NULL`)).rows[0].c;
      if (!pending) continue;
      await query(
        `UPDATE ${table} SET base_quantity = (
           SELECT CASE
             WHEN i.secondary_unit IS NOT NULL
              AND i.conversion_rate > 0
              AND UPPER(TRIM(COALESCE(${table}.unit,''))) = UPPER(TRIM(i.secondary_unit))
             THEN ${table}.quantity / i.conversion_rate
             ELSE ${table}.quantity END
           FROM items i WHERE i.id = ${table}.item_id)
         WHERE base_quantity IS NULL AND item_id IS NOT NULL`
      );
      // free-text lines with no item behind them
      await query(`UPDATE ${table} SET base_quantity = quantity WHERE base_quantity IS NULL`);
      console.log(`Backfilled base_quantity on ${pending} ${table} row(s).`);
    } catch (e) {
      // never let a migration stop the app from starting
      console.error(`base_quantity backfill skipped for ${table}: ${e.message}`);
    }
  }
}

module.exports = { setup, freeShopCode };
