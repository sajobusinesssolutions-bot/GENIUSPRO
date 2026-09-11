const express = require("express");
const router = express.Router();
const { query, pool } = require("../../database/db");
const { listQuery, sendList } = require("../../shared/paginate");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { nextSeq, pad } = require("../../shared/sequences");
const { postJournal, templates } = require("../../shared/accounting.poster");
const { CODES } = require("../../shared/account.codes");
const { blockedReason, voidLedger, logAudit, today } = require("../../shared/voucher");
const { clientRef, findByRef, isDuplicateRef, ensureKeys } = require("../../shared/idempotency");
const { blockClosed } = require("../../shared/periodlock");
const { durable } = require("../../shared/durable");

router.use(verifyToken);

const EXPENSE_CATEGORIES = ["Rent", "Salary", "Electricity", "Telephone & Internet", "Transport", "Repairs", "Stationery", "Marketing", "Bank Charges", "Miscellaneous"];

router.get("/categories", (req, res) => res.success(EXPENSE_CATEGORIES));

/* ── Expenses ── */
router.get("/", requirePermission("expenses", "view"), async (req, res) => {
  sendList(res, await listQuery({
    req,
    select: "SELECT e.*, p.name AS party_name FROM expenses e LEFT JOIN parties p ON p.id = e.party_id",
    countFrom: "FROM expenses e LEFT JOIN parties p ON p.id = e.party_id",
    where: ["e.firm_id = ?"], args: [req.user.firm_id],
    orderBy: "e.id DESC",
    searchCols: ["e.expense_no", "e.category", "e.notes", "p.name"],
    dateCol: "e.expense_date",
    /* A voided expense is still listed — it has to be, or a shop cannot see
       that the 450,000 they remember typing was taken back — but it must not
       be added up. The strip above the list and the ledger below it saying
       different numbers is how the void gets reported as a bug. */
    sumCols: { amount: "CASE WHEN COALESCE(e.status,'posted') = 'voided' THEN 0 ELSE e.amount END" },
  }));
});

const expenseReply = (e) => ({ id: e.id, expense_no: e.expense_no, amount: e.amount });

router.post("/", requirePermission("expenses", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  let ref = null;
  try {
    const b = req.body || {};
    /* The expense form saves one request per line and stops at the first
       refusal, so a dropped connection halfway down a page of receipts is the
       likeliest way this endpoint sees a retry. Each line carries its own
       reference; the ones that landed are recognised and not written again. */
    await ensureKeys();
    ref = clientRef(req);
    if (ref) {
      const prior = await findByRef("expenses", req.user.firm_id, ref);
      if (prior) return res.success({ ...expenseReply(prior), replayed: true }, "Expense recorded");
    }
    const amount = +Number(b.amount || 0).toFixed(2);
    if (!(amount > 0)) return res.fail("Enter an amount", 400);
    const tax = +Number(b.tax_amount || 0).toFixed(2);
    const dt = b.expense_date || new Date().toISOString().slice(0, 10);
    if (await blockClosed(req, res, dt, "expense")) return;
    const cashCode = b.cash_account_code || CODES.CASH;

    await conn.beginTransaction();
    const no = `EXP-${pad(await nextSeq(conn, `EXP:firm${req.user.firm_id}`))}`;
    const r = await conn.query(
      `INSERT INTO expenses (firm_id, expense_no, category, party_id, expense_date, amount, tax_amount, mode, notes, created_by, cash_account_code, status, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?)`,
      [req.user.firm_id, no, b.category || "Miscellaneous", b.party_id || null, dt, amount, tax, b.mode || "cash", b.notes || null, req.user.id, cashCode, ref]
    );
    await postJournal(conn, {
      firmId: req.user.firm_id, date: dt, description: `Expense — ${b.category || "Misc"} ${no}`, reference: no,
      sourceModule: "expenses", sourceId: r.insertId, userId: req.user.id,
      lines: templates.expense({ amount, tax, cashCode }),
    });
    await conn.commit();
    res.success({ id: r.insertId, expense_no: no }, "Expense recorded");
  } catch (err) {
    await conn.rollback();
    if (ref && isDuplicateRef(err)) {
      const prior = await findByRef("expenses", req.user.firm_id, ref);
      if (prior) return res.success({ ...expenseReply(prior), replayed: true }, "Expense recorded");
    }
    next(err);
  }
  finally { conn.release(); }
});

