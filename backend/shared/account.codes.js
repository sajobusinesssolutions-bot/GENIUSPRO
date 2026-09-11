/** account.codes.js — canonical GL codes + default chart (Uganda). */
const CODES = {
  CASH: "1001", BANK: "1002",
  DEBTORS: "1010", STOCK: "1020",
  TAX_RECOVERABLE: "1030",   // WHT withheld by customers = income-tax credit we can claim
  CREDITORS: "2010",
  TAXES_PAYABLE: "2020",     // taxes we owe URA (VAT collected, WHT we withheld from suppliers)
  CAPITAL: "3001",
  SALES: "4001", OTHER_INCOME: "4100",
  PURCHASES: "5001", COGS: "5002", STOCK_ADJ: "5003", EXPENSE: "5100", ROUND_OFF: "5900",
};
const DEFAULT_CHART = [
  [CODES.CASH, "Cash in Hand", "asset", 1, 0],
  [CODES.BANK, "Bank Account", "asset", 1, 0],
  [CODES.DEBTORS, "Accounts Receivable", "asset", 0, 1],
  [CODES.STOCK, "Inventory", "asset", 0, 1],
  [CODES.TAX_RECOVERABLE, "Tax Recoverable (WHT credit)", "asset", 0, 0],
  [CODES.CREDITORS, "Accounts Payable", "liability", 0, 1],
  [CODES.TAXES_PAYABLE, "Taxes Payable (URA)", "liability", 0, 0],
  [CODES.CAPITAL, "Owner's Capital", "equity", 0, 0],
  [CODES.SALES, "Sales", "income", 0, 0],
  [CODES.OTHER_INCOME, "Other Income", "income", 0, 0],
  [CODES.PURCHASES, "Purchases", "expense", 0, 0],
  [CODES.COGS, "Cost of Goods Sold", "expense", 0, 0],
  [CODES.STOCK_ADJ, "Stock Adjustments & Write-offs", "expense", 0, 0],
  [CODES.EXPENSE, "Indirect Expenses", "expense", 0, 0],
  [CODES.ROUND_OFF, "Round Off", "expense", 0, 0],
];
module.exports = { CODES, DEFAULT_CHART };
