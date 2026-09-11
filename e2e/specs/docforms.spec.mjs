/**
 * docforms.spec — the six document editors, full screen.
 *
 * The bug this exists for was photographed by the shopkeeper: "Record
 * purchase" was a centred dialog, and its Total row was drawn below the bottom
 * edge of the screen. `.modal-full` is forced to `height: 100vh`
 * (styles.css:931) inside a `.modal-backdrop` carrying 40px of padding
 * (deck.css:2885), so the box was 80px taller than the space it was centred
 * in — and nothing could scroll to the missing part, because the overflow
 * belonged to the backdrop rather than to the dialog. You could fill a
 * purchase in and never see what you were about to commit.
 *
 * So the assertions here are geometric and measured, at the two viewports a
 * shop actually has (a 1366x768 laptop and a 1920x1080 desktop):
 *
 *   · the shell covers the viewport, and nothing of it is outside it;
 *   · the footer — which carries the running total — has its bottom edge at
 *     or above the bottom of the window;
 *   · the grand total and the Save button are both fully inside the window,
 *     WITH a long document loaded, which is the case that used to fail;
 *   · the body is the only thing that scrolls.
 *
 * And a claim that a form works is worth nothing unless something was saved
 * through it, so each of the seven documents is filled in and saved in a real
 * browser and then read back from the API — including the fields that were
 * newly added, which is the only way to catch a control that is on screen but
 * wired to nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signIn, go, watchErrors, apiToken, BASE } from "../harness.mjs";

export const name = "document editors — full screen, reachable totals, real saves";

const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "genius-docforms-"));
const LAPTOP = { width: 1366, height: 768 };
const DESKTOP = { width: 1920, height: 1080 };

/* ── helpers ──────────────────────────────────────────────────────────── */

async function apiGet(page, token, p) {
  const r = await page.request.get(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  return j.data !== undefined ? j.data : j;
}

async function apiPost(page, token, p, data) {
  const r = await page.request.post(`${BASE}/api${p}`, { headers: { Authorization: `Bearer ${token}` }, data });
  const j = await r.json();
  return j.data !== undefined ? j.data : j;
}

/** Everything the geometry assertions need, measured in the page. */
function measure(page) {
  return page.evaluate(() => {
    const fs_ = document.querySelector(".doc-fs");
    if (!fs_) return null;
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const body = fs_.querySelector(".doc-fs-body");
    const grand = fs_.querySelector(".doc-fs-grand .v");
    const save = fs_.querySelector(".doc-fs-acts .btn-primary");
    const box = (b) => (b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) } : null);
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      shell: box(r(fs_)),
      head: box(r(fs_.querySelector(".doc-fs-head"))),
      foot: box(r(fs_.querySelector(".doc-fs-foot"))),
      grand: box(r(grand)),
      grandText: grand ? grand.textContent.trim() : null,
      save: box(r(save)),
      saveText: save ? save.textContent.trim() : null,
      bodyScrollable: body ? body.scrollHeight > body.clientHeight : null,
      bodyOverflow: body ? getComputedStyle(body).overflowY : null,
      /* Anything drawn past the bottom of the window at all. The old dialog
         failed exactly here. */
      overflowBelow: Math.round(Math.max(0, r(fs_).bottom - window.innerHeight)),
    };
  });
}

/** The whole geometry case, for one document at one viewport. */
async function assertGeometry(page, report, label) {
  const m = await measure(page);
  if (!m) return report.ok(false, `${label}: the full-screen editor is open`);
  const v = `${m.vw}x${m.vh}`;
  report.ok(m.shell.top === 0 && m.shell.left === 0 && m.shell.bottom <= m.vh + 1 && m.shell.right <= m.vw + 1,
    `${label} @ ${v}: the editor covers the viewport and nothing hangs off it`,
    `shell ${JSON.stringify(m.shell)} in ${v}, ${m.overflowBelow}px below the fold`);
  report.ok(m.foot && m.foot.bottom <= m.vh,
    `${label} @ ${v}: the action bar is inside the viewport`,
    m.foot ? `footer ${m.foot.top}–${m.foot.bottom} of ${m.vh}` : "no footer");
  report.ok(m.save && m.save.bottom <= m.vh && m.save.top >= 0,
    `${label} @ ${v}: the Save button is inside the viewport`,
    m.save ? `save ${m.save.top}–${m.save.bottom} of ${m.vh} ("${m.saveText}")` : "no save button");
  report.ok(m.grand && m.grand.bottom <= m.vh && m.grand.top >= 0,
    `${label} @ ${v}: the running total is inside the viewport`,
    m.grand ? `total ${m.grand.top}–${m.grand.bottom} of ${m.vh} ("${m.grandText}")` : "no total");
  report.ok(m.bodyOverflow === "auto" || m.bodyOverflow === "scroll",
    `${label} @ ${v}: the body is what scrolls, not the page`, `overflow-y: ${m.bodyOverflow}`);
  return m;
}

