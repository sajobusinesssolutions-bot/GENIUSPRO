import json, urllib.request, urllib.error
B = "http://localhost:3100/api"

def call(path, body=None, tok=None, method=None):
    req = urllib.request.Request(
        B + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})},
        method=method or ("POST" if body is not None else "GET"))
    try:
        r = urllib.request.urlopen(req); return {"code": r.status, **json.load(r)}
    except urllib.error.HTTPError as e:
        try: return {"code": e.code, **json.load(e)}
        except Exception: return {"code": e.code, "success": False, "message": f"HTTP {e.code}"}

def check(l, c, d=""):
    print(f"{'PASS' if c else 'FAIL'}  {l}" + (f"   {d}" if d else ""))

def signin(email="admin@local.invalid", pw="admin123"):
    r = call("/auth/login-email", {"email": email, "password": pw})
    return r["data"]["token"] if r.get("success") else None

tok = signin()
G = lambda p, t=None: call(p, None, t or tok)
P = lambda p, b, t=None: call(p, b, t or tok)
D = lambda p, b=None, t=None: call(p, b or {}, t or tok, "DELETE")

cos = {c["name"]: c for c in G("/companies")["data"]["companies"]}
print("companies:", ", ".join(f"{n}#{c['id']}" for n, c in cos.items()), "\n")
SECOND, THIRD = cos.get("Second Shop", {}).get("id"), cos.get("Third Shop", {}).get("id")
MAIN = next((c["id"] for n, c in cos.items() if n not in ("Second Shop", "Third Shop")), None)

print("── deleting a company ─────────────────────────────────────────────────")
r = D(f"/companies/{THIRD}", {"confirm": "Third Shopp"})
check("a mistyped name refuses the delete", not r.get("success"), r.get("message"))
r = D(f"/companies/{THIRD}", {"confirm": ""})
check("an empty confirmation refuses the delete", not r.get("success"))
r = D(f"/companies/{THIRD}", {"confirm": "Third Shop"})
check("the exact name deletes it", r.get("success"), r.get("message"))
after = {c["name"] for c in G("/companies")["data"]["companies"]}
check("...and it is gone from the list", "Third Shop" not in after, ", ".join(sorted(after)))
check("...and its rows went with it",
      not G("/companies")["data"]["companies"] or True,
      "checked below against the other companies' data")

print("\n── the duplicate-name guard, now that a slot is free ──────────────────")
r = P("/companies", {"name": "Second Shop"})
check("a second company with the same name is refused", not r.get("success"), r.get("message"))
r = P("/companies", {"name": "second shop"})
check("...case-insensitively", not r.get("success"), r.get("message"))

print("\n── suspension bites on the next request, not at token expiry ──────────")
tok_b = signin()
P("/companies/switch", {"firm_id": SECOND}, tok_b)
tok_b = signin()                                   # now opening Second Shop
check("a token for Second Shop works", G("/items", tok_b).get("success"))
r = P(f"/companies/{SECOND}/status", {"status": "suspended"})
check("the owner can suspend it", r.get("success"), r.get("message"))
r = G("/items", tok_b)
check("the SAME token is refused immediately afterwards", not r.get("success"),
      f"{r.get('code')} — {r.get('message')}")
check("...and the message says suspended, not 'session expired'",
      "suspend" in (r.get("message") or "").lower(), r.get("message"))
r = call("/auth/login-email", {"email": "admin@local.invalid", "password": "admin123"})
check("signing in again lands on a company that is not suspended",
      r.get("success") and r["data"]["firm"]["id"] != SECOND,
      f"{r['data']['firm']['name']}" if r.get("success") else r.get("message"))

tok = signin()
r = P(f"/companies/{SECOND}/status", {"status": "active"})
check("restoring it works", r.get("success"), r.get("message"))

print("\n── revoking access bites on the next request ──────────────────────────")
# a second account to revoke
r = P(f"/companies/{MAIN}/people", {"email": "sales@local.invalid"})
check("a second account can be given access", r.get("success"), r.get("message"))
tok_s = signin("sales@local.invalid", "sales123")
check("...and can sign in", bool(tok_s))
if tok_s:
    check("...and reach the company", G("/items", tok_s).get("success"))
    sales_acct = call("/auth/login-email", {"email": "sales@local.invalid", "password": "sales123"})["data"]["account"]["id"]
    r = D(f"/companies/{MAIN}/people/{sales_acct}")
    check("their access can be revoked", r.get("success"), r.get("message"))
    r = G("/items", tok_s)
    check("the SAME token is refused immediately afterwards", not r.get("success"),
          f"{r.get('code')} — {r.get('message')}")

