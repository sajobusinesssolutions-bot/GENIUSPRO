#!/usr/bin/env node
/**
 * run.mjs — the browser half of the test suite.
 *
 * `backend/test` covers the maths (tax, costing, units) with 34 unit tests.
 * This covers the half that only fails in a browser: layout that clips a
 * control, a keystroke order that loses data, a report that renders
 * `undefined`, a receipt that runs off the paper.
 *
 * Usage
 *   npm run test:e2e                 all specs
 *   npm run test:e2e -- till         only specs whose name matches "till"
 *   E2E_PORT=4100 npm run test:e2e   different port
 *
 * It builds nothing and installs nothing. `frontend/dist` must exist — the
 * backend serves it, so the suite exercises the production bundle rather than
 * a dev server. Run `npm run build` at the repo root first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, launchBrowser, makeReporter, BASE } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0] || "";

const files = fs.readdirSync(path.join(HERE, "specs"))
  .filter((f) => f.endsWith(".spec.mjs"))
  .sort();

const specs = [];
for (const f of files) {
  const mod = await import(path.join(HERE, "specs", f));
  if (filter && !`${f} ${mod.name || ""}`.toLowerCase().includes(filter.toLowerCase())) continue;
  specs.push({ file: f, ...mod });
}

if (!specs.length) {
  console.error(filter ? `No spec matches "${filter}".` : "No specs found.");
  process.exit(1);
}

console.log(`\nGenius POS end-to-end — ${specs.length} spec${specs.length === 1 ? "" : "s"}`);

let server, browser, failed = 0, passed = 0;
const started = Date.now();

try {
  process.stdout.write("Starting the app on a throwaway database… ");
  server = await startServer();
  console.log(`ready at ${BASE}`);
  browser = await launchBrowser();

  for (const spec of specs) {
    console.log(`\n\x1b[1m${spec.name || spec.file}\x1b[0m`);
    const report = makeReporter(spec.name || spec.file);
    try {
      await spec.run({ browser, report });
    } catch (e) {
      report.ok(false, "spec threw", e.stack?.split("\n").slice(0, 3).join("\n      ") || String(e));
    }
    failed += report.failed;
    passed += report.passed;
  }
} catch (e) {
  console.error(`\n\x1b[31mCould not run the suite\x1b[0m\n${e.message}\n`);
  failed++;
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(
  failed
    ? `\n\x1b[31m${failed} failed\x1b[0m, ${passed} passed  (${secs}s)\n`
    : `\n\x1b[32m${passed} passed\x1b[0m, 0 failed  (${secs}s)\n`
);
process.exit(failed ? 1 : 0);
