import { describe, expect, it } from "vitest";
import { initialsOf, resolveMark } from "../src/lib/identity/mark";

describe("resolveMark", () => {
  it("draws the catalog portrait for a user whose name is a catalog seller", () => {
    const mark = resolveMark({ id: "bf1645d8-user", name: "Onda Sounds" });
    expect(mark.avatar).toBe("/demo/onda.svg");
    expect(mark.initials).toBe("OS");
  });

  it("matches the seller by id, handle, or name regardless of case", () => {
    expect(resolveMark({ sellerId: "sel_kontur" }).avatar).toBe("/demo/kontur.svg");
    expect(resolveMark({ handle: "PIXELFERN" }).avatar).toBe("/demo/pixelfern.svg");
    expect(resolveMark({ name: "mara okonkwo" }).avatar).toBe("/demo/mara.svg");
  });

  it("reads the demo profile email tag when nothing else names the seller", () => {
    const mark = resolveMark({ name: "Buyer 12", email: "a.b+ledgerly-onda@example.com" });
    expect(mark.avatar).toBe("/demo/onda.svg");
    expect(mark.name).toBe("Buyer 12");
  });

  it("keeps the record's own avatar and name over the catalog", () => {
    const mark = resolveMark({ name: "Onda Sounds", avatar: "/uploads/x.jpg" });
    expect(mark.avatar).toBe("/uploads/x.jpg");
    expect(mark.name).toBe("Onda Sounds");
  });

  it("falls back to the display mapping for a seeded seller row", () => {
    const mark = resolveMark({ sellerId: "sel_juno", externalId: "juno-run-1" });
    expect(mark.avatar).toBe("/demo/juno.svg");
  });

  it("has no portrait for an unknown identity and keeps its initials", () => {
    const mark = resolveMark({ id: "sel_nobody", name: "Northline Studio" });
    expect(mark.avatar).toBeNull();
    expect(mark.initials).toBe("NS");
  });

  it("initials skip punctuation-only words", () => {
    expect(initialsOf("Grain & Gradient")).toBe("GG");
    expect(initialsOf("")).toBe("");
  });
});
