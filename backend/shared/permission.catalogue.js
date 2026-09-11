/* Permission catalogue — the plain-English list behind the roles screen.
 *
 * The server enforces permissions as module × action pairs: sales.create,
 * items.delete and so on. Those are precise but nobody setting up a shop
 * thinks in them, so the roles screen asks questions instead — "can they give
 * a discount?" — and each question maps to the pairs that actually gate it.
 *
 * The mapping lives here, on the server, for one reason: if the screen kept
 * its own list, a permission could be shown as blocked while the endpoint it
 * guards happily let the request through. Both sides read this file.
 *
 * A note on the third state. The design offers "allowed / needs a nod /
 * blocked", where "needs a nod" means a manager approves at the moment it
 * happens. Nothing in this app can ask for that approval — it would need a
 * prompt at every call site and a record of who approved what. So the
 * catalogue is two-state, and `askable` marks the entries where a future
 * approval step would make sense.
 */

const MODULES = ["parties", "items", "sales", "payments", "purchases", "expenses", "accounting", "reports", "settings", "users", "companies"];
const ACTIONS = ["view", "create", "edit", "delete"];

/* id, label, note, [module.action pairs it grants], askable */
const CATALOGUE = [
  ["Sales & till", [
    ["till_sell",      "Open the till and bill",        "Ring up a sale and take payment", ["sales.view", "sales.create", "items.view", "parties.view"]],
    ["till_discount",  "Give a discount",               "Take money off a line or a whole bill", ["sales.create"], true],
    ["till_price",     "Change a price on the line",    "Override the price an item is sold at", ["sales.create", "items.view"], true],
    ["till_void_line", "Void a line before payment",    "Remove an item from a bill not yet paid", ["sales.create"]],
    ["till_refund",    "Refund or return a sale",       "Reverse a sale after it was paid", ["sales.delete", "sales.edit"], true],
    ["till_reprint",   "Reprint a receipt",             "Print a slip again for a past sale", ["sales.view"]],
    ["till_credit",    "Sell on credit",                "Put a sale on a customer's account", ["sales.create", "parties.view"], true],
    ["till_drawer",    "Open the cash drawer by hand",  "Cash in and out without a sale", ["sales.create"], true],
  ]],
  ["Items & stock", [
    ["item_view",   "See the item list",        "Names, prices and what is in stock", ["items.view"]],
    ["item_edit",   "Add or edit an item",      "Create items and change their details", ["items.create", "items.edit"]],
    ["item_cost",   "See cost price and margin", "What you paid, and what you make", ["items.view"], true],
    ["item_adjust", "Adjust stock by hand",     "Write stock up or down outside a sale", ["items.edit"], true],
    ["item_count",  "Run a stock take",         "Count the shelf and post the difference", ["items.edit"]],
    ["item_delete", "Delete an item",           "Remove an item from the catalogue", ["items.delete"], true],
  ]],
  ["Parties", [
    ["party_view",   "See customers and suppliers", "The list and what each one owes", ["parties.view"]],
    ["party_edit",   "Add or edit a party",         "Create and change customer records", ["parties.create", "parties.edit"]],
    ["party_credit", "Change a credit limit",       "Raise or lower how much they may owe", ["parties.edit"], true],
    ["party_writeoff", "Write off a debt",          "Give up on money owed", ["parties.edit", "accounting.create"], true],
  ]],
  ["Purchases", [
    ["purch_bill",    "Record a supplier bill", "Enter what a supplier delivered", ["purchases.view", "purchases.create"]],
    ["purch_approve", "Approve a bill for payment", "Mark a bill as cleared to pay", ["purchases.edit"], true],
    ["purch_expense", "Record an expense",      "Rent, fuel, airtime and the like", ["expenses.view", "expenses.create"]],
    ["purch_pay",     "Pay a supplier",         "Send money against a bill", ["payments.create"], true],
    ["purch_delete",  "Void a bill",            "Cancel a supplier bill — goods off the shelf, supplier no longer owed", ["purchases.view", "purchases.delete"], true],
    ["purch_expense_fix", "Correct or void an expense", "Fix an expense that was entered wrongly", ["expenses.view", "expenses.edit", "expenses.delete"], true],
  ]],
  ["Cash & bank", [
    ["cash_balances", "See account balances",         "What is in the drawer and the bank", ["accounting.view"], true],
    ["cash_receipt",  "Record a receipt or payment",  "Money in and money out", ["payments.view", "payments.create"]],
    ["cash_transfer", "Transfer between accounts",    "Move money from one account to another", ["accounting.create"], true],
    ["cash_shift",    "Close the shift and count",    "Count the drawer and close the day", ["sales.view", "payments.view"]],
    ["cash_reconcile", "Reconcile a bank statement",  "Tick off what the bank actually shows", ["accounting.edit"], true],
    ["cash_fix",      "Correct or void a payment",    "Fix a receipt after it was taken — the invoices it settled are put back", ["payments.view", "payments.edit", "payments.delete"], true],
    ["cash_journal",  "Post and correct journals",    "Entries made by hand, and fixing one that was wrong", ["accounting.view", "accounting.create", "accounting.edit", "accounting.delete"], true],
  ]],
  ["Reports", [
    ["rep_dayclose", "Day close summary", "What was taken today, by tender", ["reports.view"]],
    ["rep_pl",       "Profit and loss",   "Income against expenses", ["reports.view", "accounting.view"], true],
    ["rep_itemprofit", "Item-wise profit", "What each item actually makes", ["reports.view", "items.view"], true],
    ["rep_export",   "Export to Excel",   "Take the figures out of the app", ["reports.view"], true],
  ]],
  ["Settings", [
    ["set_shop",   "Change shop settings",  "Name, taxes, numbering and the rest", ["settings.view", "settings.edit"]],
    ["set_users",  "Manage users and roles", "Add staff and decide what they may do", ["users.view", "users.create", "users.edit"]],
    ["set_users_remove", "Remove a staff account", "Take somebody off this business entirely", ["users.view", "users.edit", "users.delete"], true],
    ["set_backup", "Back up and restore",   "Take a copy, or put one back", ["settings.edit"]],
    ["set_wipe",   "Delete all data",       "Empty the shop and start again", ["settings.edit", "accounting.delete"], true],
  ]],
  ["Companies", [
    ["co_view",    "See the list of businesses",   "Which businesses this account may open, and switch between them", ["companies.view"]],
    ["co_create",  "Create a business",            "Start another business with its own stock, books and reports", ["companies.create", "companies.view"]],
    ["co_edit",    "Edit a business",              "Its name, tax number, address and invoice prefix", ["companies.edit", "companies.view"]],
    ["co_grant",   "Give somebody access",         "Decide who may open which business", ["companies.grant", "companies.view"], true],
    ["co_suspend", "Suspend a business",           "Lock everyone out of it without deleting anything", ["companies.edit", "companies.view"], true],
    ["co_delete",  "Delete a business",            "Destroy a business and everything in it", ["companies.delete"], true],
    ["co_panel",   "See the all-businesses panel", "Revenue, profit and stock across every business at once", ["companies.panel", "companies.view"], true],
  ]],
];

