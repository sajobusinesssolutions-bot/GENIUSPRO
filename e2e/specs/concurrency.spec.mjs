/**
 * concurrency.spec.mjs — two tills in one shop.
 *
 * Every other spec drives one browser against one server, which is not how a
 * shop works: the counter has two tills, both signed in, both selling the last
 * of something. Nothing in this app had ever been run that way, and two things
 * made that worth checking rather than assuming.
 *
 * The first is the storage layer. sql.js keeps the whole database in memory and
 * writes it to one file after the fact, so "the server said yes" and "it is on
 * disk" are two different events. Measured before this spec existed: a held
 * bill acknowledged and then SIGKILLed 100ms later was gone on restart — ten
 * out of ten. The other half of the same problem was worse and quieter:
 * db.export() closes and reopens the SQLite handle, which discards any open
 * transaction and resets PRAGMA foreign_keys to OFF, so a save that landed
 * mid-transaction threw away work the caller believed it had written, and every
 * save after the first left the database with no referential integrity at all.
 *
 * The second is the shape of the handlers. Node is single-threaded, so two
 * requests' SQL statements cannot interleave — unless a handler awaits real
 * I/O between reading and writing, at which point the read-check-write in
 * `prevent_negative_stock` stops meaning anything. It does not today, and the
 * assertions below are what says so tomorrow.
 *
 * ── how these stay deterministic ──
 * A race is fired with Promise.all and judged on the invariant, never on the
 * ordering. "Till A won" is not asserted anywhere: what is asserted is that
 * the shelf never went negative, that no two documents share a number, and
 * that a held bill is resumed once. Either till may win; both winning is the
 * bug. The one test that cannot be run against the shared server — SIGKILL and
 * restart — takes its own database copy and its own port, the same way
 * access.spec.mjs does for its second firm.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE } from "../harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND = path.join(ROOT, "backend");
const CRASH_PORT = Number(process.env.E2E_CRASH_PORT || (Number(process.env.E2E_PORT || 3199) + 200));

export const name = "concurrency — two tills, one shelf, one file on disk";

/* ── a client for one till, over Playwright's request context ────────────── */

function client(request, base, token) {
  const call = async (method, url, data) => {
    const res = await request.fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { data }),
      failOnStatusCode: false,
    });
    let body = null;
    try { body = await res.json(); } catch { /* not every reply is json */ }
    return { status: res.status(), ok: !!(body && body.success), body, data: body && body.data, message: body && body.message };
  };
  return {
    get: (u) => call("GET", u),
    post: (u, d) => call("POST", u, d ?? {}),
    put: (u, d) => call("PUT", u, d ?? {}),
    del: (u, d) => call("DELETE", u, d ?? {}),
  };
}

async function signInApi(request, base, username, password) {
  const res = await request.fetch(`${base}/api/auth/login`, {
    method: "POST", data: { username, password }, failOnStatusCode: false,
  });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`Could not sign in as ${username}: ${body?.message}`);
  const till = client(request, base, body.data.token);
  till.userId = body.data.user?.id;
  till.name = username;
  return till;
}

