import { describe, expect, it } from "vitest";
import users from "../../../fixtures/demo/test-users.json";
import { newBuyer, TEST_IDENTITIES } from "../src/lib/dev/identities";

// The browser bundle carries names and emails only; the fixture keeps the seed rows.
// This keeps the two from drifting without importing the fixture into client code.
describe("dev identities", () => {
  it("mirror the fixture without its passwords", () => {
    for (const key of ["buyer", "seller", "operator"] as const) {
      expect(TEST_IDENTITIES[key].name).toBe(users[key].name);
      expect(TEST_IDENTITIES[key].email).toBe(users[key].email);
      expect("password" in TEST_IDENTITIES[key]).toBe(false);
    }
    expect(TEST_IDENTITIES.seller.country).toBe(users.seller.country);
    expect(TEST_IDENTITIES.sellerForms).toEqual(
      Object.fromEntries(Object.entries(users.sellerForms).filter(([key]) => !key.startsWith("_"))),
    );
    expect(TEST_IDENTITIES.sampleProduct).toEqual(users.sampleProduct);
  });

  it("mint a unique buyer with a throwaway sign-up password", () => {
    const who = newBuyer(new Date(2026, 8, 8, 14, 30, 12));
    expect(who.email).toBe("buyer+20260908-143012@ledgerly.test");
    expect(who.password).not.toBe(users.buyer.password);
  });
});
