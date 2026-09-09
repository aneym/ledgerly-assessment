import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconcileSellerHandler } from "../../src/app/api/reconcile/[sellerId]/route";
import { createSetSellerPolicyHandler } from "../../src/app/api/sellers/[id]/policy/route";
import { createSuspendSellerHandler } from "../../src/app/api/sellers/[id]/suspend/route";

// These routes have not adopted demo scopes. A run cookie must never grant their
// operator permission, even when the requested seller belongs to the same run.
const deniedSessions = [
  { name: "signed out", role: null, run: "run_A", status: 401 },
  { name: "buyer", role: "buyer", run: "run_A", status: 403 },
  { name: "seller owner", role: "seller", run: "run_A", status: 403 },
  { name: "demo with its own run", role: "demo", run: "run_A", status: 403 },
  { name: "demo with a foreign run", role: "demo", run: "run_B", status: 403 },
  { name: "demo without a run", role: "demo", run: null, status: 403 },
  { name: "demo with a malformed cookie", role: "demo", run: "%ZZ", status: 403 },
];

afterEach(() => vi.unstubAllEnvs());

describe.each(["suspend", "policy", "reconcile"] as const)("%s operator boundary", (route) => {
  it.each(deniedSessions)("rejects $name before reading or changing seller state", async (test) => {
    const forbidden = async (): Promise<never> => {
      throw new Error("An unauthorized request reached a seller or provider operation");
    };
    const getSession = async () =>
      test.role === null ? null : { userId: "seller_owner_A", role: test.role };
    const handler =
      route === "suspend"
        ? createSuspendSellerHandler({
            getSession,
            getSeller: forbidden,
            suspend: forbidden,
            getDisplayName: forbidden,
          })
        : route === "policy"
          ? createSetSellerPolicyHandler({
              getSession,
              getSeller: forbidden,
              setSalePolicy: forbidden,
              getDisplayName: forbidden,
            })
          : createReconcileSellerHandler({
              getSession,
              detectForSeller: forbidden,
              provenance: () => "mock",
              newRunId: () => "run_reconcile",
              now: () => new Date("2026-09-09T00:00:00Z"),
            });

    // Exercise both deployment modes without constructing any provider or auth client.
    // Even an injected demo session in a live configuration must stay denied here.
    for (const mode of ["mock", "live"]) {
      vi.stubEnv("WHOP_MODE", mode);
      vi.stubEnv("NODE_ENV", mode === "live" ? "production" : "test");
      vi.stubEnv("DEMO_MODE", "1");
      const headers = new Headers({ "content-type": "application/json", "x-role": "operator" });
      if (test.run !== null) {
        headers.set("cookie", `ledgerly_demo_run=${test.run}`);
        headers.set("x-demo-run", test.run);
      }
      const path = route === "reconcile" ? "reconcile/seller_A" : `sellers/seller_A/${route}`;
      const response = await handler(
        new Request(`http://localhost/api/${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ sale_policy: "platform_only" }),
        }),
        "seller_A",
      );
      expect(response.status).toBe(test.status);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });
});
