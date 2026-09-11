/**
 * onboarding.test.js — the parts of session 7 that can be checked without a
 * server: the code generator, the password rule, and the invitation token.
 *
 * The flow itself — sign-up, verification, invitations, reset — is checked end
 * to end by `test/onboarding.e2e.js`, which needs a running server and a
 * throwaway database and is therefore not in this suite.
 */
const { describe, it, expect } = require("./tiny-test");
const { sixDigits } = require("../shared/authcodes");
const { passwordProblem, EMAIL_RE, digest } = require("../modules/auth/onboarding.routes");

describe("verification codes", () => {
  it("are always six digits", () => {
    let bad = "";
    for (let i = 0; i < 2000; i++) {
      const c = sixDigits();
      if (!/^\d{6}$/.test(c)) { bad = c; break; }
    }
    /* Leading zeros are the trap here: a code built from a number and printed
       without padding produces "4213" once in ten, and a person typing four
       digits into six boxes has no way to know what is wrong. */
    expect(bad).toBe("");
  });

  it("are not all the same code", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(sixDigits());
    expect(seen.size > 150).toBe(true);
  });

  it("include ones that start with a zero", () => {
    /* Proves the padding is real rather than accidentally never exercised.
       One in ten codes should start with 0; over 2,000 draws, seeing none
       would mean the generator cannot produce them. */
    let zeros = 0;
    for (let i = 0; i < 2000; i++) if (sixDigits()[0] === "0") zeros++;
    expect(zeros > 0).toBe(true);
  });
});

describe("password rule", () => {
  it("refuses anything under eight characters", () => {
    expect(!!passwordProblem("short12", "a@b.com")).toBe(true);
  });
  it("accepts an ordinary one", () => {
    expect(passwordProblem("shopkeeper-2026", "a@b.com")).toBe(null);
  });
  it("refuses the email address as the password", () => {
    expect(!!passwordProblem("aisha@shop.co.ug", "AISHA@shop.co.ug")).toBe(true);
  });
  it("refuses the obvious ones", () => {
    expect(!!passwordProblem("password", "a@b.com")).toBe(true);
    expect(!!passwordProblem("12345678", "a@b.com")).toBe(true);
  });
});

describe("email addresses", () => {
  it("accepts the shapes people actually have", () => {
    const good = ["a@b.co", "aisha.nakato@shop.co.ug", "sam+books@example.com", "o'brien@mail.ie"];
    expect(good.filter((e) => !EMAIL_RE.test(e)).join(",")).toBe("");
  });
  it("refuses what is plainly not one", () => {
    const bad = ["", "aisha", "aisha@", "@shop.com", "aisha@shop", "two spaces@x.com"];
    expect(bad.filter((e) => EMAIL_RE.test(e)).join(",")).toBe("");
  });
});

describe("invitation tokens", () => {
  it("hash the same way every time", () => {
    expect(digest("abc") === digest("abc")).toBe(true);
  });
  it("…and differently for different tokens", () => {
    expect(digest("abc") === digest("abd")).toBe(false);
  });
  it("are stored as a digest, not as the token", () => {
    /* What the database holds must not be usable as a link. */
    expect(digest("abc") === "abc").toBe(false);
    expect(/^[0-9a-f]{64}$/.test(digest("abc"))).toBe(true);
  });
});
