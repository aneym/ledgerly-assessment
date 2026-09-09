import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/issues",
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

import { AssistantProvider } from "@/components/operator/assistant/assistant-provider";
import { IssuesView } from "@/components/operator/issues-view";
import { injectDemoFault } from "@/lib/operator/api";
import { MOCK_ISSUES_PAGE, MOCK_SELLERS } from "@/lib/operator/fixtures";

function render(demoMode = true) {
  return renderToStaticMarkup(
    createElement(
      AssistantProvider,
      null,
      createElement(IssuesView, { sellers: MOCK_SELLERS, fixture: MOCK_ISSUES_PAGE, demoMode }),
    ),
  );
}

afterEach(() => {
  navigation.query = "";
  vi.unstubAllGlobals();
});

describe("guided simulated issue preparation", () => {
  it("exposes an enabled Next target without opening or filling the manual form", () => {
    navigation.query = "tour=C06&seller_id=seller_from_current_run";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = render();
    const control = html.match(
      /<button[^>]*data-tour="admin.issues.inject"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    expect(control).toBeDefined();
    expect(control).toContain("Prepare simulated fault");
    expect(control).not.toContain("disabled");
    expect(html).toContain("fresh simulated payment");
    expect(html).not.toContain('placeholder="pay_');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "tour=C06", "tour=C06&seller_id=%20", "tour=C07&seller_id=seller_from_current_run"])(
    "keeps the manual entry point outside a scoped C06 destination: %s",
    (query) => {
      navigation.query = query;
      const html = render();
      expect(html).not.toContain("Prepare simulated fault");
      expect(html).toContain('data-tour="admin.issues.inject-open"');
    },
  );

  it("does not expose demo preparation outside demo mode", () => {
    navigation.query = "tour=C06&seller_id=seller_from_current_run";
    expect(render(false)).not.toContain("Prepare simulated fault");
  });

  it("requests a fresh simulated payment using only the selected seller", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "case_fresh" }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await injectDemoFault({
      kind: "missing_local_payment",
      seller_id: "seller_from_current_run",
      fresh: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [path, request] = fetch.mock.calls[0];
    expect(path).toBe("/api/admin/issues/demo-fault?kind=missing_local_payment");
    expect(JSON.parse(request.body)).toEqual({ seller_id: "seller_from_current_run", fresh: true });
  });

  it("preserves the manual confirmed-payment request", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "case_manual" }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await injectDemoFault({
      kind: "missing_local_payment",
      seller_id: "seller_manual",
      payment_id: "pay_confirmed",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      seller_id: "seller_manual",
      payment_id: "pay_confirmed",
    });
  });
});
