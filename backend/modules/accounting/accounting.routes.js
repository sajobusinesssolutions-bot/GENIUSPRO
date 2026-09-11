const express = require("express");
const router = express.Router();
const { query, pool, DB_PATH } = require("../../database/db");
const fs = require("fs");
const path = require("path");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { postJournal, reverseJournal } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");
const { clientRef, findByRef, isDuplicateRef, ensureKeys } = require("../../shared/idempotency");
const { blockClosed } = require("../../shared/periodlock");

router.use(verifyToken);

/* Chart of accounts with live balances */
router.get("/accounts", requirePermission("accounting", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT a.*, COALESCE(b.balance, 0) AS balance
       FROM chart_of_accounts a
       LEFT JOIN account_balances b ON b.firm_id = a.firm_id AND b.account_code = a.code
      WHERE a.firm_id = ? ORDER BY a.code`,
    [req.user.firm_id]
  )).rows;
  res.success(rows);
});

/* Create a chart-of-accounts account */
router.post("/accounts", requirePermission("accounting", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const firmId = req.user.firm_id;
  if (!b.name || !b.type) return res.fail("Name and type are required");
  const validTypes = ["asset", "liability", "equity", "income", "expense"];
  if (!validTypes.includes(b.type)) return res.fail("Invalid account type");
  let code = (b.code || "").trim();
  if (!code) {
    // auto-code within the type's band
    const band = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 5000 }[b.type];
    const max = (await query("SELECT MAX(CAST(code AS INTEGER)) m FROM chart_of_accounts WHERE firm_id=? AND CAST(code AS INTEGER) BETWEEN ? AND ?", [firmId, band, band + 999])).rows[0].m;
    code = String(max ? max + 1 : band + 1);
  }
  const dup = (await query("SELECT 1 FROM chart_of_accounts WHERE firm_id=? AND code=?", [firmId, code])).rows[0];
  if (dup) return res.fail("An account with that code already exists");
  /* The account and its opening balance are one unit — an account created
     without the balance it was opened with is a book that does not add up. */
  /* `kind` only means anything for an account that holds money, and only
     'cash', 'bank' or 'mobile' are storable — anything else is left NULL so the tiles
     fall back to the name test rather than trusting a typo. */
  const kind = b.is_cash_bank && ["cash", "bank", "mobile"].includes(b.kind) ? b.kind : null;
  await conn.query("INSERT INTO chart_of_accounts (firm_id, code, name, type, is_cash_bank, is_control, opening_balance, status, kind) VALUES (?,?,?,?,?,?,?,?,?)",
    [firmId, code, b.name.trim(), b.type, b.is_cash_bank ? 1 : 0, 0, Number(b.opening_balance) || 0, "active", kind]);
  if (Number(b.opening_balance)) {
    await conn.query("INSERT INTO account_balances (firm_id, account_code, balance) VALUES (?,?,?)", [firmId, code, Number(b.opening_balance)]);
  }
  return () => res.success({ code }, "Account created");
}));

/* Update an account (name / type / cash-bank flag) */
router.put("/accounts/:code", requirePermission("accounting", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const firmId = req.user.firm_id;
  const acct = (await query("SELECT * FROM chart_of_accounts WHERE firm_id=? AND code=?", [firmId, req.params.code])).rows[0];
  if (!acct) return res.fail("Account not found", 404);
  const cashBank = b.is_cash_bank != null ? (b.is_cash_bank ? 1 : 0) : acct.is_cash_bank;
  /* Unticking "holds money" clears the kind with it, so an account that is
     later re-ticked cannot come back grouped from a stale answer. An omitted
     `kind` leaves whatever is stored alone. */
  const kind = !cashBank ? null
    : ["cash", "bank", "mobile"].includes(b.kind) ? b.kind
    : b.kind === null || b.kind === "" ? null
    : (acct.kind || null);
  await conn.query("UPDATE chart_of_accounts SET name=COALESCE(?,name), type=COALESCE(?,type), is_cash_bank=?, kind=? WHERE firm_id=? AND code=?",
    [b.name || null, b.type || null, cashBank, kind, firmId, req.params.code]);
  return () => res.success({ code: req.params.code }, "Account updated");
}));

/* Toggle active / disabled */
router.put("/accounts/:code/status", requirePermission("accounting", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const acct = (await query("SELECT * FROM chart_of_accounts WHERE firm_id=? AND code=?", [firmId, req.params.code])).rows[0];
  if (!acct) return res.fail("Account not found", 404);
  if (acct.is_control) return res.fail("Control accounts cannot be disabled");
  const want = acct.status === "active" ? "disabled" : "active";
  await conn.query("UPDATE chart_of_accounts SET status=? WHERE firm_id=? AND code=?", [want, firmId, req.params.code]);
  return () => res.success({ code: req.params.code, status: want }, want === "active" ? "Account enabled" : "Account disabled");
}));

/* Delete an account — blocked if control or if it has postings */
router.delete("/accounts/:code", requirePermission("accounting", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const acct = (await query("SELECT * FROM chart_of_accounts WHERE firm_id=? AND code=?", [firmId, req.params.code])).rows[0];
  if (!acct) return res.fail("Account not found", 404);
  if (acct.is_control) return res.fail("Control accounts cannot be deleted");
  const used = (await query("SELECT COUNT(*) n FROM journal_entry_lines WHERE firm_id=? AND account_code=?", [firmId, req.params.code])).rows[0].n;
  if (used > 0) return res.fail(`This account has ${used} posting(s) — disable it instead of deleting`);
  /* Balance row and account row together — a balance left behind for an
     account that no longer exists is a figure nothing can explain. */
  await conn.query("DELETE FROM account_balances WHERE firm_id=? AND account_code=?", [firmId, req.params.code]);
  await conn.query("DELETE FROM chart_of_accounts WHERE firm_id=? AND code=?", [firmId, req.params.code]);
  return () => res.success({ code: req.params.code }, "Account deleted");
}));

/* Cash & bank accounts (for the cash-sale picker) */
router.get("/cash-accounts", async (req, res) => {
  const rows = (await query(
    `SELECT a.code, a.name, a.kind, COALESCE(b.balance,0) AS balance
       FROM chart_of_accounts a LEFT JOIN account_balances b ON b.firm_id=a.firm_id AND b.account_code=a.code
      WHERE a.firm_id = ? AND a.is_cash_bank = 1 ORDER BY a.code`,
    [req.user.firm_id]
  )).rows;
  /* Deliberately open to anyone signed in — a cashier has to pick which drawer
     a cash sale lands in, and that needs no more than the code and the name.
     What it must not carry is the balance: "See account balances" is
     accounting.view in the permission catalogue, and this picker was handing
     the bank balance to every cashier who opened the payment dialog. */
  const seesBalances = (await query(
    "SELECT 1 FROM role_permissions WHERE role_id = ? AND module = 'accounting' AND action = 'view'",
    [req.user.role_id])).rows.length > 0;
  /* `kind` goes to everyone: it is how the picker groups cash, bank and mobile
     money, and knowing that the MoMo line is a MoMo line reveals nothing a
     cashier should not see. The balance is still withheld. */
  res.success(seesBalances ? rows : rows.map(({ code, name, kind }) => ({ code, name, kind })));
});

/* Day book — journal entries with their lines */
router.get("/daybook", requirePermission("accounting", "view"), async (req, res) => {
  const { from, to } = req.query;
  const cond = ["firm_id = ?"]; const args = [req.user.firm_id];
  if (from) { cond.push("entry_date >= ?"); args.push(from); }
  if (to) { cond.push("entry_date <= ?"); args.push(to); }
  const entries = (await query(
    `SELECT * FROM journal_entries WHERE ${cond.join(" AND ")} ORDER BY id DESC LIMIT 300`,
    args
  )).rows;
  for (const e of entries) {
    e.lines = (await query(
      `SELECT l.*, a.name AS account_name FROM journal_entry_lines l
         LEFT JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
        WHERE l.entry_id = ?`,
      [e.id]
    )).rows;
  }
  res.success(entries);
});

/* Universal transaction search across every journal entry in the system */
router.get("/transactions", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const q = (req.query.q || "").trim();
  const mod = (req.query.module || "").trim();
  const from = req.query.from, to = req.query.to;
  const where = ["e.firm_id = ?"]; const args = [f];
  if (q) {
    where.push(`(e.reference LIKE ? OR e.description LIKE ? OR e.entry_no LIKE ?
      OR EXISTS (SELECT 1 FROM journal_entry_lines l JOIN chart_of_accounts a ON a.firm_id=l.firm_id AND a.code=l.account_code
                  WHERE l.entry_id=e.id AND a.name LIKE ?))`);
    const like = `%${q}%`; args.push(like, like, like, like);
  }
  if (mod) { where.push("e.source_module = ?"); args.push(mod); }
  if (from) { where.push("e.entry_date >= ?"); args.push(from); }
  if (to) { where.push("e.entry_date <= ?"); args.push(to); }
  const entries = (await query(
    `SELECT e.* FROM journal_entries e WHERE ${where.join(" AND ")} ORDER BY e.id DESC LIMIT 100`, args
  )).rows;
  for (const e of entries) {
    e.lines = (await query(
      `SELECT l.account_code, l.debit, l.credit, l.narration, a.name AS account_name
         FROM journal_entry_lines l LEFT JOIN chart_of_accounts a ON a.firm_id=l.firm_id AND a.code=l.account_code
        WHERE l.entry_id = ?`, [e.id])).rows;
    e.total = +e.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0).toFixed(2);
  }
  res.success(entries);
});

/* Reverse (delete) a manual journal entry — only manual ones, to protect posted documents */
router.delete("/journal/:id", requirePermission("accounting", "delete"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = req.user.firm_id;
    const e = (await conn.query("SELECT * FROM journal_entries WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
    if (!e) { conn.release(); return res.fail("Entry not found", 404); }
    /* Two kinds of entry stand on their own: a journal somebody typed, and a
       recorded other-income receipt, which is a journal entry and nothing
       else. Everything else in this table was written BY a document — a sale,
       a payment, an expense — and removing the entry without touching the
       document leaves a sale whose money never reached the books. Those are
       voided from their own screen, which reverses the entry properly. */
    if (!STANDALONE.includes(e.source_module)) {
      conn.release();
      return res.fail(`${e.entry_no} was posted by a ${sourceLabel(e.source_module)} — void that document instead, and this entry is reversed with it`);
    }
    await conn.beginTransaction();
    // unwind this entry's effect on account balances, then remove it
    const lines = (await conn.query("SELECT account_code, debit, credit FROM journal_entry_lines WHERE firm_id=? AND entry_id=?", [f, e.id])).rows;
    for (const l of lines) {
      const delta = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      await conn.query("UPDATE account_balances SET balance = ROUND(balance - ?, 2) WHERE firm_id=? AND account_code=?", [delta, f, l.account_code]);
    }
    await conn.query("DELETE FROM journal_entry_lines WHERE firm_id=? AND entry_id=?", [f, e.id]);
    await conn.query("DELETE FROM journal_entries WHERE id=? AND firm_id=?", [e.id, f]);
    await conn.commit();
    res.success({ id: e.id }, "Journal deleted");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* Books integrity — proves the ledger is sound rather than asking anyone to trust it.
   Runs the checks that would catch a rounding fault, a half-written transaction or
   a balance that has drifted away from the documents behind it. */
/* The four panels above the ledger.
 *
 * Two of the deck's panels describe things this app does not keep — it has no
 * draft journals (every entry is posted the moment it is made) and no period
 * lock. Rather than show a figure that would always read zero, those slots
 * carry what the books actually have: how many entries a person made by hand,
 * and how far back the ledger goes. */
router.get("/overview", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const one = async (sql, args = [f]) => (await query(sql, args)).rows[0] || {};

  const tb = await one("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_entry_lines WHERE firm_id=?");
  const gap = +(tb.d - tb.c).toFixed(2);

  /* Assets are debit-natured, so a debit balance is a positive asset. */
  const assets = await one(
    `SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS v
       FROM journal_entry_lines l
       JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
      WHERE l.firm_id = ? AND a.type = 'asset'`);

  const manual = await one(
    `SELECT COUNT(*) AS n FROM journal_entries WHERE firm_id = ? AND source_module = 'manual'`);

  const month = await one(
    `SELECT COUNT(*) AS n FROM journal_entries
      WHERE firm_id = ? AND strftime('%Y-%m', entry_date) = strftime('%Y-%m','now')`);

  const span = await one(
    `SELECT MIN(entry_date) AS first, MAX(entry_date) AS last, COUNT(*) AS n
       FROM journal_entries WHERE firm_id = ?`);

  const accounts = await one("SELECT COUNT(*) AS n FROM chart_of_accounts WHERE firm_id = ?");

  res.success({
    assets: +Number(assets.v).toFixed(2),
    balanced: Math.abs(gap) < 0.005,
    bothSides: +Number(tb.d).toFixed(2),
    gap,
    manualJournals: +manual.n || 0,
    entriesThisMonth: +month.n || 0,
    entriesTotal: +span.n || 0,
    firstEntry: span.first || null,
    lastEntry: span.last || null,
    accounts: +accounts.n || 0,
  });
});

router.get("/integrity", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  const tb = (await query("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_entry_lines WHERE firm_id=?", [f])).rows[0];
  const gap = +(tb.d - tb.c).toFixed(6);
  add("Every entry balances", Math.abs(gap) < 0.005,
      `Debits Sh ${tb.d.toFixed(2)} vs credits Sh ${tb.c.toFixed(2)}${Math.abs(gap) >= 0.005 ? ` — out by Sh ${gap}` : ""}`);

  const unbalanced = (await query(
    `SELECT e.entry_no, ROUND(SUM(l.debit) - SUM(l.credit), 4) AS gap
       FROM journal_entries e JOIN journal_entry_lines l ON l.entry_id = e.id
      WHERE e.firm_id = ? GROUP BY e.id HAVING ABS(gap) > 0.005 LIMIT 5`, [f])).rows;
  add("No lopsided transactions", unbalanced.length === 0,
      unbalanced.length ? `${unbalanced.length} entry(ies) don't balance: ${unbalanced.map((u) => u.entry_no).join(", ")}` : "Each transaction's debits equal its credits");

  const artifacts = (await query(
    `SELECT COUNT(*) n FROM journal_entry_lines
      WHERE firm_id = ? AND (ABS(debit*100 - ROUND(debit*100)) > 0.000001
                          OR ABS(credit*100 - ROUND(credit*100)) > 0.000001)`, [f])).rows[0].n;
  add("Amounts are clean", artifacts === 0,
      artifacts ? `${artifacts} amount(s) carry rounding noise` : "No fractional-shilling artifacts");

  const partyGap = (await query(
    `SELECT COUNT(*) n FROM (
       SELECT p.id, p.balance,
              COALESCE((SELECT SUM(balance_due) FROM sale_invoices s WHERE s.party_id = p.id AND s.status != 'voided'), 0) AS owed
         FROM parties p WHERE p.firm_id = ? AND p.party_type = 'customer'
     ) WHERE ABS(balance - owed) > 0.5`, [f])).rows[0].n;
  add("Customer balances match their invoices", partyGap === 0,
      partyGap ? `${partyGap} customer(s) have a balance that doesn't match their unpaid invoices` : "Every customer balance is backed by documents");

  const orphans = (await query(
    "SELECT COUNT(*) n FROM journal_entry_lines l LEFT JOIN journal_entries e ON e.id = l.entry_id WHERE l.firm_id = ? AND e.id IS NULL", [f])).rows[0].n;
  add("No stranded records", orphans === 0, orphans ? `${orphans} orphaned ledger line(s)` : "Every ledger line belongs to a transaction");

  const noAcct = (await query(
    `SELECT COUNT(*) n FROM journal_entry_lines l
      LEFT JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
     WHERE l.firm_id = ? AND a.code IS NULL`, [f])).rows[0].n;
  add("Every posting has an account", noAcct === 0, noAcct ? `${noAcct} line(s) point at a missing account` : "All postings map to the chart of accounts");

  /* ── Plausibility ──────────────────────────────────────────────────────
     Everything above proves the books are internally consistent: debits equal
     credits, nothing is orphaned. Perfectly consistent books can still say the
     shop holds minus 1,420,000 of stock, and "all clear" printed over that
     reads as a lie. These ask whether the figures could be true at all.
     They read account_balances — the same basis as the default balance sheet
     they validate — because opening balances are written straight into that
     table with no journal entry, so summing journal lines would disagree with
     the report by every account's opening balance. */
  const stockBal = +(await query(
    `SELECT COALESCE(b.balance, 0) AS v
       FROM chart_of_accounts a
       LEFT JOIN account_balances b ON b.firm_id = a.firm_id AND b.account_code = a.code
      WHERE a.firm_id = ? AND a.code = ?`,
    [f, CODES.STOCK])).rows[0]?.v || 0;
  add("Stock on the books is not negative", stockBal >= -0.005,
      stockBal < -0.005
        ? `Inventory carries Sh ${stockBal.toFixed(2)} — stock has gone out that was never taken in`
        : `Inventory carries Sh ${stockBal.toFixed(2)}`);

  const overdrawn = (await query(
    `SELECT a.code, a.name, ROUND(COALESCE(b.balance, 0), 2) AS bal
       FROM chart_of_accounts a
       LEFT JOIN account_balances b ON b.firm_id = a.firm_id AND b.account_code = a.code
      WHERE a.firm_id = ? AND a.type = 'asset' AND a.code <> ?
        AND ROUND(COALESCE(b.balance, 0), 2) < -0.005
      ORDER BY bal LIMIT 5`,
    [f, CODES.STOCK])).rows;
  add("No asset account is overdrawn", overdrawn.length === 0,
      overdrawn.length
        ? `${overdrawn.map((r) => `${r.name} Sh ${r.bal}`).join(", ")} — an asset held below zero`
        : "Every asset account holds a balance of zero or better");

  const negStock = (await query(
    `SELECT COUNT(*) n FROM (
       SELECT i.id, COALESCE((SELECT SUM(quantity) FROM item_stock s WHERE s.item_id = i.id AND s.firm_id = i.firm_id), 0) AS oh
         FROM items i WHERE i.firm_id = ? AND i.is_inventory = 1
     ) WHERE oh < -0.0005`, [f])).rows[0].n;
  add("No item shows negative stock", negStock === 0,
      negStock ? `${negStock} item(s) sit on the shelf at less than zero` : "Every item's on-hand is zero or above");

  res.success({ ok: checks.every((c) => c.ok), checks, checked_at: new Date().toISOString() });
});

