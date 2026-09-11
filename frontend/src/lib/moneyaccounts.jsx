import React from "react";

/* moneyaccounts.jsx — which account the money lands in, remembered.
 *
 * Every screen that takes money has to say where it went: the till, the
 * invoice's payment step, the payment record form, a refund, an expense. Each
 * of them used to default to whichever cash/bank account sorted first by code,
 * which is "Cash in Hand" in every shop that has ever run this app. A shop
 * banking its takings through MTN MoMo therefore had every payment default to
 * the drawer, and one forgotten dropdown is a reconciliation somebody unpicks
 * by hand at the end of the month — the drawer short by the exact amount the
 * MoMo float is over.
 *
 * So the last account used on this machine is remembered and offered back.
 * Per machine, not per user, deliberately: it is a property of the counter the
 * terminal sits on ("this till banks to MoMo"), and a relief cashier signing
 * in for an afternoon should inherit it rather than start from the drawer.
 *
 * It is only a *default*. Nothing here decides anything; the operator can see
 * the account named on the screen before they save, and change it.
 */

const KEY = "vy_last_money_account";

export function lastAccount() {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}

export function rememberAccount(code) {
  if (!code) return;
  try { localStorage.setItem(KEY, String(code)); } catch { /* private mode — a default is not worth an error */ }
}

/* Pick the account a screen should open on: the one it was told to use, else
   the last one used here, else the shop's first money account. Returns "" when
   the shop has none, which the callers draw as "Cash in Hand" — the account
   the server falls back to. */
export function defaultAccount(accounts, preferred) {
  const has = (c) => !!c && accounts.some((a) => a.code === c);
  if (has(preferred)) return preferred;
  const last = lastAccount();
  if (has(last)) return last;
  return accounts[0] ? accounts[0].code : "";
}

/* The word for what an account is, for a picker that groups them.
   Only the *stored* kind is trusted for "mobile". Guessing it from the name
   would move every account called "MTN float" out of the group it has been in
   since the shop opened the book, and a grouping that changes on upgrade is
   how somebody comes to believe an account has gone missing. The cash-vs-bank
   fallback below is the same rule the server has always used, kept identical
   so the picker and the Cash & bank tiles never disagree. */
const CASHY = /\b(cash|till|drawer|petty|float|safe)\b/i;
export function accountKind(a) {
  if (a && (a.kind === "cash" || a.kind === "bank" || a.kind === "mobile")) return a.kind;
  const n = String((a && a.name) || "");
  if ((a && a.code === "1001") || CASHY.test(n)) return "cash";
  return "bank";
}

export const KIND_LABEL = { cash: "Cash", bank: "Bank", mobile: "Mobile money" };

/* The picker itself. One component, so the till, the invoice, the payment
   form, the refund and the expense cannot drift into five slightly different
   dropdowns — which is exactly how the till ended up with no picker at all
   while four other screens had one.

   Grouped by kind, because a shop with six MoMo lines and two banks needs to
   find one of them quickly, and because "Cash" versus "Mobile money" is the
   distinction that matters when reconciling: MTN and Airtel float are real
   balances somebody counts. */
export function AccountSelect({ accounts, value, onChange, id, ariaLabel, className }) {
  const groups = ["cash", "mobile", "bank"]
    .map((k) => [k, accounts.filter((a) => accountKind(a) === k)])
    .filter(([, list]) => list.length > 0);
  return (
    <select id={id} className={className} aria-label={ariaLabel} value={value || ""} onChange={(e) => onChange(e.target.value)}>
      {accounts.length === 0 && <option value="">Cash in Hand</option>}
      {groups.length === 1
        ? groups[0][1].map((a) => <option key={a.code} value={a.code}>{a.name}</option>)
        : groups.map(([k, list]) => (
            <optgroup key={k} label={KIND_LABEL[k]}>
              {list.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </optgroup>
          ))}
    </select>
  );
}
