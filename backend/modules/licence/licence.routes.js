"use strict";
/**
 * licence.routes.js — what the interface may ask about the licence.
 *
 * None of these can grant anything. They report on a licence and bind this
 * computer to one; whether it is live, blocked or expired only the licence
 * server knows, and it says so with a signature.
 */
const express = require("express");
const router = express.Router();
const { verifyToken, requirePermission } = require("../../shared/middleware/auth");
const { query } = require("../../database/db");
const lic = require("./licence.service");

router.use(verifyToken);

/**
 * Bills recorded since the licence last checked in.
 *
 * Grace is capped by work as well as by days, because a machine in aeroplane
 * mode can trade all year on one week's grace otherwise. Counted across the
 * whole installation rather than one company — a licence covers the machine.
 */
async function salesSince() {
  const at = lic.salesBaseline();
  try {
    const n = (await query("SELECT COUNT(*) c FROM sale_invoices")).rows[0].c;
    return Math.max(0, n - at);
  } catch { return 0; }
}
async function salesNow() {
  try { return (await query("SELECT COUNT(*) c FROM sale_invoices")).rows[0].c; }
  catch { return 0; }
}

/**
 * What this installation is actually using.
 *
 * A plan that says "3 businesses, 5 users" is a number in a licence file until
 * it is set beside the number the shop is really using. A shopkeeper about to
 * open a fourth business should find that out on the billing screen, not from
 * a refusal in the middle of doing it.
 *
 * Counted across the whole installation, because that is what a licence
 * covers. Failures are swallowed to null rather than to nought: "we could not
 * count" and "you have none" are different sentences, and showing the second
 * when the first is true is how somebody concludes their businesses are gone.
 */
async function usage() {
  const one = async (sql) => { try { return (await query(sql)).rows[0].c; } catch { return null; } };
  return {
    businesses: await one("SELECT COUNT(*) c FROM firms WHERE status = 'active'"),
    users: await one("SELECT COUNT(*) c FROM users WHERE COALESCE(status,'active') = 'active'"),
    invoices: await one("SELECT COUNT(*) c FROM sale_invoices"),
  };
}

/* Anyone signed in may see the state — a cashier who cannot sell needs to be
   able to read why, and to tell the owner. */
router.get("/", async (req, res) => res.success({ ...lic.status(await salesSince()), usage: await usage() }));

/* Changing it is the owner's business. */
router.post("/activate", requirePermission("settings", "edit"), async (req, res) => {
  const b = req.body || {};
  try {
    const s = await lic.activate({ key: b.key, server: b.server, salesNow: await salesNow() });
    res.success(s);
  } catch (e) {
    res.fail(e.message || "Could not activate this licence", 400);
  }
});

router.post("/check", async (req, res) => {
  const s = await lic.check({ salesNow: await salesNow() });
  res.success(s);
});

router.post("/forget", requirePermission("settings", "edit"), (req, res) => {
  lic.forget();
  res.success(lic.status(0));
});

router.post("/server", requirePermission("settings", "edit"), async (req, res) => {
  lic.setServer((req.body || {}).server);
  res.success(lic.status(await salesSince()));
});

module.exports = { router, salesSince };
