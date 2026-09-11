/**
 * tenant.tables.js — which tables belong to a company, and how to find them.
 *
 * This file is the most important thing in the per-company backup feature, and
 * it is not the export code.
 *
 * The failure mode that matters here is silent. Somebody adds a table next
 * month, forgets it here, and a shop restores a company that has quietly lost
 * its warranty claims — with no error, no warning, and no way to notice until
 * a customer produces a receipt. `tenant.tables.test.js` walks every table in
 * the live schema and fails the build if one is not named below, so adding a
 * table without deciding what a company backup does with it is a broken test
 * rather than a lost year of claims.
 *
 * ── the four classes ──────────────────────────────────────────────────────
 *
 *   FIRM_SCOPED   has a `firm_id` column. `WHERE firm_id = ?`.
 *   CHILD         reached through a firm-scoped parent, no firm_id of its own.
 *   FIRM_KEYED    firm-scoped by a naming convention rather than a column.
 *   EXCLUDED      deliberately not part of a company, with the reason written.
 *
 * ── what travels, and why ─────────────────────────────────────────────────
 *
 * **Roles and permissions travel. Logins do not.** Restoring a company should
 * not resurrect a sacked cashier's login or revert somebody's password to what
 * it was in March. Roles are the company's own structure; accounts and staff
 * rows are people, and people are not part of a backup.
 *
 * **The audit log travels, and is appended rather than replaced.** An audit log
 * that a restore can roll back is not an audit log — the same argument that put
 * round twelve's restore history in a file outside the database.
 *
 * **Sessions never travel.** A session is a fact about right now.
 */

/* Tables carrying a `firm_id`. Everything a company owns is here unless it is
   named in one of the lists below. */
const FIRM_SCOPED = [
  // ── documents ──
  "sale_invoices", "sale_invoice_lines", "sale_returns", "sale_return_lines",
  "purchase_invoices", "purchase_invoice_lines", "purchase_returns", "purchase_return_lines",
  "purchase_orders", "purchase_order_lines", "estimates", "estimate_lines",
  "challans", "challan_lines",
  // ── money ──
  "payments", "payment_allocations", "expenses",
  "journal_entries", "journal_entry_lines", "account_balances", "chart_of_accounts",
  "cash_movements", "day_closes", "shifts", "void_log",
  // ── stock ──
  "items", "item_stock", "item_barcodes", "item_units", "item_categories",
  "stock_movements", "stock_takes", "stock_take_lines", "item_serials", "repacks",
  // ── people the company deals with ──
  "parties", "party_groups", "party_item_rates",
  // ── configuration the company owns ──
  "firm_settings", "tax_rules", "tax_rates", "price_lists", "price_list_items",
  "roles",
  // ── features ──
  "offers", "loyalty_ledger", "warranties", "warranty_claims",
  "installment_plans", "recurring_docs", "recurring_runs", "boms", "production_runs",
  /* Repeating expenses: rent, wages, power. Carries its own firm_id and
     belongs to the company like any other standing instruction — a business
     restored onto another computer must still know the rent is due on the
     28th, or the first month back silently shows a profit it did not make. */
  "recurring_expenses",
  "held_sales", "tax_filings", "app_updates", "payment_reminders",
];

/* No `firm_id` of their own; reached through a parent that has one. */
const CHILD = {
  role_permissions:    { parent: "roles",              fk: "role_id" },
  bom_components:      { parent: "boms",               fk: "bom_id" },
  production_consumed: { parent: "production_runs",    fk: "run_id" },
  installment_lines:   { parent: "installment_plans",  fk: "plan_id" },
  recurring_lines:     { parent: "recurring_docs",     fk: "recurring_id" },
};

/* Firm-scoped by a key convention rather than a column. `sequences` is keyed
   "INV:firm3", "DC:firm3" — so a company's invoice numbering lives in rows
   whose name ends in `firm<id>`. It has to travel: a restored company that
   started numbering from INV-000001 again would collide with its own history,
   and `UNIQUE(firm_id, invoice_no)` would refuse the sale at the till. */