/* Flatten for lookups. */
const BY_ID = {};
for (const [group, rows] of CATALOGUE) {
  for (const [id, label, note, grants, askable] of rows) {
    BY_ID[id] = { id, group, label, note, grants, askable: !!askable };
  }
}

/* Which readable permissions a role has: one is "on" only when the role holds
   every pair it grants. A half-granted permission is not a permission — it
   would show as allowed and then fail at the point of use. */
function readableFor(pairs) {
  const held = new Set(pairs.map((p) => `${p.module}.${p.action}`));
  const on = [];
  for (const id of Object.keys(BY_ID)) {
    if (BY_ID[id].grants.every((g) => held.has(g))) on.push(id);
  }
  return on;
}

/* And back: the module.action set implied by a list of readable permissions. */
function pairsFor(ids) {
  const out = new Set();
  for (const id of ids) {
    const p = BY_ID[id];
    if (!p) continue;
    for (const g of p.grants) out.add(g);
  }
  return [...out].map((g) => {
    const [module, action] = g.split(".");
    return { module, action };
    /* Filtered against what the app enforces, not against a MODULES × ACTIONS
       square. The square was the old test, and it quietly dropped two real
       permissions on the way through: `companies.grant` and `companies.panel`
       are checked by the server but their actions are not in ACTIONS, so
       "Give somebody access" could be ticked, saved, and come back blocked. */
  }).filter((p) => GRID_PAIRS.has(`${p.module}.${p.action}`));
}

