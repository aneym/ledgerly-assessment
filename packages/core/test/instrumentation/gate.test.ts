import { describe, expect, it } from "vitest";
import { gateFromError } from "../../src/index";

describe("gateFromError", () => {
  it("reads a G01 gate off an invalid_request error carrying a capability", () => {
    expect(gateFromError({ kind: "invalid_request", gate: "G01", capability: "payouts" })).toEqual({
      id: "G01",
      reason: "Whop capability is not active on this account (payouts)",
    });
  });
  it("reads a G01 gate off an error with no capability", () => {
    expect(gateFromError({ kind: "invalid_request", gate: "G01" })).toEqual({
      id: "G01",
      reason: "Whop capability is not active on this account",
    });
  });
  it("reads a CRED gate off a credential-missing error", () => {
    expect(gateFromError({ kind: "invalid_request", gate: "CRED" })).toEqual({
      id: "CRED",
      reason: "No Whop credential is configured",
    });
  });
  it("returns null for an invalid_request error with no gate field", () => {
    expect(gateFromError({ kind: "invalid_request" })).toBeNull();
  });
  it.each(["http", "decode", "network", "not_found", "unrecognized"])(
    "returns null for a plain error kind with no gate field (%s)",
    (kind) => {
      expect(gateFromError({ kind })).toBeNull();
    },
  );
  it.each([null, undefined, "string", 42, ["G01"]])(
    "returns null for a non-object error (%s)",
    (value) => {
      expect(gateFromError(value)).toBeNull();
    },
  );
  it("returns null when gate is an unrecognized value", () => {
    expect(gateFromError({ kind: "invalid_request", gate: "WIRE" })).toBeNull();
  });
});