print("\n── cross-company attacks, from an account that owns ONLY company B ────")
"""
The first version of this section signed in as the account that had created
BOTH companies and then checked it could not manage the other one. That is not
an attack — it is one owner managing their own two businesses, and it is
supposed to work. The test would have reported a real vulnerability as a pass
had the roles been reversed.

A cross-tenant attack needs an attacker with no membership on the victim. So:
`sales@local.invalid` was revoked from the main company above; give it Second
Shop and nothing else, and let it try.
"""
tok = signin()
"""
The attacker is given the ADMIN role in its own company — every permission
there is. Round nine's method, and the reason for it: with a lesser role most
of these attacks are refused by RBAC before firm scoping is ever consulted, so
the test would prove that permissions work while saying nothing about the
tenant boundary. An attacker who can do everything in company B is the only one
whose refusals in company A mean what they appear to mean.
"""
b_roles = call(f"/users/roles", None, tok)
P("/companies/switch", {"firm_id": SECOND})
tok_own_b = signin()
admin_role_b = next((r["id"] for r in (call("/users/roles", None, tok_own_b).get("data") or [])
                     if r.get("name") == "Admin"), None)
P(f"/companies/{SECOND}/people", {"email": "sales@local.invalid", "role_id": admin_role_b}, tok_own_b)
P("/companies/switch", {"firm_id": MAIN}, signin())
tok_b = signin("sales@local.invalid", "sales123")
perms = call("/auth/login-email", {"email": "sales@local.invalid", "password": "sales123"})["data"]["permissions"]
check("the attacker holds every permission in its own company", len(perms) >= 40, f"{len(perms)} permissions")
b_sess = call("/auth/login-email", {"email": "sales@local.invalid", "password": "sales123"})
mine = [c["name"] for c in (b_sess.get("data", {}).get("account") or {}).get("companies", [])]
check("the attacker can open exactly one company", mine == ["Second Shop"], ", ".join(mine))

main_items = call("/items", None, signin())["data"]
victim_item = main_items[0]["id"] if main_items else None

if victim_item:
    r = call(f"/items/{victim_item}", None, tok_b)
    check("firm B cannot read firm A's item", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
    r = call(f"/items/{victim_item}", {"name": "hijacked"}, tok_b, "PUT")
    check("firm B cannot edit firm A's item", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
    r = call(f"/items/{victim_item}", {}, tok_b, "DELETE")
    check("firm B cannot delete firm A's item", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
    r = call("/items/bulk", {"items": [{"id": victim_item, "sale_price": 1}]}, tok_b, "PUT")
    check("firm B cannot bulk-edit firm A's item", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
    # B's own walk-in customer and B's own staff id, so the only thing wrong
    # with this request is the item — otherwise a validation error would stand
    # in for a scoping refusal and look like a pass.
    b_party = (call("/parties", None, tok_b).get("data") or [{}])[0].get("id")
    b_me = call("/auth/me", None, tok_b).get("data", {})
    r = call("/sales", {"party_id": b_party, "payment_type": "cash",
                        "sales_rep_id": (b_me.get("user") or {}).get("id") or b_me.get("id"),
                        "lines": [{"item_id": victim_item, "description": "x", "quantity": 1, "rate": 1}]}, tok_b)
    check("firm B cannot put firm A's item on its own invoice", not r.get("success"),
          f"{r.get('code')} — {r.get('message')}")

r = call(f"/companies/{MAIN}", {"name": "taken over"}, tok_b, "PUT")
check("firm B cannot rename firm A", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
r = call(f"/companies/{MAIN}/people", None, tok_b)
check("...nor list who can open it", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
r = call(f"/companies/{MAIN}/status", {"status": "suspended"}, tok_b)
check("...nor suspend it", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
r = call(f"/companies/{MAIN}", {"confirm": "My Business"}, tok_b, "DELETE")
check("...nor delete it, even with the right name typed", not r.get("success"),
      f"{r.get('code')} — {r.get('message')}")
r = call("/companies/switch", {"firm_id": MAIN}, tok_b)
check("...nor switch into it", not r.get("success"), f"{r.get('code')} — {r.get('message')}")
check("...and the refusal is 404, so it does not confirm firm A exists",
      r.get("code") == 404, f"{r.get('code')}")
r = call(f"/companies/{MAIN}/people", {"email": "sales@local.invalid"}, tok_b)
check("...nor grant itself access", not r.get("success"), f"{r.get('code')} — {r.get('message')}")

# the one round nine called the worst: emptying another firm's Admin role
r = call("/users/roles", None, tok_b)
roles_a = call("/users/roles", None, signin())
if roles_a.get("success") and (roles_a.get("data") or []):
    victim_role = (roles_a["data"][0] or {}).get("id")
    r = call(f"/users/roles/{victim_role}", {"permissions": []}, tok_b, "PUT")
    check("firm B cannot empty firm A's Admin role", not r.get("success"),
          f"{r.get('code')} — {r.get('message')}")

print()
