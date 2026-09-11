import json, urllib.request, urllib.error, subprocess, os
B = "http://localhost:3100/api"

def call(path, body=None, tok=None, method=None, raw=None, ctype=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(
        B + path, data=data,
        headers={"Content-Type": ctype or "application/json",
                 **({"Authorization": "Bearer " + tok} if tok else {})},
        method=method or ("POST" if data is not None else "GET"))
    try:
        r = urllib.request.urlopen(req)
        body_ = r.read()
        if r.headers.get("Content-Type", "").startswith("application/x-sqlite3"):
            return {"code": r.status, "success": True, "bytes": body_, "headers": dict(r.headers)}
        return {"code": r.status, **json.loads(body_)}
    except urllib.error.HTTPError as e:
        try: return {"code": e.code, **json.load(e)}
        except Exception: return {"code": e.code, "success": False, "message": f"HTTP {e.code}"}

def check(l, c, d=""):
    print(f"{'PASS' if c else 'FAIL'}  {l}" + (f"   {d}" if d else ""))

def signin(email="admin@local.invalid", pw="admin123"):
    r = call("/auth/login-email", {"email": email, "password": pw})
    return r["data"]["token"] if r.get("success") else None

def db(sql, path="/tmp/bk.db"):
    js = ("const initSqlJs=require('sql.js');const fs=require('fs');"
          "initSqlJs().then(SQL=>{const db=new SQL.Database(fs.readFileSync(" + json.dumps(path) + "));"
          f"const r=db.exec({json.dumps(sql)});"
          "console.log(JSON.stringify((r[0]&&r[0].values)||[]));});")
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd="/home/claude/work/backend")
    return json.loads(out.stdout.strip() or "[]")

print("=" * 76)
print("PER-COMPANY BACKUP AND RESTORE")
print("=" * 76)

tok = signin()
G = lambda p, t=None: call(p, None, t or tok)
P = lambda p, b, t=None: call(p, b, t or tok)

# ── three companies ───────────────────────────────────────────────────────
cos = {c["name"]: c["id"] for c in G("/companies")["data"]["companies"]}
for name in ("Shop B", "Shop C"):
    if name not in cos:
        P("/companies", {"name": name})
cos = {c["name"]: c["id"] for c in G("/companies")["data"]["companies"]}
A = next(i for n, i in cos.items() if n not in ("Shop B", "Shop C"))
Bid, C = cos["Shop B"], cos["Shop C"]
print(f"companies: A#{A}  B#{Bid}  C#{C}\n")

def snapshot(firm):
    """What a company holds, straight off the file — not through the API."""
    def one(sql):
        r = db(sql.replace("?", str(firm)))
        return r[0][0] if r and r[0] and r[0][0] is not None else 0
    return {
        "items": one("SELECT COUNT(*) FROM items WHERE firm_id=?"),
        "invoices": one("SELECT COUNT(*) FROM sale_invoices WHERE firm_id=?"),
        "parties": one("SELECT COUNT(*) FROM parties WHERE firm_id=?"),
        "debit": one("SELECT ROUND(SUM(debit),2) FROM journal_entry_lines WHERE firm_id=?"),
        "accounts": one("SELECT COUNT(*) FROM chart_of_accounts WHERE firm_id=?"),
        "roles": one("SELECT COUNT(*) FROM roles WHERE firm_id=?"),
    }

# ── give B something to lose ──────────────────────────────────────────────
P("/companies/switch", {"firm_id": Bid}); tok = signin()
for n in range(6):
    call("/items", {"name": f"B item {n}", "unit": "PCS", "sale_price": 1000 + n,
                    "purchase_price": 600 + n}, tok)
items_b = G("/items")["data"]
"""Stock in, or every sale is refused for want of it and the ledger totals stay
   zero — see the note below. `prevent_negative_stock` is on by default and is
   doing exactly its job here."""
for it in items_b:
    call(f"/items/{it['id']}/adjust", {"direction": "in", "quantity": 50,
                                       "reason": "opening", "unit_cost": 600}, tok)
party_b = (G("/parties")["data"] or [{}])[0].get("id")
me = G("/auth/me")["data"]
uid = (me.get("user") or {}).get("id") or me.get("id")
sold = 0
for n in range(3):
    r = call("/sales", {"party_id": party_b, "payment_type": "cash", "sales_rep_id": uid,
                        "lines": [{"item_id": items_b[0]["id"], "description": items_b[0]["name"],
                                   "quantity": 1, "rate": 2000}]}, tok)
    if r.get("success"): sold += 1
    elif n == 0: print("  (sale refused:", r.get("message"), ")")
"""B must actually trade before the export, or the invoice count, the invoice
total and both ledger columns are all zero — and control totals that are zero
on both sides match each other no matter what the restore does. A test whose
assertions cannot fail is the thing this session keeps catching."""
check("company B has invoices to lose", sold == 3, f"{sold}/3 sales rung up")

before_A, before_B, before_C = snapshot(A), snapshot(Bid), snapshot(C)
print("before  A:", before_A)
print("before  B:", before_B)
print("before  C:", before_C, "\n")

