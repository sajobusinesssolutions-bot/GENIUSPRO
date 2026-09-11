/* Money overview — what the shop is holding, where, and what is about to move.
 *
 * "Accounts" here are chart-of-accounts entries flagged is_cash_bank, which is
 * how the rest of the app already decides what counts as money. A shop that
 * adds an MTN MoMo account gets a card for it without anything here changing;
 * one that never opens a bank account never sees an empty bank panel.
 *
 * Mounted at /api/money.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");

router.use(verifyToken);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Cash in Hand is the drawer; everything else flagged as money is an account
   that lives somewhere other than the till. */
const CASH_CODE = "1001";

/* Which side of the Cash & Bank screen an account belongs on.
   `chart_of_accounts.kind` now stores the answer, chosen in the account editor
   when "holds money" is ticked, and it is preferred whenever it is set.

   It is NULL for every account created before that column existed, and for
   those the old rule still decides: a till, a drawer, a petty-cash float and a
   safe are money the shop can physically touch; anything else is money
   somebody else is holding. Keeping the fallback is the point — backfilling
   the column from this same regex would have frozen its mistakes ("Cash at
   Stanbic" in the drawer) into stored data, where nothing would ever question
   them again. A shopkeeper who edits the account fixes it for good; until
   then, the grouping is exactly what it was yesterday. */
const CASHY_NAME = /\b(cash|till|drawer|petty|float|safe)\b/i;
const KINDS = ["cash", "bank", "mobile"];
/* 'mobile' is a stored answer only, never guessed from the name. MTN and
   Airtel float sit in real accounts that get reconciled against a statement,
   so they are their own group rather than a kind of bank — but adding a name
   rule for it would have moved every account already called "MTN float" out of
   the group it has been in since the book was opened, and a grouping that
   changes by itself on upgrade is how somebody concludes an account has gone
   missing. An existing book groups exactly as it did yesterday until somebody
   edits the account and says so. */
const kindOf = (code, name, kind) =>
  KINDS.includes(kind) ? kind
    : (code === CASH_CODE || CASHY_NAME.test(String(name || ""))) ? "cash" : "bank";

