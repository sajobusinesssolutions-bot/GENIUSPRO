/**
 * loyalty.routes.js — customer loyalty points.
 *
 * The ledger is the truth: every movement is a row, and a balance is simply
 * their sum. Nothing caches a running total, so a balance can never drift away
 * from the movements that explain it — and any figure a customer queries can be
 * traced back to the sale that caused it.
 *
 * Redeeming produces a shilling value the cashier puts on the bill as an
 * ordinary discount, so redemptions flow through the existing tax and posting
 * logic rather than inventing a parallel kind of money.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n) => +Number(n || 0).toFixed(2);
const moduleOn = async (firmId) => await getSetting(firmId, "mod_loyalty", "0") === "1";

const scheme = async (firmId) => ({
  earnPer: Number(await getSetting(firmId, "loyalty_earn_per", "1000")) || 1000,
  pointValue: Number(await getSetting(firmId, "loyalty_point_value", "10")) || 10,
  minRedeem: Number(await getSetting(firmId, "loyalty_min_redeem", "100")) || 0,
  expiryMonths: Number(await getSetting(firmId, "loyalty_expiry_months", "12")) || 0,
  earnOnCredit: await getSetting(firmId, "loyalty_earn_on_credit", "1") === "1",
});

/** Points in, points out — the balance is the difference. */
function balanceOf(q, firmId, partyId) {
  const r = q(
    `SELECT
       COALESCE(SUM(CASE WHEN direction IN ('earn','adjust')  THEN points ELSE 0 END),0) AS credited,
       COALESCE(SUM(CASE WHEN direction IN ('redeem','expire') THEN points ELSE 0 END),0) AS spent
     FROM loyalty_ledger WHERE firm_id = ? AND party_id = ?`,
    [firmId, partyId]
  ).rows[0];
  return {
    earned: r2(r.credited),
    spent: r2(r.spent),
    balance: r2(r.credited - r.spent),
  };
}

/**
 * Award points for a sale. Called from the sale handler inside its transaction
 * so points and the invoice stand or fall together — a rolled-back sale can
 * never leave points behind.
 *
 * Exported rather than routed because earning is a consequence of selling, not
 * something anyone should be able to trigger by hand.
 */
async function awardForSale(conn, { firmId, partyId, invoiceId, amount, paymentType, userId, partyName }) {
  if (!await moduleOn(firmId)) return null;
  if (!partyId) return null;
  /* The walk-in "Cash Sale" party is not a person and must not accrue points. */
  if (partyName && partyName.toLowerCase() === "cash sale") return null;
  const s = await scheme(firmId);
  if (paymentType === "credit" && !s.earnOnCredit) return null;
  const pts = Math.floor(r2(amount) / s.earnPer);
  if (pts <= 0) return null;

  const earned = today();
  let expires = null;
  if (s.expiryMonths > 0) {
    const d = new Date(earned + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + s.expiryMonths);
    expires = d.toISOString().slice(0, 10);
  }
  await conn.query(
    `INSERT INTO loyalty_ledger (firm_id, party_id, direction, points, doc_table, doc_id, earned_on, expires_on, note, created_by)
     VALUES (?,?,'earn',?,?,?,?,?,?,?)`,
    [firmId, partyId, pts, "sale_invoices", invoiceId, earned, expires,
     `Earned on sale of Sh ${r2(amount)}`, userId || null]
  );
  return pts;
}

/* ── Routes ───────────────────────────────────────────────────────────── */

/** Everyone holding points, biggest balance first. */
router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  /* Read once, outside the loop below. It was being read per member — the same
     answer, fetched as many times as the shop has customers — and now that a
     read is a database round-trip that would be one call per row. */
  const sch = await scheme(firmId);
  const rows = (await query(
    `SELECT p.id AS party_id, p.name AS party_name, p.phone,
            COALESCE(SUM(CASE WHEN l.direction IN ('earn','adjust')  THEN l.points ELSE 0 END),0) AS credited,
            COALESCE(SUM(CASE WHEN l.direction IN ('redeem','expire') THEN l.points ELSE 0 END),0) AS spent,
            MAX(l.created_at) AS last_activity
       FROM loyalty_ledger l JOIN parties p ON p.id = l.party_id
      WHERE l.firm_id = ? GROUP BY p.id, p.name, p.phone`,
    [firmId]
  )).rows.map((r) => ({
    ...r, balance: r2(r.credited - r.spent),
    value: r2((r.credited - r.spent) * sch.pointValue),
  })).sort((a, b) => b.balance - a.balance);
  res.success({
    rows, scheme: sch,
    totals: {
      members: rows.length,
      outstanding: r2(rows.reduce((a, r) => a + r.balance, 0)),
      liability: r2(rows.reduce((a, r) => a + r.value, 0)),
    },
  });
});

