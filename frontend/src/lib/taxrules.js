import { useEffect, useState } from "react";
import api from "./api.js";

/**
 * taxrules.js — the one place that decides which tax rules a document gets.
 *
 * Three separate faults lived here, all invisible until you compared the till
 * display against the saved invoice:
 *
 *  1. GET /settings/tax-rules returns EVERY rule, including ones switched off.
 *     Six screens fed that straight into the tax engine, so deactivating a rule
 *     in Settings changed nothing anywhere. The server filters is_active on
 *     save, so the screen quoted the customer one total and the books recorded
 *     another.
 *  2. Credit notes, estimates and purchases never checked taxes_enabled at all,
 *     so turning taxes off globally still showed tax on those screens.
 *  3. The per-sale-type settings (POS / cash / credit) were only honoured on
 *     the POS screen.
 *
 * The gating below mirrors the server exactly — taxes_enabled governs every
 * document; the POS/cash/credit switches govern sales only, because that is
 * what the server applies in sales.routes.js. If you change one, change both.
 */

/** Rules the shop hasn't switched off. Older rows have no flag; treat as on. */
export const activeOnly = (rules) =>
  (rules || []).filter((r) => r.is_active == null || Number(r.is_active) === 1);

/**
 * @param {object[]} rules        every rule from the API
 * @param {object}   settings     the /settings values map
 * @param {string}   doc          pos | sale | credit_note | estimate | purchase
 * @param {string}   paymentType  cash | credit — sales documents only
 * @returns {object[]} the rules that actually apply, [] when tax is off
 */
export function effectiveRules({ rules, settings, doc = "sale", paymentType = "cash" }) {
  const s = (k) => String((settings || {})[k] ?? "1");
  if (s("taxes_enabled") === "0") return [];
  if (doc === "pos" || doc === "sale") {
    if (doc === "pos" && s("tax_on_pos") === "0") return [];
    if (paymentType === "credit" ? s("tax_on_credit") === "0" : s("tax_on_cash") === "0") return [];
  }
  return activeOnly(rules);
}

/**
 * Should tax be SHOWN on this document at all?
 *
 * The display counterpart of effectiveRules(), and deliberately a test of the
 * setting rather than of the amount. Screens had been asking
 * `calc.tax_total !== 0`, which is nearly the same answer for the wrong
 * reason: a chain whose deduct and add rules happen to cancel, or a rule that
 * rounds to nothing on a small sale, would hide a tax breakdown that really
 * applies. And it left the reverse hole — the till's own totals rail asked
 * nothing at all, so a shop with tax switched off read `Tax 0` on every
 * single bill.
 */
export function taxOn({ rules, settings, doc = "sale", paymentType = "cash" }) {
  return effectiveRules({ rules, settings, doc, paymentType }).length > 0;
}

/**
 * Loads the rules and the settings together and hands back only what applies.
 * Screens that used to call the endpoint directly should use this instead —
 * it's one line and there's nothing left to forget.
 */
export function useTaxRules(doc = "sale", paymentType = "cash") {
  const [rules, setRules] = useState([]);
  const [settings, setSettings] = useState({});
  useEffect(() => {
    api.get("/settings/tax-rules").then(setRules).catch(() => setRules([]));
    api.get("/settings").then((d) => setSettings(d.values || {})).catch(() => setSettings({}));
  }, []);
  const applies = effectiveRules({ rules, settings, doc, paymentType });
  return { rules: applies, settings, allRules: rules, taxActive: applies.length > 0 };
}
