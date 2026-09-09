import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CorrelationTable } from "../../../packages/demo-runtime/src/instrumentation";
import { isStepScreen } from "../../../packages/demo-runtime/src/steps";

describe("guided navigation contracts", () => {
  it("requires the selected issue as well as the pathname", () => {
    expect(
      isStepScreen("/admin/issues?issue=case_new", {
        pathname: "/admin/issues",
        search: "?issue=case_old",
      }),
    ).toBe(false);
    expect(
      isStepScreen("/admin/issues?issue=case_new", {
        pathname: "/admin/issues",
        search: "?tour=C07&issue=case_new",
      }),
    ).toBe(true);
    expect(isStepScreen(null, { pathname: "/sell", search: "" })).toBe(false);
  });
  it("mints a UUID accepted by public product links", () => {
    expect(new CorrelationTable().begin("C03")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
  it("publishes an explicitly labelled sample through the existing product API", () => {
    const source = readFileSync(
      new URL("../src/components/tour/GuidedProductSetup.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('data-tour="sell.product.demo"');
    expect(source).toContain('"/api/products"');
    expect(source).toContain("cover: null");
    expect(source).toContain("files: []");
    expect(source).toContain("No downloadable file is attached.");
  });
});