# ── export B ──────────────────────────────────────────────────────────────
exp = call(f"/companies/{Bid}/export", None, tok)
check("company B exports", exp.get("success") and exp.get("bytes"),
      f"{len(exp.get('bytes') or b'')} bytes, {exp.get('headers', {}).get('X-Genius-Invoices')} invoices in the header")
blob = exp.get("bytes") or b""
check("...and the file is a real SQLite database", blob[:15] == b"SQLite format 3")
open("/tmp/b-export.db", "wb").write(blob)
check("...that opens on its own", bool(db("SELECT COUNT(*) FROM sale_invoices", "/tmp/b-export.db")),
      f"{db('SELECT COUNT(*) FROM sale_invoices', '/tmp/b-export.db')} invoices inside")
check("...holding only company B",
      db("SELECT COUNT(DISTINCT firm_id) FROM items", "/tmp/b-export.db")[0][0] <= 1,
      f"{db('SELECT DISTINCT firm_id FROM items', '/tmp/b-export.db')} firm ids among its items")
check("...and no account or staff rows",
      db("SELECT COUNT(*) FROM accounts", "/tmp/b-export.db")[0][0] == 0 and
      db("SELECT COUNT(*) FROM users", "/tmp/b-export.db")[0][0] == 0,
      "people do not travel with a company")
check("...but its roles and permissions do",
      db("SELECT COUNT(*) FROM roles", "/tmp/b-export.db")[0][0] > 0 and
      db("SELECT COUNT(*) FROM role_permissions", "/tmp/b-export.db")[0][0] > 0,
      f"{db('SELECT COUNT(*) FROM roles', '/tmp/b-export.db')[0][0]} roles")

# ── preview refuses the wrong things ──────────────────────────────────────
r = call(f"/companies/{Bid}/restore/preview", None, tok, "POST", raw=b"not a database at all",
         ctype="application/octet-stream")
check("a file that is not a database is refused", r.get("data", {}).get("restorable") is False,
      r.get("data", {}).get("reason"))
r = call(f"/companies/{C}/restore/preview", None, tok, "POST", raw=blob, ctype="application/octet-stream")
check("B's backup is refused for company C", r.get("data", {}).get("restorable") is False,
      r.get("data", {}).get("reason"))
r = call(f"/companies/{Bid}/restore/preview", None, tok, "POST", raw=blob, ctype="application/octet-stream")
check("B's backup is accepted for company B", r.get("data", {}).get("restorable") is True,
      json.dumps(r.get("data", {}).get("manifest", {}).get("totals", {})))

# ── damage B, then restore it ─────────────────────────────────────────────
P("/companies/switch", {"firm_id": Bid}); tok = signin()
for it in G("/items")["data"][:3]:
    call(f"/items/{it['id']}", {"name": it["name"] + " CHANGED", "sale_price": 1}, tok, "PUT")
call("/items", {"name": "Added after the backup", "unit": "PCS", "sale_price": 5}, tok)
damaged_B = snapshot(Bid)
check("company B is now different from its backup", damaged_B != before_B,
      f"items {before_B['items']} → {damaged_B['items']}")

r = call(f"/companies/{Bid}/restore", None, tok, "POST", raw=blob, ctype="application/octet-stream")
check("the restore succeeds", r.get("success"), r.get("message"))

after_A, after_B, after_C = snapshot(A), snapshot(Bid), snapshot(C)
print("\nafter   A:", after_A)
print("after   B:", after_B)
print("after   C:", after_C, "\n")

check("company B is back exactly as it was", after_B == before_B,
      "" if after_B == before_B else f"{before_B} vs {after_B}")
# The round-twelve failure was silent and it was about the OTHER tenants.
check("company A was not touched", after_A == before_A,
      "" if after_A == before_A else f"{before_A} vs {after_A}")
check("company C was not touched", after_C == before_C,
      "" if after_C == before_C else f"{before_C} vs {after_C}")
check("the item added after the backup is gone",
      not db(f"SELECT COUNT(*) FROM items WHERE firm_id={Bid} AND name='Added after the backup'")[0][0])
check("the renamed items are back to their old names",
      not db(f"SELECT COUNT(*) FROM items WHERE firm_id={Bid} AND name LIKE '%CHANGED%'")[0][0])

# ── the safety copy, and the record ───────────────────────────────────────
safety = (r.get("data") or {}).get("safety")
check("a whole-file safety copy was taken first", bool(safety), str(safety))
if safety:
    """The backups folder sits beside the database, and this server runs on a
       copy in /tmp — so it is not backend/data/backups. Looking in the wrong
       place reported a real file as missing."""
    p = os.path.join(os.path.dirname("/tmp/bk.db"), "backups", safety)
    check("...and it exists on disk", os.path.exists(p),
          f"{os.path.getsize(p) if os.path.exists(p) else 0} bytes")
hist = os.path.join(os.path.dirname("/tmp/bk.db"), "restore-history.log")
check("the restore is recorded outside the database", os.path.exists(hist),
      open(hist).read().strip().split("\n")[-1][:110] if os.path.exists(hist) else "")

# ── signing in still works afterwards ─────────────────────────────────────
check("sign-in still works after a restore", bool(signin()), "accounts were not rolled back with the company")

print()
