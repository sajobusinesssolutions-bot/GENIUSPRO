import json, urllib.request, urllib.error, threading, time, subprocess
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
    except Exception as e:
        return {"success": False, "message": f"{type(e).__name__}: {e}"}

tok = call("/auth/login", {"username": "admin", "password": "admin123"})["data"]["token"]
GET = lambda p: call(p, tok=tok)
PUT = lambda p, b: call(p, b, tok, "PUT")
POST = lambda p, b: call(p, b, tok)

def db(sql):
    js = (
        "const initSqlJs=require('sql.js');const fs=require('fs');"
        "initSqlJs().then(SQL=>{const db=new SQL.Database(fs.readFileSync('/tmp/scratch2.db'));"
        f"const r=db.exec({json.dumps(sql)});"
        "console.log(JSON.stringify((r[0]&&r[0].values)||[]));});")
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd="/home/claude/work/backend")
    return json.loads(out.stdout.strip() or "[]")

def check(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail else ""))

print("=" * 72)
print("BULK UPDATE — audit, price lists, concurrency, books")
print("=" * 72)

items = {i["id"]: i for i in GET("/items")["data"]}
ids = sorted(items.keys())

# ── audit, read from the database rather than guessed at through an endpoint ──
rows = db("SELECT action, COUNT(*) FROM audit_logs WHERE action LIKE 'bulk%' GROUP BY action")
detail = db("SELECT detail FROM audit_logs WHERE action='bulk_edit' ORDER BY id DESC LIMIT 1")
check("audit rows are written per changed item", bool(rows), str(rows))
check("...naming the field, and both values", bool(detail) and "→" in detail[0][0], detail[0][0][:90] if detail else "")

n_before = db("SELECT COUNT(*) FROM audit_logs")[0][0]
PUT("/items/bulk", {"items": [{"id": i, "reorder_level": 7} for i in ids[:25]]})
n_after = db("SELECT COUNT(*) FROM audit_logs")[0][0]
check("one row per item, not one per batch", n_after - n_before == 25, f"{n_after - n_before} rows for 25 items")

# a refused batch must leave no audit trail either
n_before = db("SELECT COUNT(*) FROM audit_logs")[0][0]
PUT("/items/bulk", {"items": [{"id": ids[0], "sale_price": 1}, {"id": ids[1], "sale_price": -1}]})
n_after = db("SELECT COUNT(*) FROM audit_logs")[0][0]
check("a refused batch writes no audit rows", n_after == n_before, f"{n_after - n_before} written")

# ── price lists ───────────────────────────────────────────────────────────
POST("/settings/price-lists", {"name": "Wholesale"})
lists = GET("/settings/price-lists")["data"]
wl = next((l for l in lists if l["name"] == "Wholesale"), None)
if wl:
    r = PUT("/items/bulk", {"items": [], "price_list": {
        "id": wl["id"], "prices": [{"item_id": i, "price": 900} for i in ids[:40]]}})
    got = GET(f"/settings/price-lists/{wl['id']}/items")["data"]
    check("price book rows written through the same batch", r.get("success") and len(got) == 40,
          f"{len(got)} prices — {r.get('message')}")
    r = PUT("/items/bulk", {"items": [], "price_list": {
        "id": wl["id"], "prices": [{"item_id": i, "price": 900} for i in ids[:40]]}})
    check("...and resubmitting the same prices writes nothing",
          r.get("success") and r["data"]["prices"] == 0, r.get("message"))
    r = PUT("/items/bulk", {"items": [], "price_list": {"id": 999999, "prices": [{"item_id": ids[0], "price": 5}]}})
    check("a price book that is not ours is refused", not r.get("success"), r.get("message"))

# ── concurrency: a till sale while a large batch is saving ────────────────
cement = next((i for i in items.values() if "Cement" in (i["name"] or "")), None)
PARTY = (GET("/parties")["data"] or [{}])[0].get("id")
# Earlier tests left this item priced below its cost, and the shop's own
# "block selling below cost" setting then refuses the sale — correctly, and
# incidentally proving that guard still fires on a bulk-edited price. Put it
# back to something sellable so the concurrency test measures concurrency.
PUT("/items/bulk", {"items": [{"id": cement["id"], "sale_price": float(cement["purchase_price"]) * 1.4}]})
cement = {i["id"]: i for i in GET("/items")["data"]}[cement["id"]]
items = {i["id"]: i for i in GET("/items")["data"]}
sale_result = {}
def ring():
    time.sleep(0.004)                      # aim for the middle of the batch
    sale_result["r"] = POST("/sales", {
        "party_id": PARTY, "payment_type": "cash",
        "sales_rep_id": 1,
        "lines": [{"item_id": cement["id"], "description": cement["name"], "quantity": 1,
                   "rate": cement["sale_price"]}]})

inv_before = db("SELECT COUNT(*) FROM sale_invoices")[0][0]
big = [{"id": i, "sale_price": items[i]["sale_price"] + 3} for i in ids[:300]]
t = threading.Thread(target=ring); t.start()
bulk = PUT("/items/bulk", {"items": big})
t.join()
inv_after = db("SELECT COUNT(*) FROM sale_invoices")[0][0]
sale = sale_result.get("r", {})
check("the bulk save succeeded", bulk.get("success"), bulk.get("message"))
check("the concurrent till sale succeeded", sale.get("success"), sale.get("message"))
check("exactly one invoice was written", inv_after - inv_before == 1, f"{inv_after - inv_before}")

# the sale's own line must hold one coherent price, not a torn one
line = db("SELECT rate, line_total, quantity FROM sale_invoice_lines ORDER BY id DESC LIMIT 1")
if line:
    rate, total, qty = line[0]
    check("the sale's line is internally consistent", abs(rate * qty - total) < 0.01,
          f"rate {rate} x qty {qty} = {rate*qty}, line total {total}")

# ── the books still balance afterwards ────────────────────────────────────
bal = db("SELECT ROUND(SUM(debit),2), ROUND(SUM(credit),2) FROM journal_entry_lines")
if bal:
    d, c = bal[0]
    check("the ledger still balances", abs((d or 0) - (c or 0)) < 0.01, f"debits {d} vs credits {c}")

integ = GET("/accounting/integrity")
if integ.get("success"):
    data = integ["data"]
    failing = [c for c in (data.get("checks") or []) if not c.get("ok")]
    names = [c.get("name") for c in failing]
    # The shipped database already fails this one check with Sh -1,420,000 of
    # inventory — documented in round one of the previous pass. The question
    # here is only whether bulk update ADDS a failure.
    pre_existing = {"Stock on the books is not negative"}
    added = [n for n in names if n not in pre_existing]
    check("bulk update adds no new books failure", not added,
          f"failing: {names} | new: {added or 'none'}")

print()
