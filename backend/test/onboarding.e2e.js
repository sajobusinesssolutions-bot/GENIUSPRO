/**
 * onboarding.e2e.js — session 7 against a running server.
 *
 * Not part of `npm test`: it needs a server and a throwaway database. Run it
 * the way the session report did —
 *
 *   GENIUS_DB_PATH=/tmp/s7.db JWT_SECRET=… PORT=4177 EMAIL_PROVIDER=console node server.js
 *   node test/onboarding.e2e.js http://localhost:4177 /tmp/s7.log
 *
 * The codes are read back out of the server's own log, because with
 * EMAIL_PROVIDER=console that log IS the delivery mechanism. That is also the
 * point: nothing in this file can see the code any other way, which is what
 * makes the assertions about hashing and single use mean something.
 */
const fs = require("fs");

const BASE = process.argv[2] || "http://localhost:4177";
const LOG = process.argv[3] || "/tmp/s7.log";

let pass = 0, fail = 0;
const ok = (name, cond, note = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${note ? "  " + note : ""}`); }
  else { fail++; console.log(`  ✗ ${name}  ${note}`); }
};
const head = (s) => console.log(`\n── ${s}`);

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: json, message: json && json.message, data: json && json.data };
}
const GET = (p, t) => call("GET", p, undefined, t);
const POST = (p, b, t) => call("POST", p, b, t);
const DEL = (p, t) => call("DELETE", p, undefined, t);

/** The last six-digit code sent to this address, read out of the log. */
function codeFor(email) {
  const log = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`┌─ email → ${email.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\n│\\s+(\\d{6}) is your`, "g");
  let m, last = null;
  while ((m = re.exec(log))) last = m[1];
  return last;
}

const stamp = Date.now().toString(36);
const OWNER = `owner.${stamp}@example.test`;
const STAFF = `staff.${stamp}@example.test`;
const PW = "shopkeeper-2026";

(async () => {
  head("Sign up");
  let r = await POST("/api/auth/signup", { email: OWNER, password: PW, full_name: "Aisha Nakato" });
  ok("sign-up is accepted", r.status === 200, r.message);
  const firstAnswer = r.message;
  ok("…and does not say whether the address was known", /a six-digit code is on its way/i.test(r.message || ""));

  r = await POST("/api/auth/signup", { email: OWNER, password: "short" });
  ok("a weak password is refused", r.status === 400, r.message);

  r = await POST("/api/auth/signup", { email: "not-an-address", password: PW, full_name: "X" });
  ok("a malformed address is refused", r.status === 400, r.message);

  head("Verify");
  const code = codeFor(OWNER);
  ok("a code was sent", !!code, code ? "six digits" : "none found in the log");

  r = await POST("/api/auth/verify", { email: OWNER, code: "000000" });
  ok("a wrong code is refused", r.status === 400, r.message);
  ok("…and says how many tries are left", /tries left/i.test(r.message || ""), r.message);

  r = await POST("/api/auth/verify", { email: OWNER, code });
  ok("the right code is accepted", r.status === 200, r.message);
  ok("…and there is no session yet, because there is no business", !!(r.data && r.data.needs_company && r.data.ticket));
  const ticket = r.data && r.data.ticket;

  r = await POST("/api/auth/verify", { email: OWNER, code });
  ok("the same code cannot be used twice", r.status === 400, r.message);

  head("The first business");
  r = await POST("/api/auth/first-company", { ticket, name: `Nakato Stores ${stamp}`, state_code: "UG" });
  ok("the business is created", r.status === 200, r.message);
  const session = r.data || {};
  ok("…and it hands back a working session", !!session.token);
  ok("…with the account marked owner", !!(session.account && session.account.is_owner));
  ok("…and one company on the account", session.account && session.account.companies.length === 1);
  const firmId = session.firm && session.firm.id;

  r = await GET("/api/items", session.token);
  ok("the session opens the app", r.status === 200);

  r = await POST("/api/auth/first-company", { ticket, name: "A second one" });
  ok("the ticket cannot be replayed to mint another business", r.status === 409, r.message);

  head("Sign-up cannot be used as a password reset");
  r = await POST("/api/auth/signup", { email: OWNER, password: "attacker-chosen-pw", full_name: "Not Aisha" });
  ok("signing up with a taken address answers exactly as before", r.message === firstAnswer, r.message);
  r = await POST("/api/auth/login-email", { email: OWNER, password: "attacker-chosen-pw" });
  ok("…and the password was NOT changed", r.status === 401, r.message);
  r = await POST("/api/auth/login-email", { email: OWNER, password: PW });
  ok("…the real password still works", r.status === 200, r.message);
  const owner = r.data;

  head("Invite somebody who has no account");
  r = await POST(`/api/companies/${firmId}/invitations`, { email: STAFF, full_name: "Brian Okello" }, owner.token);
  ok("the invitation is created", r.status === 200, r.message);
  const url = r.data && r.data.url;
  ok("…and returns the link when no mail provider is configured", !!url);
  const token = url && url.split("/").pop();

  r = await GET(`/api/auth/invitation/${token}`);
  ok("the link says which business it is for", r.status === 200 && !!r.data.company, r.data && r.data.company);
  ok("…and that this person has no account yet", r.data && r.data.have_account === false);

  r = await POST("/api/auth/invitation/accept", { token, password: "x" });
  ok("a weak password is refused on accept", r.status === 400, r.message);

  r = await POST("/api/auth/invitation/accept", { token, password: "counter-staff-2026", full_name: "Brian Okello" });
  ok("accepting creates the account and the membership", r.status === 200, r.message);
  const staff = r.data || {};
  ok("…and signs them straight in", !!staff.token);
  ok("…not as an owner", !!(staff.account && staff.account.is_owner === false));

  r = await POST("/api/auth/invitation/accept", { token, password: "counter-staff-2026" });
  ok("an invitation is single-use", r.status === 400, r.message);

  r = await POST("/api/auth/login-email", { email: STAFF, password: "counter-staff-2026" });
  ok("the invited person can sign in afterwards", r.status === 200, r.message);
  ok("…and sees exactly one business", r.data && r.data.account.companies.length === 1);

  head("Withdrawing an invitation");
  const gone = `gone.${stamp}@example.test`;
  r = await POST(`/api/companies/${firmId}/invitations`, { email: gone }, owner.token);
  const goneUrl = r.data && r.data.url;
  const list = await GET(`/api/companies/${firmId}/invitations`, owner.token);
  const row = (list.data || []).find((i) => i.email === gone);
  ok("it is listed as outstanding", !!row && !row.accepted_at && !row.revoked_at);
  r = await DEL(`/api/companies/${firmId}/invitations/${row.id}`, owner.token);
  ok("it can be withdrawn", r.status === 200, r.message);
  r = await GET(`/api/auth/invitation/${goneUrl.split("/").pop()}`);
  ok("…and the link stops working", r.status === 400, r.message);

  head("Forgotten password");
  r = await POST("/api/auth/forgot", { email: `nobody.${stamp}@example.test` });
  ok("an unknown address gets the same answer", r.status === 200 && /code is on its way/i.test(r.message));
  r = await POST("/api/auth/forgot", { email: OWNER });
  ok("a known address gets the same answer", r.status === 200 && /code is on its way/i.test(r.message));
  const reset = codeFor(OWNER);
  ok("a reset code was sent", !!reset && reset !== code);

  r = await POST("/api/auth/reset", { email: OWNER, code: "111111", password: "brand-new-password" });
  ok("a wrong reset code is refused", r.status === 400, r.message);
  r = await POST("/api/auth/reset", { email: OWNER, code: reset, password: "brand-new-password" });
  ok("the right one changes the password", r.status === 200, r.message);

  r = await GET("/api/items", owner.token);
  ok("**every existing session is ended by the reset**", r.status === 401, r.message);
  r = await POST("/api/auth/refresh", { refresh: owner.refresh });
  ok("**and the refresh token cannot walk past it**", r.status === 401, r.message);

  r = await POST("/api/auth/login-email", { email: OWNER, password: PW });
  ok("the old password no longer works", r.status === 401, r.message);
  r = await POST("/api/auth/login-email", { email: OWNER, password: "brand-new-password" });
  ok("the new one does", r.status === 200, r.message);
  const owner2 = r.data;

  head("Changing a password from inside");
  r = await POST("/api/auth/change-password", { current: "wrong", password: "another-password-1" }, owner2.token);
  ok("the current password is required", r.status === 401, r.message);
  r = await POST("/api/auth/change-password", { current: "brand-new-password", password: "another-password-1" }, owner2.token);
  ok("with it, the password changes", r.status === 200, r.message);
  r = await GET("/api/items", owner2.token);
  ok("…and the session doing the changing keeps working", r.status === 200);

  head("Guessing a code");
  const guess = `guess.${stamp}@example.test`;
  await POST("/api/auth/signup", { email: guess, password: PW, full_name: "Guessy" });
  const real = codeFor(guess);
  let burned = null;
  for (let i = 1; i <= 6 && burned === null; i++) {
    const g = await POST("/api/auth/verify", { email: guess, code: String(100000 + i) });
    if (/last try|Ask for a new code/i.test(g.message || "")) burned = i;
  }
  ok("wrong codes are counted and the code is burned", burned === 5, `after ${burned} tries`);
  r = await POST("/api/auth/verify", { email: guess, code: real });
  ok("**the real code no longer works after the guess limit**", r.status === 400, r.message);

  head("Throttling one account");
  const hammered = `hammer.${stamp}@example.test`;
  let got429 = 0, attempts = 0;
  for (let i = 0; i < 12; i++) {
    attempts++;
    const a = await POST("/api/auth/login-email", { email: hammered, password: "guess" + i });
    if (a.status === 429) { got429 = attempts; break; }
  }
  ok("repeated sign-in attempts on one address are refused", got429 > 0 && got429 <= 10, `429 on attempt ${got429}`);
  r = await POST("/api/auth/login-email", { email: OWNER, password: "another-password-1" });
  ok("…and a different account is unaffected", r.status === 200, r.message);
  const owner3 = r.data;

  head("Handing the business over");
  const people = await GET(`/api/companies/${firmId}/people`, owner3.token);
  const brian = (people.data || []).find((p) => p.email === STAFF);
  ok("the invited person appears in the people list", !!brian);

  /* Brian is given the Admin role first, deliberately.
     The first version of this check ran as a person with no `companies.grant`
     at all, so the 403 it asserted came from the permission gate and said
     nothing whatever about ownership — it would have passed with the owner
     check deleted. Being an administrator of a business and owning it are
     different things, and this is the pair that tells them apart. */
  const roles = await GET("/api/users/roles", owner3.token);
  const adminRole = (roles.data || []).find((x) => x.name === "Admin" && x.firm_id === firmId)
    || (roles.data || []).find((x) => x.name === "Admin");
  r = await POST(`/api/companies/${firmId}/people`, { email: STAFF, role_id: adminRole && adminRole.id }, owner3.token);
  ok("the owner can make them an administrator", r.status === 200, r.message);
  r = await POST("/api/auth/login-email", { email: STAFF, password: "counter-staff-2026" });
  const admin = r.data;
  const check = await POST(`/api/companies/${firmId}/invitations`, { email: `x.${stamp}@example.test` }, admin.token);
  ok("…and an administrator really does hold companies.grant", check.status === 200, check.message);
  r = await POST(`/api/companies/${firmId}/people/${brian.account_id}/owner`, {}, admin.token);
  ok("**an administrator still cannot hand the business to themselves**", r.status === 403, r.message);
  ok("…refused for ownership, not for permission", /owner/i.test(r.message || ""), r.message);
  r = await POST(`/api/companies/${firmId}/invitations`, { email: `own.${stamp}@example.test`, is_owner: true }, admin.token);
  ok("**nor invite a second owner**", r.status === 403, r.message);
  r = await POST(`/api/companies/${firmId}/people/${brian.account_id}/owner`, {}, owner3.token);
  ok("the owner can", r.status === 200, r.message);
  r = await GET("/api/items", owner3.token);
  ok("…and both parties are signed out", r.status === 401, r.message);
  r = await POST("/api/auth/login-email", { email: STAFF, password: "counter-staff-2026" });
  ok("the new owner is an owner", r.status === 200 && r.data.account.is_owner === true, r.message);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
