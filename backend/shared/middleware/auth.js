/**
 * auth.js — JWT verification + RBAC (blueprint §5.5).
 * Permissions are loaded from role_permissions and checked per route.
 * The client mirrors these for UX, but the server is the source of truth.
 */
const jwt = require("jsonwebtoken");
const { query } = require("../../database/db");
const tenancy = require("../../database/tenancy");

/* The secret that signs every session token. A working default is a trap: the
   app boots fine on a server with no JWT_SECRET set, and then anyone who has
   ever seen this source — including anyone who unzips the installer — can forge
   an admin token for any firm. So in production we refuse to start without one;
   in development we warn but allow a throwaway key so `npm start` still works. */
const SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET is not set (or is too short). Refusing to start.\n" +
      "Set a long random value, e.g.  JWT_SECRET=$(openssl rand -hex 32)"
    );
  }
  console.warn(
    "\n⚠  JWT_SECRET is unset — using an insecure development key.\n" +
    "   NEVER run a hosted/production server this way.\n"
  );
  return s || "dev-secret-change-me";
})();
const ACCESS_TTL = "2h";
const REFRESH_TTL = "30d";

/**
 * The token says who, as which role, in which company — and, for an email
 * account, which membership grants it.
 *
 * `acct` is the accounts row for an owner or admin signing in by email; it is
 * absent for counter staff, who sign in with a username and a PIN and belong
 * to one company. Both kinds carry `id` (the users row) so every existing
 * `req.user.id` consumer — audit rows, sales reps, held-bill claims — keeps
 * working untouched.
 */
function signAccess(user, extra = {}) {
  return jwt.sign(
    {
      id: user.id, username: user.username, role_id: user.role_id,
      firm_id: user.active_firm_id,
      ...(extra.accountId ? { acct: extra.accountId } : {}),
      ...(extra.jti ? { jti: extra.jti } : {}),
    },
    SECRET,
    { expiresIn: ACCESS_TTL }
  );
}
function signRefresh(user, extra = {}) {
  return jwt.sign(
    { id: user.id, t: "refresh", ...(extra.accountId ? { acct: extra.accountId } : {}), ...(extra.jti ? { jti: extra.jti } : {}) },
    SECRET, { expiresIn: REFRESH_TTL });
}

/**
 * Verify the token, then ask the database whether it still means anything.
 *
 * The version this replaces trusted the token completely — signature, expiry,
 * nothing else. That is fine on a single-firm installation where the only
 * things a token asserts are already true. It stops being fine the moment a
 * company can be suspended or somebody's access revoked, because neither would
 * take effect until the holder's token happened to expire, up to two hours
 * later. "Suspended" and "revoked" do not mean "in a couple of hours".
 *
 * So there are three checks per request, all of them local reads against an
 * in-memory database — round ten measured whole endpoints at single-digit
 * milliseconds, and these are indexed lookups by primary key:
 *
 *   1. the session has not been revoked   (sessions.revoked_at)
 *   2. the company is still active        (firms.status)
 *   3. the membership still stands        (memberships.status), for accounts
 *
 * Each failure says which, because "session expired" on a suspended company
 * sends a shopkeeper to reset a password that was never the problem.
 */
async function verifyToken(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.fail("Sign in to continue", 401);

  let claims;
  try { claims = jwt.verify(token, SECRET); }
  catch { return res.fail("Session expired", 401); }
  if (!claims.firm_id) return res.fail("No active business selected", 403);

  const firm = (await query("SELECT status FROM firms WHERE id = ?", [claims.firm_id])).rows[0];
  if (!firm) return res.fail("That business no longer exists", 403);
  if (firm.status !== "active") {
    return res.fail("This business has been suspended. Ask the administrator.", 403);
  }

  if (claims.acct) {
    const mem = (await query(
      "SELECT m.status, m.role_id, m.is_owner, a.status AS acct_status FROM memberships m " +
      "JOIN accounts a ON a.id = m.account_id WHERE m.account_id = ? AND m.firm_id = ?",
      [claims.acct, claims.firm_id])).rows[0];
    if (!mem || mem.status !== "active") {
      return res.fail("Your access to this business has been removed", 403);
    }
    if (mem.acct_status !== "active") return res.fail("This account has been suspended", 403);
    /* The role is read from the membership rather than the token, so changing
       somebody's role takes effect on their next request too. */
    claims.role_id = mem.role_id != null ? mem.role_id : claims.role_id;
    claims.is_owner = !!mem.is_owner;
  }

  /* Last, deliberately. Suspending a company and revoking access both end the
     holder's sessions, so if this ran first every one of those would answer
     "this session has been ended" — true, but it sends a shopkeeper to reset a
     password that was never the problem. Checking the company and the
     membership first means the reply names the actual reason, and a genuinely
     ended session (a sign-out, or a session ended by an administrator) still
     falls through to here and says so. */
  if (claims.jti) {
    const sess = (await query("SELECT revoked_at FROM sessions WHERE jti = ?", [claims.jti])).rows[0];
    /* An unknown jti is treated as revoked, not as absent. A token naming a
       session the server has no record of is either forged or survived a
       restore that rolled the sessions table back; neither is a session. */
    if (!sess || sess.revoked_at) return res.fail("This session has been ended. Sign in again.", 401);
  }

  req.user = claims;
  /* From here on, every statement this request runs knows which company it
     belongs to. With one file that is a no-op; with a file per company it is
     what routes the statement — and it is deliberately placed *after* the
     three checks above, so the storage layer is never the thing that decides
     which shop's books may be opened. */
  return tenancy.withFirm(claims.firm_id, next);
}

/** Every session for an account, or for one company, ended at once. */
async function revokeSessions({ accountId, firmId, userId }) {
  if (accountId) await query("UPDATE sessions SET revoked_at = datetime('now') WHERE account_id = ? AND revoked_at IS NULL", [accountId]);
  if (userId)    await query("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", [userId]);
  if (firmId) {
    await query(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND account_id IN " +
      "(SELECT account_id FROM memberships WHERE firm_id = ?)", [firmId]);
  }
}

/** Record a session so it can be ended later. Returns the jti to sign into the token. */
async function openSession({ accountId, userId }) {
  const jti = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  await query("INSERT INTO sessions (account_id, user_id, jti) VALUES (?,?,?)", [accountId || null, userId || null, jti]);
  return jti;
}

function requirePermission(module, action) {
  return async (req, res, next) => {
    /* The owner of a company is not blockable inside it. A role is a set of
       permissions an admin edits, and an owner edited out of their own books —
       by accident or by a disgruntled manager — is a support call with no
       resolution short of the database. */
    if (req.user && req.user.is_owner) return next();
    const { rows } = await query(
      "SELECT 1 FROM role_permissions WHERE role_id = ? AND module = ? AND action = ?",
      [req.user.role_id, module, action]
    );
    if (!rows.length) return res.fail(`Not allowed to ${action} ${module}`, 403);
    next();
  };
}

/**
 * The company owner can do anything inside their own company.
 *
 * Not a role: a role is a set of permissions an admin edits, and an owner who
 * could be edited out of managing their own business is a support call nobody
 * can resolve. `is_owner` is on the membership and is read from the database on
 * every request.
 */
function requireOwner(req, res, next) {
  if (req.user && req.user.is_owner) return next();
  return requirePermission("settings", "edit")(req, res, next);
}

module.exports = {
  signAccess, signRefresh, verifyToken, requirePermission, requireOwner,
  revokeSessions, openSession, SECRET,
};