/* ─────────── Inventory changeover ───────────
   A shop that traded before this version expensed stock the moment it was bought.
   From now on stock is an asset until it sells. That leaves one gap: the goods
   still sitting on the shelf were already written off as an expense.

   This moves the value of unsold stock out of Purchases and onto the balance
   sheet, so the opening position is right. It's a one-time entry. */
router.get("/changeover/preview", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const done = (await query("SELECT svalue FROM firm_settings WHERE firm_id=? AND skey='inventory_changeover_done'", [f])).rows[0];

  const stock = (await query(
    `SELECT COALESCE(SUM(s.quantity * COALESCE(NULLIF(s.avg_cost,0), i.purchase_price, 0)),0) AS value,
            COUNT(DISTINCT s.item_id) AS items
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE s.firm_id = ? AND s.quantity > 0`, [f])).rows[0];

  const bal = async (code) => {
    const r = (await query("SELECT COALESCE(SUM(debit)-SUM(credit),0) v FROM journal_entry_lines WHERE firm_id=? AND account_code=?", [f, code])).rows[0];
    return +Number(r.v).toFixed(2);
  };
  const inventoryBalance = await bal("1020");
  const purchasesBalance = await bal("5001");
  const stockValue = +Number(stock.value).toFixed(2);
  const adjustment = +(stockValue - inventoryBalance).toFixed(2);

  res.success({
    already_done: !!(done && done.svalue === "1"),
    items_with_stock: stock.items,
    stock_value: stockValue,
    inventory_balance: inventoryBalance,
    purchases_balance: purchasesBalance,
    adjustment,
    needed: Math.abs(adjustment) > 0.5,
  });
});