/* Pairs a role holds that no fully-granted readable permission accounts for.
 *
 * These arise when a role was given half of what a question needs — say
 * parties.create but not parties.edit, where "Add or edit a party" requires
 * both. The question reads as blocked, and saving the role from this screen
 * would quietly drop the stray half. That is the right end state, but it must
 * not happen silently, so the screen is told what it would lose.
 */
const GRANTABLE = new Set();
for (const id of Object.keys(BY_ID)) for (const g of BY_ID[id].grants) GRANTABLE.add(g);

function orphanPairs(pairs) {
  const implied = new Set(pairsFor(readableFor(pairs)).map((p) => `${p.module}.${p.action}`));
  return pairs
    .map((p) => `${p.module}.${p.action}`)
    /* Only pairs the catalogue can actually grant are worth warning about.
       A role may also carry pairs nothing in the app ever checks — seeded
       leftovers like reports.delete. Losing those costs nobody anything, and
       warning about them on a fresh install would teach people to ignore the
       warning that matters. */
    .filter((g) => GRANTABLE.has(g) && !implied.has(g))
    .sort();
}

/* ── The access grid ──────────────────────────────────────────────────────
 *
 * The questions above read well and set several pairs at once, which is what
 * you want when you are handing a role to a new cashier. It is the wrong tool
 * for the other job: "this person may look at Purchases but must never delete
 * a bill" is a single cell, and finding it among thirty questions is guesswork.
 *
 * So the same permissions are also offered as a grid — one card per area of
 * the app, a box per action. Both views write the same `role_permissions`
 * rows; the grid simply writes them one at a time.
 *
 * Two rules keep this honest:
 *
 *  1. Only actions the server actually checks appear. A tickable "delete an
 *     expense" would be a promise the app cannot keep — nothing behind
 *     Expenses deletes anything — and a permission that changes nothing is
 *     worse than no permission at all, because it is believed.
 *  2. `screens` names the parts of the app each card governs, in the words on
 *     the rail. "accounting.edit" means nothing to somebody setting up a
 *     shop; "Accounting, Cash & bank" does.
 *
 * When an endpoint for one of the missing actions is written, add the action
 * here and it appears on the screen — the UI is generated from this list.
 */