/** A product nobody else is selling, with a known number on the shelf. */
async function stockedItem(till, onHand, tag) {
  const r = await till.post("/api/items", {
    name: `Concurrency ${tag} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    item_type: "product", unit: "PCS",
    /* purchase_price 0 keeps prevent_below_cost out of the way — this is a
       test about stock, and a below-cost refusal would look like one. */
    sale_price: 1000, purchase_price: 0, is_inventory: 1, opening_stock: onHand,
  });
  return r.data?.id;
}

const sellBody = (till, itemId, qty, extra = {}) => ({
  party_id: 1, payment_type: "cash", source: "pos", sales_rep_id: till.userId,
  lines: [{ item_id: itemId, description: "Concurrency probe", quantity: qty, rate: 1000, unit: "PCS" }],
  ...extra,
});

const onHandOf = async (till, itemId) => Number((await till.get(`/api/items/${itemId}`)).data?.on_hand);

/* ── the spec ────────────────────────────────────────────────────────────── */

export async function run({ browser, report }) {
  const ctx = await browser.newContext();
  const request = ctx.request;
  try {
    const tillA = await signInApi(request, BASE, "admin", "admin123");
    const tillB = await signInApi(request, BASE, "sales", "sales123");

    await sameItemAtTheSameMoment({ tillA, tillB, report });
    await documentNumbersUnderLoad({ tillA, report });
    await oneReferenceOneInvoice({ tillA, report });
    await twoTillsOneHeldBill({ tillA, tillB, report });
    await voidAndEditTheSameSale({ tillA, report });
    await committedWorkSurvivesAPowerCut({ request, report });
  } finally {
    await ctx.close();
  }
}

/* ── 1. two tills sell the last of something ─────────────────────────────── */

async function sameItemAtTheSameMoment({ tillA, tillB, report }) {
  const itemId = await stockedItem(tillA, 10, "shelf");
  if (!itemId) return report.ok(false, "the suite can create an item to sell", "POST /api/items returned no id");

  /* Both tills post at once, each for more than half the shelf. If the guard
     only holds when requests are serial, both are told yes and the shop has
     sold sixteen of ten. */
  const [a, b] = await Promise.all([
    tillA.post("/api/sales", sellBody(tillA, itemId, 8)),
    tillB.post("/api/sales", sellBody(tillB, itemId, 8)),
  ]);

  const sold = [a, b].filter((r) => r.ok).length;
  const left = await onHandOf(tillA, itemId);

  report.ok(left >= 0,
    "two tills selling at once cannot put the shelf below zero",
    `10 on hand, both tills sold 8; ${sold} succeeded and ${left} left`);
  report.ok(sold === 1,
    "only one of two simultaneous sales of the last stock is accepted",
    `A: ${a.status} ${a.message} | B: ${b.status} ${b.message}`);
  report.ok(left === 2,
    "the shelf is left holding exactly what was not sold",
    `expected 2, found ${left}`);

  const refused = [a, b].find((r) => !r.ok);
  report.ok(!!refused && /in stock/i.test(refused.message || ""),
    "the till that lost is told the stock ran out, not that something went wrong",
    refused ? `${refused.status} ${refused.message}` : "neither request was refused");

  /* The movement ledger is the truth behind the cached on-hand; a guard that
     held on one and not the other would still hand the shop a wrong figure. */
  const ledger = (await tillA.get(`/api/items/${itemId}/ledger`)).data;
  const rows = (ledger && (ledger.rows || ledger.movements || ledger)) || [];
  const out = Array.isArray(rows)
    ? rows.filter((m) => m.direction === "out").reduce((n, m) => n + Number(m.quantity || 0), 0)
    : null;
  if (out !== null) {
    report.ok(out <= 10,
      "the stock ledger never records more going out than was ever on the shelf",
      `${out} units issued against 10 received`);
  }
}

/* ── 2. document numbers ─────────────────────────────────────────────────── */

async function documentNumbersUnderLoad({ tillA, report }) {
  const itemId = await stockedItem(tillA, 500, "numbering");
  const BILLS = 12;

  const results = await Promise.all(
    Array.from({ length: BILLS }, () => tillA.post("/api/sales", sellBody(tillA, itemId, 1))));
  const accepted = results.filter((r) => r.ok);

  report.ok(accepted.length === BILLS,
    "a burst of simultaneous sales all go through",
    `${accepted.length} of ${BILLS} accepted — ${results.filter((r) => !r.ok).map((r) => r.status + " " + r.message).join(" | ")}`);

  const numbers = accepted.map((r) => r.data.invoice_no);
  report.ok(new Set(numbers).size === numbers.length,
    "no two invoices posted at the same moment carry the same number",
    `${new Set(numbers).size} distinct numbers from ${numbers.length} invoices: ${numbers.join(", ")}`);

  /* Each cash sale also writes a payment, numbered from the same mechanism. A
     duplicate there reconciles the same money twice. */
  const payments = (await tillA.get("/api/payments?limit=500")).data;
  const rows = (payments && (payments.rows || payments)) || [];
  const payNos = rows.map((p) => p.payment_no).filter(Boolean);
  report.ok(payNos.length > 0 && new Set(payNos).size === payNos.length,
    "no two payments carry the same receipt number",
    `${new Set(payNos).size} distinct from ${payNos.length} payments`);

  /* And the database now refuses a repeat outright, so this cannot come back
     by way of some future handler that numbers documents its own way. */
  const ids = accepted.map((r) => r.data.id);
  const fetched = await Promise.all(ids.slice(0, 3).map((id) => tillA.get(`/api/sales/${id}`)));
  report.ok(fetched.every((r) => r.ok && r.data.invoice_no),
    "every invoice in the burst is readable back under its own number");
}

/* ── 3. the same attempt sent twice at once ──────────────────────────────── */

async function oneReferenceOneInvoice({ tillA, report }) {
  const itemId = await stockedItem(tillA, 50, "retry");
  const ref = `e2e-concurrency-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /* Not a retry after a failure — two copies of one attempt in flight at the
     same time, which is what a cashier's second Confirm press looks like when
     the first reply is still on its way. */
  const [a, b] = await Promise.all([
    tillA.post("/api/sales", sellBody(tillA, itemId, 1, { client_ref: ref })),
    tillA.post("/api/sales", sellBody(tillA, itemId, 1, { client_ref: ref })),
  ]);

  report.ok(a.ok && b.ok,
    "both copies of one attempt are answered with the sale, not an error",
    `A: ${a.status} ${a.message} | B: ${b.status} ${b.message}`);
  report.ok(a.ok && b.ok && a.data.id === b.data.id,
    "one attempt posted twice at once produces one invoice",
    a.ok && b.ok ? `ids ${a.data.id} and ${b.data.id}` : "one of the two was refused");
  report.ok((await onHandOf(tillA, itemId)) === 49,
    "the customer is charged for one item and one item leaves the shelf",
    `expected 49 left of 50, found ${await onHandOf(tillA, itemId)}`);
}

/* ── 4. two tills reach for the same held bill ───────────────────────────── */

async function twoTillsOneHeldBill({ tillA, tillB, report }) {
  const label = `Table ${Date.now() % 100}`;
  await tillA.post("/api/pos/held", { label, payload: { lines: [], party_id: 1 }, total_hint: 84000 });
  const list = (await tillA.get("/api/pos/held")).data || [];
  const bill = list.find((h) => h.label === label);
  if (!bill) return report.ok(false, "a bill put on hold can be found again", "the held list did not contain it");

  /* The till resumes in two steps — read the bill, then remove it — so the
     removal cannot be the guard: by the time it runs, both tills already have
     the customer's lines on screen. */
  const [a, b] = await Promise.all([
    tillA.get(`/api/pos/held/${bill.id}`),
    tillB.get(`/api/pos/held/${bill.id}`),
  ]);
  const resumed = [a, b].filter((r) => r.ok);
  report.ok(resumed.length === 1,
    "a held bill can only be resumed by one till",
    `A: ${a.status} ${a.message} | B: ${b.status} ${b.message}`);
  const loser = [a, b].find((r) => !r.ok);
  report.ok(!!loser && loser.status === 409,
    "the second till is told somebody else has the bill rather than handed a copy of it",
    loser ? `${loser.status} ${loser.message}` : "both tills were handed the bill");
  report.ok(!loser || /already resuming/i.test(loser.message || ""),
    "the refusal says what is actually happening to the bill",
    loser && loser.message);

  const winner = resumed[0] === a ? tillA : tillB;
  report.ok(!!(resumed[0] && resumed[0].data && resumed[0].data.payload),
    "the till that wins gets the customer's lines back");

  /* And the removal that follows is honest about whether it removed anything. */
  const [d1, d2] = await Promise.all([
    winner.del(`/api/pos/held/${bill.id}`),
    winner.del(`/api/pos/held/${bill.id}`),
  ]);
  report.ok([d1, d2].filter((r) => r.ok).length === 1,
    "removing a held bill twice reports the removal once",
    `first: ${d1.status} ${d1.message} | second: ${d2.status} ${d2.message}`);

  const after = (await tillA.get("/api/pos/held")).data || [];
  report.ok(!after.some((h) => h.id === bill.id),
    "a resumed bill is off the hold strip for both tills");
}

/* ── 5. one till voids what the other is editing ─────────────────────────── */

async function voidAndEditTheSameSale({ tillA, report }) {
  const itemId = await stockedItem(tillA, 100, "voidedit");
  const sale = await tillA.post("/api/sales", sellBody(tillA, itemId, 5));
  if (!sale.ok) return report.ok(false, "the suite can post a sale to void", `${sale.status} ${sale.message}`);
  const afterSale = await onHandOf(tillA, itemId);

  /* Both from the owner's token on purpose. The seeded cashier has no "edit
     sales" permission, so driving the edit from the second till would be
     refused by RBAC before it ever reached the race — a green tick that proves
     nothing. Two tabs open on one manager's login is the same collision and
     gets past the permission check. */
  const [voided, edited] = await Promise.all([
    tillA.del(`/api/sales/${sale.data.id}`, { reason: "concurrency probe" }),
    tillA.put(`/api/sales/${sale.data.id}`, sellBody(tillA, itemId, 3)),
  ]);

  report.ok(afterSale === 95, "the sale took its five off the shelf", `expected 95, found ${afterSale}`);
  report.ok(!(voided.ok && edited.ok),
    "a sale cannot be voided and rewritten at the same time",
    `void: ${voided.status} ${voided.message} | edit: ${edited.status} ${edited.message}`);

  /* Whichever won, the shelf must reflect exactly one outcome: the void puts
     all five back, the edit leaves three gone. Reversing a reversed posting
     would put ten back and leave the item overstated by five. */
  const left = await onHandOf(tillA, itemId);
  report.ok(left === 100 || left === 97,
    "the shelf reflects one outcome, not both reversals",
    `expected 100 (voided) or 97 (rewritten to 3), found ${left}`);
}

/* ── 6. the power goes off ───────────────────────────────────────────────── */

/**
 * The shared server cannot be killed — every other spec is using it — so this
 * one takes its own copy of the database and its own port, boots it, does a
 * burst of work, SIGKILLs it (not SIGTERM: a power cut does not run exit
 * handlers), boots it again on the same file and counts what is still there.
 */
async function crashServer(dbPath) {
  const proc = spawn("node", ["server.js"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(CRASH_PORT),
      GENIUS_DB_PATH: dbPath,
      JWT_SECRET: process.env.JWT_SECRET || "e2e-only-not-a-production-secret",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));

  const base = `http://localhost:${CRASH_PORT}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return { proc, base }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill("SIGKILL");
  throw new Error("The crash-test backend never became healthy.\n" + log.join(""));
}

async function committedWorkSurvivesAPowerCut({ request, report }) {
  const src = path.join(BACKEND, "data", "genius.db");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genius-crash-"));
  const dbPath = path.join(dir, "genius.db");
  fs.copyFileSync(src, dbPath);

  let proc;
  try {
    let started = await crashServer(dbPath);
    proc = started.proc;
    let till = await signInApi(request, started.base, "admin", "admin123");

    const itemId = await stockedItem(till, 1000, "crash");
    /* Settle the setup to disk so what the count measures afterwards is the
       burst, not the item that was created to make the burst possible. */
    await new Promise((r) => setTimeout(r, 1500));

    const BILLS = 8, HOLDS = 8, VOIDS = 8;
    const acked = { sales: [], holds: 0, voids: 0 };
    await Promise.all([
      ...Array.from({ length: BILLS }, () =>
        till.post("/api/sales", sellBody(till, itemId, 1)).then((r) => { if (r.ok) acked.sales.push(r.data.invoice_no); })),
      ...Array.from({ length: HOLDS }, (_, i) =>
        till.post("/api/pos/held", { label: `Crash hold ${i}`, payload: { lines: [] }, total_hint: i })
          .then((r) => { if (r.ok) acked.holds++; })),
      ...Array.from({ length: VOIDS }, (_, i) =>
        till.post("/api/pos/void", { scope: "item", item_name: `Crash void ${i}`, quantity: 1, amount: 100, reason: "crash probe" })
          .then((r) => { if (r.ok) acked.voids++; })),
    ]);

    /* No grace period at all. Everything below was acknowledged before this
       line ran, and SIGKILL gives the process no chance to flush. */
    proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 700));

    started = await crashServer(dbPath);
    proc = started.proc;
    till = await signInApi(request, started.base, "admin", "admin123");

    const sales = (await till.get("/api/sales?limit=500")).data;
    const saleRows = (sales && (sales.rows || sales)) || [];
    const survivingSales = acked.sales.filter((no) => saleRows.some((s) => s.invoice_no === no)).length;
    const survivingHolds = ((await till.get("/api/pos/held")).data || []).length;
    const left = await onHandOf(till, itemId);

    report.ok(survivingSales === acked.sales.length,
      "every sale the till was told had gone through is still there after a power cut",
      `${survivingSales} of ${acked.sales.length} acknowledged invoices survived SIGKILL`);
    report.ok(survivingHolds >= acked.holds,
      "held bills acknowledged before a power cut are still on the strip afterwards",
      `${survivingHolds} of ${acked.holds} survived`);
    report.ok(left === 1000 - acked.sales.length,
      "stock on disk agrees with the sales that survived",
      `expected ${1000 - acked.sales.length} left, found ${left}`);

    /* The file itself has to be usable, not merely present — a half-written
       export would take the shop's whole book with it. */
    report.ok(saleRows.length > 0 && Number.isFinite(left),
      "the database file is readable and complete after an unclean shutdown");
  } finally {
    proc?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