/* ── Other income (interest, commission, scrap…) ── */
router.get("/other-income", requirePermission("expenses", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT j.id, j.entry_no, j.entry_date, j.description, l.credit AS amount
       FROM journal_entries j JOIN journal_entry_lines l ON l.entry_id = j.id
      WHERE j.firm_id = ? AND j.source_module = 'other_income' AND l.account_code = ?
      ORDER BY j.id DESC LIMIT 200`,
    [req.user.firm_id, CODES.OTHER_INCOME]
  )).rows;
  res.success(rows);
});

router.post("/other-income", requirePermission("expenses", "create"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const amount = +Number(b.amount || 0).toFixed(2);
    if (!(amount > 0)) return res.fail("Enter an amount", 400);
    const dt = b.date || new Date().toISOString().slice(0, 10);
    await conn.beginTransaction();
    const je = await postJournal(conn, {
      firmId: req.user.firm_id, date: dt, description: b.description || "Other income",
      sourceModule: "other_income", userId: req.user.id,
      lines: templates.otherIncome({ amount, cashCode: b.cash_account_code || CODES.CASH }),
    });
    await conn.commit();
    res.success(je, "Income recorded");
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* One expense, for the edit form to open. */
/* Digits only. `/expenses/recurring` is a single segment too, and a bare
   `/:id` would swallow it — the schedules list would answer "expense not
   found" and nothing would say why. */
router.get("/:id(\\d+)", requirePermission("expenses", "view"), async (req, res) => {
  const row = (await query(
    `SELECT e.*, p.name AS party_name FROM expenses e
       LEFT JOIN parties p ON p.id = e.party_id
      WHERE e.id = ? AND e.firm_id = ?`, [req.params.id, req.user.firm_id])).rows[0];
  if (!row) return res.fail("Expense not found", 404);
  res.success(row);
});

/**
 * Correct an expense.
 *
 * Void and re-post under the same number, in one transaction. Doing it as a
 * reversal plus a fresh entry — rather than editing the journal lines in
 * place — means the ledger shows what was posted, that it was taken back, and
 * what replaced it. An amount quietly rewritten in the books is the one thing
 * an auditor cannot follow.
 */
router.put("/:id(\\d+)", requirePermission("expenses", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const e = (await query("SELECT * FROM expenses WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    const stop = blockedReason(e, { label: "Expense" });
    if (stop) return res.fail(stop, e ? 400 : 404);

    const b = req.body || {};
    const amount = +Number(b.amount != null ? b.amount : e.amount).toFixed(2);
    if (!(amount > 0)) return res.fail("Enter an amount", 400);
    const tax = +Number(b.tax_amount != null ? b.tax_amount : e.tax_amount || 0).toFixed(2);
    if (tax < 0) return res.fail("Tax cannot be negative", 400);
    const dt = b.expense_date || e.expense_date;
    const cashCode = b.cash_account_code || e.cash_account_code || CODES.CASH;
    const category = b.category || e.category;

    await conn.beginTransaction();
    await voidLedger(conn, { firmId, sources: ["expenses"], sourceId: e.id, docNo: e.expense_no, userId: req.user.id, date: today() });
    await conn.query(
      `UPDATE expenses SET category=?, party_id=?, expense_date=?, amount=?, tax_amount=?, mode=?, notes=?,
              cash_account_code=?, edited_at=datetime('now'), edit_count=COALESCE(edit_count,0)+1
        WHERE id=? AND firm_id=?`,
      [category, b.party_id !== undefined ? (b.party_id || null) : e.party_id, dt, amount, tax,
       b.mode || e.mode || "cash", b.notes !== undefined ? (b.notes || null) : e.notes, cashCode, e.id, firmId]);
    await postJournal(conn, {
      firmId, date: dt, description: `Expense — ${category || "Misc"} ${e.expense_no} (amended)`, reference: e.expense_no,
      sourceModule: "expenses", sourceId: e.id, userId: req.user.id,
      lines: templates.expense({ amount, tax, cashCode }),
    });
    await logAudit(conn, { userId: req.user.id, module: "expenses", action: "edit", entityId: e.id,
      detail: `${e.expense_no} ${e.amount} → ${amount}` });
    await conn.commit();
    res.success({ id: e.id, expense_no: e.expense_no, amount }, `${e.expense_no} updated`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/** Cancel an expense. The row stays, marked voided, with its journal reversed. */
router.delete("/:id(\\d+)", requirePermission("expenses", "delete"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const e = (await query("SELECT * FROM expenses WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
    const stop = blockedReason(e, { label: "Expense" });
    if (stop) return res.fail(stop, e ? 400 : 404);

    await conn.beginTransaction();
    await voidLedger(conn, { firmId, sources: ["expenses"], sourceId: e.id, docNo: e.expense_no, userId: req.user.id, date: today() });
    await conn.query(
      "UPDATE expenses SET status='voided', void_reason=?, voided_at=datetime('now') WHERE id=? AND firm_id=?",
      [(req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : null, e.id, firmId]);
    await logAudit(conn, { userId: req.user.id, module: "expenses", action: "void", entityId: e.id,
      detail: `${e.expense_no} ${e.amount}` });
    await conn.commit();
    res.success({ id: e.id, voided: true }, `${e.expense_no} voided`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

/* ── Other income ─────────────────────────────────────────────────────────
 * Other income has no document table of its own — it is a journal entry and
 * nothing else. So correcting one means rewriting that entry, and cancelling
 * one means removing it, which is what `/accounting/journal/:id` already does
 * for entries with nothing behind them. These two forward to exactly that, so
 * the Income screen does not need its own copy of the rule.
 */
router.put("/other-income/:id", requirePermission("expenses", "edit"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const je = (await query("SELECT * FROM journal_entries WHERE id=? AND firm_id=? AND source_module='other_income'",
      [req.params.id, firmId])).rows[0];
    if (!je) return res.fail("Income entry not found", 404);
    const b = req.body || {};
    const amount = +Number(b.amount || 0).toFixed(2);
    if (!(amount > 0)) return res.fail("Enter an amount", 400);
    const dt = b.date || je.entry_date;
    const cashCode = b.cash_account_code || CODES.CASH;

    await conn.beginTransaction();
    /* Unwind this entry's effect on the balances, then rewrite its lines in
       place. The entry keeps its number, because JE-000031 may already be
       quoted in a reconciliation somebody has printed. */
    const olds = (await conn.query("SELECT account_code, debit, credit FROM journal_entry_lines WHERE firm_id=? AND entry_id=?",
      [firmId, je.id])).rows;
    for (const l of olds) {
      const delta = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      await conn.query("UPDATE account_balances SET balance = ROUND(balance - ?, 2) WHERE firm_id=? AND account_code=?",
        [delta, firmId, l.account_code]);
    }
    await conn.query("DELETE FROM journal_entry_lines WHERE firm_id=? AND entry_id=?", [firmId, je.id]);

    for (const l of templates.otherIncome({ amount, cashCode })) {
      const acct = (await conn.query("SELECT 1 FROM chart_of_accounts WHERE firm_id=? AND code=?", [firmId, l.account_code])).rows[0];
      if (!acct) continue;
      await conn.query(
        "INSERT INTO journal_entry_lines (firm_id, entry_id, account_code, debit, credit, narration) VALUES (?,?,?,?,?,?)",
        [firmId, je.id, l.account_code, Number(l.debit) || 0, Number(l.credit) || 0, null]);
      const delta = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      const bal = (await conn.query("SELECT id FROM account_balances WHERE firm_id=? AND account_code=?", [firmId, l.account_code])).rows[0];
      if (bal) await conn.query("UPDATE account_balances SET balance = balance + ? WHERE id = ?", [delta, bal.id]);
      else await conn.query("INSERT INTO account_balances (firm_id, account_code, balance) VALUES (?,?,?)", [firmId, l.account_code, delta]);
    }
    await conn.query(
      `UPDATE journal_entries SET entry_date=?, description=?, edited_at=datetime('now'),
              edit_count=COALESCE(edit_count,0)+1 WHERE id=? AND firm_id=?`,
      [dt, b.description || je.description, je.id, firmId]);
    await logAudit(conn, { userId: req.user.id, module: "expenses", action: "edit_income", entityId: je.id, detail: je.entry_no });
    await conn.commit();
    res.success({ id: je.id, entry_no: je.entry_no, amount }, `${je.entry_no} updated`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});

router.delete("/other-income/:id", requirePermission("expenses", "delete"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const firmId = req.user.firm_id;
    const je = (await query("SELECT * FROM journal_entries WHERE id=? AND firm_id=? AND source_module='other_income'",
      [req.params.id, firmId])).rows[0];
    if (!je) return res.fail("Income entry not found", 404);
    await conn.beginTransaction();
    const lines = (await conn.query("SELECT account_code, debit, credit FROM journal_entry_lines WHERE firm_id=? AND entry_id=?",
      [firmId, je.id])).rows;
    for (const l of lines) {
      const delta = (Number(l.debit) || 0) - (Number(l.credit) || 0);
      await conn.query("UPDATE account_balances SET balance = ROUND(balance - ?, 2) WHERE firm_id=? AND account_code=?",
        [delta, firmId, l.account_code]);
    }
    await conn.query("DELETE FROM journal_entry_lines WHERE firm_id=? AND entry_id=?", [firmId, je.id]);
    await conn.query("DELETE FROM journal_entries WHERE id=? AND firm_id=?", [je.id, firmId]);
    await logAudit(conn, { userId: req.user.id, module: "expenses", action: "delete_income", entityId: je.id, detail: je.entry_no });
    await conn.commit();
    res.success({ id: je.id }, `${je.entry_no} removed`);
  } catch (err) { await conn.rollback(); next(err); }
  finally { conn.release(); }
});


/* ══════════════════════════════════════════════════════════════════════════
   Repeating expenses
   ─────────────────────────────────────────────────────────────────────────
   Rent, wages, power, the internet bill: the same amount on the same day
   every month. Every one of them had to be typed by hand, which means the
   month somebody is busy is the month the books show a profit the shop did
   not make.

   A schedule is a description of an expense plus when it falls due. Raising
   one goes through the ordinary POST above — same journal, same numbering,
   same audit trail — so a repeated expense is a normal expense that happens
   to have been typed by the machine. `expenses.recurring_id` says which
   schedule produced it, which is what makes "did the rent go in twice?"
   answerable.
   ══════════════════════════════════════════════════════════════════════════ */

const FREQ = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };

/* The next date after `from`, `n` periods on.
 *
 * Month arithmetic is done on the calendar rather than by adding 30 days,
 * and a schedule that starts on the 31st lands on the last day of a short
 * month rather than skidding into the next one — rent due on the 31st is due
 * on the 28th of February, not the 3rd of March. */
function advance(from, freq, n) {
  const step = Math.max(1, Number(n) || 1);
  const d = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (freq === "daily")  d.setUTCDate(d.getUTCDate() + step);
  else if (freq === "weekly") d.setUTCDate(d.getUTCDate() + 7 * step);
  else if (freq === "yearly") d.setUTCFullYear(d.getUTCFullYear() + step);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + step);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

const schedRow = (r) => ({
  ...r,
  due: !!(r.status === "active" && r.next_run && r.next_run <= today()),
});

router.get("/recurring", requirePermission("expenses", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT r.*, p.name AS party_name
       FROM recurring_expenses r LEFT JOIN parties p ON p.id = r.party_id
      WHERE r.firm_id = ?
      ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
               COALESCE(r.next_run, '9999-12-31')`, [req.user.firm_id])).rows;
  const monthly = rows.filter((r) => r.status === "active").reduce((a, r) => {
    const per = { daily: 30, weekly: 4.333, monthly: 1, yearly: 1 / 12 }[r.frequency] || 1;
    return a + (Number(r.amount) || 0) * per / Math.max(1, Number(r.interval_n) || 1);
  }, 0);
  res.success({
    rows: rows.map(schedRow),
    /* What these schedules cost the shop in a month, however they are spaced.
       It is the figure an owner actually wants off this screen, and adding it
       up by hand across four frequencies is exactly the sort of arithmetic
       nobody does. */
    monthly_cost: Math.round((monthly + Number.EPSILON) * 100) / 100,
  });
});

