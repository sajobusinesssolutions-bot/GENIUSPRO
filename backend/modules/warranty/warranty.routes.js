/**
 * warranty.routes.js — warranty cover and claims.
 *
 * Cover is created automatically when something with a warranty period is
 * sold, inside the sale's own transaction, so a refused invoice never leaves
 * cover behind. Where an item is serialised, each unit gets its own record and
 * can be looked up by serial at the counter — which is what actually happens
 * when a customer walks in holding the thing.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { durable } = require("../../shared/durable");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { getSetting } = require("../settings/settings.service");

router.use(verifyToken);

const today = () => new Date().toISOString().slice(0, 10);
const moduleOn = async (firmId) => await getSetting(firmId, "mod_insurance", "0") === "1";

/** Add whole months, clamping into short months (31 Jan + 1 = 28 Feb). */
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDate();
  const m = d.getUTCMonth() + Number(months || 0);
  d.setUTCFullYear(d.getUTCFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12, 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

const withState = (w) => {
  const t = today();
  const expired = w.expires_on < t;
  const daysLeft = Math.ceil((Date.parse(w.expires_on) - Date.parse(t)) / 86400000);
  return {
    ...w,
    expired, days_left: expired ? 0 : daysLeft,
    state: w.status === "void" ? "void" : expired ? "expired" : daysLeft <= 30 ? "ending soon" : "in cover",
  };
};

/**
 * Create cover for a sale. Called from the sale handler inside its transaction.
 * Serialised items get one record per serial so each unit can be traced;
 * everything else gets one record covering the line.
 */
async function coverForSale(conn, { firmId, partyId, invoiceId, lines, userId }) {
  if (!await moduleOn(firmId)) return 0;
  let made = 0;
  const start = today();
  for (const ln of lines || []) {
    if (!ln.item_id) continue;
    const it = (await conn.query("SELECT id, warranty_months, track_serials FROM items WHERE id = ? AND firm_id = ?",
      [ln.item_id, firmId])).rows[0];
    const months = Number(it?.warranty_months) || 0;
    if (!it || months <= 0) continue;
    const expires = addMonths(start, months);

    /* Serials issued against this invoice each get their own cover. */
    const serials = it.track_serials
      ? (await conn.query("SELECT serial FROM item_serials WHERE firm_id=? AND item_id=? AND sale_id=?",
          [firmId, it.id, invoiceId])).rows
      : [];

    if (serials.length) {
      for (const s of serials) {
        await conn.query(
          `INSERT INTO warranties (firm_id, item_id, serial, quantity, party_id, invoice_id, starts_on, months, expires_on, created_by)
           VALUES (?,?,?,1,?,?,?,?,?,?)`,
          [firmId, it.id, s.serial, partyId || null, invoiceId, start, months, expires, userId || null]);
        made++;
      }
    } else {
      await conn.query(
        `INSERT INTO warranties (firm_id, item_id, serial, quantity, party_id, invoice_id, starts_on, months, expires_on, created_by)
         VALUES (?,?,NULL,?,?,?,?,?,?,?)`,
        [firmId, it.id, Number(ln.quantity) || 1, partyId || null, invoiceId, start, months, expires, userId || null]);
      made++;
    }
  }
  return made;
}

/* ── Routes ───────────────────────────────────────────────────────────── */

const BASE = `SELECT w.*, i.name AS item_name, i.unit AS item_unit, p.name AS party_name, p.phone,
                     s.invoice_no,
                     (SELECT COUNT(*) FROM warranty_claims c WHERE c.warranty_id = w.id) AS claim_count,
                     (SELECT COUNT(*) FROM warranty_claims c WHERE c.warranty_id = w.id AND c.status = 'open') AS open_claims
                FROM warranties w
                JOIN items i ON i.id = w.item_id
                LEFT JOIN parties p ON p.id = w.party_id
                LEFT JOIN sale_invoices s ON s.id = w.invoice_id`;

router.get("/", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(`${BASE} WHERE w.firm_id = ? ORDER BY w.id DESC LIMIT 500`, [req.user.firm_id]))
    .rows.map(withState);
  const live = rows.filter((r) => r.state === "in cover" || r.state === "ending soon");
  res.success({
    rows,
    totals: {
      in_cover: live.length,
      ending_soon: rows.filter((r) => r.state === "ending soon").length,
      open_claims: rows.reduce((a, r) => a + (r.open_claims || 0), 0),
    },
  });
});

/** Counter lookup: a customer arrives holding a serial number. */
router.get("/lookup", requirePermission("sales", "view"), async (req, res) => {
  const serial = (req.query.serial || "").trim();
  if (!serial) return res.fail("Enter a serial number", 400);
  const rows = (await query(`${BASE} WHERE w.firm_id = ? AND lower(w.serial) = lower(?) ORDER BY w.id DESC`,
    [req.user.firm_id, serial])).rows.map(withState);
  if (!rows.length) return res.success({ found: false, serial }, `No cover on file for "${serial}"`);
  const w = rows[0];
  const claims = (await query("SELECT * FROM warranty_claims WHERE warranty_id = ? ORDER BY id DESC", [w.id])).rows;
  res.success({ found: true, serial, warranty: w, claims });
});

