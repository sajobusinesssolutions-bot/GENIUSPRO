/**
 * companies.routes.js — many businesses on one installation.
 *
 * The tenant boundary already existed: `firms` is the company, `firm_id` is
 * threaded through 56 tables, and round nine hardened every one of them
 * against a genuine second tenant attacking over HTTP. What was missing was
 * everything a person needs — a list, a switcher, a way to create one, and a
 * way to say who may open which.
 *
 * ── the rules this file exists to hold ────────────────────────────────────
 *
 * **Access is a membership, never a claim in a token.** `verifyToken` re-reads
 * the membership and the company's status on every request, so revoking access
 * or suspending a business bites on the next request rather than whenever a
 * token happens to expire. That is the difference between "suspended" and
 * "suspended in up to two hours".
 *
 * **A company is created whole or not at all.** `provisionFirm` writes the
 * chart of accounts, the roles, the units and the walk-in customer inside the
 * same transaction as the firm row. A firm with no chart of accounts cannot
 * post a sale and cannot be repaired from the interface.
 *
 * **Deleting is the dangerous one**, and it is guarded four ways: the name must
 * be typed back, it cannot be the last company, it cannot be the caller's only
 * company, and it takes a full export first — which lands in session 5.
 */
const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const bcrypt = require("bcryptjs");
const { verifyToken, requirePermission, requireOwner, revokeSessions } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");

/* ── Who may do the irreversible things to a business ──────────────────────
 *
 * Suspend, delete, empty, edit, copy, restore, lock. Every one of these either
 * ends a business or ends a day's trading in it, and a `companies` permission
 * on its own was too blunt a key for that: a role could be given "companies:
 * edit" so that a supervisor could rename a branch, and the same tick handed
 * them Restore — which replaces the books wholesale — and the panel PIN, which
 * locks the owner out of their own figures.
 *
 * So these need BOTH: the permission, and being the owner or an administrator.
 * `requireOwner` is the existing name for exactly that pair (the owner, who is
 * never blockable in their own business, or somebody trusted with settings —
 * which is what an admin is here). Composing rather than replacing means a
 * role that was never given `companies` at all still cannot reach these, and
 * nothing about the ordinary screens changes.
 */
const adminOnly = (action) => [requirePermission("companies", action), requireOwner];
/* Every transaction on this screen is a central one: the rows it writes —
   companies, who may open them, invitations to them — are the installation's,
   not any one company's. The company's own database is touched only by
   `audit()` and by provisioning, both of which say so. */
const centralDurable = (next, fn) => durable(next, fn, { central: true });
const { provisionFirm } = require("../../shared/provision");
const licence = require("../licence/licence.service");
const express_ = require("express");
const fs = require("fs");
const path = require("path");
const backups = require("../system/backup.service");
const fresh = require("../system/startfresh.service");
const AdmZip = require("adm-zip");
const { exportFirm } = require("../system/firmexport.service");
const { inspect, restoreFirm } = require("../system/firmrestore.service");
const { sendEmail, emailConfigured } = require("../../shared/email");
const { newInvitationToken, EMAIL_RE } = require("../auth/onboarding.routes");
const tenancy = require("../../database/tenancy");
const { ensureLocalUser } = require("../../shared/localuser");

router.use(verifyToken);

/* The lower of what the account allows and what the licence was sold for.
   An unlicensed installation falls back to the account's own column, so a
   shop that has not typed a key yet is not silently reduced to one. */
function businessCap(acct) {
  const own = Number(acct && acct.company_limit) || 3;
  const plan = licence.limit("businesses", own);
  return Math.max(1, Math.min(own, plan));
}

/* Every firm-scoped table, for the delete path. Kept as one list rather than
   discovered at runtime so that adding a table without deciding what deleting
   a company does to it breaks a test rather than silently orphaning rows. */
const FIRM_TABLES = [
  "sale_invoice_lines", "sale_invoices", "sale_return_lines", "sale_returns",
  "purchase_invoice_lines", "purchase_invoices", "purchase_return_lines", "purchase_returns",
  "challan_lines", "challans", "estimate_lines", "estimates",
  "payment_allocations", "payments", "expenses", "journal_entry_lines", "journal_entries",
  "account_balances", "chart_of_accounts", "stock_movements", "item_stock", "item_barcodes",
  "items", "item_units", "item_categories", "parties", "party_groups",
  "price_list_items", "price_lists", "tax_rules", "tax_rates", "firm_settings",
  "held_sales", "sequences",
];

/**
 * Record something in the company's audit log.
 *
 * Split out because it is the one write on this screen that belongs to the
 * *company's* database while everything else here — firms, memberships,
 * invitations — belongs to the central one. Called after the transaction
 * commits, never inside it: the two cannot commit together, and pretending
 * they can is the failure this whole boundary exists to prevent.
 *
 * The cost is honest and small: a crash in the moment between the commit and
 * this line loses the audit entry for a change that did happen. That is the
 * right way round — an audit entry for a change that did not happen would be
 * worse.
 */
async function audit(firmId, userId, action, entityId, detail = "") {
  try {
    await tenancy.withFirm(firmId, async () =>
      await query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
        [userId, "companies", action, entityId, detail]));
  } catch (e) {
    /* Never fail the operation because its audit row could not be written —
       but never let it pass unnoticed either. */
    console.error(`companies: could not write the audit entry for ${action} on firm ${firmId}: ${e.message}`);
  }
}

/** A role's name, looked up in the company's own file. */
async function roleName(roleId) {
  if (!roleId) return null;
  const r = (await query("SELECT name FROM roles WHERE id = ?", [roleId])).rows[0];
  return r ? r.name : null;
}

/** The membership this account holds for a company, if any. */
async function membership(accountId, firmId) {
  if (!accountId) return null;
  return (await query("SELECT * FROM memberships WHERE account_id = ? AND firm_id = ?", [accountId, firmId])).rows[0] || null;
}

/* ── The list ─────────────────────────────────────────────────────────────
 *
 * Only companies this account may enter. An admin does not get to see every
 * company on the installation by virtue of being an admin *somewhere* — being
 * an administrator of shop A says nothing about shop B, and a list that showed
 * B's name and turnover to A's manager would be the same cross-tenant leak
 * round nine spent a round closing, dressed as a feature.
 */
router.get("/", requirePermission("companies", "view"), async (req, res) => {
  if (!req.user.acct) {
    /* Counter staff belong to one company and have no switcher. Returning it
       alone is more useful than an empty list plus an explanation. */
    const f = (await query("SELECT id, name, status FROM firms WHERE id = ?", [req.user.firm_id])).rows[0];
    return res.success({ companies: f ? [{ ...f, is_owner: 0, active: true }] : [], can_create: false });
  }
  const rows = (await query(
    `SELECT f.id, f.name, f.legal_name, f.gstin, f.address, f.phone, f.email,
            f.invoice_prefix, f.shop_code, f.status, f.created_at,
            m.is_owner, m.status AS access,
            (SELECT COUNT(*) FROM memberships x WHERE x.firm_id = f.id AND x.status = 'active') AS people
       FROM memberships m JOIN firms f ON f.id = m.firm_id
      WHERE m.account_id = ? AND m.status = 'active'
      ORDER BY f.name`, [req.user.acct])).rows;
  const acct = (await query("SELECT company_limit, default_firm_id FROM accounts WHERE id = ?",
    [req.user.acct])).rows[0] || {};
  /* Two ceilings, and the lower one wins. `company_limit` is the account's own
     (an installation may want fewer than the plan allows); the licence's is
     what was paid for. Before this, the column was "a plan column nothing
     charges for yet" — now the plan charges for it. */
  const cap = businessCap(acct);
  /* A loop rather than .map(): reading each company's PIN is a database call
     now, and an async callback handed to .map() returns an array of promises
     that nothing here would wait for — every padlock would draw open. */
  const companies = [];
  for (const r of rows) {
    companies.push({
      ...r,
      active: r.id === req.user.firm_id,
      is_default: r.id === (acct.default_firm_id || 0),
      /* Whether it asks for a PIN, never the PIN itself. The screen needs to
         draw a padlock and offer to change it; nothing about the hash belongs
         in a reply. */
      locked: !!await firmPinHash(r.id),
    });
  }
  res.success({
    companies,
    default_firm_id: acct.default_firm_id || null,
    can_create: rows.length < cap,
    company_limit: cap,
    /* so the screen can say *why* it is capped rather than only that it is */
    plan: (licence.status(0).licence || {}).planName || null,
  });
});

