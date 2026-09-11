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
        except Exception: return {"code": e.code, "success": False, "message": str(e.code)}

r = call("/auth/login-email", {"email": "admin@local.invalid", "password": "admin123"})
tok = r["data"]["token"] if r.get("success") else None
if not tok:
    r = call("/auth/login", {"username": "admin", "password": "admin123"})
    tok = r["data"]["token"] if r.get("success") else None
    print("(signed in by username — the large seeder rewrites users, so the")
    print(" adopted account may not survive it; the panel is the same either way)")

for n in ("Scale B", "Scale C", "Scale D", "Scale E"):
    call("/companies", {"name": n}, tok)

cos = call("/companies", None, tok).get("data", {}).get("companies", [])
first = call("/companies/panel?period=this_year", None, tok)
d = first.get("data") or {}
if not first.get("success"):
    print("panel failed:", first.get("message"))
    raise SystemExit(1)

print(f"companies on the installation: {len(cos)}")
print(f"invoices the panel added up:   {(d.get('totals') or {}).get('invoices')}")
print(f"revenue:                       {(d.get('totals') or {}).get('revenue')}")
print()
print("period       time over 5 runs")
print("-" * 40)
for period in ("today", "this_month", "this_year"):
    ts = []
    for _ in range(5):
        t0 = time.time()
        rr = call(f"/companies/panel?period={period}", None, tok)
        ts.append((time.time() - t0) * 1000)
    print(f"  {period:11} {min(ts):5.0f}–{max(ts):.0f} ms" if rr.get("success")
          else f"  {period:11} FAILED — {rr.get('message')}")