const GRID = [
  { id: "sales", label: "Sales & till", screens: ["Till", "Sales", "Shifts"],
    note: "Ringing up, invoices, refunds and voids.",
    actions: [
      ["view",   "See sales",       "The sales list, past receipts and shift figures"],
      ["create", "Make a sale",     "Ring up at the till and raise invoices"],
      ["edit",   "Change a sale",   "Amend an invoice after it was saved"],
      ["delete", "Void or refund",  "Reverse a sale that was already paid"],
    ] },
  { id: "items", label: "Items & stock", screens: ["Items", "Stock take"],
    note: "The catalogue, prices, units, categories and what is on the shelf.",
    actions: [
      ["view",   "See items",      "Names, prices and stock on hand"],
      ["create", "Add an item",    "New products, services, units and categories"],
      ["edit",   "Edit an item",   "Change details, adjust stock, post a stock take"],
      ["delete", "Delete an item", "Remove an item from the catalogue"],
    ] },
  { id: "parties", label: "Customers & suppliers", screens: ["Parties", "Reminders"],
    note: "Who you sell to and buy from, and what they owe.",
    actions: [
      ["view",   "See parties",      "The list, balances and statements"],
      ["create", "Add a party",      "New customers and suppliers"],
      ["edit",   "Edit a party",     "Details, credit limits and write-offs"],
      ["delete", "Delete a party",   "Remove a customer or supplier record"],
    ] },
  { id: "purchases", label: "Purchases", screens: ["Purchases"],
    note: "Supplier bills, purchase orders and goods received.",
    actions: [
      ["view",   "See purchases",  "Bills, orders and what is outstanding"],
      ["create", "Record a bill",  "Enter what a supplier delivered"],
      ["edit",   "Change a bill",  "Amend or approve a bill for payment"],
      ["delete", "Void a bill",    "Cancel one — the goods come back off the shelf and the supplier is no longer owed"],
    ] },
  { id: "accounting", label: "Accounting", screens: ["Accounting", "Cash & bank"],
    note: "The ledger, journals, the day book, trial balance and reconciliation.",
    actions: [
      ["view",   "See the books",     "Accounts, balances, the day book and statements"],
      ["create", "Post an entry",     "Journals, transfers between accounts"],
      ["edit",   "Change an entry",   "Amend a posting or reconcile a statement"],
      ["delete", "Delete an entry",   "Remove a posting from the ledger"],
    ] },
  { id: "payments", label: "Money in & out", screens: ["Cash & bank"],
    note: "Receipts against invoices and payments against bills.",
    actions: [
      ["view",   "See payments",     "What has been received and paid"],
      ["create", "Take a payment",   "Record money received or sent"],
      ["edit",   "Correct a payment", "Change the amount, date or what it settled"],
      ["delete", "Void a payment",   "Cancel a receipt and give the invoices their balance back"],
    ] },
  { id: "expenses", label: "Expenses & other income", screens: ["Purchases › Expenses", "Cash & bank"],
    note: "Rent, fuel, airtime, and income that is not a sale.",
    actions: [
      ["view",   "See expenses",      "The expense list and other income"],
      ["create", "Record an expense", "Enter a cost or a receipt of other income"],
      ["edit",   "Correct an expense", "Change an amount, category or date after it was entered"],
      ["delete", "Void an expense",   "Cancel one, reversing what it posted to the books"],
    ] },
  { id: "reports", label: "Reports", screens: ["Reports", "Dashboard"],
    note: "Every report the app can produce, and the figures on the dashboard.",
    actions: [
      ["view", "See reports", "Profit and loss, item profit, day close and the rest"],
    ] },
  { id: "users", label: "Staff & roles", screens: ["Staff", "Settings › Users"],
    note: "Accounts, PINs and what each role may do — including this screen.",
    actions: [
      ["view",   "See staff",      "The staff list and the roles they are on"],
      ["create", "Add a person",   "Create staff accounts and new roles"],
      ["edit",   "Edit a person",  "Change details, PINs, roles and permissions"],
      ["delete", "Remove a person", "Take an account off this business — retired, not erased, if they ever sold anything"],
    ] },
  { id: "settings", label: "Settings", screens: ["Settings", "Tax & URA", "Data tools"],
    note: "Shop details, taxes, numbering, modules, backup and restore.",
    actions: [
      ["view", "See settings",    "Read the settings without changing them"],
      ["edit", "Change settings", "Shop details, taxes, backup, restore and wipe"],
    ] },
  { id: "companies", label: "Businesses", screens: ["Companies"],
    note: "This account may hold more than one business. These decide what it may do to them.",
    actions: [
      ["view",   "See businesses",   "Which businesses this account may open and switch between"],
      ["create", "Add a business",   "Start another business with its own books"],
      ["edit",   "Edit a business",  "Name, tax number, prefix, suspend, back up and restore"],
      ["delete", "Delete a business", "Destroy a business and everything in it"],
      ["grant",  "Give access",      "Decide who may open which business"],
      ["panel",  "All-business panel", "Revenue, profit and stock across every business at once"],
    ] },
];

/* Every pair the grid can set, as `module.action`. The save endpoint checks
   against this rather than a MODULES × ACTIONS square, because the square
   contains pairs nothing enforces — writing those back is how a role ends up
   holding `reports.delete` and the roles screen ends up warning about it. */
const GRID_PAIRS = new Set();
for (const m of GRID) for (const [a] of m.actions) GRID_PAIRS.add(`${m.id}.${a}`);

module.exports = { MODULES, ACTIONS, CATALOGUE, BY_ID, GRID, GRID_PAIRS, readableFor, pairsFor, orphanPairs };
