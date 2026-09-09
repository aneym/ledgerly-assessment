import { err, ok, type Result, runId, type Seller, sellerId, whopAccountId } from "@ledgerly/core";
import { describe, expect, it } from "vitest";
import { createCreateSellerHandler } from "../../src/app/api/sellers/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));

function seller(overrides: Partial<Seller> = {}): Seller {
  return {
    id: SELLER_ID,
    runId: value(runId("run_1")),
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    whopAccountId: value(whopAccountId("biz_alice")),
    salePolicy: "direct",
    status: "active",
    ...overrides,
  };
}

function request(body: unknown) {
  return new Request("https://example.invalid/api/sellers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function baseDeps(overrides: Partial<Parameters<typeof createCreateSellerHandler>[0]> = {}) {
  const attached: Array<{ sellerId: string; userId: string }> = [];
  const roleChanges: Array<{ userId: string; role: string }> = [];
  const displayNames: Array<{ id: string; displayName: string }> = [];
  return {
    deps: {
      getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" as const }),
      onboardSeller: () =>
        Promise.resolve(
          ok({
            seller: {
              id: SELLER_ID,
              runId: value(runId("run_1")),
              externalId: "alice",
              email: "alice@example.invalid",
              country: "US" as const,
              whopAccountId: value(whopAccountId("biz_alice")),
            },
            operationKey: "op_1",
            onboardingUrl: "https://onboard.example.invalid/1",
          }),
        ),
      attachSellerOwner: (sellerIdArg: string, userIdArg: string) => {
        attached.push({ sellerId: sellerIdArg, userId: userIdArg });
        return Promise.resolve();
      },
      setRole: (userIdArg: string, role: "seller") => {
        roleChanges.push({ userId: userIdArg, role });
        return Promise.resolve();
      },
      runId: () => "run_1",
      getSeller: () => Promise.resolve(seller()),
      getAccount: () =>
        Promise.resolve(
          ok({
            id: value(whopAccountId("biz_alice")),
            raw: {
              capabilities: { accept_card_payments: "active" },
              required_actions: [{ action: "verify_identity" }],
            },
          }),
        ),
      env: { WHOP_MODE: "mock" as const },
      // No partial-onboarding-recovery case by default: onboardSeller() above always
      // succeeds, so this is never consulted unless a test overrides onboardSeller to fail
      // and wants to exercise the recovery path.
      getSellerByIdentity: () => Promise.resolve(null),
      getDisplayName: () => Promise.resolve(null),
      setDisplayName: (id: string, displayName: string) => {
        displayNames.push({ id, displayName });
        return Promise.resolve();
      },
      ...overrides,
    },
    attached,
    roleChanges,
    displayNames,
  };
}

describe("createCreateSellerHandler", () => {
  it("rejects an unauthenticated caller before touching the body", async () => {
    const { deps } = baseDeps({ getSession: () => Promise.resolve(null) });
    const handler = createCreateSellerHandler(deps);
    const response = await handler(request({}));
    expect(response.status).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const { deps } = baseDeps();
    const handler = createCreateSellerHandler(deps);
    const response = await handler(request({ externalId: "", email: "a@b.c", country: "US" }));
    expect(response.status).toBe(400);
  });

  it("rejects an unknown country", async () => {
    const { deps } = baseDeps();
    const handler = createCreateSellerHandler(deps);
    const response = await handler(request({ externalId: "alice", email: "a@b.c", country: "FR" }));
    expect(response.status).toBe(400);
  });

  it("creates the seller, attaches ownership, promotes a buyer to seller, and returns 201 with the exact JSON shape", async () => {
    const { deps, attached, roleChanges } = baseDeps();
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({ externalId: "alice", email: "alice@example.invalid", country: "US" }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      name: string;
      country: string;
      sale_policy: string;
      whop_account_id: string;
      verification: string;
      required_actions: string[];
      capabilities: { payments: string; transfers: string; payouts: string };
      provenance: string;
      onboarding_url: string;
    };
    expect(body).toEqual({
      id: "seller_1",
      name: "alice",
      status: "active",
      country: "US",
      sale_policy: "direct",
      whop_account_id: "biz_alice",
      verification: "pending",
      required_actions: ["verify_identity"],
      capabilities: { payments: "active", transfers: "inactive", payouts: "inactive" },
      provenance: "mock",
      onboarding_url: "https://onboard.example.invalid/1",
      onboardingUrl: "https://onboard.example.invalid/1",
      seller: {
        id: "seller_1",
        externalId: "alice",
        country: "US",
        whopAccountId: "biz_alice",
        displayName: null,
      },
      account: null,
    });
    expect(attached).toEqual([{ sellerId: "seller_1", userId: "user_1" }]);
    expect(roleChanges).toEqual([{ userId: "user_1", role: "seller" }]);
  });

  it("does not re-promote a caller who is already a seller or operator", async () => {
    const { deps, roleChanges } = baseDeps({
      getSession: () => Promise.resolve({ userId: "user_2", role: "seller" as const }),
    });
    const handler = createCreateSellerHandler(deps);
    await handler(request({ externalId: "alice", email: "alice@example.invalid", country: "US" }));
    expect(roleChanges).toEqual([]);
  });

  it("maps an identity conflict from the onboarding service to 409", async () => {
    const { deps } = baseDeps({
      onboardSeller: () => Promise.resolve(err({ kind: "identity_conflict" as const })),
    });
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({ externalId: "alice", email: "alice@example.invalid", country: "US" }),
    );
    expect(response.status).toBe(409);
  });

  it("accepts the contract's snake_case field names", async () => {
    const { deps } = baseDeps();
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({ external_id: "alice", email: "alice@example.invalid", country: "US" }),
    );
    expect(response.status).toBe(201);
  });

  it("accepts a name field submitted as title and stores it as the display name", async () => {
    const { deps, displayNames } = baseDeps();
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({
        external_id: "alice",
        email: "alice@example.invalid",
        country: "US",
        title: "Alice's Shop",
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe("Alice's Shop");
    expect(displayNames).toEqual([{ id: "seller_1", displayName: "Alice's Shop" }]);
  });

  it("returns the offending field names on 400", async () => {
    const { deps } = baseDeps();
    const handler = createCreateSellerHandler(deps);
    const response = await handler(request({ email: "alice@example.invalid" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fields: string[] };
    expect(body.error).toBe("invalid_body");
    expect(body.fields.sort()).toEqual(["country", "external_id"]);
  });

  it("surfaces a provider HTTP failure as 502 provider_http with the extracted whop error", async () => {
    const { deps } = baseDeps({
      onboardSeller: () =>
        Promise.resolve(
          err({
            kind: "http" as const,
            status: 400,
            body: {
              error: { type: "bad_request", message: "Please input an external identifier" },
            },
          }),
        ),
    });
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({ externalId: "alice", email: "alice@example.invalid", country: "US" }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      error: string;
      status: number;
      whop_error_code: string;
      message: string;
    };
    expect(body).toEqual({
      error: "provider_http",
      status: 400,
      whop_error_code: "bad_request",
      message: "Please input an external identifier",
    });
  });

  it("recovers with 201 when the account was created but the onboarding link mint failed", async () => {
    const { deps, attached, roleChanges } = baseDeps({
      onboardSeller: () =>
        Promise.resolve(
          err({
            kind: "http" as const,
            status: 502,
            body: { error: { type: "server_error", message: "link mint failed" } },
          }),
        ),
      getSellerByIdentity: (runIdArg: string, externalId: string) =>
        Promise.resolve(runIdArg === "run_1" && externalId === "alice" ? seller() : null),
    });
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({ externalId: "alice", email: "alice@example.invalid", country: "US" }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      onboarding_url: string | null;
      error: { stage: string; status: number; whop_error_code: string; message: string };
    };
    expect(body.onboarding_url).toBeNull();
    expect(body.error).toEqual({
      stage: "onboarding_link",
      status: 502,
      whop_error_code: "server_error",
      message: "link mint failed",
    });
    expect(attached).toEqual([{ sellerId: "seller_1", userId: "user_1" }]);
    expect(roleChanges).toEqual([{ userId: "user_1", role: "seller" }]);
  });

  it("does not recover into 201 when nothing was created (no whopAccountId on lookup)", async () => {
    const { deps } = baseDeps({
      onboardSeller: () => Promise.resolve(err({ kind: "http" as const, status: 500, body: {} })),
      getSellerByIdentity: () => Promise.resolve(null),
    });
    const handler = createCreateSellerHandler(deps);
    const response = await handler(
      request({ externalId: "alice", email: "alice@example.invalid", country: "US" }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("provider_http");
  });
});

describe("per-run isolation for the guided demo", () => {
  it("uses the demo run cookie only in demo mode and only for well-formed run ids", async () => {
    const { demoRunIdFor } = await import("../../src/app/api/sellers/route");
    const withCookie = new Request("http://x/api/sellers", {
      headers: { cookie: "ledgerly_demo_run=run_ab12CD" },
    });
    expect(demoRunIdFor(withCookie, { DEMO_MODE: "1" } as NodeJS.ProcessEnv)).toBe("run_ab12CD");
    expect(demoRunIdFor(withCookie, {} as NodeJS.ProcessEnv)).toBeUndefined();
    const bad = new Request("http://x/api/sellers", {
      headers: { cookie: "ledgerly_demo_run=../x" },
    });
    expect(demoRunIdFor(bad, { DEMO_MODE: "1" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      demoRunIdFor(new Request("http://x/api/sellers"), { DEMO_MODE: "1" } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

describe("authenticated demo seller creation scope", () => {
  it.each(["buyer", "seller", "demo"])(
    "rejects foreign run creation by the %s profile before onboarding",
    async (role) => {
      const { deps, attached, roleChanges } = baseDeps({
        getSession: async () => ({ userId: "issued_A", role, demoRunId: "run_A" }),
        onboardSeller: async () => {
          throw new Error("Must not onboard a foreign run");
        },
        runId: () => "run_B",
      });
      const response = await createCreateSellerHandler(deps)(
        new Request("http://x/api/sellers", {
          method: "POST",
          headers: { "x-demo-run": "run_B" },
          body: JSON.stringify({
            externalId: "alice",
            email: "alice@example.invalid",
            country: "US",
          }),
        }),
      );
      expect(response.status).toBe(403);
      expect(attached).toEqual([]);
      expect(roleChanges).toEqual([]);
    },
  );
  it("uses the verified profile run for onboarding", async () => {
    const { deps } = baseDeps({
      getSession: async () => ({ userId: "issued_A", role: "buyer", demoRunId: "run_A" }),
      runId: () => {
        throw new Error("Must use the session run");
      },
      onboardSeller: async (input) => {
        expect(input.runId).toBe("run_A");
        return err({ kind: "invalid_identity" });
      },
    });
    const response = await createCreateSellerHandler(deps)(
      new Request("http://x/api/sellers", {
        method: "POST",
        headers: { "x-demo-run": "run_A" },
        body: JSON.stringify({
          externalId: "alice",
          email: "alice@example.invalid",
          country: "US",
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "invalid_identity" });
  });
});
