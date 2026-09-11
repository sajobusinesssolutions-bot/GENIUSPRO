/**
 * router.js — which file a statement belongs in.
 *
 * Going online means one SQLite file per company (ONLINE-ONBOARDING.md, option
 * A). That decision is only half a design; the other half is the question this
 * file answers, on every statement:
 *
 *     does this row live in the company's file, or in the central one?
 *
 * ── the two homes ─────────────────────────────────────────────────────────
 *
 *   TENANT    everything a company owns — its documents, stock, parties,
 *             ledger, settings, roles and its audit log. Taken straight from
 *             `shared/tenant.tables.js`, which a test already holds against
 *             the live schema, so a table added next month cannot quietly
 *             acquire a home by accident.
 *
 *   CENTRAL   identity and the things that span companies: accounts, staff
 *             logins, memberships, invitations, sessions, verification codes,
 *             the sign-in throttle, the outbox — and `firms` itself, because
 *             the list of companies cannot live inside one of them.
 *
 * ── the guard, which is the point of this file ────────────────────────────
 *
 * A statement that names tables from both homes cannot be answered by either
 * file. Today it silently would be: `query()` would hand it to one handle,
 * SQLite would report "no such table", or — far worse for a LEFT JOIN — return
 * rows with the other side blank, and a screen would render the missing half
 * as empty rather than as broken.
 *
 * So a straddling statement **throws, by name**, and says which tables sit on
 * which side. Splitting the storage without this would be the same class of
 * silent failure as round twelve's restore: an operation that reports success
 * and quietly loses half of what it was asked about.
 *
 * `audit()` runs the same classification over every SQL literal in the source
 * tree, so the work list is knowable before a single shop is migrated rather
 * than discovered one 500 at a time.
 */
const { FIRM_SCOPED, CHILD, FIRM_KEYED } = require("../shared/tenant.tables");

/* A company's own tables. `audit_logs` is here rather than in the excluded
   list it sits in for backups: it is keyed by user rather than by firm, but it
   records what happened inside one company, and a hosted installation that
   pooled every shop's audit trail into one file would be handing each shop's
   history to whoever could read another's. */
const TENANT = new Set([
  ...FIRM_SCOPED,
  ...Object.keys(CHILD),
  ...Object.keys(FIRM_KEYED),
  "audit_logs",
  /* Counter staff live with the company they work in.
   *
   * This is the boundary decision the whole split turns on, and the first
   * version got it wrong. Putting `users` in the central file looked right —
   * it is identity, and `login` has to find somebody before a company is
   * known. But a scan of every SQL literal in the tree said otherwise: **33 of
   * the 36 statements that straddled the boundary were one thing**, a
   * company's rows joined to `users` to print who did it. Cashier on a
   * receipt, who held a bill, who voided a line, who counted the stock, the
   * whole sales-rep half of Reports.
   *
   * Splitting 33 reports into two queries each, to stitch a name back on in
   * JavaScript, is 33 chances to render "Unknown" where a person's name
   * belongs. Moving one table moves all of them at once — and it agrees with
   * what the two-tier identity design already said in session 4: an *account*
   * is global and a *staff login* belongs to one shop. It also makes
   * `users.username` unique per company rather than per installation, which is
   * the behaviour a hosted product needs: two shops may both employ a James.
   *
   * What it costs is named in the report: the two sign-in routes that look a
   * person up before a company is known now need the shop identified first. */
  "users",
]);

/* Identity, and everything that spans companies. */
const CENTRAL = new Set([
  "firms",          // the list of companies cannot live inside one of them
  "accounts", "memberships", "invitations", "sessions",
  "auth_codes", "login_attempts", "email_outbox",
  /* The second factor. Both belong to an account, and an account spans every
     company on the installation — an owner of three shops has one set of
     backup codes and one list of trusted devices, not three. Putting them in a
     company's file would mean the sign-in code depended on which shop happened
     to be open, and signing in is what happens before a shop is chosen. */
  "trusted_devices", "backup_codes",
  /* Settings that belong to the installation rather than to any company: the
     branch panel's PIN, each business's own PIN, and where each company's
     cloud copy last got to.
     
     Central for the same reason `firms` is. The panel PIN guards the view over
     every company at once, so it cannot live inside one of them; a business's
     PIN must survive that business being restored, or restoring it would clear
     its own lock; and the cloud marks say "this copy has been sent", which is
     the one fact a restored backup must NOT bring back with it. */
  "app_settings",
]);

