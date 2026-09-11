const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");

router.use(verifyToken);

const MODULES = ["parties", "items", "sales", "payments", "purchases", "expenses", "accounting", "reports", "settings", "users"];
const ACTIONS = ["view", "create", "edit", "delete"];

router.get("/matrix-meta", (req, res) => res.success({ modules: MODULES, actions: ACTIONS }));

/* The plain-English permission list the roles screen asks its questions from,
   plus which of them each role currently holds. Both come from one catalogue
   on the server, so the screen can never show a permission as allowed while
   the endpoint behind it refuses. */
const CAT = require("../../shared/permission.catalogue");

router.get("/permission-catalogue", requirePermission("users", "view"), async (req, res) => {
  const roles = (await query("SELECT * FROM roles WHERE firm_id = ? OR firm_id IS NULL ORDER BY id", [req.user.firm_id])).rows;
  for (const r of roles) {
    const pairs = (await query("SELECT module, action FROM role_permissions WHERE role_id = ?", [r.id])).rows;
    r.granted = CAT.readableFor(pairs);
    r.pair_count = pairs.length;
    r.orphans = CAT.orphanPairs(pairs);
    r.user_count = (await query("SELECT COUNT(*) n FROM users WHERE role_id = ? AND COALESCE(status,'active') = 'active'", [r.id])).rows[0].n;
  }
  res.success({
    groups: CAT.CATALOGUE.map(([group, rows]) => ({
      group,
      rows: rows.map(([id, label, note, grants, askable]) => ({ id, label, note, askable: !!askable })),
    })),
    roles,
  });
});

/* The same permissions as a grid — one card per area of the app, a box per
   action — for the times a single cell is what you are after. Ships the raw
   `module.action` pairs each role holds, because the grid edits those
   directly rather than going through the readable questions. */
router.get("/permission-grid", requirePermission("users", "view"), async (req, res) => {
  const roles = (await query("SELECT * FROM roles WHERE firm_id = ? OR firm_id IS NULL ORDER BY id",
    [req.user.firm_id])).rows;
  for (const r of roles) {
    r.permissions = (await query("SELECT module, action FROM role_permissions WHERE role_id = ?", [r.id])).rows
      /* Pairs nothing enforces are seeded leftovers. Showing them would mean
         drawing boxes the grid cannot draw, and counting them in a tally that
         says how much this role may do. */
      .filter((p) => CAT.GRID_PAIRS.has(`${p.module}.${p.action}`));
    r.user_count = (await query("SELECT COUNT(*) n FROM users WHERE role_id = ? AND COALESCE(status,'active') = 'active'",
      [r.id])).rows[0].n;
  }
  res.success({
    modules: CAT.GRID.map((m) => ({
      id: m.id, label: m.label, note: m.note, screens: m.screens,
      actions: m.actions.map(([action, label, note]) => ({ action, label, note })),
    })),
    roles,
  });
});

/* Save a role from the readable list. The pairs are worked out here rather
   than sent up, so a screen cannot grant something the catalogue does not. */
