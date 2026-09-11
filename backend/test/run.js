/**
 * run.js — the test entry point.  `node backend/test/run.js`  (or `npm test`).
 *
 * No framework, no install. Loads every *.test.js beside it, then prints a
 * summary and exits non-zero on any failure so CI (and update.bat) can gate on
 * it. Keep new test files named *.test.js and they're picked up automatically.
 */
const fs = require("fs");
const path = require("path");
const { report } = require("./tiny-test");

console.log("Running tests…\n");
for (const f of fs.readdirSync(__dirname)) {
  if (f.endsWith(".test.js")) require(path.join(__dirname, f));
}
report();
