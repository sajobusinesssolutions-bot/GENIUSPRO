import json, urllib.request, urllib.error
B = "http://localhost:3100/api"

def call(path, body=None, tok=None, method=None):
    req = urllib.request.Request(
        B + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})},
        method=method or ("POST" if body is not None else "GET"))
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        try: return json.load(e)
        except Exception: return {"success": False, "message": f"HTTP {e.code}"}

def check(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail else ""))
    return cond

print("=" * 74)
print("COMPANIES — identity, access, isolation")
print("=" * 74)

# ── the migration adopted the shipped install; sign in the old way still works
old = call("/auth/login", {"username": "admin", "password": "admin123"})
check("username + password sign-in still works after the migration", old.get("success"), old.get("message"))
tok = old["data"]["token"]
GET  = lambda p: call(p, tok=tok)
POST = lambda p, b: call(p, b, tok)
PUT  = lambda p, b: call(p, b, tok, "PUT")
DEL  = lambda p, b=None: call(p, b if b is not None else {}, tok, "DELETE")

# ── sign in by email, using the adopted placeholder account
em = call("/auth/login-email", {"email": "admin@local.invalid", "password": "admin123"})
check("email sign-in works for the adopted account", em.get("success"), em.get("message"))
if em.get("success"):
    tok = em["data"]["token"]
    GET  = lambda p: call(p, tok=tok)
    POST = lambda p, b: call(p, b, tok)
    PUT  = lambda p, b: call(p, b, tok, "PUT")
    DEL  = lambda p, b=None: call(p, b if b is not None else {}, tok, "DELETE")
    acct = em["data"].get("account") or {}
    check("...and it carries the account's companies", bool(acct.get("companies")),
          f"{len(acct.get('companies') or [])} company, owner={acct.get('is_owner')}")

check("an unknown email is refused the same way as a wrong password",
      call("/auth/login-email", {"email": "nobody@example.com", "password": "x"}).get("message")
      == call("/auth/login-email", {"email": "admin@local.invalid", "password": "wrong"}).get("message"),
      call("/auth/login-email", {"email": "nobody@example.com", "password": "x"}).get("message"))

# ── the list
lst = GET("/companies")
check("the company list is reachable", lst.get("success"),
      f"{len(lst.get('data', {}).get('companies', []))} companies, can_create={lst.get('data', {}).get('can_create')}")

# ── create two more
b = POST("/companies", {"name": "Second Shop", "gstin": "TIN-002", "invoice_prefix": "SS"})
c = POST("/companies", {"name": "Third Shop", "invoice_prefix": "TS"})
check("a second company is created", b.get("success"), b.get("message"))
check("a third company is created", c.get("success"), c.get("message"))
B_ID = (b.get("data") or {}).get("id")
C_ID = (c.get("data") or {}).get("id")

check("a duplicate name on the same account is refused",
      not POST("/companies", {"name": "Second Shop"}).get("success"),
      POST("/companies", {"name": "Second Shop"}).get("message"))

# ── a new company is provisioned whole
if B_ID:
    sw = POST("/companies/switch", {"firm_id": B_ID})
    check("switching to it succeeds", sw.get("success"), sw.get("message"))
    # a switch changes the server-side active firm; re-issue the token
    em2 = call("/auth/login-email", {"email": "admin@local.invalid", "password": "admin123"})
    tok = em2["data"]["token"]
    GET  = lambda p: call(p, tok=tok)
    POST = lambda p, b: call(p, b, tok)
    PUT  = lambda p, b: call(p, b, tok, "PUT")
    DEL  = lambda p, b=None: call(p, b if b is not None else {}, tok, "DELETE")
    check("...and the session now opens it", em2["data"]["firm"]["id"] == B_ID,
          f"firm {em2['data']['firm']['id']} — {em2['data']['firm']['name']}")

    accts = GET("/accounting/accounts")
    n = len(accts.get("data") or [])
    check("the new company has its own chart of accounts", n > 10, f"{n} accounts")
    units = GET("/settings/units")
    check("...its own units", len(units.get("data") or []) >= 6, f"{len(units.get('data') or [])} units")
    parties = GET("/parties")
    check("...and a walk-in customer, so it can ring its first sale",
          any(p["name"] == "Cash Sale" for p in (parties.get("data") or [])))
    items = GET("/items")
    check("...and no stock from anybody else", len(items.get("data") or []) == 0,
          f"{len(items.get('data') or [])} items")

print()
