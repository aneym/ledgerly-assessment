import {
  type CreateOrderInput,
  err,
  money,
  type Order,
  ok,
  orderId,
  type Result,
  runId,
  sellerId,
} from "@ledgerly/core";
import { createProductsRepo, createTestDb, sellers } from "@ledgerly/db";
import { describe, expect, it, vi } from "vitest";
import {
  type CreateCheckoutDeps,
  createCheckoutHandler,
  type LookupProduct,
} from "../../src/app/api/checkouts/route";

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

const SELLER_ID = value(sellerId("seller_1"));
const RUN_ID = value(runId("run_1"));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: value(orderId("order_1")),
    runId: RUN_ID,
    sellerId: SELLER_ID,
    productTitle: "Course",
    productExternalId: "prod_1",
    gross: value(money(2500, "USD")),
    fee: value(money(200, "USD")),
    flow: "direct",
    checkoutConfigurationId: "chk_1",
    purchaseUrl: "https://pay.example.invalid/1",
    status: "checkout_created",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    provenance: "mock",
    buyerUserId: null,
    paymentId: null,
    ...overrides,
  };
}

const noProductCatalog: LookupProduct = async () => null;

function baseDeps(overrides: Partial<CreateCheckoutDeps> = {}): CreateCheckoutDeps {
  return {
    getSellerRunId: () => Promise.resolve(RUN_ID),
    createOrder: (_input: CreateOrderInput) => Promise.resolve(ok(order())),
    lookupProduct: noProductCatalog,
    getSession: () => Promise.resolve(null),
    ...overrides,
  };
}

