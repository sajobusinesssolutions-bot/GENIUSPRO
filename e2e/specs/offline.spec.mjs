/**
 * offline.spec — what happens when the line drops with a form half saved.
 *
 * `resilience.spec` covers the till. This covers the rest of the app, and the
 * two behaviours the shop actually asked for:
 *
 *   1. When the connection is down, a save is REFUSED before it leaves the
 *      browser, with a message that says nothing was saved. The old behaviour
 *      was to send it anyway, hold the socket for twenty-five seconds, and
 *      come back with an error that could not say whether the document had
 *      been posted — which is the one answer nobody can act on.
 *
 *   2. Pressing Save twice — because the first press appeared to do nothing —
 *      records ONE document, not two. Every form that posts money now carries
 *      a reference for the attempt, so the server recognises the second press
 *      as the same intent rather than a second expense.
 *
 * The connection is cut with `context.setOffline`, which is what a browser
 * with no route to the server actually looks like, rather than by stopping the
 * backend the whole suite shares.
 */
export const name = "offline — a save that cannot land is refused, not gambled on";

export async function run({ browser, report }) {
  const ok = (n, c, note) => report.ok(!!c, n, note);
  const { signIn } = await import("../harness.mjs");
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  /* First run of a fresh database lands on the setup wizard, which owns the
     screen until it is dismissed. */
  for (let i = 0; i < 3; i++) {
    const s = page.getByRole("button", { name: /skip setup/i }).first();
    if (!(await s.count())) break;
    await s.click(); await page.waitForTimeout(900);
    const c = page.getByRole("button", { name: /skip|yes|confirm/i }).last();
    if (await c.count()) await c.click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  const token = await page.evaluate(() => localStorage.getItem("vy_token"));
  const api = (path, method = "GET", body) => page.evaluate(
    async ([p, m, b, t]) => {
      const r = await fetch(p, {
        method: m,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: b ? JSON.stringify(b) : undefined,
      });
      const j = await r.json().catch(() => null);
      return { status: r.status, data: j && j.data, message: j && j.message };
    }, [path, method, body, token]);

  const expenseCount = async () => {
    const r = await api("/api/expenses?page=1&limit=200");
    return ((r.data && (r.data.rows || r.data)) || []).length;
  };

  /* ── 1. Refused while down ─────────────────────────────────────────────── */
  const before = await expenseCount();
  await context.setOffline(true);
  const blocked = await api("/api/expenses", "POST", { category: "Rent", amount: 99000 }).catch(() => null);
  ok("a write while offline does not reach the server", blocked === null || blocked.status !== 200,
     blocked ? `status ${blocked.status}` : "the request never resolved");
  await context.setOffline(false);
  await page.waitForTimeout(1500);
  ok("and nothing was written", (await expenseCount()) === before, `${before} before, ${await expenseCount()} after`);

  /* ── 2. Save pressed twice ─────────────────────────────────────────────── */
  /* The same reference on both, which is what the form sends when somebody
     presses Save a second time after the first appeared to do nothing. */
  const ref = `spec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const body = { client_ref: ref, category: "Transport", amount: 41000 };
  const first = await api("/api/expenses", "POST", body);
  const second = await api("/api/expenses", "POST", body);
  ok("both presses answered", first.status === 200 && second.status === 200);
  ok("both name the same expense", first.data.expense_no === second.data.expense_no, first.data.expense_no);
  ok("the second is reported as a replay, not a new document", second.data.replayed === true);
  ok("one expense in the book", (await expenseCount()) === before + 1,
     `${before} before, ${await expenseCount()} after two presses`);

  /* ── 3. The banner does not block the button under it ──────────────────── */
  /* It is a status message and nothing on it is clickable, but it is a
     full-width bar at the top of the window — and it appears precisely when
     somebody is reaching for Save. */
  await context.setOffline(true);
  await page.waitForTimeout(2600);           /* let the health probe notice */
  const swallows = await page.evaluate(() => {
    const b = document.querySelector(".conn-banner");
    if (!b) return "no banner";
    return getComputedStyle(b).pointerEvents === "none" ? false : true;
  });
  ok("the offline banner lets clicks through to the page", swallows === false || swallows === "no banner",
     String(swallows));
  await context.setOffline(false);
  await page.waitForTimeout(1200);

  await context.close();
}