/* ── Switch the active company ─────────────────────────────────────────────
 *
 * Not wrapped in `durable()`, and that is a consequence of the storage split
 * rather than a shortcut. Switching writes to three places: the account's
 * "last company" in the central file, and a staff row in each of two different
 * companies' files. No transaction reaches across two SQLite files, and
 * pretending otherwise by opening one on the company being left would silently
 * cover the write to the company being entered.
 *
 * So the writes are ordered so that a crash between any two of them leaves
 * something harmless: the staff row in the target company (creating it twice
 * is impossible — it is keyed by account), then the pointer on the account,
 * and only then a session that names the new company. A crash before the last
 * step leaves the shopkeeper signed into the company they were already in.
 */
router.post("/switch", requirePermission("companies", "view"), async (req, res) => {
  const firmId = Number((req.body || {}).firm_id);
  const mem = await membership(req.user.acct, firmId);
  /* 404, not 403. A membership that does not exist and a company that does not
     exist must answer the same way, or the reply confirms which other
     businesses are on this installation. */
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  const firm = (await query("SELECT id, name, status FROM firms WHERE id = ?", [firmId])).rows[0];
  if (!firm) return res.notFound("Business not found");
  if (firm.status !== "active") return res.fail("That business is suspended", 403);

  const acct = req.user.acct
    ? (await query("SELECT * FROM accounts WHERE id = ?", [req.user.acct])).rows[0]
    : null;
  if (!acct) return res.fail("Only an account with an email address can switch business", 403);

  /* A business with a PIN asks for it here, where the switch actually happens.
     Checking it on the screen instead would make it a suggestion: this route
     hands back a session for the company being opened. */
  const lock = await firmPinHash(firmId);
  if (lock) {
    const given = String((req.body || {}).pin || "");
    /* 403, not 401. A 401 says "we do not know who you are", and the client
       answers that by refreshing the session and trying again — which for a
       lock that has nothing to do with the session is a loop with no end. The
       session here is perfectly good; it is the PIN that is missing. */
    if (!given) return res.fail(`${firm.name} is locked with a PIN`, 403, { firm_locked: true });
    if (!bcrypt.compareSync(given, lock)) return res.fail("Wrong PIN for that business", 403, { firm_locked: true });
  }

  /* A whole new session comes back, not an acknowledgement.
   *
   * The token carries the company, and the role can differ between them — an
   * owner in one business may be a clerk in another. Answering "switched" and
   * letting the browser keep the token it already holds means the next request
   * is still made against the old company: the server had switched and the
   * client had not, which is worse than not switching at all, because the
   * screen says one business while the data is another's.
   *
   * `sessionFor` is the same function the three sign-in paths use, so a
   * switched session and a fresh one cannot come to differ. */
  const { sessionFor } = require("../auth/auth.routes");
  return await tenancy.withFirm(firmId, async () => {
    /* The staff row for this account **inside the company being opened**. With
       one file this found the row that already existed and pointed it at the
       new company; with a file per company it creates one the first time an
       account enters a business it has been given access to. */
    const user = await ensureLocalUser({ query }, acct, firmId, mem.role_id || null);
    await query("UPDATE accounts SET last_firm_id = ? WHERE id = ?", [firmId, acct.id]);
    return res.success({ ...await sessionFor(user, acct), firm_id: firmId, name: firm.name },
      `Switched to ${firm.name}`);
  });
});

/* ── Create ──────────────────────────────────────────────────────────────── */
router.post("/", requirePermission("companies", "create"), async (req, res, next) => await centralDurable(next, async (conn) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.fail("Name the business", 400);
  if (!req.user.acct) return res.fail("Only an account with an email address can create a business", 403);

  const acct = (await query("SELECT company_limit FROM accounts WHERE id = ?", [req.user.acct])).rows[0] || {};
  const have = (await query("SELECT COUNT(*) c FROM memberships WHERE account_id = ? AND status = 'active'",
    [req.user.acct])).rows[0].c;
  const cap = businessCap(acct);
  if (have >= cap) {
    const plan = (licence.status(0).licence || {}).planName;
    return res.fail(plan
      ? `The ${plan} plan covers ${cap} business${cap === 1 ? "" : "es"}. Move to a bigger plan to add another.`
      : `This account can hold ${cap} business${cap === 1 ? "" : "es"}.`, 403);
  }
  const clash = (await query("SELECT f.id FROM memberships m JOIN firms f ON f.id = m.firm_id " +
    "WHERE m.account_id = ? AND lower(f.name) = lower(?)", [req.user.acct, name])).rows[0];
  if (clash) return res.fail(`You already have a business called "${name}"`, 400);

  /* The Admin role comes back from provisioning rather than being read back
     afterwards. The read looked harmless and was not: `roles` belongs to the
     company, and the company in context here is still the one the owner is
     standing in — so it went looking for the new business's Admin role in the
     old business's database and found nothing. Once each company has its own
     file, "read it back" has to say which file. */
  const { firmId, adminRoleId } = await provisionFirm(conn, { ...b, name, created_by: req.user.id, mark_setup_done: true });
  await conn.query("INSERT INTO memberships (account_id, firm_id, role_id, is_owner, status) VALUES (?,?,?,1,'active')",
    [req.user.acct, firmId, adminRoleId]);

  /* A second branch of the same shop sells the same things. Retyping four
     hundred items to open it is the reason people give up on the second
     business, so the new one can start as a copy of an existing one's
     catalogue — the items and their prices, the categories they sit in, and
     the units they are sold by. Deliberately NOT the stock, which belongs to
     a shelf in a building, nor the customers, the invoices or the ledger. */
  let copied = null;
  if (b.copy_from) {
    const from = Number(b.copy_from);
    const may = await membership(req.user.acct, from);
    if (!may || may.status !== "active") return res.fail("You cannot copy from that business", 403);
    copied = await copyCatalogue(conn, from, firmId);
  }

  const auditNow = async () => await audit(firmId, req.user.id, "create", firmId, name);
  return async () => { await auditNow(); return res.success({ id: firmId, name, copied },
    copied ? `${name} created with ${copied.items} item${copied.items === 1 ? "" : "s"} copied over`
           : `${name} created`); };
}));

