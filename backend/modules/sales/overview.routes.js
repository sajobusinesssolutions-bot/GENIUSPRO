/* Sales overview — the three figures above the list, and the count on each of
 * the four document tabs.
 *
 * The list endpoint already returns sums for whatever page is showing. These
 * are different: they describe the book regardless of the search or the page,
 * which is what the panels above the table are for. Counting them in the
 * browser would mean fetching every invoice to display three numbers.
 *
 * ── the date range ────────────────────────────────────────────────────────
 *
 * These used to describe the whole book while the list under them showed a
 * date range, so picking "this month" left three figures for all time sitting
 * above thirty invoices for March. Two sets of numbers on one screen that
 * disagree, with nothing saying why. They take the same range now, and the
 * screen says which period it is describing.
 *
 * No range is still the whole book, because that is what somebody who has not
 * chosen one is asking for.
 *
 * Attached by sales.routes.js above its "/:id" route.
 */
const { query } = require("../../database/db");

function attach(router, requirePermission) {
  router.get("/overview", requirePermission("sales", "view"), async (req, res) => {
    const firm = req.user.firm_id;
    const from = String(req.query.from || "").slice(0, 10);
    const to = String(req.query.to || "").slice(0, 10);

    /* One clause per date column, because the four documents do not share a
       name for the day they were raised. */
    const span = (col) => {
      const parts = [];
      const args = [];
      if (from) { parts.push(`AND ${col} >= ?`); args.push(from); }
      if (to) { parts.push(`AND ${col} <= ?`); args.push(to); }
      return { sql: parts.join(" "), args };
    };
    const inv_ = span("invoice_date");
    const est_ = span("doc_date");
    const ret_ = span("return_date");
    const chl_ = span("challan_date");

    const one = async (sql, args = [firm]) => {
      try { return (await query(sql, args)).rows[0] || {}; }
      catch { return {}; }
    };

    /* Voided invoices are excluded from the money: they were reversed, so
       counting them would overstate both what was sold and what is owed. */
    const inv = await one(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(grand_total), 0) AS total,
              COALESCE(SUM(paid_amount), 0) AS received,
              COALESCE(SUM(balance_due), 0) AS owed,
              COALESCE(SUM(CASE WHEN balance_due <= 0.005 THEN 1 ELSE 0 END), 0) AS settled,
              COALESCE(SUM(CASE WHEN balance_due > 0.005 THEN 1 ELSE 0 END), 0) AS open_n
         FROM sale_invoices
        WHERE firm_id = ? AND COALESCE(status, '') <> 'voided' ${inv_.sql}`,
      [firm, ...inv_.args]
    );

    /* "Over 90 days" counts documents, not money — it is a warning about how
       old the oldest debts are, which an amount would hide. */
    const old = await one(
      `SELECT COUNT(*) AS n FROM sale_invoices
        WHERE firm_id = ? AND COALESCE(status, '') <> 'voided'
          AND balance_due > 0.005
          AND invoice_date <= date('now', '-90 day')`
    );

    const voided = await one(
      `SELECT COUNT(*) AS n FROM sale_invoices WHERE firm_id = ? AND status = 'voided' ${inv_.sql}`,
      [firm, ...inv_.args]
    );

    const est = await one(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(grand_total), 0) AS total,
              COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open_n,
              COALESCE(SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END), 0) AS converted
         FROM estimates WHERE firm_id = ? ${est_.sql}`,
      [firm, ...est_.args]
    );

    const cn = await one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS total
         FROM sale_returns WHERE firm_id = ? ${ret_.sql}`,
      [firm, ...ret_.args]
    );

    const ch = await one(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open_n,
              COALESCE(SUM(CASE WHEN status = 'invoiced' THEN 1 ELSE 0 END), 0) AS invoiced
         FROM challans WHERE firm_id = ? ${chl_.sql}`,
      [firm, ...chl_.args]
    );

    const total = +inv.total || 0;
    const received = +inv.received || 0;

    res.success({
      period: { from: from || null, to: to || null },
      counts: {
        invoices: +inv.n || 0,
        estimates: +est.n || 0,
        credit: +cn.n || 0,
        challans: +ch.n || 0,
      },
      invoices: {
        total,
        received,
        owed: +inv.owed || 0,
        /* Guard the divide: a book with no sales is not 0% collected, it has
           nothing to collect, and NaN would reach the screen. */
        collectedPct: total > 0 ? Math.round((received / total) * 100) : 0,
        count: +inv.n || 0,
        settled: +inv.settled || 0,
        open: +inv.open_n || 0,
        over90: +old.n || 0,
        voided: +voided.n || 0,
      },
      estimates: {
        total: +est.total || 0, count: +est.n || 0,
        open: +est.open_n || 0, converted: +est.converted || 0,
      },
      credit: { total: +cn.total || 0, count: +cn.n || 0 },
      challans: { count: +ch.n || 0, open: +ch.open_n || 0, invoiced: +ch.invoiced || 0 },
    });
  });
}

module.exports = { attach };
