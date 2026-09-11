#!/usr/bin/env node
"use strict";
/**
 * needs-build.js — has the interface changed since it was last built?
 *
 * `start.bat` used to ask `if not exist frontend\dist\index.html`, which is a
 * different question and the wrong one. Updates ship source, not a bundle, so
 * after the very first build that test was always true and the answer was
 * always "no need" — the server went on serving whatever had been compiled on
 * the day the shop was installed, and not one line of any update since ever
 * reached the screen. The comment above it said exactly what it was there to
 * prevent; the condition did the opposite.
 *
 * (.cjs, not .js: this package is `"type": "module"`, so a .js file here is
 * ESM and `require` throws. It still "worked" — by crashing, which exits
 * non-zero, which reads as "needs a build" — and would have rebuilt the
 * interface on every single start.)
 *
 * So: fingerprint the source, keep the fingerprint beside the bundle, and
 * compare. Contents rather than timestamps, because unzipping an update
 * rewrites every mtime and would otherwise rebuild whether anything changed or
 * not — and because a clock that has been set back would hide a real change.
 *
 *   node needs-build.cjs          exit 1 if a build is needed, 0 if not
 *   node needs-build.cjs --stamp  record the current source as built
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HERE = __dirname;
const DIST = path.join(HERE, "dist");
const STAMP = path.join(DIST, ".build-stamp");

/* What the bundle is made of. Anything here changing means the compiled
   output is out of date. */
const WATCH_DIRS = ["src", "public"];
const WATCH_FILES = ["index.html", "package.json", "vite.config.js", "vite.config.ts", "vite.config.mjs"];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function fingerprint() {
  const files = [];
  for (const d of WATCH_DIRS) walk(path.join(HERE, d), files);
  for (const f of WATCH_FILES) {
    const p = path.join(HERE, f);
    try { if (fs.statSync(p).isFile()) files.push(p); } catch { /* not in this build */ }
  }
  const h = crypto.createHash("sha256");
  for (const p of files.sort()) {
    h.update(path.relative(HERE, p).replace(/\\/g, "/"));
    h.update("\0");
    try { h.update(fs.readFileSync(p)); } catch { h.update("unreadable"); }
    h.update("\0");
  }
  return h.digest("hex");
}

if (process.argv.includes("--stamp")) {
  try {
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(STAMP, fingerprint() + "\n", "utf8");
  } catch (e) {
    /* Not fatal: the worst case is one unnecessary rebuild next time, which
       is the safe direction to fail in. */
    console.error("could not record the build stamp:", e.message);
  }
  process.exit(0);
}

/* No bundle at all is the easy case. */
if (!fs.existsSync(path.join(DIST, "index.html"))) process.exit(1);

let was = "";
try { was = fs.readFileSync(STAMP, "utf8").trim(); } catch { /* built before stamps existed */ }
process.exit(was && was === fingerprint() ? 0 : 1);
