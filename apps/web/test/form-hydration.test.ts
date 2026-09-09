import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { AuthForm } from "@/components/buyer/AuthForm";
import { SellForm } from "@/components/seller/SellForm";

const cases = [
  {
    name: "seller",
    element: createElement(SellForm, { correlationId: null }),
    controls: 4,
    fields: ["country", "name", "email"],
  },
  {
    name: "sign-up",
    element: createElement(AuthForm, { mode: "signup", next: "/sell", correlationId: null }),
    controls: 5,
    fields: ["name", "email", "password"],
  },
  {
    name: "sign-in",
    element: createElement(AuthForm, { mode: "signin", next: "/library", correlationId: null }),
    controls: 4,
    fields: ["email", "password"],
  },
];

describe("forms before hydration", () => {
  for (const { name, element, controls, fields } of cases) {
    it(`${name} disables every editable control and action in the server HTML`, () => {
      const html = renderToString(element);
      const fieldset = html.match(/<fieldset\b[^>]*>[\s\S]*?<\/fieldset>/)?.[0];
      expect(fieldset, "the form must render a native disabled fieldset").toBeDefined();
      expect(fieldset).toMatch(/^<fieldset\b[^>]*\sdisabled=""/);
      // Controls in the first legend escape native fieldset disabling.
      expect(fieldset).not.toMatch(/<legend\b/);
      expect(fieldset?.match(/<(?:input|select|textarea|button)\b/g)).toHaveLength(controls);
      for (const field of fields) {
        expect(fieldset).toContain(`name="${field}"`);
      }
      expect(html.replace(fieldset ?? "", "")).not.toMatch(/<(?:input|select|textarea|button)\b/);
      expect(fieldset).toMatch(/<button\b[^>]*type="submit"[^>]*\sdisabled=""/);
    });

    it(`${name} uses POST as a fallback so native submission cannot put fields in the URL`, () => {
      const html = renderToString(element);
      expect(html).toMatch(/<form\b[^>]*\smethod="post"/);
      expect(html).not.toMatch(/<form\b[^>]*\saction=/);
    });
  }
});