/** One customer's balance and the movements behind it. */
/* Every points movement across all members — the third tab.
   Above "/party/:partyId" so "history" is never read as a party id. */
router.get("/history", requirePermission("sales", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const rows = (await query(
    `SELECT l.*, p.name AS party_name, COALESCE(u.full_name, u.username) AS by_user
       FROM loyalty_ledger l
       JOIN parties p ON p.id = l.party_id
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.firm_id = ? ORDER BY l.id DESC LIMIT 200`, [firmId])).rows;

  const s2 = await scheme(firmId);
  const month = new Date().toISOString().slice(0, 7);
  const inMonth = rows.filter((r) => String(r.created_at || "").slice(0, 7) === month);
  res.success({
    rows,
    totals: {
      earnedThisMonth: inMonth.filter((r) => r.direction === "earn").reduce((a, r) => a + (+r.points || 0), 0),
      redeemedThisMonth: inMonth.filter((r) => r.direction === "redeem").reduce((a, r) => a + (+r.points || 0), 0),
      redeemedValue: r2(inMonth.filter((r) => r.direction === "redeem").reduce((a, r) => a + (+r.value || 0), 0)),
      count: rows.length,
    },
    scheme: s2,
  });
});

router.get("/party/:partyId", requirePermission("sales", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [req.params.partyId, firmId])).rows[0];
  if (!party) return res.notFound("Customer not found");
  const s = await scheme(firmId);
  const bal = balanceOf(query, firmId, party.id);
  const history = (await query(
    `SELECT l.*, s.invoice_no FROM loyalty_ledger l
       LEFT JOIN sale_invoices s ON s.id = l.doc_id AND l.doc_table = 'sale_invoices'
      WHERE l.firm_id = ? AND l.party_id = ? ORDER BY l.id DESC LIMIT 100`,
    [firmId, party.id]
  )).rows;
  /* Points already earned that will lapse in the next two months, so a shop
     can nudge the customer before they lose them. */
  const soon = (await query(
    `SELECT COALESCE(SUM(points),0) v FROM loyalty_ledger
      WHERE firm_id = ? AND party_id = ? AND direction = 'earn'
        AND expires_on IS NOT NULL AND expires_on > ? AND expires_on <= date(?, '+2 months')`,
    [firmId, party.id, today(), today()]
  )).rows[0].v;

  res.success({
    party_id: party.id, party_name: party.name, phone: party.phone,
    ...bal, value: r2(bal.balance * s.pointValue),
    redeemable: bal.balance >= s.minRedeem,
    expiring_soon: r2(Math.min(soon, bal.balance)),
    scheme: s, history,
  });
});

/** What a redemption would be worth, before committing to it. */
router.get("/quote/:partyId", requirePermission("sales", "view"), async (req, res) => {
  const firmId = req.user.firm_id;
  const s = await scheme(firmId);
  const bal = balanceOf(query, firmId, req.params.partyId);
  const want = Number(req.query.points) || bal.balance;
  const points = Math.min(want, bal.balance);
  res.success({
    balance: bal.balance, points,
    value: r2(points * s.pointValue),
    allowed: points >= s.minRedeem && points > 0,
    min_redeem: s.minRedeem, point_value: s.pointValue,
  });
});

/**
 * Spend points. Returns the shilling value to put on the bill as a discount —
 * the money side stays in the ordinary invoice, so nothing here touches the
 * ledger of account.
 */