router.post("/changeover", requirePermission("accounting", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = req.user.firm_id;
    const done = (await conn.query("SELECT svalue FROM firm_settings WHERE firm_id=? AND skey='inventory_changeover_done'", [f])).rows[0];
    if (done && done.svalue === "1" && !req.body.force) {
      conn.release(); return res.fail("The changeover has already been run once");
    }

    const stock = (await conn.query(
      `SELECT COALESCE(SUM(s.quantity * COALESCE(NULLIF(s.avg_cost,0), i.purchase_price, 0)),0) AS value
         FROM item_stock s JOIN items i ON i.id = s.item_id
        WHERE s.firm_id = ? AND s.quantity > 0`, [f])).rows[0];
    const inv = (await conn.query("SELECT COALESCE(SUM(debit)-SUM(credit),0) v FROM journal_entry_lines WHERE firm_id=? AND account_code='1020'", [f])).rows[0];
    const adjustment = +(Number(stock.value) - Number(inv.v)).toFixed(2);
    if (Math.abs(adjustment) < 0.5) {
      conn.release(); return res.fail("Inventory already matches the stock on hand — nothing to adjust");
    }

    // safety copy of the database before touching the books
    let backup = null;
    try {
      const dir = path.join(path.dirname(DB_PATH), "backups");
      fs.mkdirSync(dir, { recursive: true });
      backup = path.join(dir, `pre-changeover-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backup);
    } catch { backup = null; }

    await conn.beginTransaction();
    await postJournal(conn, {
      firmId: f, date: req.body.date || new Date().toISOString().slice(0, 10),
      description: "Inventory changeover — unsold stock moved from Purchases to Inventory",
      reference: "CHANGEOVER", sourceModule: "changeover", sourceId: 0, userId: req.user.id,
      lines: adjustment > 0
        ? [{ account_code: "1020", debit: adjustment, narration: "Stock on hand at changeover" },
           { account_code: "5001", credit: adjustment, narration: "Reverse purchases already expensed" }]
        : [{ account_code: "5001", debit: -adjustment, narration: "Correct overstated inventory" },
           { account_code: "1020", credit: -adjustment, narration: "Stock on hand at changeover" }],
    });
    await conn.query("DELETE FROM firm_settings WHERE firm_id=? AND skey='inventory_changeover_done'", [f]);
    await conn.query("INSERT INTO firm_settings (firm_id, skey, svalue) VALUES (?,?,?)", [f, "inventory_changeover_done", "1"]);
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "accounting", "changeover", 0, `adjustment ${adjustment}`]);
    await conn.commit();
    res.success({ adjustment, backup: backup ? path.basename(backup) : null },
      `Inventory changeover posted — Sh ${Math.abs(adjustment).toFixed(2)} moved`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* Profit & Loss */
router.get("/profit-loss", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const { from, to } = req.query;
  const dcond = []; const dargs = [];
  if (from) { dcond.push("e.entry_date >= ?"); dargs.push(from); }
  if (to) { dcond.push("e.entry_date <= ?"); dargs.push(to); }
  const dwhere = dcond.length ? " AND " + dcond.join(" AND ") : "";
  // period movement per income/expense account — sum only lines whose entry falls in range
  const rows = (await query(
    `SELECT a.code, a.name, a.type,
            COALESCE((SELECT SUM(l.debit) - SUM(l.credit)
                        FROM journal_entry_lines l
                        JOIN journal_entries e ON e.id = l.entry_id
                       WHERE l.firm_id = a.firm_id AND l.account_code = a.code${dwhere}), 0) AS balance
       FROM chart_of_accounts a
      WHERE a.firm_id=? AND a.type IN ('income','expense')`,
    [...dargs, f]
  )).rows;
  const income = rows.filter((r) => r.type === "income").map((r) => ({ ...r, amount: -r.balance })).filter((r) => Math.abs(r.amount) > 0.001);
  const expense = rows.filter((r) => r.type === "expense").map((r) => ({ ...r, amount: r.balance })).filter((r) => Math.abs(r.amount) > 0.001);
  const totalIncome = +income.reduce((a, r) => a + r.amount, 0).toFixed(2);
  const totalExpense = +expense.reduce((a, r) => a + r.amount, 0).toFixed(2);
  res.success({ income, expense, totalIncome, totalExpense, netProfit: +(totalIncome - totalExpense).toFixed(2), from: from || null, to: to || null });
});

/* Balance sheet */
router.get("/balance-sheet", requirePermission("accounting", "view"), async (req, res) => {
  const f = req.user.firm_id;
  const asOf = req.query.to || req.query.as_of;
  // balances as of a date, derived from journal lines (all history up to and including asOf)
  const rows = asOf ? (await query(
    `SELECT a.code, a.name, a.type,
            COALESCE((SELECT SUM(l.debit) - SUM(l.credit)
                        FROM journal_entry_lines l
                        JOIN journal_entries e ON e.id = l.entry_id
                       WHERE l.firm_id = a.firm_id AND l.account_code = a.code AND e.entry_date <= ?), 0) AS balance
       FROM chart_of_accounts a
      WHERE a.firm_id=?`,
    [asOf, f])).rows
  : (await query(
    `SELECT a.code, a.name, a.type, COALESCE(b.balance,0) AS balance
       FROM chart_of_accounts a LEFT JOIN account_balances b ON b.firm_id=a.firm_id AND b.account_code=a.code
      WHERE a.firm_id = ?`,
    [f]
  )).rows;
  const assets = rows.filter((r) => r.type === "asset").map((r) => ({ ...r, amount: r.balance }));
  const liabilities = rows.filter((r) => r.type === "liability").map((r) => ({ ...r, amount: -r.balance }));
  const equity = rows.filter((r) => r.type === "equity").map((r) => ({ ...r, amount: -r.balance }));
  // retained profit folds into equity
  const income = rows.filter((r) => r.type === "income").reduce((a, r) => a - r.balance, 0);
  const expense = rows.filter((r) => r.type === "expense").reduce((a, r) => a + r.balance, 0);
  const netProfit = +(income - expense).toFixed(2);
  const totalAssets = +assets.reduce((a, r) => a + r.amount, 0).toFixed(2);
  const totalLiab = +liabilities.reduce((a, r) => a + r.amount, 0).toFixed(2);
  const totalEquity = +(equity.reduce((a, r) => a + r.amount, 0) + netProfit).toFixed(2);
  res.success({ assets, liabilities, equity, netProfit, totalAssets, totalLiabilitiesAndEquity: +(totalLiab + totalEquity).toFixed(2), totalLiab, totalEquity, asOf: asOf || null });
});

/* Manual journal entry */
/* Entries with no document behind them — the only ones this screen may
   rewrite or remove directly. */
const STANDALONE = ["manual", "other_income"];

/* What wrote an entry, in the words the rest of the app uses, so a refusal
   points at the screen that can actually undo it. */
function sourceLabel(m) {
  const name = (k) => ({ sales: "sale", purchases: "purchase bill", payments: "payment", expenses: "expense",
    sale_returns: "credit note", purchase_returns: "debit note", pos: "till sale",
    stock: "stock movement", manual: "journal", other_income: "other-income receipt" })[k] || k || "document";
  /* Reversals are entries too, and somebody will eventually click one. Saying
     "posted by a payments_void" is the code leaking; saying it is the reversal
     of a payment points at the document that actually owns it. */
  return String(m).endsWith("_void")
    ? `reversal of a ${name(String(m).replace(/_void$/, ""))}`
    : name(m);
}

/**
 * Correct a journal made by hand.
 *
 * Rewritten in place rather than reversed-and-reposted, and deliberately so:
 * unlike an expense or a payment, a manual journal is not a document anybody
 * holds a copy of, and its entry number is not written on anything outside
 * this app. Filling the ledger with reversal pairs for a typo in a narration
 * would make the day book harder to read to no one's benefit. The edit is
 * recorded on the entry — `edited_at`, `edit_count` — so a changed journal is
 * still visibly a changed journal.
 *
 * An entry a document posted is refused, for the reason the delete gives.
 */
router.put("/journal/:id", requirePermission("accounting", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = req.user.firm_id;
    const e = (await query("SELECT * FROM journal_entries WHERE id=? AND firm_id=?", [req.params.id, f])).rows[0];
    if (!e) return res.fail("Entry not found", 404);
    if (!STANDALONE.includes(e.source_module)) {
      return res.fail(`${e.entry_no} was posted by a ${sourceLabel(e.source_module)} — change that document instead`);
    }
    const b = req.body || {};
    const lines = Array.isArray(b.lines) ? b.lines : null;
    if (!lines || lines.length < 2) return res.fail("A journal needs at least two lines");

    /* Balanced before anything is touched. postJournal throws on an unbalanced
       set, but by then the old lines are already gone and only the transaction
       rollback saves the books — better to refuse while nothing has moved. */
    const r2n = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const dr = r2n(lines.reduce((a, l) => a + (Number(l.debit) || 0), 0));
    const cr = r2n(lines.reduce((a, l) => a + (Number(l.credit) || 0), 0));
    if (Math.abs(dr - cr) > 0.01) return res.fail(`This journal does not balance — debits ${dr.toFixed(2)}, credits ${cr.toFixed(2)}`);
    if (!(dr > 0)) return res.fail("A journal of nothing has nothing to post");

    await conn.beginTransaction();
    const olds = (await conn.query("SELECT account_code, debit, credit FROM journal_entry_lines WHERE firm_id=? AND entry_id=?", [f, e.id])).rows;
    for (const l of olds) {
      const delta = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      await conn.query("UPDATE account_balances SET balance = ROUND(balance - ?, 2) WHERE firm_id=? AND account_code=?", [delta, f, l.account_code]);
    }
    await conn.query("DELETE FROM journal_entry_lines WHERE firm_id=? AND entry_id=?", [f, e.id]);

    let posted = 0;
    for (const l of lines) {
      const debit = Number(l.debit) || 0, credit = Number(l.credit) || 0;
      if (!debit && !credit) continue;
      const acct = (await conn.query("SELECT 1 FROM chart_of_accounts WHERE firm_id=? AND code=?", [f, l.account_code])).rows[0];
      /* An unknown account is refused rather than skipped. postJournal skips
         it so a half-built chart cannot break a sale at the till; here there
         is a person looking at a form, and silently dropping the line they
         typed would leave an entry that does not balance and no clue why. */
      if (!acct) { await conn.rollback(); return res.fail(`There is no account with the code ${l.account_code}`); }
      await conn.query("INSERT INTO journal_entry_lines (firm_id, entry_id, account_code, debit, credit, narration) VALUES (?,?,?,?,?,?)",
        [f, e.id, l.account_code, debit, credit, l.narration || null]);
      const delta = debit - credit;
      const bal = (await conn.query("SELECT id FROM account_balances WHERE firm_id=? AND account_code=?", [f, l.account_code])).rows[0];
      if (bal) await conn.query("UPDATE account_balances SET balance = balance + ? WHERE id = ?", [delta, bal.id]);
      else await conn.query("INSERT INTO account_balances (firm_id, account_code, balance) VALUES (?,?,?)", [f, l.account_code, delta]);
      posted++;
    }
    await conn.query(
      `UPDATE journal_entries SET entry_date=?, description=?, reference=?, edited_at=datetime('now'),
              edit_count=COALESCE(edit_count,0)+1 WHERE id=? AND firm_id=?`,
      [b.date || e.entry_date, b.description !== undefined ? b.description : e.description,
       b.reference !== undefined ? b.reference : e.reference, e.id, f]);
    await conn.query("INSERT INTO audit_logs (user_id, module, action, entity_id, detail) VALUES (?,?,?,?,?)",
      [req.user.id, "accounting", "edit_journal", e.id, `${e.entry_no} rewritten — ${posted} lines, ${dr.toFixed(2)}`]);
    await conn.commit();
    res.success({ id: e.id, entry_no: e.entry_no, lines: posted, total: dr }, `${e.entry_no} updated`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

router.post("/journal", requirePermission("accounting", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  let ref = null;
  try {
    const b = req.body || {};
    if (!Array.isArray(b.lines) || b.lines.length < 2) return res.fail("A journal needs at least two lines");
    if (await blockClosed(req, res, b.date || new Date().toISOString().slice(0, 10), "journal")) return;
    /* A hand-keyed journal is the one posting with no document behind it, so a
       duplicate leaves nothing obvious for anybody to notice — it just sits in
       the ledger, balanced, moving two accounts by an amount nobody entered
       twice on purpose. */
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("journal_entries", req.user.firm_id, ref);
      if (prior) return res.success({ entryId: prior.id, entry_no: prior.entry_no, replayed: true }, "Journal posted");
    }
    await conn.beginTransaction();
    const je = await postJournal(conn, {
      firmId: req.user.firm_id, date: b.date || new Date().toISOString().slice(0, 10),
      description: b.description, reference: b.reference, sourceModule: "manual", userId: req.user.id, lines: b.lines,
      clientRef: ref,
    });
    await conn.commit();
    res.success(je, "Journal posted");
  } catch (err) {
    await conn.rollback();
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("journal_entries", req.user.firm_id, ref);
      if (prior) return res.success({ entryId: prior.id, entry_no: prior.entry_no, replayed: true }, "Journal posted");
    }
    next(err);
  }
  finally { conn.release(); }
});

module.exports = router;
