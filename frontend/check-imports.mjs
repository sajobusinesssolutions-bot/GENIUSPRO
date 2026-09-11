#!/usr/bin/env node
/**
 * check-imports.mjs — flags JSX components a file uses but never imports or
 * defines.
 *
 * Vite compiles such a file without complaint and it throws the moment the
 * screen renders, which is how a missing PartyCombo import once shipped past a
 * clean build. This is a cheap net for that one mistake, not a type checker.
 *
 *   node check-imports.mjs
 *
 * Exits non-zero if anything is missing, so it can go in a pre-release step.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["src/pages", "src/lib"];
const BUILTIN = new Set(["React", "Fragment"]);

let problems = 0;

for (const dir of DIRS) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsx")).sort(); }
  catch { continue; }

  for (const file of files) {
    const path = join(dir, file);
    const src = readFileSync(path, "utf8");

    const used = new Set([...src.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]));

    const imported = new Set();
    for (const m of src.matchAll(/import\s+(?:([A-Za-z0-9_]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
      if (m[1]) imported.add(m[1]);
      if (m[2]) {
        for (const raw of m[2].split(",")) {
          const name = raw.trim().split(/\s+as\s+/).pop().trim();
          if (name) imported.add(name);
        }
      }
    }

    const defined = new Set([
      ...[...src.matchAll(/function\s+([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]),
      ...[...src.matchAll(/const\s+([A-Z][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
    ]);

    const missing = [...used].filter((n) => !imported.has(n) && !defined.has(n) && !BUILTIN.has(n)).sort();
    if (missing.length) {
      problems++;
      console.error(`${path}: component used but not imported or defined -> ${missing.join(", ")}`);
    }

    /* Bare SHOUTY_CASE constants are the other half of the same mistake.
       Deleting a block of a file can take a constant with it while the code
       that reads it stays behind — which is exactly how GROUP_ORDER went
       missing from Reports and crashed the screen on open, past a clean build
       and past the component check above.

       Comments, string and template literals, and JSX text are stripped first,
       or every hex colour, SVG path and the word VAT in a sentence gets
       reported. A noisy check is one nobody runs. */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/`(?:\\.|[^`\\])*`/g, "``")
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/>[^<>{}]*</g, "><");

    const shouty = new Set(
      [...code.matchAll(/(?<![.\w$])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1])
    );
    const declared = new Set([
      ...[...code.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]),
      ...imported,
    ]);
    const missingConst = [...shouty].filter((n) => !declared.has(n)).sort();
    if (missingConst.length) {
      problems++;
      console.error(`${path}: constant used but never declared -> ${missingConst.join(", ")}`);
    }
  }
}

if (problems) {
  console.error(`\n${problems} file(s) would throw at render.`);
  process.exit(1);
}
console.log("check-imports: clean");