router.put("/roles/:id/catalogue", requirePermission("users", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const roleId = Number(req.params.id);
    const role = (await conn.query("SELECT * FROM roles WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)",
      [roleId, req.user.firm_id])).rows[0];
    if (!role) return res.fail("Role not found", 404);

    const ids = Array.isArray(req.body.granted) ? req.body.granted : [];
    const pairs = CAT.pairsFor(ids);

    /* A firm that locks itself out of user administration cannot get back in
       without a developer. Refuse to take the last route in. */
    if (role.is_system && !ids.includes("set_users")) {
      const others = (await conn.query(
        `SELECT COUNT(*) n FROM roles r
          WHERE (r.firm_id = ? OR r.firm_id IS NULL) AND r.id <> ?
            AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module='users' AND p.action='edit')`,
        [req.user.firm_id, roleId])).rows[0].n;
      if (!others) return res.fail("Someone has to be able to manage users — this is the last role that can");
    }

    await conn.beginTransaction();
    await conn.query("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
    for (const p of pairs) {
      await conn.query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [roleId, p.module, p.action]);
    }
    await conn.commit();
    res.success({ granted: ids.length, pairs: pairs.length }, "Role saved");
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/* Ready-made permission sets for the roles the setup wizard offers. */
const ROLE_PRESETS = {
  cashier: {
    name: "Cashier",
    perms: [["parties", "view"], ["parties", "create"], ["items", "view"],
            ["sales", "view"], ["sales", "create"], ["payments", "view"], ["payments", "create"]],
  },
  manager: {
    name: "Manager",
    // everything except user administration
    perms: MODULES.filter((m) => m !== "users").flatMap((m) => ACTIONS.map((a) => [m, a])),
  },
};

/**
 * Resolve a role for a new user.
 *
 * Callers may pass a numeric role_id or a role name ("cashier", "Manager", …).
 * The wizard passed a name, which the old code ignored — the account was
 * created with role_id NULL, so the person could log in but had no permissions
 * at all and was bounced straight back to the login screen. Anything we can't
 * resolve is now an error rather than a silently useless account.
 */
/* `conn` is the open transaction, and every write below must go through it.
 * Creating a role with the plain `query()` while a transaction is open writes
 * outside it: on the failure path the new role survives a rollback, and on
 * the success path the storage layer can be asked to save a database that is
 * mid-transaction. Creating the very first Cashier — which is exactly what
 * the setup wizard's last step does — is the request that hits it. */
async function resolveRoleId(conn, firmId, body) {
  if (body.role_id) {
    const r = (await query("SELECT id FROM roles WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)", [body.role_id, firmId])).rows[0];
    return r ? r.id : null;
  }
  const raw = String(body.role || "").trim();
  if (!raw) return null;
  const exact = (await query("SELECT id FROM roles WHERE firm_id = ? AND LOWER(name) = LOWER(?)", [firmId, raw])).rows[0];
  if (exact) return exact.id;
  const preset = ROLE_PRESETS[raw.toLowerCase()];
  if (!preset) return null;
  const byPresetName = (await query("SELECT id FROM roles WHERE firm_id = ? AND LOWER(name) = LOWER(?)", [firmId, preset.name])).rows[0];
  if (byPresetName) return byPresetName.id;
  await conn.query("INSERT INTO roles (firm_id, name, is_system) VALUES (?,?,0)", [firmId, preset.name]);
  const id = (await query("SELECT id FROM roles WHERE firm_id = ? AND name = ?", [firmId, preset.name])).rows[0].id;
  for (const [m, a] of preset.perms) {
    try { await conn.query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [id, m, a]); } catch {}
  }
  return id;
}

/* Sales-rep picker list — id + name only, available to any signed-in user.
   A cashier needs this to attribute a sale, but shouldn't need users.view (which
   would expose the whole staff admin screen). Deliberately minimal fields. */
router.get("/reps", async (req, res) => {
  const rows = (await query(
    `SELECT id, COALESCE(full_name, username) AS full_name, username, status
       FROM users WHERE active_firm_id = ? AND status = 'active' ORDER BY full_name`,
    [req.user.firm_id])).rows;
  res.success(rows);
});

/* Users in this firm */
router.get("/", requirePermission("users", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.status, r.name AS role_name, u.role_id,
            CASE WHEN u.pin_hash IS NOT NULL AND u.pin_hash <> '' THEN 1 ELSE 0 END AS has_pin
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.active_firm_id = ? ORDER BY u.id`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

router.post("/", requirePermission("users", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  if (!b.username || !b.password) return res.fail("Username and password required");
  if ((await query("SELECT 1 FROM users WHERE username = ?", [b.username])).rows.length) return res.fail("Username taken");
  const roleId = await resolveRoleId(conn, req.user.firm_id, b);
  if (!roleId) return res.fail("Pick a role for this login — an account with no role can't sign in");
  await conn.query(
    `INSERT INTO users (username, password_hash, full_name, email, phone, role_id, active_firm_id, status)
     VALUES (?,?,?,?,?,?,?, 'active')`,
    [b.username, bcrypt.hashSync(b.password, 10), b.full_name || null, b.email || null, b.phone || null, roleId, req.user.firm_id]
  );
  return () => res.success({ ok: true, role_id: roleId }, "User created");
}));

/* Details and password change together: a password saved without the role
   change beside it is a login with the wrong permissions. */
router.put("/:id", requirePermission("users", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const id = req.params.id;
  const u = (await query("SELECT * FROM users WHERE id = ? AND active_firm_id = ?", [id, req.user.firm_id])).rows[0];
  if (!u) return res.notFound("User not found");
  await conn.query("UPDATE users SET full_name = ?, email = ?, phone = ?, role_id = ?, status = ? WHERE id = ?",
    [b.full_name ?? u.full_name, b.email ?? u.email, b.phone ?? u.phone, b.role_id ?? u.role_id, b.status ?? u.status, id]);
  if (b.password) await conn.query("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(b.password, 10), id]);
  return () => res.success({ ok: true }, "User updated");
}));

/**
 * Remove a staff account.
 *
 * Accounts could be switched off but never removed, so a shop that took on
 * four students over Christmas carried four dead logins for ever — and
 * `users.delete` was a permission the grid could not even offer, because
 * nothing enforced it.
 *
 * What "remove" means here matters. A person who has SOLD something is not
 * deleted: their id is on every invoice they rang up, on the shift they
 * closed, on the audit trail, and removing the row would leave those documents
 * attributed to nobody. That account is retired instead — switched off,
 * released from its role, and its username freed so it can be reissued. Only
 * an account that never did anything is actually deleted, because there is
 * nothing to orphan.
 *
 * Two refusals, both about locking the shop out of itself: nobody may remove
 * their own account, and the last login that can manage users may not go.
 */
router.delete("/:id", requirePermission("users", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const id = Number(req.params.id);
  const u = (await query("SELECT * FROM users WHERE id = ? AND active_firm_id = ?", [id, firmId])).rows[0];
  if (!u) return res.fail("User not found", 404);
  if (id === Number(req.user.id)) {
    return res.fail("You cannot remove the account you are signed in with — ask another administrator");
  }
  if (u.is_owner) return res.fail("The owner's account cannot be removed");

  /* Would this take away the last login that can manage staff and roles? */
  const canManage = async (uid) => (await query(
    `SELECT 1 FROM users x JOIN role_permissions p ON p.role_id = x.role_id
      WHERE x.id = ? AND p.module='users' AND p.action='edit'`, [uid])).rows[0];
  if (await canManage(id)) {
    const others = (await query(
      `SELECT COUNT(*) n FROM users x JOIN role_permissions p ON p.role_id = x.role_id
        WHERE x.active_firm_id = ? AND x.id <> ? AND COALESCE(x.status,'active') = 'active'
          AND p.module='users' AND p.action='edit'`, [firmId, id])).rows[0].n;
    if (!others) return res.fail("Someone has to be able to manage staff and roles — this is the last account that can");
  }

  /* Anything at all with this person's name on it. */
  const traces = (await query(
    `SELECT (SELECT COUNT(*) FROM sale_invoices WHERE firm_id=? AND (created_by=? OR sales_rep_id=?))
          + (SELECT COUNT(*) FROM purchase_invoices WHERE firm_id=? AND created_by=?)
          + (SELECT COUNT(*) FROM payments WHERE firm_id=? AND created_by=?)
          + (SELECT COUNT(*) FROM expenses WHERE firm_id=? AND created_by=?)
          + (SELECT COUNT(*) FROM shifts WHERE firm_id=? AND user_id=?) AS n`,
    [firmId, id, id, firmId, id, firmId, id, firmId, id, firmId, id])).rows[0].n;

  if (traces > 0) {
    /* Retired, not deleted. The username is freed by suffixing it, so the same
       person can be taken back on with their own name later, and the old
       documents still resolve to this row. */
    const freed = `${u.username}~${Date.now().toString(36)}`;
    await conn.query("UPDATE users SET status='removed', username=?, role_id=NULL, pin_hash=NULL WHERE id=?", [freed, id]);
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "users", "retire", id, `${u.username} retired — ${traces} document(s) keep their name`]);
    return () => res.success({ id, retired: true, documents: traces },
      `${u.full_name || u.username} removed. ${traces} document${traces === 1 ? "" : "s"} still carry their name, so the record is kept rather than erased — the login no longer works and the username is free again.`);
  }

  await conn.query("DELETE FROM users WHERE id = ? AND active_firm_id = ?", [id, firmId]);
  await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
    [req.user.id, "users", "delete", id, u.username]);
  return () => res.success({ id, deleted: true }, `${u.full_name || u.username} removed`);
}));

/* Roles + permission matrix */
/* Set or clear someone's counter PIN. Hashed, never returned, and only ever
   set by someone who can manage users — a PIN you can read off a screen is
   not a PIN. */
router.put("/:id/pin", requirePermission("users", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const pin = String((req.body || {}).pin || "").trim();
  /* Scoped to the caller's own business in the statement itself. Unscoped, an
     id belonging to another business matched, and setting a PIN there is a way
     in: PIN sign-in asks for a username and four digits and nothing else. */
  const user = (await query("SELECT id, username FROM users WHERE id = ? AND active_firm_id = ?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!user) return res.fail("User not found", 404);

  if (pin === "") {
    await conn.query("UPDATE users SET pin_hash = NULL WHERE id = ?", [user.id]);
    return () => res.success({ id: user.id, has_pin: false }, "PIN removed");
  }
  if (!/^\d{4}$/.test(pin)) return res.fail("A PIN is exactly four digits");
  /* Four digits in a row, or four the same, are the ones people actually
     choose and the ones anyone would try first. */
  if (/^(\d)\1{3}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
    return res.fail("Pick a less obvious PIN — that is one of the first anyone would try");
  }
  await conn.query("UPDATE users SET pin_hash = ? WHERE id = ?", [bcrypt.hashSync(pin, 10), user.id]);
  return () => res.success({ id: user.id, has_pin: true }, "PIN set");
}));

router.get("/roles", requirePermission("users", "view"), async (req, res) => {
  const roles = (await query("SELECT * FROM roles WHERE firm_id = ? OR firm_id IS NULL ORDER BY id", [req.user.firm_id])).rows;
  for (const r of roles) {
    r.permissions = (await query("SELECT module, action FROM role_permissions WHERE role_id = ?", [r.id])).rows;
  }
  res.success(roles);
});

/* Create a role.
 *
 * `copy_from` is the difference between this being useful and being a chore:
 * a new role almost always starts life as "the same as Cashier, but also
 * allowed to take a return". Starting from an empty permission set means
 * thirty boxes before the role can do anything, and the screen that follows
 * looks broken until they are all ticked. */
router.post("/roles", requirePermission("users", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  if (!name) return res.fail("Role name required");
  if (name.length > 60) return res.fail("That name is too long — keep it under 60 characters");

  /* Two roles with the same name in one business is two rows nobody can tell
     apart on the staff form, where a role is chosen by its name alone. */
  const clash = (await conn.query(
    "SELECT id FROM roles WHERE (firm_id = ? OR firm_id IS NULL) AND LOWER(name) = LOWER(?)",
    [req.user.firm_id, name])).rows[0];
  if (clash) return res.fail(`There is already a role called “${name}”`);

  const r = await conn.query("INSERT INTO roles (firm_id, name, is_system) VALUES (?,?,0)", [req.user.firm_id, name]);

  const from = Number(body.copy_from || 0);
  if (from) {
    /* Only from a role this business may actually see — otherwise the id is
       taken on trust and one firm's permission set could be read into
       another's. Same rule as everywhere else on this router. */
    const src = (await conn.query("SELECT id FROM roles WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)",
      [from, req.user.firm_id])).rows[0];
    if (src) {
      const perms = (await conn.query("SELECT module, action FROM role_permissions WHERE role_id = ?", [src.id])).rows;
      for (const p of perms) {
        await conn.query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)",
          [r.insertId, p.module, p.action]);
      }
    }
  }
  return () => res.success({ id: r.insertId }, "Role created");
}));

/* Rename. Built-in roles keep their names: Admin and Cashier are referred to
   by name in the sign-in screen's hint and in the seed data, and a firm that
   renamed Admin to "Bob" would be reading about a role that no longer exists. */
router.put("/roles/:id", requirePermission("users", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const roleId = Number(req.params.id);
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.fail("Role name required");
  if (name.length > 60) return res.fail("That name is too long — keep it under 60 characters");

  const role = (await conn.query("SELECT * FROM roles WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)",
    [roleId, req.user.firm_id])).rows[0];
  if (!role) return res.fail("Role not found", 404);
  if (role.is_system) return res.fail("Built-in roles keep their names. Copy it to a new role instead");

  const clash = (await conn.query(
    "SELECT id FROM roles WHERE (firm_id = ? OR firm_id IS NULL) AND id <> ? AND LOWER(name) = LOWER(?)",
    [req.user.firm_id, roleId, name])).rows[0];
  if (clash) return res.fail(`There is already a role called “${name}”`);

  await conn.query("UPDATE roles SET name = ? WHERE id = ?", [name, roleId]);
  return () => res.success({ id: roleId, name }, "Role renamed");
}));

/* Delete. Refused while anyone is on it — a user row pointing at a role that
   is gone is a person who can sign in and do nothing, with no screen that
   explains why. */
router.delete("/roles/:id", requirePermission("users", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const roleId = Number(req.params.id);
  const role = (await conn.query("SELECT * FROM roles WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)",
    [roleId, req.user.firm_id])).rows[0];
  if (!role) return res.fail("Role not found", 404);
  if (role.is_system) return res.fail("Built-in roles cannot be deleted");

  const n = (await conn.query("SELECT COUNT(*) n FROM users WHERE role_id = ?", [roleId])).rows[0].n;
  if (n) return res.fail(`${n} ${n === 1 ? "person is" : "people are"} on this role. Move them to another role first`);

  await conn.query("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
  await conn.query("DELETE FROM roles WHERE id = ?", [roleId]);
  return () => res.success({ ok: true }, "Role deleted");
}));

router.put("/roles/:id/permissions", requirePermission("users", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const roleId = Number(req.params.id);
    /* The role must be one this business can actually administer. Without this
       check the id was taken on trust, so anyone signed in anywhere could
       rewrite — or empty — another business's Admin role and lock its owner
       out of their own books. Same rule as /roles/:id/catalogue. */
    const role = (await conn.query("SELECT id FROM roles WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)",
      [roleId, req.user.firm_id])).rows[0];
    if (!role) return res.fail("Role not found", 404);

    const perms = (Array.isArray(req.body.permissions) ? req.body.permissions : [])
      /* Checked against the catalogue, not against a MODULES × ACTIONS square.
         The square was missing `companies` entirely, so every companies
         permission set from the grid was accepted, dropped on the way to the
         table, and came back off — the screen said saved and nothing had
         been. It also let through pairs nothing in the app enforces. */
      .filter((p) => p && CAT.GRID_PAIRS.has(`${p.module}.${p.action}`));

    /* The same guard the readable list has, and for the same reason: a firm
       that takes user administration off its last role cannot get it back
       without a developer. This endpoint had no such guard, so the grid could
       do in one click what the questions screen refuses. */
    const keepsUsers = perms.some((p) => p.module === "users" && p.action === "edit");
    if (!keepsUsers) {
      const others = (await conn.query(
        `SELECT COUNT(*) n FROM roles r
          WHERE (r.firm_id = ? OR r.firm_id IS NULL) AND r.id <> ?
            AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module='users' AND p.action='edit')`,
        [req.user.firm_id, roleId])).rows[0].n;
      if (!others) return res.fail("Someone has to be able to manage staff and roles — this is the last role that can");
    }

    await conn.beginTransaction();
    await conn.query("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
    for (const p of perms) {
      await conn.query("INSERT INTO role_permissions (role_id, module, action) VALUES (?,?,?)", [roleId, p.module, p.action]);
    }
    await conn.commit();
    res.success({ ok: true }, "Permissions saved");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

module.exports = router;