/* ── Edit ────────────────────────────────────────────────────────────────── */
router.put("/:id", adminOnly("edit"), async (req, res, next) => await centralDurable(next, async (conn) => {
  const firmId = Number(req.params.id);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  const b = req.body || {};
  const fields = ["name", "legal_name", "gstin", "address", "phone", "email", "invoice_prefix", "state_code", "shop_code"];
  const set = fields.filter((f) => f in b);

  /* The shop code is what counter staff type to say which shop they are
     signing in to, so it has to be typable and it has to be unique across the
     installation. Refusing a bad one here is the only place that can be done:
     a duplicate would send one shop's cashier at another shop's till. */
  if ("shop_code" in b) {
    const code = String(b.shop_code || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(code)) {
      return res.fail("A shop code is 2–32 characters: letters, numbers and hyphens.", 400);
    }
    const clash = (await query("SELECT id FROM firms WHERE lower(shop_code) = ? AND id <> ?", [code, firmId])).rows[0];
    if (clash) return res.fail("Another business is already using that shop code", 400);
    b.shop_code = code;
  }
  if (!set.length) return res.fail("Nothing to change", 400);
  if ("name" in b && !String(b.name).trim()) return res.fail("A business cannot be left without a name", 400);
  await conn.query(`UPDATE firms SET ${set.map((f) => `${f}=?`).join(", ")} WHERE id = ?`,
    [...set.map((f) => (b[f] === "" ? null : b[f])), firmId]);
  const auditNow = async () => await audit(firmId, req.user.id, "edit", firmId, set.join(","));
  return async () => { await auditNow(); return res.success({ ok: true }, "Business updated"); };
}));

/* ── Suspend and restore ──────────────────────────────────────────────────
 *
 * Suspending locks everybody out and touches not one row of data. Every
 * session on the company is ended in the same transaction, because a
 * suspension that leaves the people already signed in still working is not a
 * suspension.
 */
router.post("/:id/status", adminOnly("edit"), async (req, res, next) => await centralDurable(next, async (conn) => {
  const firmId = Number(req.params.id);
  const want = (req.body || {}).status === "active" ? "active" : "suspended";
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  if (want === "suspended") {
    if (!mem.is_owner) return res.fail("Only the owner of a business can suspend it", 403);
    const others = (await query(
      "SELECT COUNT(*) c FROM memberships m JOIN firms f ON f.id = m.firm_id " +
      "WHERE m.account_id = ? AND m.status = 'active' AND f.status = 'active' AND f.id != ?",
      [req.user.acct, firmId])).rows[0].c;
    /* Suspending the only business you can open locks you out of the screen
       that would let you un-suspend it. */
    if (!others) return res.fail("This is the only business you can open. Suspending it would lock you out.", 400);
  }
  await conn.query("UPDATE firms SET status = ? WHERE id = ?", [want, firmId]);
  if (want === "suspended") await revokeSessions({ firmId });
  const auditNow = async () => await audit(firmId, req.user.id, want === "active" ? "restore" : "suspend", firmId, "");
  return async () => { await auditNow(); return res.success({ status: want }, want === "active" ? "Business restored" : "Business suspended"); };
}));

/* ── Who may open this company ───────────────────────────────────────────── */
router.get("/:id/people", requirePermission("companies", "grant"), async (req, res) => {
  const firmId = Number(req.params.id);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  /* Two queries rather than one, because they read from two different
     databases once companies have files of their own: memberships and accounts
     are central, and roles belong to the company. See database/router.js — a
     statement naming both is refused rather than quietly answered by whichever
     file it was handed to. */
  const rows = (await query(
    `SELECT m.id, m.account_id, m.role_id, m.is_owner, m.status,
            a.email, a.full_name, a.status AS account_status
       FROM memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.firm_id = ? ORDER BY m.is_owner DESC, a.email`, [firmId])).rows;
  /* A loop, not .map(): naming a role is a database read, so the callback
     would be async and .map() would hand back promises nobody awaits. */
  const out = [];
  for (const r of rows) out.push({ ...r, role_name: await roleName(r.role_id) });
  res.success(out);
});

/* Grant or change access. Creating a membership by hand is deliberately the
   only path here: there is no "request access", and an invitation flow that
   emails a token belongs with the rest of the onboarding work. */
router.post("/:id/people", requirePermission("companies", "grant"), async (req, res, next) => await centralDurable(next, async (conn) => {
  const firmId = Number(req.params.id);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  const b = req.body || {};
  const acct = (await query("SELECT id, email FROM accounts WHERE lower(email) = lower(?)",
    [String(b.email || "").trim()])).rows[0];
  if (!acct) return res.fail("No account with that email address", 404);
  const roleId = b.role_id ? Number(b.role_id) : null;
  if (roleId) {
    /* The role must belong to THIS company. Without this, an account could be
       given a role id from another firm and inherit its permission set. */
    const role = (await query("SELECT id FROM roles WHERE id = ? AND firm_id = ?", [roleId, firmId])).rows[0];
    if (!role) return res.fail("That role does not belong to this business", 400);
  }
  const existing = (await query("SELECT id FROM memberships WHERE account_id = ? AND firm_id = ?", [acct.id, firmId])).rows[0];
  if (existing) {
    await conn.query("UPDATE memberships SET role_id = ?, status = 'active' WHERE id = ?", [roleId, existing.id]);
  } else {
    await conn.query("INSERT INTO memberships (account_id, firm_id, role_id, is_owner, status) VALUES (?,?,?,0,'active')",
      [acct.id, firmId, roleId]);
  }
  const auditNow = async () => await audit(firmId, req.user.id, "grant", firmId, acct.email);
  return async () => { await auditNow(); return res.success({ ok: true }, `${acct.email} can now open this business`); };
}));

/* Revoke. Ends their sessions in the same transaction — access removed that
   leaves somebody already inside still working is not removed. */
router.delete("/:id/people/:accountId", requirePermission("companies", "grant"), async (req, res, next) => await centralDurable(next, async (conn) => {
  const firmId = Number(req.params.id);
  const target = Number(req.params.accountId);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  const theirs = (await query("SELECT * FROM memberships WHERE account_id = ? AND firm_id = ?", [target, firmId])).rows[0];
  if (!theirs) return res.notFound("They do not have access to this business");
  if (theirs.is_owner) return res.fail("The owner's access cannot be removed. Transfer the business first.", 400);
  if (target === req.user.acct) return res.fail("You cannot remove your own access", 400);
  await conn.query("UPDATE memberships SET status = 'revoked' WHERE id = ?", [theirs.id]);
  await revokeSessions({ accountId: target });
  const auditNow = async () => await audit(firmId, req.user.id, "revoke", firmId, String(target));
  return async () => { await auditNow(); return res.success({ ok: true }, "Access removed"); };
}));

/* Hand the business over.
 *
 * The revoke route above tells somebody to "transfer the business first", and
 * until now there was nothing that did. A company must have exactly one owner
 * at all times — nought is a company nobody can rescue when an administrator
 * locks themselves out, and the ownership bypass in `requirePermission` means
 * two is two people who cannot be restrained by any role.
 */
router.post("/:id/people/:accountId/owner", requirePermission("companies", "grant"),
  async (req, res, next) => await centralDurable(next, async (conn) => {
    const firmId = Number(req.params.id);
    const target = Number(req.params.accountId);
    const mine = await membership(req.user.acct, firmId);
    if (!mine || mine.status !== "active") return res.notFound("Business not found");
    /* Only the owner may give the business away. `companies.grant` decides who
       may open it; that is a different and smaller thing than deciding who
       owns it, and an administrator who could hand it to themselves would make
       the owner's protections meaningless. */
    if (!mine.is_owner) return res.fail("Only the owner can hand over a business", 403);
    const theirs = (await query("SELECT * FROM memberships WHERE account_id = ? AND firm_id = ? AND status = 'active'",
      [target, firmId])).rows[0];
    if (!theirs) return res.notFound("They do not have access to this business");
    if (target === req.user.acct) return res.fail("You already own this business", 400);
    const acct = (await query("SELECT email FROM accounts WHERE id = ?", [target])).rows[0] || {};

    await conn.query("UPDATE memberships SET is_owner = 0 WHERE firm_id = ?", [firmId]);
    await conn.query("UPDATE memberships SET is_owner = 1 WHERE id = ?", [theirs.id]);
    /* Both sessions end. The old owner is holding tokens that no longer mean
       what they meant, and the new owner's next request should carry the
       ownership rather than pick it up whenever their token expires. */
    await revokeSessions({ accountId: target });
    await revokeSessions({ accountId: req.user.acct });
    const auditNow = async () => await audit(firmId, req.user.id, "transfer-owner", firmId, acct.email || String(target));
    return async () => { await auditNow(); return res.success({ ok: true }, `${acct.email || "They"} now own this business. Everyone has been signed out.`); };
  }));

