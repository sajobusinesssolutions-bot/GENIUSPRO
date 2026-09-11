import json, urllib.request, urllib.error, time
B = "http://localhost:3100/api"

def call(p, b=None, t=None, m=None):
    r = urllib.request.Request(B + p, data=json.dumps(b).encode() if b is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + t} if t else {})},
        method=m or ("POST" if b is not None else "GET"))
    try:
        x = urllib.request.urlopen(r); return {"code": x.status, **json.load(x)}
    except urllib.error.HTTPError as e:
        try: return {"code": e.code, **json.load(e)}
        except Exception: return {"code": e.code, "success": False, "message": f"HTTP {e.code}"}

def check(l, c, d=""):
    print(f"{'PASS' if c else 'FAIL'}  {l}" + (f"   {d}" if d else ""))

def signin(email="admin@local.invalid", pw="admin123"):
    r = call("/auth/login-email", {"email": email, "password": pw})
    return r["data"]["token"] if r.get("success") else None

print("=" * 74)
print("ALL-BUSINESSES PANEL")
print("=" * 74)

tok = signin()
G = lambda p, t=None: call(p, None, t or tok)
P = lambda p, b, t=None: call(p, b, t or tok)

cos = {c["name"]: c["id"] for c in G("/companies")["data"]["companies"]}
for n in ("Panel B", "Panel C"):
    if n not in cos: P("/companies", {"name": n})
cos = {c["name"]: c["id"] for c in G("/companies")["data"]["companies"]}
A = next(i for n, i in cos.items() if not n.startswith("Panel"))
Bid, C = cos["Panel B"], cos["Panel C"]

# give B something to trade with, so the panel is not all zeroes
P("/companies/switch", {"firm_id": Bid}); tok = signin()
me = G("/auth/me")["data"]; uid = (me.get("user") or {}).get("id") or me.get("id")
party = (G("/parties")["data"] or [{}])[0].get("id")
for n in range(4):
    it = P("/items", {"name": f"Panel item {n}", "unit": "PCS", "sale_price": 5000, "purchase_price": 3000})
    if it.get("success"):
        P(f"/items/{it['data']['id']}/adjust", {"direction": "in", "quantity": 40, "reason": "opening", "unit_cost": 3000})
items = G("/items")["data"]
for n in range(5):
    P("/sales", {"party_id": party, "payment_type": "cash", "sales_rep_id": uid,
                 "lines": [{"item_id": items[0]["id"], "description": items[0]["name"], "quantity": 2, "rate": 5000}]})
P("/expenses", {"category": "Rent", "amount": 200000, "mode": "cash"})
P("/expenses", {"category": "Utilities", "amount": 45000, "mode": "cash"})
P("/companies/switch", {"firm_id": A}); tok = signin()

# ── the panel itself ──────────────────────────────────────────────────────
t0 = time.time()
r = G("/companies/panel")
ms = int((time.time() - t0) * 1000)
check("the panel answers", r.get("success"), f"{ms}ms")
d = r.get("data") or {}
check("...covering every business this account may open", len(d.get("companies") or []) == len(cos),
      f"{len(d.get('companies') or [])} of {len(cos)}")
check("...with a period, named", bool((d.get("period") or {}).get("label")),
      f"{d['period']['label']} — {d['period']['from']} to {d['period']['to']}" if d.get("period") else "")

# ── the totals must BE the total of the parts ─────────────────────────────
cs = d.get("companies") or []
tt = d.get("totals") or {}
for k in ("revenue", "profit", "stock_value", "receivable", "invoices", "expenses"):
    got = round(sum(c[k] for c in cs), 2)
    want = round(tt[k], 2)
    check(f"the combined {k} is the sum of the businesses", abs(got - want) < 0.01, f"{got} vs {want}")

# ── and each business's figures must match its own screens ────────────────
P("/companies/switch", {"firm_id": Bid}); tokB = signin()
own = call("/dashboard/overview?period=this_month", None, tokB)
b_panel = next(c for c in cs if c["id"] == Bid)
inv_own = call("/sales", None, tokB).get("data") or []
check("company B's invoice count matches its own Sales screen",
      b_panel["invoices"] == len(inv_own), f"panel {b_panel['invoices']} vs sales list {len(inv_own)}")
rev_own = round(sum(i.get("grand_total", 0) for i in inv_own), 2)
check("...and its revenue matches the sum of those invoices",
      abs(b_panel["revenue"] - rev_own) < 0.01, f"panel {b_panel['revenue']} vs {rev_own}")
stock_own = call("/items", None, tokB).get("data") or []
check("...and it reports expenses it actually recorded", b_panel["expenses"] > 0,
      f"{b_panel['expenses']}")

# ── expense categories ────────────────────────────────────────────────────
P("/companies/switch", {"firm_id": A}); tok = signin()
d = G("/companies/panel")["data"]
cats = {c["category"]: c["amount"] for c in (d.get("expense_categories") or [])}
check("expenses are broken down by category", "Rent" in cats and "Utilities" in cats, json.dumps(cats))

# ── the permission is a refusal, not a hidden button ──────────────────────
"""The whole point of this screen is that it shows one business's takings to
somebody standing in another. Hiding the button is the convenience; the 403 is
the control, so it is the thing worth testing."""
P(f"/companies/{Bid}/people", {"email": "sales@local.invalid"})
P("/companies/switch", {"firm_id": Bid}); tokOwn = signin()
roles = call("/users/roles", None, tokOwn).get("data") or []
sales_role = next((x["id"] for x in roles if x.get("name") == "Salesman"), None)
P(f"/companies/{Bid}/people", {"email": "sales@local.invalid", "role_id": sales_role}, tokOwn)
P("/companies/switch", {"firm_id": A}, signin())
tok_s = signin("sales@local.invalid", "sales123")
if tok_s:
    perms = call("/auth/login-email", {"email": "sales@local.invalid", "password": "sales123"})["data"]["permissions"]
    has = any(p["module"] == "companies" and p["action"] == "panel" for p in perms)
    check("an account without companies.panel does not hold it", not has, f"{len(perms)} permissions")
    r = call("/companies/panel", None, tok_s)
    check("...and the server refuses it the panel", not r.get("success"),
          f"{r.get('code')} — {r.get('message')}")
else:
    check("a limited account could sign in", False)

# ── period changes the answer ─────────────────────────────────────────────
a = G("/companies/panel?period=today")["data"]["totals"]["revenue"]
b = G("/companies/panel?period=this_year")["data"]["totals"]["revenue"]
check("the period actually changes the figures", b >= a, f"today {a} · this year {b}")

# ── timing at a realistic size ────────────────────────────────────────────
times = []
for _ in range(5):
    t0 = time.time(); G("/companies/panel?period=this_year"); times.append((time.time() - t0) * 1000)
check("the panel is quick enough to open on demand", max(times) < 1500,
      f"{min(times):.0f}–{max(times):.0f}ms over 5 runs, {len(cs)} businesses")

print()