router.post("/recurring", requirePermission("expenses", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const amount = +Number(b.amount || 0).toFixed(2);
  if (!name) return res.fail("Give the schedule a name — 'Shop rent', 'MTN internet'");
  if (!(amount > 0)) return res.fail("Enter an amount");
  const freq = FREQ[b.frequency] ? b.frequency : "monthly";
  const start = b.start_date || today();
  const r = await conn.query(
    `INSERT INTO recurring_expenses
       (firm_id, name, category, party_id, amount, tax_amount, mode, cash_account_code, notes,
        frequency, interval_n, start_date, next_run, end_until, auto, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)`,
    [req.user.firm_id, name, b.category || "Miscellaneous", b.party_id || null,
     amount, +Number(b.tax_amount || 0).toFixed(2), b.mode || "cash",
     b.cash_account_code || null, b.notes || null,
     freq, Math.max(1, Number(b.interval_n) || 1), start, start, b.end_until || null,
     b.auto === false || b.auto === 0 ? 0 : 1, req.user.id]);
  return () => res.success({ id: r.insertId }, "Repeating expense set up");
}));

router.put("/recurring/:id", requirePermission("expenses", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const b = req.body || {};
  const row = (await conn.query("SELECT * FROM recurring_expenses WHERE id=? AND firm_id=?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!row) return res.fail("Schedule not found", 404);
  const amount = b.amount == null ? row.amount : +Number(b.amount).toFixed(2);
  if (!(amount > 0)) return res.fail("Enter an amount");
  const freq = FREQ[b.frequency] ? b.frequency : row.frequency;
  await conn.query(
    `UPDATE recurring_expenses SET name=?, category=?, party_id=?, amount=?, tax_amount=?,
            mode=?, cash_account_code=?, notes=?, frequency=?, interval_n=?, end_until=?, auto=?
      WHERE id=? AND firm_id=?`,
    [String(b.name || row.name).trim(), b.category ?? row.category, b.party_id ?? row.party_id,
     amount, b.tax_amount == null ? row.tax_amount : +Number(b.tax_amount).toFixed(2),
     b.mode || row.mode, b.cash_account_code ?? row.cash_account_code, b.notes ?? row.notes,
     freq, Math.max(1, Number(b.interval_n) || row.interval_n || 1),
     b.end_until === undefined ? row.end_until : (b.end_until || null),
     b.auto === undefined ? row.auto : (b.auto ? 1 : 0),
     row.id, req.user.firm_id]);
  return () => res.success({ id: row.id }, "Schedule updated");
}));

router.post("/recurring/:id/status", requirePermission("expenses", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const want = ["active", "paused", "ended"].includes((req.body || {}).status) ? req.body.status : null;
  if (!want) return res.fail("Say whether it is active, paused or ended");
  const row = (await conn.query("SELECT * FROM recurring_expenses WHERE id=? AND firm_id=?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!row) return res.fail("Schedule not found", 404);
  /* Resuming a schedule that has been paused past its due date must not raise
     the months it slept through in one go. It picks up from today. */
  const next = want === "active"
    ? (row.next_run && row.next_run > today() ? row.next_run : today())
    : row.next_run;
  await conn.query("UPDATE recurring_expenses SET status=?, next_run=? WHERE id=?", [want, want === "ended" ? null : next, row.id]);
  return () => res.success({ id: row.id, status: want }, `Schedule ${want}`);
}));

router.delete("/recurring/:id", requirePermission("expenses", "delete"), async (req, res, next) => await durable(next, async (conn) => {
  const row = (await conn.query("SELECT id FROM recurring_expenses WHERE id=? AND firm_id=?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!row) return res.fail("Schedule not found", 404);
  /* The expenses it already raised are real and stay. Only the schedule goes. */
  await conn.query("DELETE FROM recurring_expenses WHERE id=?", [row.id]);
  return () => res.success({ ok: true }, "Schedule deleted. The expenses it already raised are untouched");
}));

/* Raise one occurrence. Shared by the "Raise it now" button and by run-due. */
async function raiseOnce(conn, user, sched, forDate) {
  const dt = forDate || sched.next_run || today();
  const no = `EXP-${pad(await nextSeq(conn, `EXP:firm${user.firm_id}`))}`;
  const cashCode = sched.cash_account_code || CODES.CASH;
  const amount = +Number(sched.amount || 0).toFixed(2);
  const tax = +Number(sched.tax_amount || 0).toFixed(2);
  const r = await conn.query(
    `INSERT INTO expenses (firm_id, expense_no, category, party_id, expense_date, amount, tax_amount,
                           mode, notes, created_by, cash_account_code, status, recurring_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'posted',?)`,
    [user.firm_id, no, sched.category || "Miscellaneous", sched.party_id || null, dt, amount, tax,
     sched.mode || "cash", sched.notes || sched.name, user.id, cashCode, sched.id]);
  await postJournal(conn, {
    firmId: user.firm_id, date: dt, description: `Expense — ${sched.name} ${no}`, reference: no,
    sourceModule: "expenses", sourceId: r.insertId, userId: user.id,
    lines: templates.expense({ amount, tax, cashCode }),
  });
  const next = advance(dt, sched.frequency, sched.interval_n);
  const ended = sched.end_until && next && next > sched.end_until;
  await conn.query(
    `UPDATE recurring_expenses SET generated = COALESCE(generated,0) + 1, last_run = ?,
            next_run = ?, status = ? WHERE id = ?`,
    [dt, ended ? null : next, ended ? "ended" : sched.status, sched.id]);
  return { id: r.insertId, expense_no: no, expense_date: dt };
}

router.post("/recurring/:id/run", requirePermission("expenses", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const sched = (await conn.query("SELECT * FROM recurring_expenses WHERE id=? AND firm_id=?",
    [req.params.id, req.user.firm_id])).rows[0];
  if (!sched) return res.fail("Schedule not found", 404);
  if (sched.status === "ended") return res.fail("This schedule has ended");
  const made = await raiseOnce(conn, req.user, sched, (req.body || {}).date);
  return () => res.success(made, `${made.expense_no} raised`);
}));

/* Everything that has fallen due. Called by the schedule runner and by the
   button on the screen, so a shop with no background runner can still catch
   up with one click. `auto = 0` schedules are skipped: they exist to be
   raised on purpose. */
router.post("/recurring/run-due", requirePermission("expenses", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const due = (await conn.query(
    `SELECT * FROM recurring_expenses
      WHERE firm_id=? AND status='active' AND auto=1 AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run`, [req.user.firm_id, today()])).rows;
  const made = [];
  for (const sched of due) {
    /* Catch up one period at a time rather than raising a single lump, so a
       shop that was closed for two months gets two rent entries dated when
       they were actually due — which is what the P&L for those months needs. */
    let cur = { ...sched };
    let guard = 0;
    while (cur.next_run && cur.next_run <= today() && guard++ < 24) {
      const one = await raiseOnce(conn, req.user, cur, cur.next_run);
      made.push({ ...one, name: cur.name });
      cur = (await conn.query("SELECT * FROM recurring_expenses WHERE id=?", [cur.id])).rows[0] || {};
      if (cur.status !== "active") break;
    }
  }
  return () => res.success({ raised: made },
    made.length ? `${made.length} expense${made.length === 1 ? "" : "s"} raised` : "Nothing was due");
}));

module.exports = router;