const FIRM_KEYED = {
  sequences: { column: "name", suffix: (firmId) => `firm${firmId}` },
};

/* Not part of a company. The reason is the point of this list. */
const EXCLUDED = {
  firms: "The company row itself — handled separately, not as content.",
  accounts:
    "People, not company data. A restore must not resurrect a deleted account, " +
    "revert somebody's password, or hand a company's backup the power to change " +
    "who can sign in to the installation.",
  users:
    "Counter staff logins. Same argument as accounts: restoring a company to " +
    "yesterday should not bring back a cashier sacked this morning, nor undo a " +
    "password changed since. Roles and permissions DO travel, so the structure " +
    "returns and the people are re-added.",
  memberships:
    "Who may open which company. An access grant is a decision made now, not " +
    "state to be rolled back — and a backup that could re-grant access would be " +
    "a way to give yourself a company you had been removed from.",
  invitations: "Pending invitations are about now, like memberships.",
  sessions: "A session is a fact about right now. Restoring one would be meaningless.",
  auth_codes:
    "Verification and reset codes. Live for fifteen minutes and belong to an " +
    "address rather than to a company — and a restore that reinstated a spent " +
    "reset code would be a way to hand somebody a second use of it.",
  trusted_devices:
    "Which computers and phones an account has already proved itself on. " +
    "About people and their hardware, not about a company — and a backup that " +
    "could reinstate a trusted device would be a way to restore access from a " +
    "laptop somebody had deliberately revoked.",
  backup_codes:
    "An account's way back in when email fails. A restore that brought back a " +
    "spent code would hand somebody a second use of it, which is the same " +
    "fault as reinstating a used reset code.",
  login_attempts:
    "The sign-in throttle's counters. Restoring a company must not clear an " +
    "attacker's slate, which is the whole reason these moved out of memory.",
  email_outbox:
    "A record of what was sent to whom, across every company on the " +
    "installation. Not this company's data, and rolling it back would lose the " +
    "only evidence of a message somebody is asking about.",
  audit_logs:
    "Travels, but appended rather than replaced — handled outside the ordinary " +
    "table walk. An audit log a restore can roll back is not an audit log.",
  app_settings:
    "Settings that belong to the installation rather than to a company — the " +
    "branch panel's PIN among them. A backup of one business must not be able " +
    "to set or clear the lock on the view over all of them.",
  sqlite_sequence: "SQLite's own AUTOINCREMENT bookkeeping.",
};

/* Appended on import, never deleted on the way in. */
const APPEND_ONLY = { audit_logs: { firmVia: "user" } };

/** Every table this module has an opinion about. */
function classified() {
  return new Set([
    ...FIRM_SCOPED, ...Object.keys(CHILD), ...Object.keys(FIRM_KEYED), ...Object.keys(EXCLUDED),
  ]);
}

/**
 * Tables present in the live schema that nothing above accounts for.
 *
 * Returned rather than thrown, so the test can name them all at once instead of
 * one per run.
 */
function unclassified(liveTableNames) {
  const known = classified();
  return liveTableNames.filter((t) => !known.has(t)).sort();
}

/**
 * Tables named here that the live schema does not have.
 *
 * Just as important as the other direction and easier to forget: a table
 * renamed without updating this file would otherwise be exported as nothing at
 * all, quietly, and the export would still look successful.
 */
function missingFromSchema(liveTableNames) {
  const live = new Set(liveTableNames);
  return [...FIRM_SCOPED, ...Object.keys(CHILD), ...Object.keys(FIRM_KEYED)]
    .filter((t) => !live.has(t)).sort();
}

module.exports = {
  FIRM_SCOPED, CHILD, FIRM_KEYED, EXCLUDED, APPEND_ONLY,
  classified, unclassified, missingFromSchema,
};
