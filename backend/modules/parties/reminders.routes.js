/**
 * reminders.routes.js — chasing what the shop is owed.
 *
 * ── what this does and, more importantly, what it will not do ──────────────
 *
 * It works out who owes money, how overdue they are, and writes the message.
 * It does not send anything. The link it hands back opens WhatsApp or the
 * phone's messaging app with the text already in it, and a person presses
 * send.
 *
 * That is a deliberate limit, not a missing feature:
 *
 *   · The message arrives from the shopkeeper's own number, which is the
 *     number the customer already answers. A gateway's shortcode is a number
 *     they have been trained by every other business to ignore.
 *   · A debt chased automatically is a customer lost. The one decision that
 *     must stay with a person is whether *this* customer, who bought on
 *     credit last Tuesday and is two days late, should be messaged at all.
 *   · Nothing here can send in the night, in a loop, or to a list somebody
 *     did not read first. There is no route that could.
 *
 * Every reminder that goes out is recorded, which is what makes the cooldown
 * real: a shopkeeper working down the list on Tuesday does not send the same
 * person the same message they sent on Monday.
 *
 * Mounted at /api/reminders.
 */
const express = require("express");
const router = express.Router();
const { query } = require("../../database/db");
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { durable } = require("../../shared/durable");
const { getAllSettings } = require("../settings/settings.service");

router.use(verifyToken);

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The settings this feature reads, with the catalogue's defaults applied. */
async function config(firmId) {
  const st = await getAllSettings(firmId) || {};
  const v = st.values || st;
  return {
    channel: v.remind_channel || "whatsapp",
    grace: num(v.remind_grace_days, 0),
    minBalance: num(v.remind_min_balance, 0),
    cooldown: num(v.remind_cooldown_days, 7),
    signature: v.remind_signature || "",
    countryCode: String(v.remind_country_code || "256").replace(/\D/g, "") || "256",
    templates: {
      gentle: v.remind_tpl_gentle || "",
      due: v.remind_tpl_due || "",
      late: v.remind_tpl_late || "",
    },
  };
}

/**
 * A phone number in the form a messaging link needs.
 *
 * Local numbers are written 07xx here and a `wa.me` link needs the country
 * code, so a leading zero is replaced rather than dropped — dropping it turns
 * 0701… into 701…, which is a different number in some countries and no
 * number at all in others. The code is a setting, because this app is not only
 * used in one country.
 */
function digits(phone, countryCode) {
  const raw = String(phone || "").replace(/[^0-9+]/g, "");
  if (!raw) return "";
  if (raw[0] === "+") return raw.slice(1);
  if (raw[0] === "0") return countryCode + raw.slice(1);
  return raw;
}

function fill(tpl, { party, firm, d, signature }) {
  const first = String(party.name || "").trim().split(/\s+/)[0] || party.name || "there";
  const out = String(tpl || "")
    .replace(/\{name\}/g, first)
    .replace(/\{balance\}/g, String(d.balance_text))
    .replace(/\{business\}/g, firm.name || "")
    .replace(/\{days\}/g, String(d.days))
    .replace(/\{bills\}/g, `${d.bills} bill${d.bills === 1 ? "" : "s"}`)
    .replace(/\{phone\}/g, firm.phone || "");
  return signature ? `${out}\n${signature}` : out;
}

/**
 * Who owes what, and for how long.
 *
 * The balance comes from the open invoices rather than from `parties.balance`,
 * for one reason: the message names a figure the customer is going to check
 * against their own bills. A running balance that has drifted by a rounding
 * error is a figure that starts an argument, and the sum of what is actually
 * outstanding cannot drift from itself.
 */