/* ── Invitations ──────────────────────────────────────────────────────────
 *
 * Granting access by email address only works for somebody who already has an
 * account — `POST /:id/people` says as much, with "No account with that email
 * address". Everybody else needs this: a single-use link, sent to the address,
 * that creates the account and the membership together.
 *
 * The token is 32 random bytes and is stored only as a SHA-256 digest, so a
 * copy of the database is not a folder of working invitations.
 */
router.get("/:id/invitations", requirePermission("companies", "grant"), async (req, res) => {
  const firmId = Number(req.params.id);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  const rows = (await query(
    `SELECT i.id, i.email, i.role_id, i.is_owner, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
            (i.expires_at < datetime('now')) AS expired
       FROM invitations i WHERE i.firm_id = ? ORDER BY i.id DESC LIMIT 100`, [firmId])).rows;
  /* A loop, not .map(): naming a role is a database read, so the callback
     would be async and .map() would hand back promises nobody awaits. */
  const out = [];
  for (const r of rows) out.push({ ...r, role_name: await roleName(r.role_id) });
  res.success(out);
});

router.post("/:id/invitations", requirePermission("companies", "grant"),
  async (req, res, next) => await centralDurable(next, async (conn) => {
    const firmId = Number(req.params.id);
    const mem = await membership(req.user.acct, firmId);
    if (!mem || mem.status !== "active") return res.notFound("Business not found");
    const b = req.body || {};
    const email = String(b.email || "").trim();
    if (!EMAIL_RE.test(email)) return res.fail("That does not look like an email address", 400);

    const already = (await query(
      `SELECT m.status FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.firm_id = ? AND lower(a.email) = lower(?)`, [firmId, email])).rows[0];
    if (already && already.status === "active") return res.fail("They can already open this business", 400);

    const roleId = b.role_id ? Number(b.role_id) : null;
    if (roleId) {
      const role = (await query("SELECT id FROM roles WHERE id = ? AND firm_id = ?", [roleId, firmId])).rows[0];
      if (!role) return res.fail("That role does not belong to this business", 400);
    }
    /* Only an owner may invite another owner. Ownership is the one thing no
       role can restrain, so it must not be reachable from a permission an
       owner handed out for a different purpose. */
    const asOwner = !!b.is_owner;
    if (asOwner && !mem.is_owner) return res.fail("Only the owner can invite another owner", 403);

    /* One live invitation per address per business. Otherwise a mistyped role
       is fixed by sending a second link, and both keep working. */
    await conn.query(
      `UPDATE invitations SET revoked_at = datetime('now')
        WHERE firm_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL AND revoked_at IS NULL`,
      [firmId, email]);

    const { hash, url } = newInvitationToken(req);
    await conn.query(
      `INSERT INTO invitations (token, email, firm_id, role_id, invited_by, is_owner, full_name, expires_at)
       VALUES (?,?,?,?,?,?,?, datetime('now', '+7 days'))`,
      [hash, email, firmId, roleId, req.user.id, asOwner ? 1 : 0, String(b.full_name || "").trim() || null]);
    const firm = (await query("SELECT name FROM firms WHERE id = ?", [firmId])).rows[0] || {};
    const roleName = roleId ? ((await query("SELECT name FROM roles WHERE id = ?", [roleId])).rows[0] || {}).name : null;
    const inviter = (await query("SELECT full_name FROM users WHERE id = ?", [req.user.id])).rows[0] || {};
    const auditNow = async () => await audit(firmId, req.user.id, "invite", firmId, email);

    /* Sent after the commit, deliberately. An invitation email for a row that
       rolled back is a link that will never work, and the person holding it
       has no way to tell that from a broken product. */
    return async () => { await auditNow();
      const sent = await sendEmail({
        to: email, template: "invite", purpose: "invite",
        data: { inviter: inviter.full_name || null, company: firm.name, url, role: asOwner ? "the owner" : roleName },
      });
      /* "Sent" means a mail provider accepted it. With none configured the
         message was only printed to the server's log, and reporting that as
         sent put a green "Invitation sent to …" directly above a panel saying
         nothing was sent — the screen contradicting itself in one glance. */
      const delivered = emailConfigured() && sent.ok;
      res.success({ sent: delivered, email, expires_days: 7, ...(delivered ? {} : { url }) },
        delivered ? `Invitation sent to ${email}`
          : emailConfigured()
            ? `Invitation created, but the email could not be sent (${sent.error || "unknown error"}).`
            : "Invitation created. No email provider is set up, so pass the link on yourself.");
    };
  }));

router.delete("/:id/invitations/:invId", requirePermission("companies", "grant"),
  async (req, res, next) => await centralDurable(next, async (conn) => {
    const firmId = Number(req.params.id);
    const mem = await membership(req.user.acct, firmId);
    if (!mem || mem.status !== "active") return res.notFound("Business not found");
    const inv = (await query("SELECT * FROM invitations WHERE id = ? AND firm_id = ?",
      [Number(req.params.invId), firmId])).rows[0];
    if (!inv) return res.notFound("Invitation not found");
    if (inv.accepted_at) return res.fail("That invitation has already been used", 400);
    await conn.query("UPDATE invitations SET revoked_at = datetime('now') WHERE id = ?", [inv.id]);
    const auditNow = async () => await audit(firmId, req.user.id, "invite-withdraw", firmId, inv.email);
    return async () => { await auditNow(); return res.success({ ok: true }, "Invitation withdrawn"); };
  }));



/* ── The all-businesses panel ─────────────────────────────────────────────
 *
 * Every business this account may open, in one pass.
 *
 * Not N round trips. A shopkeeper with six businesses would otherwise wait for
 * six sequential dashboards, each opening the same tables — and the figures
 * would be from six different instants, so the total would not be the total of
 * anything. One query per measure, grouped by firm, is both faster and the only
 * way the combined figure is true.
 *
 * Gated on `companies.panel` **server-side**. Hiding the rail entry is a
 * convenience; this is the refusal that matters, because the panel is the one
 * screen that shows one business's takings to somebody standing in another.
 */
/**
 * Copy one business's catalogue into a new one.
 *
 * What travels: categories, units, and items with their prices. What does not,
 * and why each:
 *
 *   · **stock** — it is a count of things on a shelf in a building. A new
 *     branch that opens holding the old branch's stock is a book that says the
 *     same crate is in two places.
 *   · **customers, invoices, payments, the ledger** — those are the old
 *     business's trading, not its shape.
 *   · **staff** — and this one was written, tested, and taken out again. A
 *     username is unique across the whole installation, not per company, so
 *     copying the logins into a second business would collide on every one of
 *     them and silently skip the lot. A "copy the staff too" tick that can
 *     never do anything is worse than not offering it. The right answer for
 *     somebody who works both counters is to give their account access to the
 *     second business under People, which already exists and does not
 *     duplicate the person.
 *
 * Ids are not reused: a copied item is a new item with a new id. Prices and
 * names are carried across, and `item_code` with them, because a shop that
 * knows a thing as HW-002 knows it as HW-002 in both branches.
 */