/* SQLite's own bookkeeping, present in every file and never named by the app.
   Listed so it is a deliberate absence rather than an oversight. */
const NEITHER = new Set(["sqlite_sequence", "sqlite_master", "sqlite_temp_master"]);

/**
 * The tables a statement names.
 *
 * Deliberately simple: the clause keywords that can be followed by a table
 * name, and the identifier after each. It does not parse SQL, and it does not
 * need to — an alias, a subquery or a CTE still has to name its tables after
 * one of these words. Over-reporting is safe here (an unknown name is
 * reported, not assumed); under-reporting would not be, which is why the
 * keyword list includes every form this codebase uses.
 */
/* `IF NOT EXISTS` and `TEMP` sit between the keyword and the name, and reading
   "IF" as a table name is how `CREATE TABLE IF NOT EXISTS items` came out
   classified as belonging to nowhere in particular. */
const CLAUSE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;

/* `CREATE INDEX … ON <table>` names its table after ON, which is the one place
   ON introduces a table rather than a join condition. Matched separately so
   the general clause list does not have to include ON and start reading join
   aliases as tables. */
const INDEX_ON = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][A-Za-z0-9_]*\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

function tablesIn(sql) {
  const out = new Set();
  const text = String(sql || "")
    /* A template literal reaches the audit as `${...}`; blank it rather than
       let a placeholder be read as a table name. */
    .replace(/\$\{[^}]*\}/g, " ? ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  let m;
  INDEX_ON.lastIndex = 0;
  while ((m = INDEX_ON.exec(text))) {
    const name = m[1].toLowerCase();
    if (!NEITHER.has(name)) out.add(name);
  }
  CLAUSE.lastIndex = 0;
  while ((m = CLAUSE.exec(text))) {
    const name = m[1].toLowerCase();
    if (!NEITHER.has(name)) out.add(name);
  }
  /* Common table expressions name themselves after WITH and are then used
     after FROM, where they look exactly like a table. Remove them so a query
     with a CTE is not reported as touching an unknown table. */
  const withNames = [...String(text).matchAll(/\bWITH\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\b|\)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)]
    .map((x) => (x[1] || x[2] || "").toLowerCase());
  for (const n of withNames) out.delete(n);
  return [...out];
}

const CROSS_HOME = "CROSS_HOME";

/**
 * Where this statement belongs: "central", "tenant", or "none" (it names no
 * table this layer knows — `SELECT 1`, a pragma, a temp table).
 *
 * @throws an Error tagged `code = "CROSS_HOME"` when it straddles.
 */
function homeOf(sql) {
  const named = tablesIn(sql);
  const tenant = named.filter((t) => TENANT.has(t));
  const central = named.filter((t) => CENTRAL.has(t));
  if (tenant.length && central.length) {
    const e = new Error(
      `This statement reads from two different databases and cannot be answered by either: ` +
      `${tenant.join(", ")} live in the company's file, ${central.join(", ")} in the central one. ` +
      `Split it into two queries.`);
    e.code = CROSS_HOME;
    e.tenant = tenant;
    e.central = central;
    return Object.assign({ home: CROSS_HOME, error: e, tenant, central });
  }
  if (tenant.length) return { home: "tenant", tenant, central };
  if (central.length) return { home: "central", tenant, central };
  return { home: "none", tenant, central };
}

/** Every table named anywhere that neither list claims. Feeds the test. */
function unknownTables(sql) {
  return tablesIn(sql).filter((t) => !TENANT.has(t) && !CENTRAL.has(t));
}

module.exports = { homeOf, tablesIn, unknownTables, TENANT, CENTRAL, NEITHER, CROSS_HOME };
