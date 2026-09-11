/* Moved to shared/idempotency.js when payments, expenses, purchase bills,
   debit notes, journals and quotations came under the same protection — the
   sales module was never the reason it worked. Re-exported here so the
   existing importers keep working unchanged. */
module.exports = require("../../shared/idempotency");