router.get("/overview", requirePermission("accounting", "view"), async (req, res) => {
  const firm = req.user.firm_id;
  const one = async (sql, args = [firm]) => (await query(sql, args)).rows[0] || {};

  /* The period the movement figures describe. Balances are always as they
     stand right now — an account holds what it holds, and "the balance during
     March" is not a thing — but what moved in and out is a question about a
     period, and the screen was only ever able to ask it about today. */
  const from = String(req.query.from || "").slice(0, 10);
  const to = String(req.query.to || "").slice(0, 10);
  const dated = !!(from || to);

  /* Today's movement, per account, in one pass. The tiles show where each
     account opened today and where it stands now; without this the screen
     would have to fetch a statement per account and add the rows up in the
     browser, which is the same arithmetic done four times over a slow link. */
  const today = new Map();
  for (const t of (await query(
    `SELECT l.account_code AS code,
            COALESCE(SUM(l.debit), 0)  AS in_today,
            COALESCE(SUM(l.credit), 0) AS out_today,
            COUNT(*) AS moves
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id
       JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
      WHERE l.firm_id = ? AND a.is_cash_bank = 1 ${dated
        ? `${from ? "AND j.entry_date >= ?" : ""} ${to ? "AND j.entry_date <= ?" : ""}`
        : "AND j.entry_date = date('now')"}
      GROUP BY l.account_code`,
    dated ? [firm, ...(from ? [from] : []), ...(to ? [to] : [])] : [firm]
  )).rows) today.set(t.code, t);

  const accounts = (await query(
    `SELECT a.code, a.name, a.kind, COALESCE(b.balance, 0) AS balance
       FROM chart_of_accounts a
       LEFT JOIN account_balances b ON b.firm_id = a.firm_id AND b.account_code = a.code
      WHERE a.firm_id = ? AND a.is_cash_bank = 1
      ORDER BY a.code`,
    [firm]
  )).rows.map((a) => {
    const t = today.get(a.code) || { in_today: 0, out_today: 0, moves: 0 };
    const balance = r2(a.balance);
    const inToday = r2(t.in_today);
    const outToday = r2(t.out_today);
    return {
      code: a.code, name: a.name, balance, is_cash: a.code === CASH_CODE,
      kind: kindOf(a.code, a.name, a.kind),
      /* Close is the live balance; opening is derived from it by unwinding
         today's movements, because nothing in this schema stores a daily
         snapshot. Doing it this way round means the big figure on the tile is
         always the one the rest of the app agrees with, and it is the
         *opening* that carries any error — which is the right way round, since
         the balance is what a shopkeeper reconciles against. */
      openingToday: r2(balance - (inToday - outToday)),
      inToday, outToday, closeToday: balance,
      movesToday: +t.moves || 0,
    };
  });

  /* In and out across every money account this month. Debits into a cash or
     bank account are money arriving; credits are money leaving. */
  const month = await one(
    `SELECT COALESCE(SUM(l.debit), 0) AS cash_in, COALESCE(SUM(l.credit), 0) AS cash_out
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id
       JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
      WHERE l.firm_id = ? AND a.is_cash_bank = 1
        AND strftime('%Y-%m', j.entry_date) = strftime('%Y-%m', 'now')`
  );

  /* What is about to move, both ways. Counting documents as well as amounts,
     because "four invoices" and "one big one" are different problems. */
  const inDue = await one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(balance_due), 0) AS amount
       FROM sale_invoices
      WHERE firm_id = ? AND COALESCE(status,'') <> 'voided' AND balance_due > 0.005
        AND COALESCE(due_date, invoice_date) <= date('now', '+7 day')`
  );
  const outDue = await one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(balance_due), 0) AS amount
       FROM purchase_invoices
      WHERE firm_id = ? AND balance_due > 0.005
        AND COALESCE(due_date, bill_date) <= date('now', '+7 day')`
  );

  res.success({
    period: { from: from || null, to: to || null, label: dated ? null : "today" },
    accounts,
    onHand: r2(accounts.reduce((a, x) => a + x.balance, 0)),
    month: { in: r2(month.cash_in), out: r2(month.cash_out), net: r2(month.cash_in - month.cash_out) },
    dueThisWeek: {
      incoming: { count: +inDue.n || 0, amount: r2(inDue.amount) },
      outgoing: { count: +outDue.n || 0, amount: r2(outDue.amount) },
    },
  });
});

/* Movements on the money accounts. ?code= narrows to one account, ?date= to a
   single day (what the cash book needs), ?from/&to for a range. */
router.get("/movements", requirePermission("accounting", "view"), async (req, res) => {
  const cond = ["l.firm_id = ?", "a.is_cash_bank = 1"];
  const args = [req.user.firm_id];

  if (req.query.code) { cond.push("l.account_code = ?"); args.push(req.query.code); }
  if (req.query.date) { cond.push("j.entry_date = ?"); args.push(req.query.date); }
  if (req.query.from) { cond.push("j.entry_date >= ?"); args.push(req.query.from); }
  if (req.query.to)   { cond.push("j.entry_date <= ?"); args.push(req.query.to); }

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

  const rows = (await query(
    `SELECT j.entry_date AS d, j.entry_no, j.description, j.source_module, j.reference,
            l.account_code, a.name AS account_name,
            l.debit AS cash_in, l.credit AS cash_out
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.entry_id
       JOIN chart_of_accounts a ON a.firm_id = l.firm_id AND a.code = l.account_code
      WHERE ${cond.join(" AND ")}
      ORDER BY j.entry_date DESC, j.id DESC
      LIMIT ${limit}`,
    args
  )).rows;

  const totals = rows.reduce((a, r) => {
    a.in = r2(a.in + (+r.cash_in || 0));
    a.out = r2(a.out + (+r.cash_out || 0));
    return a;
  }, { in: 0, out: 0 });

  res.success({ rows, totals: { ...totals, net: r2(totals.in - totals.out) } });
});

module.exports = router;