async function copyCatalogue(conn, fromFirm, toFirm) {
  const out = { items: 0, categories: 0, units: 0 };

  /* Categories first, and a map from the old id to the new, because items
     point at them. A copy that dropped the mapping would file every item
     under whatever category happened to hold the same id in the new
     business — which, after provisioning, is "General". */
  const catMap = new Map();
  for (const c of (await query("SELECT id, name FROM item_categories WHERE firm_id = ?", [fromFirm])).rows) {
    const here = (await query("SELECT id FROM item_categories WHERE firm_id = ? AND lower(name) = lower(?)",
      [toFirm, c.name])).rows[0];
    if (here) { catMap.set(c.id, here.id); continue; }
    await conn.query("INSERT INTO item_categories (firm_id, name) VALUES (?,?)", [toFirm, c.name]);
    const made = (await query("SELECT id FROM item_categories WHERE firm_id = ? AND name = ?", [toFirm, c.name])).rows[0];
    if (made) { catMap.set(c.id, made.id); out.categories++; }
  }

  for (const u of (await query("SELECT name, short FROM item_units WHERE firm_id = ?", [fromFirm])).rows) {
    const here = (await query("SELECT id FROM item_units WHERE firm_id = ? AND lower(name) = lower(?)",
      [toFirm, u.name])).rows[0];
    if (here) continue;
    await conn.query("INSERT INTO item_units (firm_id, name, short) VALUES (?,?,?)", [toFirm, u.name, u.short]);
    out.units++;
  }

  for (const i of (await query(
    `SELECT item_code, name, item_type, is_inventory, hsn_sac, unit, sale_price, purchase_price,
            price_inclusive, reorder_level, category_id, wholesale_price, mrp, description,
            secondary_unit, conversion_rate, secondary_price
       FROM items WHERE firm_id = ? AND COALESCE(is_active, 1) = 1`, [fromFirm])).rows) {
    await conn.query(
      `INSERT INTO items (firm_id, item_code, name, item_type, is_inventory, hsn_sac, unit,
                          sale_price, purchase_price, price_inclusive, reorder_level, category_id,
                          wholesale_price, mrp, description, secondary_unit, conversion_rate, secondary_price)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [toFirm, i.item_code || null, i.name, i.item_type || "product", i.is_inventory, i.hsn_sac || null,
       i.unit || "PCS", i.sale_price || 0, i.purchase_price || 0, i.price_inclusive || 0,
       i.reorder_level || 0, catMap.get(i.category_id) || null, i.wholesale_price || 0, i.mrp || 0,
       i.description || null, i.secondary_unit || null, i.conversion_rate || 0, i.secondary_price || 0]);
    out.items++;
  }

  return out;
}

/**
 * Empty a business without deleting it.
 *
 * The one a shopkeeper wants after a month of trying the app out with made-up
 * sales: keep the name, the items and the staff, throw away the trading. It is
 * the same service the Settings → Start fresh screen uses, so there is one
 * definition of what "empty" means rather than two that drift.
 *
 * Guarded by typing the name back, exactly as deletion is, because the two
 * mistakes look identical afterwards.
 */
router.post("/:id/reset", adminOnly("delete"), async (req, res, next) => {
  const firmId = Number(req.params.id);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  if (!mem.is_owner) return res.fail("Only the owner of a business can empty it", 403);

  const firm = (await query("SELECT id, name FROM firms WHERE id = ?", [firmId])).rows[0];
  if (!firm) return res.notFound("Business not found");
  const typed = String((req.body || {}).confirm || "").trim();
  if (typed.toLowerCase() !== String(firm.name).trim().toLowerCase()) {
    return res.fail(`Type "${firm.name}" exactly to confirm`, 400);
  }

  /* A verified copy first, always. Emptying is not undoable and the person
     doing it is, by definition, about to lose something. */
  let safety = null;
  try { safety = await backups.keepSafetyCopy(); }
  catch (e) { return res.fail(`Could not take a safety copy first, so nothing was emptied: ${e.message}`, 500); }

  const b = req.body || {};
  try {
    /* The wipe runs INSIDE the transaction and the reply function only
       reports it. Written the other way round — `(conn) => () => startFresh(…)`
       — `durable` sees a handler that wrote nothing, commits an empty
       transaction, and only then runs thirty DELETEs through a connection
       whose transaction has already closed. A failure halfway through would
       leave the books half-emptied with nothing to roll back to, which is the
       one outcome this route exists to make impossible. */
    return await tenancy.withFirm(firmId, async () => await durable(next, async (conn) => {
      const out = await fresh.startFresh(conn, firmId, {
        alsoCatalogue: !!b.also_items,
        alsoTaxRules: !!b.also_taxes,
        reopenSetup: !!b.reopen_setup,
      });
      return async () => {
        await audit(firmId, req.user.id, "reset", firmId, firm.name);
        return res.success(out,
          `${firm.name} has been emptied. A copy of everything as it was is in the backups folder` +
          `${safety ? ` as ${safety}` : ""}.`);
      };
    }));
  } catch (err) { return next(err); }
});

/* ── Which business opens when you sign in ────────────────────────────────
 *
 * An owner with four businesses spends most days in one of them. Opening
 * whichever was last used is right until the evening they check the other
 * branch's figures, after which every morning starts in the wrong shop.
 *
 * Stored on the account, not on the installation: two owners sharing a
 * computer have different answers.
 */
router.post("/:id/default", requirePermission("companies", "view"), async (req, res, next) =>
  await centralDurable(next, async (conn) => {
    if (!req.user.acct) return res.fail("Only an account with an email address has a default business", 403);
    const firmId = Number(req.params.id);
    const wanted = (req.body || {}).on !== false;
    if (wanted) {
      const mem = await membership(req.user.acct, firmId);
      if (!mem || mem.status !== "active") return res.notFound("Business not found");
    }
    await conn.query("UPDATE accounts SET default_firm_id = ? WHERE id = ?",
      [wanted ? firmId : null, req.user.acct]);
    return () => res.success({ default_firm_id: wanted ? firmId : null },
      wanted ? "This business will open when you sign in" : "No business is set to open first");
  }));

/* ── A PIN on one business ────────────────────────────────────────────────
 *
 * Separate from the panel's lock and from the sign-in PIN, and for a different
 * reason than either: an owner who lets a manager run the hardware shop does
 * not thereby let them open the pharmacy's books from the same computer. The
 * membership says who may; this says who may right now, at this keyboard.
 *
 * Hashed, and in `app_settings` — outside every company's own data — so that
 * restoring the business it guards can neither remove the lock nor restore an
 * old one.
 */
async function firmPinHash(firmId) {
  try {
    const r = (await query("SELECT svalue FROM app_settings WHERE skey = ?", [`firm_pin:${firmId}`])).rows[0];
    return (r && r.svalue) || "";
  } catch { return ""; }
}

router.get("/:id/pin", requirePermission("companies", "view"), async (req, res) => {
  res.success({ set: !!await firmPinHash(Number(req.params.id)) });
});

router.post("/:id/pin", adminOnly("edit"), async (req, res, next) =>
  await centralDurable(next, async (conn) => {
    const firmId = Number(req.params.id);
    const mem = await membership(req.user.acct, firmId);
    if (!mem || !mem.is_owner) return res.fail("Only the owner of a business can lock it", 403);

    const current = await firmPinHash(firmId);
    const b = req.body || {};
    if (current && !bcrypt.compareSync(String(b.old_pin || ""), current)) {
      return res.fail("That is not the current PIN for this business", 403);
    }
    const pin = String(b.pin || "").trim();
    if (pin === "") {
      await conn.query("DELETE FROM app_settings WHERE skey = ?", [`firm_pin:${firmId}`]);
      return () => res.success({ set: false }, "This business no longer asks for a PIN");
    }
    if (!/^\d{4,8}$/.test(pin)) return res.fail("A PIN is four to eight digits");
    if (/^(\d)\1+$/.test(pin)) return res.fail("Pick a less obvious PIN");
    await conn.query(
      "INSERT INTO app_settings (skey, svalue, updated_at) VALUES (?,?,datetime('now')) " +
      "ON CONFLICT(skey) DO UPDATE SET svalue = excluded.svalue, updated_at = datetime('now')",
      [`firm_pin:${firmId}`, bcrypt.hashSync(pin, 10)]);
    return () => res.success({ set: true }, "This business now asks for a PIN");
  }));

/* ── The panel's own lock ─────────────────────────────────────────────────
 *
 * The panel shows every business's takings on one screen. A manager who is
 * entitled to open shop A's books is not, by that fact, entitled to see what
 * shop B took last month — and on a shared back-office computer the person
 * sitting down is not always the owner.
 *
 * So the panel can carry a PIN of its own, on top of the permission. It is
 * hashed and lives in `app_settings`, which belongs to the installation
 * rather than to any one company: a PIN stored inside one of the businesses
 * it protects would be restored or cleared by that business's backup.
 *
 * Optional by design. A single-business shop should not be made to invent a
 * second PIN to look at its own figures.
 */
async function panelPinHash() {
  try {
    const r = (await query("SELECT svalue FROM app_settings WHERE skey = 'panel_pin'")).rows[0];
    return (r && r.svalue) || "";
  } catch { return ""; }
}

/**
 * Every business, in one file.
 *
 * A shopkeeper with four businesses had four buttons to press and four files
 * to keep track of, which is four chances to have three. One zip holding one
 * verified export per business — the same export the single-business button
 * makes, so each one restores through the same checked path — plus a plain
 * text list of what is inside it, because a zip of four `.genius.db` files is
 * unreadable to the person who most needs to read it.
 *
 * Streamed as one download rather than written into the backups folder: the
 * point of this file is that it leaves the building.
 */
router.get("/backup-all", adminOnly("edit"), async (req, res, next) => {
  try {
    if (!req.user.acct) return res.fail("Only an account with an email address can do this", 403);
    const mine = (await query(
      `SELECT f.id, f.name FROM memberships m JOIN firms f ON f.id = m.firm_id
        WHERE m.account_id = ? AND m.status = 'active' ORDER BY f.name`, [req.user.acct])).rows;
    if (!mine.length) return res.fail("There is nothing to back up", 400);

    const zip = new AdmZip();
    const lines = [
      "Genius POS — a copy of every business",
      `Taken ${new Date().toLocaleString()}`,
      "",
    ];
    for (const f of mine) {
      /* One failing business must not cost the other three their copy. It is
         named in the index instead, which is the only place anybody would
         look for it. */
      try {
        const { bytes, manifest } = await exportFirm(f.id);
        const safe = String(f.name).replace(/[^\w -]+/g, "-").trim() || `business-${f.id}`;
        zip.addFile(`${safe}.genius.db`, Buffer.from(bytes));
        lines.push(`${f.name}`);
        lines.push(`  file      ${safe}.genius.db`);
        lines.push(`  invoices  ${(manifest && manifest.invoices) != null ? manifest.invoices : "—"}`);
        lines.push(`  size      ${Math.round(bytes.length / 1024)} KB`);
        lines.push("");
      } catch (e) {
        lines.push(`${f.name}`);
        lines.push(`  NOT INCLUDED — ${e.message}`);
        lines.push("");
      }
    }
    lines.push("Restore one at a time: Companies → the business → Restore, and choose its file.");
    lines.push("A business can only be restored over itself.");
    lines.push("");
    lines.push("Powered by SALJO TECH");
    zip.addFile("what-is-in-here.txt", Buffer.from(lines.join("\n"), "utf8"));

    const buf = zip.toBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="genius-all-businesses-${stamp}.zip"`);
    res.setHeader("Content-Length", buf.length);
    return res.end(buf);
  } catch (err) { return next(err); }
});