router.get("/", requirePermission("parties", "view"), async (req, res) => {
  const firm = req.user.firm_id;
  const cfg = await config(firm);
  const firmRow = (await query("SELECT name, phone FROM firms WHERE id = ?", [firm])).rows[0] || {};
  const settingsPhone = (await query(
    "SELECT svalue FROM firm_settings WHERE firm_id = ? AND skey = 'firm_phone'", [firm])).rows[0];
  const business = { name: firmRow.name, phone: firmRow.phone || (settingsPhone && settingsPhone.svalue) || "" };

  const rows = (await query(
    `SELECT p.id, p.name, p.phone, p.party_no,
            COALESCE(SUM(i.balance_due), 0) AS balance,
            COUNT(i.id) AS bills,
            MIN(COALESCE(i.due_date, i.invoice_date)) AS oldest
       FROM parties p
       JOIN sale_invoices i ON i.party_id = p.id AND i.firm_id = p.firm_id
      WHERE p.firm_id = ? AND COALESCE(p.status,'active') = 'active'
        AND p.party_type <> 'supplier'
        AND i.balance_due > 0.005 AND COALESCE(i.status,'') <> 'void'
      GROUP BY p.id ORDER BY balance DESC`, [firm])).rows;

  const today = new Date();
  const lastByParty = new Map();
  for (const r of (await query(
    `SELECT party_id, MAX(created_at) AS last_at, COUNT(*) AS times
       FROM payment_reminders WHERE firm_id = ? GROUP BY party_id`, [firm])).rows) {
    lastByParty.set(r.party_id, r);
  }

  const out = [];
  for (const r of rows) {
    const balance = Math.round(Number(r.balance) * 100) / 100;
    const days = r.oldest
      ? Math.max(0, Math.floor((today - new Date(`${r.oldest}T00:00:00`)) / 86400000))
      : 0;
    if (balance < cfg.minBalance) continue;
    if (days < cfg.grace) continue;

    const last = lastByParty.get(r.id) || null;
    const sinceLast = last && last.last_at
      ? (today - new Date(String(last.last_at).replace(" ", "T"))) / 86400000
      : null;
    const cooling = cfg.cooldown > 0 && sinceLast !== null && sinceLast < cfg.cooldown;

    const tpl = days >= 30 ? cfg.templates.late : days > 0 ? cfg.templates.due : cfg.templates.gentle;
    const d = { balance, bills: r.bills, days, balance_text: balance.toLocaleString() };
    const message = fill(tpl, { party: r, firm: business, d, signature: cfg.signature });
    const to = digits(r.phone, cfg.countryCode);

    out.push({
      party_id: r.id, name: r.name, party_no: r.party_no, phone: r.phone || "",
      balance, bills: r.bills, oldest: r.oldest, days,
      reachable: !!to,
      /* The app builds the link; the phone opens it; a person presses send. */
      link: !to ? null
        : cfg.channel === "sms"
          ? `sms:${r.phone}?body=${encodeURIComponent(message)}`
          : `https://wa.me/${to}?text=${encodeURIComponent(message)}`,
      message,
      last_sent: last ? last.last_at : null,
      times_sent: last ? last.times : 0,
      in_cooldown: cooling,
    });
  }

  const owed = out.reduce((a, x) => a + x.balance, 0);
  res.success({
    rows: out,
    channel: cfg.channel,
    cooldown_days: cfg.cooldown,
    totals: {
      owed: Math.round(owed * 100) / 100,
      customers: out.length,
      overdue: out.filter((x) => x.days > 0).length,
      ready: out.filter((x) => x.reachable && !x.in_cooldown).length,
      unreachable: out.filter((x) => !x.reachable).length,
    },
  });
});

/** What has already been sent, newest first. */
router.get("/log", requirePermission("parties", "view"), async (req, res) => {
  const rows = (await query(
    `SELECT r.id, r.party_id, r.channel, r.balance, r.days, r.message, r.created_at,
            p.name AS party_name, COALESCE(u.full_name, u.username) AS who
       FROM payment_reminders r
       LEFT JOIN parties p ON p.id = r.party_id AND p.firm_id = r.firm_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.firm_id = ? ORDER BY r.id DESC LIMIT 200`, [req.user.firm_id])).rows;
  res.success(rows);
});

/**
 * Record that a reminder went out.
 *
 * Called by the screen after it has opened the message, not before — because
 * what is being recorded is that somebody was asked, and the app cannot know
 * that until the person has been handed the message to send. It will
 * occasionally record one that was opened and then abandoned. That is the
 * right way round: a cooldown that is one message too cautious costs nothing,
 * and one that is a message short sends a customer the same text twice.
 */
router.post("/:partyId/sent", requirePermission("parties", "view"), async (req, res, next) =>
  await durable(next, async (conn) => {
    const firm = req.user.firm_id;
    const party = (await query("SELECT id FROM parties WHERE id = ? AND firm_id = ?",
      [req.params.partyId, firm])).rows[0];
    if (!party) return res.fail("No such customer", 404);
    const b = req.body || {};
    await conn.query(
      `INSERT INTO payment_reminders (firm_id, party_id, user_id, channel, balance, days, message)
       VALUES (?,?,?,?,?,?,?)`,
      [firm, party.id, req.user.id || null, String(b.channel || "whatsapp").slice(0, 20),
       num(b.balance, 0), num(b.days, 0), String(b.message || "").slice(0, 2000)]);
    return () => res.success({ ok: true }, "Reminder recorded");
  }));

module.exports = router;
