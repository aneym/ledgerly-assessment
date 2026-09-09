import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise the real component and request helper with controlled React lifecycle
// boundaries. This is a component regression, not browser hydration evidence.
const lifecycle = vi.hoisted(() => ({
  current: null as null | {
    values: unknown[];
    cursor: number;
    effects: (() => void)[];
  },
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState(initial: unknown) {
      const current = lifecycle.current;
      // biome-ignore lint/correctness/useHookAtTopLevel: This external React test double delegates SSR to the real hook.
      if (!current) return react.useState(initial);
      const index = current.cursor++;
      if (!(index in current.values)) current.values[index] = initial;
      return [
        current.values[index],
        (value: unknown) => {
          current.values[index] = value;
        },
      ];
    },
    useEffect(effect: () => void, dependencies: unknown[]) {
      // biome-ignore lint/correctness/useHookAtTopLevel: This external React test double delegates SSR to the real hook.
      if (!lifecycle.current) return react.useEffect(effect, dependencies);
      lifecycle.current.effects.push(effect);
    },
  };
});

import { SignOut } from "@/components/buyer/SignOut";

afterEach(() => {
  lifecycle.current = null;
  vi.unstubAllGlobals();
});

function component(next?: string) {
  const state = { values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] };
  function render() {
    lifecycle.current = state;
    state.cursor = 0;
    state.effects = [];
    const tree = SignOut({ correlationId: "signout-regression", next });
    lifecycle.current = null;
    const button = tree.props.children[0] as ReactElement<{
      disabled: boolean;
      onClick: () => Promise<void>;
      children: string;
    }>;
    return { button: button.props, html: () => renderToString(tree) };
  }
  return {
    render,
    mount: () => {
      for (const effect of state.effects) effect();
    },
  };
}

describe("SignOut readiness and auth request preservation", () => {
  it("renders a disabled native sign-out button before hydration", () => {
    const html = renderToString(createElement(SignOut, { correlationId: "signout-regression" }));
    expect(html).toMatch(/<button\b[^>]*\sdisabled=""[^>]*>Sign out<\/button>/);
  });

  it("ignores activation before the mount effect, then sends one POST while pending", async () => {
    let respond!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const assign = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { assign } });
    const view = component("/library");
    const beforeMount = view.render();
    expect(beforeMount.button.disabled).toBe(true);
    await beforeMount.button.onClick();
    expect(fetch).not.toHaveBeenCalled();
    view.mount();
    const ready = view.render();
    expect(ready.button.disabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    const request = ready.button.onClick();
    const pending = view.render();
    expect(pending.button.disabled).toBe(true);
    expect(pending.button.children).toBe("Signing out");
    await pending.button.onClick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/sign-out",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        cache: "no-store",
        headers: expect.objectContaining({ "x-ledgerly-correlation-id": "signout-regression" }),
      }),
    );
    expect(assign).not.toHaveBeenCalled();
    respond(Response.json({ success: true }));
    await request;
    expect(assign).toHaveBeenCalledExactlyOnceWith("/library");
    expect(view.render().button.disabled).toBe(true);
  });

  for (const failure of ["network", "http", "unexpected"] as const) {
    it(`keeps ${failure} failure visible without navigation or automatic retry`, async () => {
      const fetch = vi.fn();
      if (failure === "network") fetch.mockRejectedValueOnce(new TypeError("offline"));
      else
        fetch.mockResolvedValueOnce(
          Response.json(failure === "http" ? { error: "Sign-out rejected" } : { success: false }, {
            status: failure === "http" ? 503 : 200,
          }),
        );
      fetch.mockResolvedValueOnce(Response.json({ success: true }));
      const assign = vi.fn();
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("window", { location: { assign } });
      const view = component();
      view.render();
      view.mount();
      await view.render().button.onClick();
      const failed = view.render();
      expect(failed.button.disabled).toBe(false);
      expect(failed.html()).toContain('role="alert"');
      expect(failed.html()).toContain("POST /api/auth/sign-out");
      expect(assign).not.toHaveBeenCalled();
      await Promise.resolve();
      view.render();
      expect(fetch).toHaveBeenCalledTimes(1);
      await failed.button.onClick();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(assign).toHaveBeenCalledExactlyOnceWith("/");
      expect(view.render().html()).not.toContain('role="alert"');
    });
  }

  for (const next of ["https://example.com", "//example.com", "/\\example.com"]) {
    it(`preserves the home fallback for unsafe destination ${next}`, async () => {
      const assign = vi.fn();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })));
      vi.stubGlobal("window", { location: { assign } });
      const view = component(next);
      view.render();
      view.mount();
      await view.render().button.onClick();
      expect(assign).toHaveBeenCalledExactlyOnceWith("/");
    });
  }
});