router.get("/panel-pin", requirePermission("companies", "panel"), async (req, res) => {
  res.success({ set: !!await panelPinHash() });
});

/**
 * Set, change or remove the PIN.
 *
 * Changing one requires the old one. Without that, anybody who reached the
 * panel once — or who is simply sitting at an unlocked machine — could lock
 * the owner out of their own figures, and there is no reset for a PIN that
 * exists to keep people out.
 */
router.post("/panel-pin", adminOnly("panel"), async (req, res, next) =>
  await centralDurable(next, async (conn) => {
    if (!req.user.acct) return res.fail("This panel is for account holders", 403);
    const b = req.body || {};
    const current = await panelPinHash();
    if (current && !bcrypt.compareSync(String(b.old_pin || ""), current)) {
      return res.fail("That is not the current panel PIN", 403);
    }
    const pin = String(b.pin || "").trim();
    if (pin === "") {
      await conn.query("DELETE FROM app_settings WHERE skey = 'panel_pin'");
      return () => res.success({ set: false }, "The panel no longer asks for a PIN");
    }
    if (!/^\d{4,8}$/.test(pin)) return res.fail("A panel PIN is four to eight digits");
    if (/^(\d)\1+$/.test(pin)) return res.fail("Pick a less obvious PIN");
    await conn.query(
      "INSERT INTO app_settings (skey, svalue, updated_at) VALUES ('panel_pin', ?, datetime('now')) " +
      "ON CONFLICT(skey) DO UPDATE SET svalue = excluded.svalue, updated_at = datetime('now')",
      [bcrypt.hashSync(pin, 10)]);
    return () => res.success({ set: true }, "Panel PIN saved");
  }));

/** Open the lock for this session. Throttled by the same limiter as sign-in. */
router.post("/panel-unlock", requirePermission("companies", "panel"), async (req, res) => {
  const hash = await panelPinHash();
  if (!hash) return res.success({ ok: true });
  const pin = String((req.body || {}).pin || "");
  if (!bcrypt.compareSync(pin, hash)) return res.fail("Wrong panel PIN", 403);
  res.success({ ok: true });
});