function post(body: unknown) {
  return new Request("https://example.invalid/api/checkouts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const validBody = {
  seller_id: "seller_1",
  productTitle: "Course",
  productExternalId: "prod_1",
  priceMinor: 2500,
  currency: "USD",
};

describe("createCheckoutHandler", () => {
  it("requires no authentication: an anonymous request succeeds", async () => {
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
  });

  it("accepts the legacy sellerId alias for seller_id", async () => {
    const { seller_id: _seller_id, ...rest } = validBody;
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post({ ...rest, sellerId: "seller_1" }));
    expect(response.status).toBe(201);
  });

  it("rejects an invalid body", async () => {
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post({ ...validBody, priceMinor: "not a number" }));
    expect(response.status).toBe(400);
  });

  it("rejects a body with neither product_slug nor direct product fields", async () => {
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post({ seller_id: "seller_1" }));
    expect(response.status).toBe(400);
  });

  it("rejects an unsupported currency", async () => {
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post({ ...validBody, currency: "GBP" }));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the seller does not exist", async () => {
    const handler = createCheckoutHandler(
      baseDeps({ getSellerRunId: () => Promise.resolve(null) }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(404);
  });

  it("creates the order and returns 201 with the exact JSON shape", async () => {
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      order_id: string;
      purchase_url: string;
      status: string;
      provenance: string;
    };
    expect(body).toEqual({
      order_id: "order_1",
      purchase_url: "https://pay.example.invalid/1",
      status: "checkout_created",
      provenance: "mock",
    });
  });

  it("resolves product_slug against the catalog when it hits", async () => {
    const lookupProduct: LookupProduct = async (sellerIdArg, slug) =>
      sellerIdArg === "seller_1" && slug === "course-1"
        ? { productTitle: "Course", priceMinor: 2500, currency: "USD" }
        : null;
    const handler = createCheckoutHandler(baseDeps({ lookupProduct }));
    const response = await handler(post({ seller_id: "seller_1", product_slug: "course-1" }));
    expect(response.status).toBe(201);
  });

  it("resolves title, amount and currency from the products table scoped by seller and slug", async () => {
    const db = await createTestDb();
    try {
      await db.insert(sellers).values({
        id: "seller_1",
        runId: "run_1",
        externalId: "checkout-seller",
        email: "checkout@example.invalid",
        country: "US",
        salePolicy: "direct",
      });
      const products = createProductsRepo(db);
      await products.create({
        id: "prod_db",
        sellerId: "seller_1",
        slug: "course-1",
        title: "Database course title",
        subtitle: null,
        category: "education",
        description: null,
        priceMinor: 7900,
        currency: "EUR",
        cover: null,
        files: [],
      });
      const createOrder = vi.fn(baseDeps().createOrder);
      const handler = createCheckoutHandler(
        baseDeps({
          createOrder,
          lookupProduct: async (seller, slug) => {
            const product = await products.getBySlug(seller, slug);
            return product
              ? {
                  productTitle: product.title,
                  productExternalId: product.id,
                  priceMinor: product.priceMinor,
                  currency: product.currency,
                }
              : null;
          },
        }),
      );

      const miss = await handler(post({ seller_id: "seller_9", product_slug: "course-1" }));
      expect(miss.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();

      const hit = await handler(
        post({
          seller_id: "seller_1",
          product_slug: "course-1",
          productTitle: "Caller title must not win",
          productExternalId: "caller-product",
        }),
      );
      expect(hit.status).toBe(201);
      expect(createOrder).toHaveBeenCalledExactlyOnceWith({
        runId: RUN_ID,
        sellerId: SELLER_ID,
        productTitle: "Database course title",
        productExternalId: "prod_db",
        gross: { amountMinor: 7900, currency: "EUR" },
      });
    } finally {
      await db.$client.close();
    }
  }, 30000);

  it.each([
    { priceMinor: 1 },
    { amount: 1 },
    { amount_minor: 1 },
    { amountMinor: 1 },
    { price_minor: 1 },
    { currency: "BRL" },
    { priceMinor: 2500 },
    { currency: "USD" },
    { priceMinor: null },
    { currency: null },
    { priceMinor: 1, currency: "USD" },
  ])("rejects caller-supplied or tampered pricing with product_slug: %j", async (pricing) => {
    const createOrder = vi.fn(baseDeps().createOrder);
    const lookupProduct = vi.fn(async () => ({
      productTitle: "Course",
      priceMinor: 2500,
      currency: "USD" as const,
    }));
    const handler = createCheckoutHandler(baseDeps({ createOrder, lookupProduct }));
    const response = await handler(
      post({
        seller_id: "seller_1",
        product_slug: "course-1",
        ...pricing,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "product_pricing_not_allowed" });
    expect(lookupProduct).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it.each(["", "   ", null, 42])(
    "rejects an invalid product_slug without using direct pricing: %j",
    async (slug) => {
      const createOrder = vi.fn(baseDeps().createOrder);
      const handler = createCheckoutHandler(baseDeps({ createOrder }));
      const response = await handler(post({ seller_id: "seller_1", product_slug: slug }));
      expect(response.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
    },
  );

  it("rejects pricing with the legacy productSlug alias", async () => {
    const handler = createCheckoutHandler(baseDeps());
    const response = await handler(post({ ...validBody, productSlug: "course-1" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "product_pricing_not_allowed" });
  });

  it("maps seller_not_onboarded to 409", async () => {
    const handler = createCheckoutHandler(
      baseDeps({ createOrder: () => Promise.resolve(err({ kind: "seller_not_onboarded" })) }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(409);
  });

  it("maps seller_suspended to 403", async () => {
    const handler = createCheckoutHandler(
      baseDeps({ createOrder: () => Promise.resolve(err({ kind: "seller_suspended" })) }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(403);
  });

  it("maps a WhopError to 502 by default", async () => {
    const handler = createCheckoutHandler(
      baseDeps({ createOrder: () => Promise.resolve(err({ kind: "network" })) }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(502);
  });

  it("records the signed-in caller's userId as buyerUserId on the order", async () => {
    let received: CreateOrderInput | undefined;
    const handler = createCheckoutHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "user_1", role: "buyer" }),
        createOrder: (input) => {
          received = input;
          return Promise.resolve(ok(order()));
        },
      }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
    expect(received?.buyerUserId).toBe("user_1");
  });

  it("omits buyerUserId for an anonymous checkout", async () => {
    let received: CreateOrderInput | undefined;
    const handler = createCheckoutHandler(
      baseDeps({
        createOrder: (input) => {
          received = input;
          return Promise.resolve(ok(order()));
        },
      }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
    expect(received?.buyerUserId).toBeUndefined();
  });
});
