/**
 * permissions.test.js — the catalogue behind the roles screen.
 *
 * Two views write the same `role_permissions` rows: the plain-English
 * questions, and the access grid. Neither may offer something the server does
 * not enforce, and neither may quietly drop something it does. Both failures
 * look identical to whoever set the role — the screen says saved, and the
 * permission is off when they come back — so they are worth pinning down.
 */
const { describe, it, expect } = require("./tiny-test");
const CAT = require("../shared/permission.catalogue");

describe("permission catalogue", () => {
  it("every grid pair is a module and action the app knows", () => {
    for (const key of CAT.GRID_PAIRS) {
      const [module, action] = key.split(".");
      expect(CAT.MODULES.includes(module)).toBe(true);
      expect(typeof action === "string" && action.length > 0).toBe(true);
    }
  });

  it("every question grants only pairs the grid can also set", () => {
    /* If a question granted a pair the grid has no box for, the grid would
       silently drop it the next time somebody saved a role there. */
    for (const id of Object.keys(CAT.BY_ID)) {
      for (const g of CAT.BY_ID[id].grants) {
        expect(CAT.GRID_PAIRS.has(g)).toBe(true);
      }
    }
  });

  it("keeps companies.grant and companies.panel through pairsFor", () => {
    /* These are checked by the server but their actions are not in ACTIONS,
       and the old filter tested against ACTIONS — so "Give somebody access"
       could be ticked, saved, and come back blocked. */
    const pairs = CAT.pairsFor(["co_grant", "co_panel"]);
    const keys = pairs.map((p) => `${p.module}.${p.action}`);
    expect(keys.includes("companies.grant")).toBe(true);
    expect(keys.includes("companies.panel")).toBe(true);
  });

  it("a question is readable only when every pair it needs is held", () => {
    /* Half a question is not a question: "Add or edit a party" needs both
       create and edit, and holding one must not read as allowed. */
    const half = [{ module: "parties", action: "create" }];
    expect(CAT.readableFor(half).includes("party_edit")).toBe(false);
    const whole = [{ module: "parties", action: "create" }, { module: "parties", action: "edit" }];
    expect(CAT.readableFor(whole).includes("party_edit")).toBe(true);
  });

  it("round-trips: what a question grants reads back as that question", () => {
    for (const id of Object.keys(CAT.BY_ID)) {
      expect(CAT.readableFor(CAT.pairsFor([id])).includes(id)).toBe(true);
    }
  });

  it("names the screens each grid card governs", () => {
    /* "accounting.edit" means nothing to somebody setting up a shop. The card
       has to say which parts of the app it turns on. */
    for (const m of CAT.GRID) {
      expect(Array.isArray(m.screens) && m.screens.length > 0).toBe(true);
      expect(m.actions.length > 0).toBe(true);
      expect(m.actions.some((a) => a[0] === "view")).toBe(true);
    }
  });
});
