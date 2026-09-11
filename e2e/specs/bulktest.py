import json, urllib.request, urllib.error, time
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
        return json.load(e)

tok = call("/auth/login", {"username": "admin", "password": "admin123"})["data"]["token"]
GET = lambda p: call(p, tok=tok)
PUT = lambda p, b: call(p, b, tok, "PUT")

def items():
    return {i["id"]: i for i in GET("/items")["data"]}

def audits():
    r = GET("/utilities/audit-log")
    d = r.get("data")
    return d if isinstance(d, list) else []

print("=" * 72)
print("BULK UPDATE — backend behaviour")
print("=" * 72)

# seed a workable catalogue so the batch tests mean something
base = items()
if len(base) < 60:
    print("\nseeding items for the batch tests…")
    for n in range(len(base), 320):
        call("/items", {"name": f"Test item {n:04d}", "unit": "PCS",
                        "sale_price": 1000 + n, "purchase_price": 600 + n}, tok)
base = items()
ids = sorted(base.keys())
print(f"catalogue: {len(base)} items\n")

def check(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail else ""))
    return cond

# ── 1. a straightforward batch ────────────────────────────────────────────
batch = ids[:300]
before = {i: base[i]["sale_price"] for i in batch}
t0 = time.time()
r = PUT("/items/bulk", {"items": [{"id": i, "sale_price": before[i] + 250} for i in batch]})
ms = int((time.time() - t0) * 1000)
after = items()
moved = sum(1 for i in batch if after[i]["sale_price"] == before[i] + 250)
check("300-item batch applied", r.get("success") and moved == 300, f"{moved}/300 in {ms}ms — {r.get('message')}")

# ── 2. nothing changed is not a save ──────────────────────────────────────
r = PUT("/items/bulk", {"items": [{"id": i, "sale_price": after[i]["sale_price"]} for i in batch]})
check("resubmitting the same values writes nothing",
      r.get("success") and r["data"]["updated"] == 0, r.get("message"))

# ── 3. one bad row rolls the whole batch back ─────────────────────────────
pre = items()
bad = [{"id": i, "sale_price": pre[i]["sale_price"] + 100} for i in batch]
bad[179]["sale_price"] = -5                       # row 180 of 300
r = PUT("/items/bulk", {"items": bad})
post = items()
untouched = sum(1 for i in batch if post[i]["sale_price"] == pre[i]["sale_price"])
check("a bad row on 180 of 300 refuses the batch", not r.get("success"), r.get("message"))
check("...and nothing at all was written", untouched == 300, f"{untouched}/300 unchanged")

# ── 4. a foreign / unknown id is refused, not skipped ─────────────────────
r = PUT("/items/bulk", {"items": [{"id": ids[0], "sale_price": 4242}, {"id": 999999, "sale_price": 10}]})
check("an unknown id refuses the batch", not r.get("success"), r.get("message"))
check("...and the good row in it was not written", items()[ids[0]]["sale_price"] != 4242)

# ── 5. duplicate names ────────────────────────────────────────────────────
r = PUT("/items/bulk", {"items": [{"id": ids[0], "name": base[ids[1]]["name"]}]})
check("a name that clashes with an existing item is refused", not r.get("success"), r.get("message"))
r = PUT("/items/bulk", {"items": [{"id": ids[0], "name": "Clash"}, {"id": ids[1], "name": "Clash"}]})
check("two rows claiming one name is refused", not r.get("success"), r.get("message"))
# swapping two names must still be possible
n0, n1 = items()[ids[0]]["name"], items()[ids[1]]["name"]
r = PUT("/items/bulk", {"items": [{"id": ids[0], "name": n1}, {"id": ids[1], "name": n0}]})
sw = items()
check("swapping two names is allowed", r.get("success") and sw[ids[0]]["name"] == n1 and sw[ids[1]]["name"] == n0,
      r.get("message"))
PUT("/items/bulk", {"items": [{"id": ids[0], "name": n0}, {"id": ids[1], "name": n1}]})

# ── 6. an empty name ──────────────────────────────────────────────────────
r = PUT("/items/bulk", {"items": [{"id": ids[0], "name": "   "}]})
check("an item cannot be left without a name", not r.get("success"), r.get("message"))

# ── 7. a second unit with no conversion rate ──────────────────────────────
r = PUT("/items/bulk", {"items": [{"id": ids[0], "secondary_unit": "KG", "conversion_rate": 0}]})
check("a second unit with a zero rate is refused", not r.get("success"), r.get("message"))
r = PUT("/items/bulk", {"items": [{"id": ids[0], "secondary_unit": "KG", "conversion_rate": 50}]})
check("...and is accepted with a real rate", r.get("success"), r.get("message"))

# ── 8. fields not on the allow-list are ignored, not trusted ──────────────
r = PUT("/items/bulk", {"items": [{"id": ids[0], "firm_id": 99, "id_": 1, "sale_price": 7777}]})
chk = items()[ids[0]]
check("an unlisted field is ignored", r.get("success") and chk["sale_price"] == 7777 and chk["firm_id"] == 1,
      f"firm_id still {chk['firm_id']}")

# ── 9. the ceiling ────────────────────────────────────────────────────────
r = PUT("/items/bulk", {"items": [{"id": ids[0], "sale_price": 1} for _ in range(5001)]})
check("a runaway batch is refused", not r.get("success"), r.get("message"))

# Audit rows are checked in bulktest2.py, straight off the database. The
# check that used to live here read an /audit-log endpoint that does not
# exist, so it failed for a reason that had nothing to do with the feature.

print()