router.get("/:id", requirePermission("sales", "view"), async (req, res) => {
  const w = (await query(`${BASE} WHERE w.id = ? AND w.firm_id = ?`, [req.params.id, req.user.firm_id])).rows[0];
  if (!w) return res.notFound("Warranty not found");
  const claims = (await query("SELECT * FROM warranty_claims WHERE warranty_id = ? ORDER BY id DESC", [w.id])).rows;
  res.success({ ...withState(w), claims });
});

/** Register cover by hand — for goods sold before the module was switched on. */
router.post("/", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  if (!await moduleOn(firmId)) return res.fail('Switch on "Warranty cover & claims" in Settings → Modules first', 400);
  const b = req.body || {};
  const it = (await query("SELECT * FROM items WHERE id = ? AND firm_id = ?", [b.item_id, firmId])).rows[0];
  if (!it) return res.fail("Choose the item", 400);
  const months = Number(b.months) || Number(it.warranty_months) || 0;
  if (!(months > 0)) return res.fail("How many months of cover?", 400);
  const start = b.starts_on || today();
  const r = await conn.query(
    `INSERT INTO warranties (firm_id, item_id, serial, quantity, party_id, invoice_id, starts_on, months, expires_on, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [firmId, it.id, b.serial || null, Number(b.quantity) || 1, b.party_id || null, b.invoice_id || null,
     start, months, addMonths(start, months), b.notes || null, req.user.id]
  );
  return () => res.success({ id: r.insertId }, `Cover registered to ${addMonths(start, months)}`);
}));

/** Void cover — the record stays so the history is still explainable. */
router.post("/:id/void", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const w = (await conn.query("SELECT * FROM warranties WHERE id = ? AND firm_id = ?", [req.params.id, req.user.firm_id])).rows[0];
  if (!w) return res.notFound("Warranty not found");
  if (!req.body?.note) return res.fail("Give a reason for voiding the cover", 400);
  await conn.query("UPDATE warranties SET status = 'void', notes = ? WHERE id = ?",
    [`${w.notes ? w.notes + " · " : ""}Voided: ${req.body.note}`, w.id]);
  return () => res.success({ id: w.id }, "Cover voided");
}));

/* ── Claims ───────────────────────────────────────────────────────────── */

router.get("/claims/all", requirePermission("sales", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT c.*, w.serial, w.expires_on, i.name AS item_name, p.name AS party_name, p.phone
       FROM warranty_claims c
       JOIN warranties w ON w.id = c.warranty_id
       JOIN items i ON i.id = w.item_id
       LEFT JOIN parties p ON p.id = w.party_id
      WHERE c.firm_id = ? ORDER BY c.status, c.id DESC LIMIT 300`,
    [req.user.firm_id]
  )).rows;
  res.success({
    rows,
    totals: { open: rows.filter((r) => r.status === "open").length,
              cost: +rows.reduce((a, r) => a + (r.cost || 0), 0).toFixed(2) },
  });
});

router.post("/:id/claims", requirePermission("sales", "create"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const w = (await query("SELECT * FROM warranties WHERE id = ? AND firm_id = ?", [req.params.id, firmId])).rows[0];
  if (!w) return res.notFound("Warranty not found");
  const b = req.body || {};
  const when = b.claim_date || today();
  /* A claim outside the cover period is refused rather than quietly accepted —
     the shop needs to see that before promising a repair. */
  if (w.status === "void") return res.fail("This cover was voided", 400);
  if (when > w.expires_on) return res.fail(`Cover ran out on ${w.expires_on}`, 400);
  if (when < w.starts_on) return res.fail(`Cover only started on ${w.starts_on}`, 400);
  if (!b.fault) return res.fail("Describe the fault", 400);

  const r = await conn.query(
    `INSERT INTO warranty_claims (firm_id, warranty_id, claim_date, fault, status, notes, created_by)
     VALUES (?,?,?,?,'open',?,?)`,
    [firmId, w.id, when, b.fault, b.notes || null, req.user.id]
  );
  return () => res.success({ id: r.insertId }, "Claim logged");
}));

router.post("/claims/:claimId/close", requirePermission("sales", "edit"), async (req, res, next) => await durable(next, async (conn) => {
  const firmId = req.user.firm_id;
  const c = (await query("SELECT * FROM warranty_claims WHERE id = ? AND firm_id = ?", [req.params.claimId, firmId])).rows[0];
  if (!c) return res.notFound("Claim not found");
  if (c.status === "closed") return res.fail("That claim is already closed", 400);
  const b = req.body || {};
  const outcome = ["repaired", "replaced", "refunded", "rejected"].includes(b.outcome) ? b.outcome : null;
  if (!outcome) return res.fail("How was it settled — repaired, replaced, refunded or rejected?", 400);
  await conn.query(
    "UPDATE warranty_claims SET status='closed', outcome=?, cost=?, closed_on=?, notes=? WHERE id=?",
    [outcome, Number(b.cost) || 0, today(), b.notes ?? c.notes, c.id]
  );
  return () => res.success({ id: c.id, outcome }, `Claim closed — ${outcome}`);
}));

module.exports = router;
module.exports.coverForSale = coverForSale;
module.exports.addMonths = addMonths;
