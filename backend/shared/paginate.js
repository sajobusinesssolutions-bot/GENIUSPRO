/**
 * paginate.js — opt-in server-side paging for list endpoints.
 *
 * Callers that pass ?page= get { rows, total, page, limit, pages }.
 * Callers that don't get a plain array, so existing screens keep working.
 */
const { query } = require("../database/db");

const MAX_LIMIT = 200;
/* Ceiling for a caller that does not paginate at all. Same 500 as before, so
   nothing that worked stops working — but it is now a documented cap that
   announces itself rather than a silent slice. */
const LEGACY_LIMIT = 500;

/**
 * @param req            express request (reads page, limit, q, from, to)
 * @param select         columns + FROM/JOIN, e.g. "SELECT s.*, p.name AS party_name FROM ... JOIN ..."
 * @param countFrom      FROM/JOIN clause used for COUNT(*), e.g. "FROM sale_invoices s JOIN ..."
 * @param where          array of SQL conditions already parameterised
 * @param args           bind values matching `where`
 * @param orderBy        e.g. "s.id DESC"
 * @param searchCols     columns the ?q= term should match against
 * @param dateCol        column the ?from/?to range applies to
 * @param legacyLimit    cap used when the caller doesn't paginate
 */
async function listQuery({ req, select, countFrom, where = [], args = [], orderBy, searchCols = [], dateCol, sumCols = {} }) {
  const conds = [...where];
  const binds = [...args];

  const q = (req.query.q || "").trim();
  if (q && searchCols.length) {
    conds.push("(" + searchCols.map((c) => `${c} LIKE ?`).join(" OR ") + ")");
    searchCols.forEach(() => binds.push(`%${q}%`));
  }
  if (dateCol && req.query.from) { conds.push(`${dateCol} >= ?`); binds.push(req.query.from); }
  if (dateCol && req.query.to) { conds.push(`${dateCol} <= ?`); binds.push(req.query.to); }

  const whereSql = conds.length ? " WHERE " + conds.join(" AND ") : "";
  const paged = req.query.page != null;

  if (!paged) {
    /* The unpaged path used to ignore ?limit= entirely and always take 500.
       Two problems, both found by measuring against a 6,000-invoice shop: a
       caller asking for 50 got 500 — ten times the payload it wanted — and at
       500 the result was silently truncated, so a shop with 6,000 invoices was
       handed 500 of them with nothing to say the other 5,500 existed. A quiet
       truncation reads as "this is all of it", which is the worst answer a
       books system can give.

       Now: honour the limit the caller asked for, and when the result is cut
       short, say so. The body stays a bare array so existing screens are
       unaffected — the signal rides on headers, which any caller that does not
       look for them simply ignores. */
    const asked = parseInt(req.query.limit, 10);
    const cap = Math.min(Math.max(asked > 0 ? asked : LEGACY_LIMIT, 1), LEGACY_LIMIT);
    /* One row past the cap: cheap, and it tells us whether more exist without
       paying for a COUNT(*) on every unpaged call. */
    const probe = (await query(`${select}${whereSql} ORDER BY ${orderBy} LIMIT ?`, [...binds, cap + 1])).rows;
    const truncated = probe.length > cap;
    return { legacy: true, rows: truncated ? probe.slice(0, cap) : probe, truncated, cap };
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_LIMIT);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  const total = (await query(`SELECT COUNT(*) AS n ${countFrom}${whereSql}`, binds)).rows[0].n;
  const rows = (await query(`${select}${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...binds, limit, offset])).rows;

  // totals across the WHOLE filtered set, so KPI cards don't just describe this page
  let sums = {};
  const sumKeys = Object.keys(sumCols);
  if (sumKeys.length) {
    const expr = sumKeys.map((k) => `COALESCE(SUM(${sumCols[k]}),0) AS ${k}`).join(", ");
    sums = (await query(`SELECT ${expr} ${countFrom}${whereSql}`, binds)).rows[0] || {};
  }

  return { legacy: false, rows, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1), sums };
}

/** Send either the bare array (legacy callers) or the paged envelope. */
function sendList(res, result) {
  if (result.legacy) {
    /* Non-breaking truncation signal: the body is still a bare array. */
    res.set("X-Result-Limit", String(result.cap));
    if (result.truncated) res.set("X-Result-Truncated", "true");
    return res.success(result.rows);
  }
  const { rows, total, page, limit, pages, sums } = result;
  return res.success({ rows, total, page, limit, pages, sums });
}

module.exports = { listQuery, sendList, MAX_LIMIT, LEGACY_LIMIT };