router.get("/panel", requirePermission("companies", "panel"), async (req, res) => {
  if (!req.user.acct) return res.fail("This panel is for account holders", 403);
  /* The PIN, checked here as well as at /panel-unlock. A lock that only the
     screen enforces is not a lock: the figures are one fetch away. */
  const hash = await panelPinHash();
  if (hash) {
    const given = String(req.query.pin || req.get("X-Panel-Pin") || "");
    if (!given || !bcrypt.compareSync(given, hash)) {
      /* 403 for the same reason the business lock uses it: the session is
         fine, the PIN is what is missing, and a 401 sends the client into a
         refresh-and-retry loop it can never win. */
      return res.fail("This panel is locked with a PIN", 403, { panel_locked: true });
    }
  }

  /* Only businesses this account may open — the same rule as the list. Being
     an administrator of shop A says nothing about shop B. */
  const mine = (await query(
    `SELECT f.id, f.name, f.status FROM memberships m JOIN firms f ON f.id = m.firm_id
      WHERE m.account_id = ? AND m.status = 'active' ORDER BY f.name`, [req.user.acct])).rows;
  if (!mine.length) return res.success({ companies: [], period: null });

  const ids = mine.map((f) => f.id);
  const marks = ids.map(() => "?").join(",");
  const { from, to, label } = periodFrom(req.query);

  /* One statement per measure, grouped by firm. */
  const byFirm = async (sql, args) => {
    const out = {};
    try { for (const r of (await query(sql, args)).rows) out[r.firm_id] = r; }
    catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; }
    return out;
  };

  const sales = await byFirm(
    `SELECT firm_id, COUNT(*) AS invoices, COALESCE(SUM(grand_total),0) AS revenue,
            COALESCE(AVG(grand_total),0) AS avg_bill
       FROM sale_invoices WHERE firm_id IN (${marks}) AND invoice_date BETWEEN ? AND ?
      GROUP BY firm_id`, [...ids, from, to]);

  /* Cost of what was sold, from the ledger rather than from item costs — the
     ledger is what the books say, and a profit figure that disagreed with the
     profit-and-loss report would be the more alarming of the two. */
  const cogs = await byFirm(
    `SELECT l.firm_id, COALESCE(SUM(l.debit - l.credit),0) AS cogs
       FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.firm_id IN (${marks}) AND l.account_code IN ('5002','5001')
        AND e.entry_date BETWEEN ? AND ? GROUP BY l.firm_id`, [...ids, from, to]);

  const expenses = await byFirm(
    `SELECT firm_id, COALESCE(SUM(amount),0) AS expenses, COUNT(*) AS expense_count
       FROM expenses WHERE firm_id IN (${marks}) AND expense_date BETWEEN ? AND ?
        AND COALESCE(status,'posted') <> 'voided'
      GROUP BY firm_id`, [...ids, from, to]);

  const stock = await byFirm(
    `SELECT firm_id, COALESCE(SUM(quantity * avg_cost),0) AS stock_value,
            COALESCE(SUM(quantity),0) AS on_hand
       FROM item_stock WHERE firm_id IN (${marks}) GROUP BY firm_id`, ids);

  const lowStock = await byFirm(
    `SELECT i.firm_id, COUNT(*) AS low
       FROM items i WHERE i.firm_id IN (${marks}) AND i.reorder_level > 0
        AND COALESCE((SELECT SUM(quantity) FROM item_stock s
                       WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) <= i.reorder_level
      GROUP BY i.firm_id`, ids);

  /* Money owed to you and by you, from the control accounts. */
  const balances = await byFirm(
    `SELECT firm_id,
            COALESCE(SUM(CASE WHEN account_code = '1010' THEN balance END),0) AS receivable,
            COALESCE(SUM(CASE WHEN account_code = '2010' THEN -balance END),0) AS payable,
            COALESCE(SUM(CASE WHEN account_code IN ('1001','1002') THEN balance END),0) AS cash
       FROM account_balances WHERE firm_id IN (${marks}) GROUP BY firm_id`, ids);

  /* Receivables by age. The buckets are the ones the ageing report already
     uses, so the panel and the report cannot disagree. */
  const ageing = { d0: 0, d31: 0, d61: 0, d90: 0 };
  try {
    for (const r of (await query(
      `SELECT balance_due AS due,
              CAST(julianday('now') - julianday(COALESCE(due_date, invoice_date)) AS INTEGER) AS age
         FROM sale_invoices
        WHERE firm_id IN (${marks}) AND balance_due > 0.005`, ids)).rows) {
      const a = Number(r.age) || 0, due = Number(r.due) || 0;
      if (a <= 30) ageing.d0 += due;
      else if (a <= 60) ageing.d31 += due;
      else if (a <= 90) ageing.d61 += due;
      else ageing.d90 += due;
    }
  } catch { /* nothing outstanding */ }

  /* Expenses by category across every business — the one breakdown that is
     more useful combined than per business, since a category is the same
     category wherever it was spent. */
  let expenseCats = [];
  try {
    expenseCats = (await query(
      `SELECT COALESCE(NULLIF(TRIM(category),''),'Uncategorised') AS category,
              COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n
         FROM expenses WHERE firm_id IN (${marks}) AND expense_date BETWEEN ? AND ?
          AND COALESCE(status,'posted') <> 'voided'
        GROUP BY 1 ORDER BY amount DESC LIMIT 12`, [...ids, from, to])).rows;
  } catch { expenseCats = []; }

  const companies = mine.map((f) => {
    const s = sales[f.id] || {}, c = cogs[f.id] || {}, e = expenses[f.id] || {};
    const st = stock[f.id] || {}, b = balances[f.id] || {}, l = lowStock[f.id] || {};
    const revenue = Number(s.revenue) || 0;
    const cost = Number(c.cogs) || 0;
    const spend = Number(e.expenses) || 0;
    return {
      id: f.id, name: f.name, status: f.status,
      revenue, invoices: Number(s.invoices) || 0, avg_bill: Number(s.avg_bill) || 0,
      cogs: cost, expenses: spend, expense_count: Number(e.expense_count) || 0,
      /* Gross profit less running costs. Named `profit` on the wire and
         "Profit after costs" on screen, because "profit" on its own is the word
         two people mean two different things by. */
      profit: revenue - cost - spend,
      gross_profit: revenue - cost,
      stock_value: Number(st.stock_value) || 0,
      on_hand: Number(st.on_hand) || 0,
      low_stock: Number(l.low) || 0,
      receivable: Number(b.receivable) || 0,
      payable: Number(b.payable) || 0,
      cash: Number(b.cash) || 0,
    };
  });

  const sum = (k) => companies.reduce((t, c) => t + (Number(c[k]) || 0), 0);
  res.success({
    period: { from, to, label },
    /* One currency across every business, per the decision on record. If that
       ever stops being true, this total stops being addition and the screen has
       to say so rather than quietly summing shillings and dollars. */
    currency_note: "single",
    companies,
    totals: {
      revenue: sum("revenue"), profit: sum("profit"), gross_profit: sum("gross_profit"),
      cogs: sum("cogs"), expenses: sum("expenses"), invoices: sum("invoices"),
      stock_value: sum("stock_value"), low_stock: sum("low_stock"),
      receivable: sum("receivable"), payable: sum("payable"), cash: sum("cash"),
      trading: companies.filter((c) => c.status === "active").length,
    },
    ageing,
    expense_categories: expenseCats.map((r) => ({
      category: r.category, amount: Number(r.amount) || 0, count: Number(r.n) || 0,
    })),
  });
});

/* The same period vocabulary the rest of the app standardised on in round
   eight, so "this month" means the same thing on every screen. */
function periodFrom(q) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const p = String(q.period || "this_month");
  if (q.from && q.to) return { from: String(q.from), to: String(q.to), label: "Chosen dates" };
  if (p === "today") return { from: iso(now), to: iso(now), label: "Today" };
  if (p === "this_year") {
    return { from: `${now.getFullYear()}-01-01`, to: iso(now), label: "This year" };
  }
  if (p === "last_month") {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: iso(first), to: iso(last), label: "Last month" };
  }
  if (p === "last_7") {
    const d = new Date(now); d.setDate(d.getDate() - 6);
    return { from: iso(d), to: iso(now), label: "Last 7 days" };
  }
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: iso(first), to: iso(now), label: "This month" };
}

