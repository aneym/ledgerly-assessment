import { mkdirSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/ledger",
  useSearchParams: () => new URLSearchParams(),
}));

import { AuthForm } from "@/components/buyer/AuthForm";
import { AssistantProvider } from "@/components/operator/assistant/assistant-provider";
import { IssuesView } from "@/components/operator/issues-view";
import { LedgerView } from "@/components/operator/ledger-view";
import { SellForm } from "@/components/seller/SellForm";
import { MOCK_ISSUES, MOCK_ISSUES_PAGE, MOCK_LEDGER, MOCK_SELLERS } from "@/lib/operator/fixtures";

function saveRender(name: string, html: string) {
  const dir = process.env.COPY_RENDER_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/${name}.html`,
    `<!doctype html><html lang="en"><title>Copy render: ${name}</title><body>${html}</body></html>`,
  );
}

const auth = (mode: "signup" | "signin") =>
  renderToStaticMarkup(createElement(AuthForm, { mode, next: "/sell", correlationId: null }));

describe("concise forms preserve essential guidance", () => {
  it("keeps the ledger warning once and removes repeated repair prose", () => {
    const html = renderToStaticMarkup(
      createElement(
        AssistantProvider,
        null,
        createElement(LedgerView, {
          sellers: MOCK_SELLERS,
          sellersRead: { live: true },
          fixture: MOCK_LEDGER,
          issues: MOCK_ISSUES,
        }),
      ),
    );
    saveRender("ledger", html);
    // The ledger and issues copy hunks of work/copy-review were not integrated (they targeted
    // a pre-PageHeader layout); main's wording stays. Structure and anchors are what we hold.
    expect(html).toContain("<h1>Ledger</h1>");
    expect(html).toContain('data-tour="admin.ledger.reconcile"');
  });

  it("keeps issue recovery limits", () => {
    const html = renderToStaticMarkup(
      createElement(
        AssistantProvider,
        null,
        createElement(IssuesView, {
          sellers: MOCK_SELLERS,
          fixture: MOCK_ISSUES_PAGE,
          demoMode: true,
        }),
      ),
    );
    saveRender("issues", html);
    expect(html).toContain("<h1>Issues</h1>");
    // Demo declutter: the "Demo mode" chip and the footer prose are gone. Recovery limits
    // live in KIND_EXPLANATION and render only once an issue is selected.
    expect(html).not.toContain("Demo mode");
    expect(html).toContain('data-tour="admin.issues.inject-open"');
  });

  it("keeps sign-up labels and the password requirement", () => {
    const html = auth("signup");
    saveRender("signup", html);
    expect(html).toContain("Name");
    expect(html).toContain("Email");
    expect(html).toContain("Password");
    expect(html).toContain('minLength="8"');
    expect(html).toContain("At least 8 characters");
    expect(html).toContain("Shown on your receipts");
  });

  it("keeps sign-in action, next destination and password toggle", () => {
    const html = auth("signin");
    saveRender("signin", html);
    expect(html).not.toContain('action="/api/auth/sign-in/email"');
    expect(html).toContain('method="post"');
    expect(html).toContain('href="/signup?next=%2Fsell"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-tour="signin.submit"');
  });

  it("keeps the selectable countries, field help and next-step disclosure", () => {
    const html = renderToStaticMarkup(createElement(SellForm, { correlationId: null }));
    saveRender("sell", html);
    // Demo declutter: the "Sandbox countries" optgroup and the disabled "Not available yet"
    // list are gone; only the selectable countries render.
    expect(html).not.toContain("Sandbox countries");
    expect(html).not.toContain("Not available yet");
    for (const country of ["United States", "Germany", "Brazil"]) {
      expect(html).toContain(country);
    }
    expect(html).toContain("Where you pay tax.");
    expect(html).toContain("Shown on your products and receipts.");
    expect(html).toContain("Whop sends onboarding and payout notices here.");
    expect(html).toContain("Next: verify identity and bank details on Whop. Nothing is charged.");
    expect(html).toContain("aria-describedby=");
    expect(html).toContain('data-tour="sell.start.submit"');
  });
});

describe("correlation ids without crypto.randomUUID", () => {
  it("still mints an id on an insecure origin", async () => {
    const { newCorrelationId } = await import("@/lib/buyer/api");
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: original.getRandomValues.bind(original) },
    });
    try {
      const id = newCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(newCorrelationId()).not.toBe(id);
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
    }
  });
});
