#!/usr/bin/env node
/**
 * check-layers.mjs — guards the stacking order.
 *
 * A dialog opened from a panel must sit above that panel, and a dropdown
 * opened from the dialog above both. Getting this wrong does not break the
 * build or throw — the thing simply opens where you cannot see it, which is
 * how "add a customer" and item search looked dead inside the invoice builder
 * for a whole release.
 */
import { readFileSync } from "node:fs";

const css = ["src/styles.css", "src/deck.css"].map((f) => readFileSync(f, "utf8")).join("\n");

/* Last declaration wins, and deck.css is concatenated second. */
const z = {};
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)[^{}]*\{[^{}]*z-index:\s*(\d+)/g)) z[m.group ? m[1] : m[1]] = Number(m[2]);

const PANELS = ["slide-veil", "dk-till", "dk-form-veil", "dk-mveil"];
const rules = [
  ["dialogs above every panel", () => Math.min(z["modal-backdrop"] ?? 0) > Math.max(...PANELS.map((p) => z[p] ?? 0))],
  ["dropdowns above dialogs", () => (z["combo-list-fixed"] ?? 0) > (z["modal-backdrop"] ?? 0)],
  ["toasts above everything", () => (z["toast-host"] ?? 0) >= Math.max(...Object.values(z))],
];

let bad = 0;
for (const [name, ok] of rules) {
  if (!ok()) { bad++; console.error(`layer check failed: ${name}`); }
}
if (bad) {
  console.error("\nCurrent layers:", JSON.stringify(
    Object.fromEntries(Object.entries(z).filter(([k]) => /veil|till|modal|combo|toast|cf-|sheet/.test(k))), null, 1));
  process.exit(1);
}
console.log("check-layers: clean");