/* ── Backup and restore, one company at a time ────────────────────────────
 *
 * Round twelve made whole-file restore refuse on any installation holding more
 * than one company, and was right to. These are the routes that give a shop
 * its recovery button back once it has two — see firmexport.service.js for why
 * restoring in place needs no renumbering, and firmrestore.service.js for the
 * order of operations.
 *
 * Gated on `companies.edit` rather than `settings.edit`: this is an action on
 * a business, and the person who may take a copy of a business is the person
 * who may manage it. The membership check underneath means it can only ever be
 * a business the caller can already open.
 */

/** Download this company as a file. */
router.get("/:id/export", adminOnly("edit"), async (req, res, next) => {
  try {
    const firmId = Number(req.params.id);
    const mem = await membership(req.user.acct, firmId);
    if (!mem || mem.status !== "active") return res.notFound("Business not found");

    const { bytes, manifest } = await exportFirm(firmId);
    const safeName = String(manifest.firm_name || "business").replace(/[^\w-]+/g, "-").slice(0, 40);
    const stamp = manifest.taken_at.slice(0, 10);
    res.setHeader("Content-Type", "application/x-sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-${stamp}.genius.db"`);
    /* The totals ride on a header as well as inside the file, so a shop can see
       what it just downloaded without opening it. */
    res.setHeader("X-Genius-Invoices", String(manifest.totals.invoices));
    res.setHeader("X-Genius-Firm", String(firmId));
    res.send(bytes);
  } catch (e) { next(e); }
});

/** Say what a file is, before anybody presses restore. */
router.post("/:id/restore/preview", adminOnly("edit"),
  express_.raw({ type: ["application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"], limit: "512mb" }),
  async (req, res) => {
    const firmId = Number(req.params.id);
    const mem = await membership(req.user.acct, firmId);
    if (!mem || mem.status !== "active") return res.notFound("Business not found");
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || !bytes.length) return res.fail("No file received", 400);

    const r = await inspect(bytes);
    if (!r.ok) return res.success({ restorable: false, reason: r.why });
    const m = r.manifest;
    const target = (await query("SELECT name FROM firms WHERE id = ?", [firmId])).rows[0];
    if (Number(m.firm_id) !== firmId) {
      return res.success({
        restorable: false,
        reason: `That backup is of "${m.firm_name}". It can only go back over the same business` +
                `${target ? `, and this one is "${target.name}"` : ""}.`,
        manifest: { firm_name: m.firm_name, taken_at: m.taken_at, totals: m.totals },
      });
    }
    res.success({
      restorable: true,
      older_schema: r.older_schema,
      manifest: {
        firm_name: m.firm_name, taken_at: m.taken_at, app_version: m.app_version, totals: m.totals,
      },
    });
  });

/** Put it back. */
router.post("/:id/restore", adminOnly("edit"),
  express_.raw({ type: ["application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"], limit: "512mb" }),
  async (req, res, next) => {
    try {
      const firmId = Number(req.params.id);
      const mem = await membership(req.user.acct, firmId);
      if (!mem || mem.status !== "active") return res.notFound("Business not found");
      /* The owner only. Restoring is destroying today's trading for everybody
         in the business, and being able to edit it is not the same as being
         able to roll it back. */
      if (!mem.is_owner) return res.fail("Only the owner of a business can restore it", 403);
      const bytes = Buffer.isBuffer(req.body) ? req.body : null;
      if (!bytes || !bytes.length) return res.fail("No file received", 400);

      const r = await restoreFirm(bytes, { intoFirmId: firmId, userId: req.user.id });
      res.success(r, `${r.firm_name} restored to how it was on ${String(r.taken_at).slice(0, 10)}`);
    } catch (e) {
      /* A refusal here is a sentence a shopkeeper has to act on, not a stack
         trace. `restoreFirm` throws with that already written. */
      res.fail(e.message, 400);
    }
  });

/* ── Delete ──────────────────────────────────────────────────────────────── */
router.delete("/:id", adminOnly("delete"), async (req, res, next) => {
  /* A copy is taken before anything is destroyed, and the delete does not
     happen if the copy cannot be written and read back.
     *
     * Session 4 shipped this route without it, and said so: the typed-in name
     * was the only thing between a shop and permanent loss. A confirmation
     * stops the wrong click; it does nothing about the right click made for
     * the wrong reason, which is the one people actually ring up about. The
     * file lands in backups/ where the Backup screen already lists it, and it
     * is a per-company export, so it can be restored into a fresh company on
     * this or any other installation. */
  const firmId = Number(req.params.id);
  const mem = await membership(req.user.acct, firmId);
  if (!mem || mem.status !== "active") return res.notFound("Business not found");
  if (!mem.is_owner) return res.fail("Only the owner of a business can delete it", 403);
  const firmRow = (await query("SELECT name FROM firms WHERE id = ?", [firmId])).rows[0];
  if (!firmRow) return res.notFound("Business not found");
  if (String((req.body || {}).confirm || "").trim() !== firmRow.name) {
    return res.fail(`Type the business name exactly — "${firmRow.name}" — to confirm`, 400);
  }

  let keptAs = null;
  try {
    const { bytes, manifest } = await exportFirm(firmId);
    fs.mkdirSync(backups.BACKUP_DIR, { recursive: true });
    const safeName = String(manifest.firm_name || "business").replace(/[^\w-]+/g, "-").slice(0, 40);
    const stamp = manifest.taken_at.replace(/[:.]/g, "-").replace(/Z$/, "");
    keptAs = `deleted-${safeName}-${stamp}.genius.db`;
    fs.writeFileSync(path.join(backups.BACKUP_DIR, keptAs), bytes);
  } catch (e) {
    return res.fail(
      `A copy of this business could not be saved first, so nothing was deleted — ${e.message}`, 500);
  }

  return await centralDurable(next, async (conn) => {
  const firm = firmRow;
  const total = (await query("SELECT COUNT(*) c FROM firms")).rows[0].c;
  if (total <= 1) return res.fail("This is the only business on this installation", 400);
  const mine = (await query(
    "SELECT COUNT(*) c FROM memberships WHERE account_id = ? AND status = 'active'", [req.user.acct])).rows[0].c;
  if (mine <= 1) return res.fail("This is the only business you can open", 400);

  /* Ordered children-first. `sequences` and `firm_settings` go too, or the next
     company to take this id would inherit its invoice numbering. */
  for (const t of FIRM_TABLES) {
    try { await conn.query(`DELETE FROM ${t} WHERE firm_id = ?`, [firmId]); }
    catch (e) { if (!/no such table|no such column/i.test(e.message)) throw e; }
  }
  await conn.query("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE firm_id = ?)", [firmId]);
  await conn.query("DELETE FROM roles WHERE firm_id = ?", [firmId]);
  await conn.query("DELETE FROM memberships WHERE firm_id = ?", [firmId]);
  await conn.query("DELETE FROM invitations WHERE firm_id = ?", [firmId]);
  /* Staff whose only company this was are deactivated rather than deleted:
     their id is on audit rows and sales in other companies' history if they
     ever moved, and a dangling user id reads as "unknown" forever. */
  await conn.query("UPDATE users SET status = 'inactive', active_firm_id = NULL WHERE active_firm_id = ?", [firmId]);
  await conn.query("DELETE FROM firms WHERE id = ?", [firmId]);
  await revokeSessions({ firmId });
  /* Filed in the caller's own company, not in the one that has just been
     destroyed. An audit entry written into a deleted business is an entry
     nobody will ever read. */
  const auditNow = async () => await audit(req.user.firm_id, req.user.id, "delete", firmId, `${firm.name} — copy kept as ${keptAs}`);
  return async () => { await auditNow(); return res.success({ deleted: true, kept_as: keptAs },
    `${firm.name} deleted. A copy was kept as ${keptAs}.`); };
  });
});

module.exports = router;
