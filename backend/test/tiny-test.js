/**
 * tiny-test.js — a ~40-line test runner with no dependencies.
 *
 * Why not Jest or vitest? Those need `npm install`, and the point of these
 * tests is that they run anywhere the app runs, including a shop PC with no dev
 * tooling. `node backend/test/run.js` is the whole story.
 *
 * If you later add vitest (recommended in the engineering review), the test
 * files barely change — describe/it/expect are the same shape.
 */
let passed = 0, failed = 0;
const failures = [];
let suite = "";
/* Tests, in order.
 *
 * The runner was synchronous, so an `async` test body returned a promise that
 * nobody waited for: the test was recorded as passing the instant it started,
 * and anything it went on to assert reported after the summary had already
 * printed — or not at all. A test that cannot fail is worse than no test, and
 * this one hid a real finding until it was noticed.
 *
 * The fix after that queued async bodies for report() to await "one at a time"
 * — but it still *called* each body the moment it was registered, and only
 * awaited the promises afterwards. Every async test therefore started at once
 * and ran up to its first await before any of them finished. With one query
 * per test that was invisible; once a query became a promise (see
 * database/db.js) it stopped being invisible, because two tests sharing a
 * database file would interleave their writes and each see the other's
 * half-finished state.
 *
 * So nothing is called here. The body is stored and run by report(), one after
 * the previous has finished, which is what the description always claimed. */
const pending = [];

function describe(name, fn) { suite = name; fn(); suite = ""; }

function it(name, fn) {
  pending.push({ where: `${suite} › ${name}`, run: fn });
}

function pass() { passed++; process.stdout.write("."); }
function fail(where, e) {
  failed++;
  failures.push({ where, msg: e && e.message ? e.message : String(e) });
  process.stdout.write("F");
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function expect(actual) {
  return {
    toBe(exp) { if (actual !== exp) throw new Error(`expected ${fmt(exp)}, got ${fmt(actual)}`); },
    toEqual(exp) { if (!eq(actual, exp)) throw new Error(`expected ${fmt(exp)}, got ${fmt(actual)}`); },
    toBeCloseTo(exp, dp = 2) {
      const d = Math.abs(actual - exp);
      if (d > Math.pow(10, -dp) / 2) throw new Error(`expected ~${exp} (±${dp}dp), got ${actual}`);
    },
    toThrow() {
      let threw = false;
      try { actual(); } catch { threw = true; }
      if (!threw) throw new Error("expected function to throw, it didn't");
    },
  };
}

const fmt = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));

async function report() {
  for (const t of pending) {
    /* `await` on a non-promise is harmless, so a synchronous body and an async
       one are run the same way and a throw from either lands in one place. */
    try { await t.run(); pass(); }
    catch (e) { fail(t.where, e); }
  }
  console.log(`\n\n${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`\n  ✗ ${f.where}\n    ${f.msg}`);
  if (failed) process.exit(1);
}

module.exports = { describe, it, expect, report };
