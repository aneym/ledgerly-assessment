import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "../../src/app/(storefront)/handoff/scenarios/page";

describe("assessment simulation page", () => {
  it("renders a separate mock selection with explicit provider limits and evidence links", () => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("Demo/Mock");
    expect(html).toContain("These results are simulations.");
    expect(html).toContain("do not complete identity checks");
    expect(html).toContain('href="/handoff/evidence"');
    expect(html).toContain('href="/handoff"');
    expect(html).toContain('id="scenario-selection"');
    expect(html.match(/<option /g)).toHaveLength(4);
    expect(html).toContain("Run Demo/Mock scenario");
    expect(html).not.toContain("biz_demo_mara");
  });
});
