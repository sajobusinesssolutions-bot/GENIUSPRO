/**
 * periodlock.js — nothing may be posted into a month that has been filed.
 *
 * The books had no closing date at all. Posting a sale, a bill or a journal
 * dated into a period already declared to URA was not merely allowed, it was
 * invisible: the document appeared, the ledger moved, the return that had
 * already been submitted no longer matched the books behind it, and the first
 * anybody heard of it was an assessment.
 *
 * "Books closed up to" (Settings → Transactions) is a date. On or before it,
 * nothing new may be dated. After it, everything works as before.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It does not stop a document already in a closed period being VOIDED. A void
 * is dated today and posts a reversal today — the closed period keeps every
 * figure it was filed with, and the correction lands in the open one, which is
 * exactly how a correction to a filed period is supposed to be made. Blocking
 * the void as well would leave a shop with a known-wrong document and no legal
 * way to correct it.
 *
 * Off by default and empty on every existing database, because a lock that
 * switched itself on during an upgrade would refuse the first sale of the
 * morning.
 */
const { getSetting } = require("../modules/settings/settings.service");

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The closing date for this firm, or null when there is no lock. */
async function lockedUpto(firmId) {
  const v = String(await getSetting(firmId, "books_locked_upto", "") || "").trim();
  return ISO.test(v) ? v : null;
}

/**
 * The refusal for a document dated into a closed period, or null when it is
 * fine. Returns a sentence rather than a boolean because a bare "not allowed"
 * leaves the operator with no idea what to change.
 */
async function refuseIfClosed(firmId, date, what = "document") {
  const upto = await lockedUpto(firmId);
  if (!upto) return null;
  const d = String(date || "").slice(0, 10);
  if (!ISO.test(d)) return null;                  /* no date given: today's, which is never closed */
  if (d > upto) return null;
  return `The books are closed up to ${upto}, so this ${what} cannot be dated ${d}. Date it after ${upto}, or move the closing date in Settings → Transactions.`;
}

/** Express-friendly: returns true when it has already answered the request. */
async function blockClosed(req, res, date, what) {
  const msg = await refuseIfClosed(req.user.firm_id, date, what);
  if (!msg) return false;
  res.fail(msg, 409);
  return true;
}

module.exports = { lockedUpto, refuseIfClosed, blockClosed };
