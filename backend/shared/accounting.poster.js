/**
 * accounting.poster.js — double-entry posting engine (blueprint §5.7).
 *
 * postJournal writes a balanced entry into journal_entries + journal_entry_lines
 * and updates account_balances. Balances are signed with DEBIT positive
 * (assets/expenses increase with debit; income/liabilities/equity increase with credit).
 *
 * Lines whose account_code is unknown for the firm are skipped (so a partial
 * chart never crashes a sale) — but we assert the entry balances first, so a
 * silent skip can't hide an unbalanced entry.
 */
const { nextSeq, pad } = require("./sequences");
const { CODES } = require("./account.codes");

async function postJournal(conn, { firmId, date, description, reference, sourceModule, sourceId, lines, userId, clientRef = null }) {
  const clean = lines.filter((l) => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
  const totDr = round2(clean.reduce((a, l) => a + (Number(l.debit) || 0), 0));
  const totCr = round2(clean.reduce((a, l) => a + (Number(l.credit) || 0), 0));
  if (Math.abs(totDr - totCr) > 0.01) {
    throw new Error(`Unbalanced journal: Dr ${totDr} vs Cr ${totCr} (${description})`);
  }

  const no = `JE-${pad(await nextSeq(conn, `JE:firm${firmId}`))}`;
  /* `client_ref` only ever carries a value for a journal somebody typed. An
     entry a document produced is already protected by that document's own
     key — writing the same reference on both would make the bill's key
     collide with its own journal's. */
  const r = await conn.query(
    `INSERT INTO journal_entries (firm_id, entry_no, entry_date, description, reference, source_module, source_id, created_by, client_ref)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [firmId, no, date, description || null, reference || null, sourceModule || "manual", sourceId || null, userId || null, clientRef || null]
  );
  const entryId = r.insertId;

  for (const l of clean) {
    // Only post to accounts that exist for this firm.
    const acct = (await conn.query("SELECT 1 FROM chart_of_accounts WHERE firm_id = ? AND code = ?", [firmId, l.account_code])).rows[0];
    if (!acct) continue;
    await conn.query(
      `INSERT INTO journal_entry_lines (firm_id, entry_id, account_code, debit, credit, narration)
       VALUES (?,?,?,?,?,?)`,
      [firmId, entryId, l.account_code, Number(l.debit) || 0, Number(l.credit) || 0, l.narration || null]
    );
    const delta = (Number(l.debit) || 0) - (Number(l.credit) || 0);
    const bal = (await conn.query("SELECT id FROM account_balances WHERE firm_id = ? AND account_code = ?", [firmId, l.account_code])).rows[0];
    if (bal) await conn.query("UPDATE account_balances SET balance = balance + ? WHERE id = ?", [delta, bal.id]);
    else await conn.query("INSERT INTO account_balances (firm_id, account_code, balance) VALUES (?,?,?)", [firmId, l.account_code, delta]);
  }
  return { entryId, entry_no: no };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Posting templates — build balanced line sets from totals.
 * Each returns an array of { account_code, debit, credit }.
 */
const templates = {
  /**
   * Sale. grand = sub − deducted + added + roundOff.
   * Deducted taxes (WHT/VAT withheld by the buyer) become a Tax Recoverable
   * asset — money we can claim against our URA liability.
   */
  sale({ subTotal, deducted = 0, added = 0, roundOff = 0, receivableCode, salesSplit }) {
    const grand = round2(subTotal - deducted + added + roundOff);
    const lines = [{ account_code: receivableCode, debit: grand }];
    if (deducted) lines.push({ account_code: CODES.TAX_RECOVERABLE, debit: deducted });
    // credit each overridden sales account, remainder to the default Sales account
    if (salesSplit && Object.keys(salesSplit).length) {
      let assigned = 0;
      for (const [code, amt] of Object.entries(salesSplit)) { lines.push({ account_code: code, credit: round2(amt) }); assigned = round2(assigned + amt); }
      const rest = round2(subTotal - assigned);
      if (Math.abs(rest) > 0.001) lines.push({ account_code: CODES.SALES, credit: rest });
    } else lines.push({ account_code: CODES.SALES, credit: subTotal });
    if (added) lines.push({ account_code: CODES.TAXES_PAYABLE, credit: added });
    if (roundOff > 0) lines.push({ account_code: CODES.ROUND_OFF, credit: roundOff });
    else if (roundOff < 0) lines.push({ account_code: CODES.ROUND_OFF, debit: -roundOff });
    return lines;
  },
  saleCredit(a) { return templates.sale({ ...a, receivableCode: CODES.DEBTORS }); },
  saleCash(a) { return templates.sale({ ...a, receivableCode: a.cashCode || CODES.CASH }); },

  /**
   * Purchase. Deducted taxes are amounts WE withhold from the supplier and
   * owe URA (Taxes Payable). Added taxes charged by the supplier are recoverable.
   */
  purchase({ subTotal, deducted = 0, added = 0, roundOff = 0, payableCode, stockCode }) {
    const grand = round2(subTotal - deducted + added + roundOff);
    // Perpetual inventory: buying stock is not an expense, it swaps cash/credit for an asset.
    // The expense lands later, as COGS, when the goods are actually sold.
    const lines = [{ account_code: stockCode || CODES.STOCK, debit: subTotal }];
    if (added) lines.push({ account_code: CODES.TAX_RECOVERABLE, debit: added });
    if (roundOff > 0) lines.push({ account_code: CODES.ROUND_OFF, debit: roundOff });
    lines.push({ account_code: payableCode, credit: grand });
    if (deducted) lines.push({ account_code: CODES.TAXES_PAYABLE, credit: deducted });
    if (roundOff < 0) lines.push({ account_code: CODES.ROUND_OFF, credit: -roundOff });
    return lines;
  },
  purchaseCredit(a) { return templates.purchase({ ...a, payableCode: CODES.CREDITORS }); },
  purchaseCash(a) { return templates.purchase({ ...a, payableCode: a.cashCode || CODES.CASH }); },

  /**
   * Money in from a customer. `amount` is what settles the invoice; `deducted`
   * is tax the customer withheld (WHT) — it also settles the invoice but never
   * reaches our bank, so it lands in Tax Recoverable. `charges` are bank fees
   * taken out of the deposit, so cash actually received is amount − charges.
   */
  paymentIn({ amount, cashCode = CODES.CASH, deducted = 0, charges = 0 }) {
    const lines = [{ account_code: cashCode, debit: round2(amount - charges) }];
    if (charges) lines.push({ account_code: CODES.EXPENSE, debit: charges });
    if (deducted) lines.push({ account_code: CODES.TAX_RECOVERABLE, debit: deducted });
    lines.push({ account_code: CODES.DEBTORS, credit: round2(amount + deducted) });
    return lines;
  },
  /** Money out to a supplier. `deducted` is WHT we keep back and owe URA. */
  paymentOut({ amount, cashCode = CODES.CASH, deducted = 0, charges = 0 }) {
    const lines = [{ account_code: CODES.CREDITORS, debit: round2(amount + deducted) }];
    if (charges) lines.push({ account_code: CODES.EXPENSE, debit: charges });
    if (deducted) lines.push({ account_code: CODES.TAXES_PAYABLE, credit: deducted });
    lines.push({ account_code: cashCode, credit: round2(amount + charges) });
    return lines;
  },
  expense({ amount, tax = 0, cashCode = CODES.CASH }) {
    const lines = [{ account_code: CODES.EXPENSE, debit: amount }];
    if (tax) lines.push({ account_code: CODES.TAX_RECOVERABLE, debit: tax });
    lines.push({ account_code: cashCode, credit: round2(amount + tax) });
    return lines;
  },
  otherIncome({ amount, cashCode = CODES.CASH }) {
    return [
      { account_code: cashCode, debit: amount },
      { account_code: CODES.OTHER_INCOME, credit: amount },
    ];
  },
  // Credit note reverses a sale; debit note reverses a purchase.
  creditNote({ subTotal, deducted = 0, added = 0, creditCode }) {
    const grand = round2(subTotal - deducted + added);
    const lines = [{ account_code: CODES.SALES, debit: subTotal }];
    if (added) lines.push({ account_code: CODES.TAXES_PAYABLE, debit: added });
    lines.push({ account_code: creditCode, credit: grand });
    if (deducted) lines.push({ account_code: CODES.TAX_RECOVERABLE, credit: deducted });
    return lines;
  },
  debitNote({ subTotal, deducted = 0, added = 0 }) {
    const grand = round2(subTotal - deducted + added);
    const lines = [{ account_code: CODES.CREDITORS, debit: grand }];
    if (deducted) lines.push({ account_code: CODES.TAXES_PAYABLE, debit: deducted });
    lines.push({ account_code: CODES.PURCHASES, credit: subTotal });
    if (added) lines.push({ account_code: CODES.TAX_RECOVERABLE, credit: added });
    return lines;
  },
};

/**
 * Reverse every journal entry a source produced: swap debit/credit, post as a
 * new balanced entry.
 *
 * ── Why `reversed_at` exists ──────────────────────────────────────────────
 *
 * This used to reverse EVERY entry filed under (source_module, source_id),
 * every time it was called. That is right exactly once, and wrong the moment a
 * document is amended, because an amendment is "reverse, then post again under
 * the same source" — which leaves two entries there, one of them already
 * reversed.
 *
 * The arithmetic of the old behaviour, on an expense entered as 450,000 and
 * corrected to 45,000:
 *
 *   post      → entry A  Dr 450,000
 *   amend     → reverse A (Cr 450,000), post entry B  Dr 45,000   → books: 45,000 ✓
 *   void      → reverse A *again* AND B  (Cr 495,000)             → books: −450,000 ✗
 *
 * The ledger still balanced — every reversal is itself a balanced entry — so
 * the trial balance gave no warning at all. It simply put 450,000 of expense
 * that never happened into the accounts, and the only way to notice was to
 * read the day book line by line.
 *
 * This is not only reachable through the new expense and payment edits. Sales
 * have had "reverse and re-post under the same source" since edit-an-invoice
 * was written, so any invoice amended and later voided has carried the same
 * fault. Stamping each entry as it is reversed makes a second reversal
 * impossible rather than merely unlikely.
 */
async function reverseJournal(conn, { firmId, sourceModule, sourceId, date, description, userId }) {
  const entries = (await conn.query(
    "SELECT id FROM journal_entries WHERE firm_id=? AND source_module=? AND source_id=? AND reversed_at IS NULL",
    [firmId, sourceModule, sourceId])).rows;
  for (const e of entries) {
    const lines = (await conn.query(
      "SELECT account_code, debit, credit, narration FROM journal_entry_lines WHERE entry_id=?", [e.id])).rows
      .map((l) => ({ account_code: l.account_code, debit: round2(l.credit), credit: round2(l.debit), narration: "Reversal: " + (l.narration || "") }));
    if (lines.length) await postJournal(conn, { firmId, date, description, reference: description, sourceModule: sourceModule + "_void", sourceId, lines, userId });
    /* Stamped whether or not it had lines: an entry with none has nothing to
       reverse, and leaving it unstamped would make it a candidate forever. */
    await conn.query("UPDATE journal_entries SET reversed_at = datetime('now') WHERE id = ?", [e.id]);
  }
  return entries.length;
}

/* Cost of goods sold: move the cost of what left the shelf out of Inventory
   and into an expense, so gross profit on the P&L is real.
   `split` lets an item post to its own COGS account when one is configured. */
templates.cogs = function ({ totalCost, split }) {
  const lines = [];
  let assigned = 0;
  if (split) {
    for (const [code, amt] of Object.entries(split)) {
      if (amt > 0) { lines.push({ account_code: code, debit: round2(amt) }); assigned = round2(assigned + amt); }
    }
  }
  const rest = round2(totalCost - assigned);
  if (rest > 0.004) lines.push({ account_code: CODES.COGS, debit: rest });
  if (!lines.length) return [];
  lines.push({ account_code: CODES.STOCK, credit: round2(totalCost) });
  return lines;
};

module.exports = { postJournal, reverseJournal, templates, round2 };
