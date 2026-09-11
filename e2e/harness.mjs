/**
 * harness.mjs — boot the real app against a throwaway database, drive it, tear down.
 *
 * The backend already serves `frontend/dist` when it exists (server.js:84), so
 * these tests run against the production bundle on a single origin — no Vite,
 * no proxy, and what is exercised is what ships.
 *
 * The database is copied to a temp file and handed to the server via
 * GENIUS_DB_PATH (database/db.js:20). Tests ring up real sales and void real
 * lines; none of it touches `backend/data/genius.db`.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.E2E_PORT || 3199);
export const BASE = `http://localhost:${PORT}`;
const CREDS = { username: "admin", password: "admin123" };

/* ── assertions ─────────────────────────────────────────────────────────── */
export function makeReporter(specName) {
  const results = [];
  return {
    results,
    ok(pass, message, detail) {
      results.push({ pass: !!pass, message, detail });
      const mark = pass ? "\x1b[32m  ✓\x1b[0m" : "\x1b[31m  ✗\x1b[0m";
      console.log(`${mark} ${message}${detail ? `\n      ${detail}` : ""}`);
      return !!pass;
    },
    info(message) { console.log(`    · ${message}`); },
    get failed() { return results.filter((r) => !r.pass).length; },
    get passed() { return results.filter((r) => r.pass).length; },
    specName,
  };
}

/* ── server ─────────────────────────────────────────────────────────────── */
async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function startServer() {
  const dist = path.join(ROOT, "frontend", "dist", "index.html");
  if (!fs.existsSync(dist)) {
    throw new Error(
      "frontend/dist is missing — the server has no UI to serve.\n" +
      "Run `npm run build` at the repo root first (or `cd frontend && npm run build`)."
    );
  }

  const src = path.join(ROOT, "backend", "data", "genius.db");
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-e2e-"));
  const dbPath = path.join(dir, "genius.db");
  fs.copyFileSync(src, dbPath);

  const proc = spawn("node", ["server.js"], {
    cwd: path.join(ROOT, "backend"),
    env: {
      ...process.env,
      PORT: String(PORT),
      GENIUS_DB_PATH: dbPath,
      /* The suite signs tokens against a fixed key so a run is reproducible.
         Never a production value — the server refuses to boot in production
         without a real one (shared/middleware/auth.js:16). */
      JWT_SECRET: process.env.JWT_SECRET || "e2e-only-not-a-production-secret",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));

  if (!(await waitForHealth())) {
    proc.kill("SIGKILL");
    throw new Error("Backend never became healthy.\n" + log.join(""));
  }

  return {
    dbPath,
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 400));
      if (!proc.killed) proc.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ── browser ────────────────────────────────────────────────────────────── */
export async function launchBrowser() {
  /* PLAYWRIGHT_BROWSERS_PATH is respected when set; otherwise Playwright's
     own resolution applies, so this works on a developer machine too. */
  const exe = process.env.E2E_CHROMIUM;
  return chromium.launch(exe ? { executablePath: exe } : {});
}

export async function signIn(page, { width = 1440, height = 900 } = {}) {
  await page.setViewportSize({ width, height });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="text"]', CREDS.username).catch(() => {});
    await page.fill('input[type="password"]', CREDS.password);
    await page.getByRole("button", { name: /open shop/i }).click();
    await page.waitForSelector(".dk-rail", { timeout: 20000 });
    await page.waitForTimeout(1500);
  }
}

/** Nav labels carry a count badge ("1 Sales"), so anchor on the end only. */
export async function go(page, label) {
  const b = page.locator(".dk-rail .dk-nav").filter({ hasText: new RegExp(`${label}$`, "i") }).first();
  if (!(await b.count())) return false;
  await b.click();
  await page.waitForTimeout(1400);
  return true;
}

export async function apiToken(request) {
  const r = await request.post(`${BASE}/api/auth/login`, { data: CREDS });
  return (await r.json()).data?.token;
}

/** Collect page errors and real console errors; ignore transport noise. */
export function watchErrors(page) {
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|ERR_TUNNEL|Failed to load resource/.test(t)) return;
    errs.push(`CONSOLE ${t.slice(0, 200)}`);
  });
  return errs;
}