router.post("/redeem", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Client loyalty points" in Settings → Modules first', 400);
  const b = req.body || {};
  const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
  if (!party) return res.fail("Choose a customer", 400);
  const s = await scheme(firmId);
  const pts = Math.floor(Number(b.points) || 0);
  if (!(pts > 0)) return res.fail("How many points are being redeemed?", 400);
  const bal = balanceOf(query, firmId, party.id);
  if (pts > bal.balance) return res.fail(`${party.name} only has ${bal.balance} points`, 400);
  if (pts < s.minRedeem) return res.fail(`At least ${s.minRedeem} points are needed to redeem`, 400);

  const value = r2(pts * s.pointValue);
  await conn.query(
    `INSERT INTO loyalty_ledger (firm_id, party_id, direction, points, value, doc_table, doc_id, note, created_by)
     VALUES (?,?,'redeem',?,?,?,?,?,?)`,
    [firmId, party.id, pts, value, b.doc_table || null, b.doc_id || null,
     b.note || `Redeemed for Sh ${value}`, req.user.id]
  );
  return () => res.success({ points: pts, value, balance: r2(bal.balance - pts) },
    `${pts} points redeemed — take Sh ${value} off the bill`);
}));

/** Manual correction, always with a reason attached. */
router.post("/adjust", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Client loyalty points" in Settings → Modules first', 400);
  const b = req.body || {};
  const party = (await query("SELECT * FROM parties WHERE id = ? AND firm_id = ?", [b.party_id, firmId])).rows[0];
  if (!party) return res.fail("Choose a customer", 400);
  const pts = Math.floor(Number(b.points) || 0);
  if (!pts) return res.fail("How many points?", 400);
  if (!b.note) return res.fail("Give a reason — corrections should always be explainable", 400);
  const bal = balanceOf(query, firmId, party.id);
  if (pts < 0 && Math.abs(pts) > bal.balance) return res.fail(`${party.name} only has ${bal.balance} points`, 400);

  await conn.query(
    `INSERT INTO loyalty_ledger (firm_id, party_id, direction, points, earned_on, note, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [firmId, party.id, pts > 0 ? "adjust" : "expire", Math.abs(pts), today(), b.note, req.user.id]
  );
  return () => res.success({ balance: r2(bal.balance + pts) },
    `${pts > 0 ? "Added" : "Removed"} ${Math.abs(pts)} points for ${party.name}`);
}));

/**
 * Lapse points past their expiry date.
 *
 * Older points are treated as spent first, so a customer who keeps earning and
 * redeeming never loses points they have effectively already used. Only the
 * genuinely stale remainder lapses.
 */
/* One sweep, one transaction. Lapsing half the shop's customers and losing the
   other half to a power cut would leave balances nobody could reconstruct. */
router.post("/expire", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Client loyalty points" in Settings → Modules first', 400);
  const s = await scheme(firmId);
  if (!s.expiryMonths) return res.success({ expired: 0, parties: 0 }, "Points are set never to expire");
  const cutoff = req.body?.on || today();

  const parties = (await query(
    "SELECT DISTINCT party_id FROM loyalty_ledger WHERE firm_id = ? AND direction = 'earn' AND expires_on IS NOT NULL AND expires_on <= ?",
    [firmId, cutoff]
  )).rows;

  let total = 0, touched = 0;
  for (const { party_id } of parties) {
    const bal = balanceOf(query, firmId, party_id);
    if (bal.balance <= 0) continue;
    const stale = (await query(
      "SELECT COALESCE(SUM(points),0) v FROM loyalty_ledger WHERE firm_id=? AND party_id=? AND direction='earn' AND expires_on IS NOT NULL AND expires_on <= ?",
      [firmId, party_id, cutoff]
    )).rows[0].v;
    /* Spending is applied to the oldest points first, so only what is left of
       the stale batch after everything already redeemed can lapse. */
    const lapse = Math.max(0, Math.min(bal.balance, r2(stale - bal.spent)));
    if (lapse <= 0) continue;
    await conn.query(
      `INSERT INTO loyalty_ledger (firm_id, party_id, direction, points, earned_on, note, created_by)
       VALUES (?,?,'expire',?,?,?,?)`,
      [firmId, party_id, lapse, cutoff, `Expired — earned over ${s.expiryMonths} months ago`, req.user.id]
    );
    total = r2(total + lapse); touched++;
  }
  return () => res.success({ expired: total, parties: touched },
    touched ? `${total} points lapsed across ${touched} customer${touched === 1 ? "" : "s"}` : "Nothing to expire");
}));

module.exports = router;
module.exports.awardForSale = awardForSale;
module.exports.balanceOf = balanceOf;