async function shoot(page, file) {
  const p = path.join(SHOTS, file);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

/** Type into a combo and take the first match. */
async function combo(page, locator, text) {
  await locator.click();
  await page.keyboard.type(text, { delay: 25 });
  await page.waitForTimeout(650);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(450);
}

/** Open a tab on a deck page, then its create button. */
async function openDoc(page, nav, tab, createLabel) {
  await go(page, nav);
  if (tab) {
    await page.locator(".dk-tab").filter({ hasText: new RegExp(`^${tab}`, "i") }).first().click();
    await page.waitForTimeout(900);
  }
  await page.getByRole("button", { name: new RegExp(`^${createLabel}$`, "i") }).first().click();
  await page.waitForTimeout(1400);
}

async function closeDoc(page) {
  await page.locator(".doc-fs .doc-fs-acts .btn-ghost").first().click().catch(() => {});
  await page.waitForTimeout(500);
}

/** First line of the shared item table. */
const itemCell = (page) => page.locator(".doc-linegrid tbody tr").first().locator("input").first();
const qtyCell = (page) => page.locator(".doc-linegrid tbody tr").first().locator("td.num input").first();

async function saveDoc(page) {
  await page.locator(".doc-fs .doc-fs-acts .btn-primary").first().click();
  await page.waitForTimeout(2200);
}

/* ── the spec ─────────────────────────────────────────────────────────── */
export async function run({ browser, report }) {
  const ctx = await browser.newContext({ viewport: LAPTOP });
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  await signIn(page, LAPTOP);
  const token = await apiToken(page.request);

  /* The seeded book has two customers and no supplier at all, so the fixtures
     a purchase needs are made through the API rather than assumed. Everything
     under test is still driven through the browser. */
  let parties = await apiGet(page, token, "/parties");
  if (!parties.some((p) => p.party_type === "supplier")) {
    await apiPost(page, token, "/parties", { name: "Docforms Supplier Ltd", party_type: "supplier", phone: "0772000999" });
    parties = await apiGet(page, token, "/parties");
  }
  const items = await apiGet(page, token, "/items");
  const supplier = parties.find((p) => p.party_type === "supplier");
  const customer = parties.find((p) => p.party_type !== "supplier") || parties[0];
  const item = items[0];
  report.ok(supplier && customer && item, "the seeded book has a supplier, a customer and an item",
    `${supplier?.name} / ${customer?.name} / ${item?.name}`);

  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);

  /* ── 1. Purchase ─────────────────────────────────────────────────────── */
  await openDoc(page, "Purchases", "Bills", "New bill");
  report.ok(await page.locator(".doc-fs").count() > 0, "Record purchase opens as a full-screen editor");
  report.ok(await page.locator(".modal-backdrop").count() === 0, "Record purchase is no longer a dialog on a backdrop");
  report.ok((await page.locator(".doc-fs-head h2").innerText()).trim() === "Record purchase",
    "the header names the document");
  report.ok((await page.locator(".doc-fs-no").innerText()).includes("PUR-"),
    "the header carries the document number");

  await combo(page, page.locator(".doc-fs .combo input").first(), supplier.name);
  await page.locator('.doc-fs input[type="date"]').first().fill(today);
  await page.locator('.doc-fs input[type="date"]').nth(1).fill(later);   // payment due — new field
  await combo(page, itemCell(page), item.name.slice(0, 8));
  await qtyCell(page).fill("4");
  await page.locator(".doc-linegrid tbody tr").first().locator("td.num input").nth(1).fill("2500");
  await page.waitForTimeout(700);

  report.ok(await page.locator(".doc-party-name").count() > 0,
    "the chosen supplier is read back with their balance",
    (await page.locator(".doc-party-name").first().innerText().catch(() => "")).trim());

  /* The photographed failure was a LONG document. Twelve extra lines is more
     than fits any of these viewports, so this is the case that used to push
     the Total off the bottom of the screen. */
  for (let i = 0; i < 12; i++) await page.locator(".doc-addrow .btn").first().click();
  await page.waitForTimeout(600);
  const long = await assertGeometry(page, report, "purchase (13 lines)");
  report.ok(long && long.bodyScrollable, "a thirteen-line purchase scrolls its body rather than the shell",
    long ? `body scrolls: ${long.bodyScrollable}` : "");
  report.info(`screenshot: ${await shoot(page, "purchase-1366x768.png")}`);

  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(500);
  await assertGeometry(page, report, "purchase (13 lines)");
  report.info(`screenshot: ${await shoot(page, "purchase-1920x1080.png")}`);
  await page.setViewportSize(LAPTOP);
  await page.waitForTimeout(400);

  /* What the footer says, read off the screen, is what the assertion below
     compares the saved row against — the whole complaint was that this figure
     could not be seen before committing, so "what was on screen" is the thing
     worth pinning, not a number hard-coded in the test. Taxes here include a
     withholding deduction, which is exactly why. */
  const shownTotal = Number((await page.locator(".doc-fs-grand .v").innerText()).replace(/[^\d.]/g, ""));
  const billsBefore = (await apiGet(page, token, "/purchases?page=1&limit=1")).total;
  await saveDoc(page);
  report.ok(await page.locator(".doc-fs").count() === 0, "saving closes the purchase editor");
  const bills = await apiGet(page, token, "/purchases?page=1&limit=3");
  const bill = bills.rows[0];
  report.ok(bills.total === billsBefore + 1, "the purchase landed in the book",
    `${billsBefore} → ${bills.total}`);
  report.ok(bill && Math.abs(Number(bill.grand_total) - shownTotal) < 0.01,
    "the purchase saved exactly the total the footer was showing",
    bill ? `${bill.bill_no} saved ${bill.grand_total}, screen said ${shownTotal}` : "no bill");
  report.ok(bill && bill.due_date === later, "the new Payment due field reached the database",
    bill ? `due_date ${bill.due_date}, wanted ${later}` : "");
  report.ok(bill && bill.bill_date === today, "the new Bill date field reached the database",
    bill ? `bill_date ${bill.bill_date}` : "");

  /* ── 2. Purchase order ───────────────────────────────────────────────── */
  await openDoc(page, "Purchases", "Purchase orders", "New order");
  report.ok(await page.locator(".doc-fs").count() > 0,
    "Purchase order has an editor at all (there was no way to raise one by hand)");
  await combo(page, page.locator(".doc-fs .combo input").first(), supplier.name);
  await page.locator('.doc-fs input[type="date"]').nth(1).fill(later);     // expected delivery
  await page.locator(".doc-fs textarea").first().fill("Deliver before noon");
  await combo(page, itemCell(page), item.name.slice(0, 8));
  await qtyCell(page).fill("7");
  await page.waitForTimeout(600);
  await assertGeometry(page, report, "purchase order");
  report.info(`screenshot: ${await shoot(page, "purchase-order-1366x768.png")}`);
  await page.setViewportSize(DESKTOP); await page.waitForTimeout(400);
  await assertGeometry(page, report, "purchase order");
  await page.setViewportSize(LAPTOP); await page.waitForTimeout(400);

  await saveDoc(page);
  const pos = await apiGet(page, token, "/purchase-orders");
  const po = pos[0];
  report.ok(po && Number(po.total) > 0, "the purchase order was created", po ? `${po.po_no} = ${po.total}` : "none");
  const poFull = po ? await apiGet(page, token, `/purchase-orders/${po.id}`) : null;
  report.ok(poFull && poFull.expected_date === later, "the expected delivery date reached the database",
    poFull ? `expected_date ${poFull.expected_date}` : "");
  report.ok(poFull && poFull.note === "Deliver before noon", "the note to the supplier reached the database",
    poFull ? `note ${JSON.stringify(poFull.note)}` : "");
  report.ok(poFull && poFull.status === "draft", "a new order is a draft and has not touched stock",
    poFull ? `status ${poFull.status}` : "");

  /* ── 3. Debit note ───────────────────────────────────────────────────── */
  await openDoc(page, "Purchases", "Debit notes", "New debit note");
  report.ok(await page.locator(".doc-fs").count() > 0,
    "the debit note editor opens (it used to throw on render — `extras` was undefined)");
  /* Picking the original purchase is the field that never existed. */
  await page.locator(".doc-fs select").first().selectOption(String(bill.id));
  await page.waitForTimeout(1200);
  report.ok(Number(await qtyCell(page).inputValue()) > 0, "choosing the original bill prefills its lines",
    `qty ${await qtyCell(page).inputValue()}`);
  await qtyCell(page).fill("1");
  await page.locator('.doc-fs input[placeholder="Wrong batch, damaged…"]').fill("Damaged in transit");
  await page.waitForTimeout(600);
  await assertGeometry(page, report, "debit note");
  report.info(`screenshot: ${await shoot(page, "debit-note-1366x768.png")}`);
  await page.setViewportSize(DESKTOP); await page.waitForTimeout(400);
  await assertGeometry(page, report, "debit note");
  await page.setViewportSize(LAPTOP); await page.waitForTimeout(400);

  await saveDoc(page);
  const dns = await apiGet(page, token, "/returns/debit-notes");
  const dn = dns[0];
  report.ok(dn && Number(dn.grand_total) > 0, "the debit note was raised", dn ? `${dn.note_no} = ${dn.grand_total}` : "none");
  report.ok(dn && Number(dn.bill_id) === Number(bill.id),
    "the debit note is filed against the purchase it corrects",
    dn ? `bill_id ${dn.bill_id}, wanted ${bill.id}` : "");
  report.ok(dn && dn.reason === "Damaged in transit", "the reason reached the database", dn ? dn.reason : "");

  /* ── 4. Expense ──────────────────────────────────────────────────────── */
  await openDoc(page, "Purchases", "Expenses", "New expense");
  report.ok(await page.locator(".doc-fs").count() > 0, "the expense editor is full screen");
  await page.locator('.doc-fs input[type="number"]').first().fill("18500");
  await page.locator('.doc-fs input[type="date"]').first().fill(today);
  await page.locator('.doc-fs input[type="number"]').nth(1).fill("1500");   // tax — new field
  await page.locator(".doc-fs textarea").first().fill("Generator fuel");
  await page.waitForTimeout(500);
  await assertGeometry(page, report, "expense");
  report.info(`screenshot: ${await shoot(page, "expense-1366x768.png")}`);
  await page.setViewportSize(DESKTOP); await page.waitForTimeout(400);
  await assertGeometry(page, report, "expense");
  await page.setViewportSize(LAPTOP); await page.waitForTimeout(400);

  await saveDoc(page);
  const exps = await apiGet(page, token, "/expenses?page=1&limit=3");
  const exp = exps.rows[0];
  report.ok(exp && Number(exp.amount) === 18500, "the expense was recorded", exp ? `${exp.expense_no} = ${exp.amount}` : "none");
  report.ok(exp && exp.expense_date === today, "the new Date field reached the database", exp ? exp.expense_date : "");
  report.ok(exp && Number(exp.tax_amount) === 1500, "the new Tax field reached the database", exp ? `tax ${exp.tax_amount}` : "");

  /* ── 5. Estimate ─────────────────────────────────────────────────────── */
  await openDoc(page, "Sales", "Estimates", "New estimate");
  report.ok(await page.locator(".doc-fs").count() > 0, "the estimate editor is full screen");
  await combo(page, page.locator(".doc-fs .combo input").first(), customer.name);
  await page.locator('.doc-fs input[type="date"]').nth(1).fill(later);   // valid until
  await page.locator(".doc-fs textarea").first().fill("Price holds for 20 days");
  await combo(page, itemCell(page), item.name.slice(0, 8));
  await qtyCell(page).fill("3");
  await page.waitForTimeout(700);
  await assertGeometry(page, report, "estimate");
  report.info(`screenshot: ${await shoot(page, "estimate-1366x768.png")}`);
  await page.setViewportSize(DESKTOP); await page.waitForTimeout(400);
  await assertGeometry(page, report, "estimate");
  await page.setViewportSize(LAPTOP); await page.waitForTimeout(400);

  await saveDoc(page);
  const ests = await apiGet(page, token, "/estimates");
  const est = ests[0];
  report.ok(est && Number(est.grand_total) > 0, "the estimate was saved", est ? `${est.doc_no} = ${est.grand_total}` : "none");
  report.ok(est && est.valid_until === later, "the validity date reached the database", est ? `valid_until ${est.valid_until}` : "");
  report.ok(est && est.notes === "Price holds for 20 days", "the estimate notes reached the database", est ? String(est.notes) : "");
  report.ok(est && est.status === "open", "a new estimate is open and has not touched stock", est ? est.status : "");

  /* ── 6. Credit note ──────────────────────────────────────────────────── */
  const sales = await apiGet(page, token, "/sales");
  const saleRows = Array.isArray(sales) ? sales : sales.rows || [];
  const sale = saleRows[0];
  await openDoc(page, "Sales", "Credit notes", "New credit note");
  report.ok(await page.locator(".doc-fs").count() > 0, "the credit note editor is full screen");
  if (sale) {
    await page.locator(".doc-fs select").first().selectOption(String(sale.id));
    await page.waitForTimeout(1300);
  }
  await qtyCell(page).fill("1");
  await page.locator('.doc-fs input[placeholder="Damaged, wrong item…"]').fill("Wrong size");
  await page.waitForTimeout(600);
  await assertGeometry(page, report, "credit note");
  report.info(`screenshot: ${await shoot(page, "credit-note-1366x768.png")}`);
  await page.setViewportSize(DESKTOP); await page.waitForTimeout(400);
  await assertGeometry(page, report, "credit note");
  await page.setViewportSize(LAPTOP); await page.waitForTimeout(400);

  await saveDoc(page);
  const cns = await apiGet(page, token, "/returns/credit-notes");
  const cn = cns[0];
  report.ok(cn && Number(cn.grand_total) > 0, "the credit note was issued", cn ? `${cn.note_no} = ${cn.grand_total}` : "none");
  report.ok(!sale || Number(cn.invoice_id) === Number(sale.id),
    "the credit note is filed against the invoice it reverses",
    cn ? `invoice_id ${cn.invoice_id}, wanted ${sale && sale.id}` : "");
  report.ok(cn && cn.return_date === today, "the return date reached the database", cn ? cn.return_date : "");

  /* ── 7. Delivery challan ─────────────────────────────────────────────── */
  await openDoc(page, "Sales", "Delivery challans", "New challan");
  report.ok(await page.locator(".doc-fs").count() > 0, "the challan editor is full screen");
  await combo(page, page.locator(".doc-fs .combo input").first(), customer.name);
  await page.locator('.doc-fs input[placeholder="UAX 123A"]').fill("UAX 123A");
  await page.locator('.doc-fs input[placeholder="Who is carrying it"]').fill("Ssemakula 0772000111");
  await page.locator('.doc-fs input[type="date"]').nth(1).fill(later);   // return by
  await combo(page, itemCell(page), item.name.slice(0, 8));
  await qtyCell(page).fill("6");
  await page.waitForTimeout(600);
  const chGeom = await assertGeometry(page, report, "delivery challan");
  report.ok(chGeom && /6/.test(chGeom.grandText || ""), "the challan footer counts the goods going out",
    chGeom ? `"${chGeom.grandText}"` : "");
  report.info(`screenshot: ${await shoot(page, "challan-1366x768.png")}`);
  await page.setViewportSize(DESKTOP); await page.waitForTimeout(400);
  await assertGeometry(page, report, "delivery challan");
  await page.setViewportSize(LAPTOP); await page.waitForTimeout(400);

  await saveDoc(page);
  const chs = await apiGet(page, token, "/returns/challans");
  const ch = chs[0];
  report.ok(ch && ch.line_count > 0, "the challan was created", ch ? `${ch.challan_no}, ${ch.line_count} line(s)` : "none");
  report.ok(ch && ch.vehicle_no === "UAX 123A", "the vehicle number reached the database", ch ? String(ch.vehicle_no) : "");
  report.ok(ch && /Driver: Ssemakula/.test(ch.notes || "") && new RegExp(`Return by: ${later}`).test(ch.notes || ""),
    "driver and return-by are carried on the paper (in notes — the table has no columns for them)",
    ch ? String(ch.notes) : "");

  /* ── behaviour that must not have been lost ──────────────────────────── */
  await openDoc(page, "Purchases", "Bills", "New bill");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");             // closes the party dropdown
  await page.waitForTimeout(400);
  const stillOpen = await page.locator(".doc-fs").count() > 0;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  report.ok(stillOpen && (await page.locator(".doc-fs").count()) === 0,
    "Escape backs out one layer at a time: dropdown first, then the editor",
    `after first Escape the editor was ${stillOpen ? "open" : "CLOSED"}`);

  await openDoc(page, "Purchases", "Bills", "New bill");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  await page.locator(".doc-addrow .btn").nth(1).click();          // Add Items in Bulk
  await page.waitForTimeout(800);
  const picker = await page.locator(".modal-backdrop").count();
  const above = await page.evaluate(() => {
    const m = document.querySelector(".modal-backdrop"), d = document.querySelector(".doc-fs");
    if (!m || !d) return null;
    return Number(getComputedStyle(m).zIndex) > Number(getComputedStyle(d).zIndex);
  });
  report.ok(picker > 0 && above === true, "the bulk item picker still opens ON TOP of the full-screen editor",
    `picker ${picker}, above ${above}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await closeDoc(page);

  report.ok(errs.length === 0, "no page errors across the seven editors",
    [...new Set(errs)].slice(0, 5).join("\n      "));
  report.info(`screenshots in ${SHOTS}`);
  await page.close();
}
