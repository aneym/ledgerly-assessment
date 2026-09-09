import { describe, expect, it } from "vitest";
import {
  type CreateProductDeps,
  createCreateProductHandler,
} from "../../src/app/api/products/route";

function baseDeps(overrides: Partial<CreateProductDeps> = {}): CreateProductDeps {
  return {
    getSession: () => Promise.resolve({ userId: "user_1", role: "seller" }),
    getSellerOwner: () => Promise.resolve("user_1"),
    getProductBySlug: () => Promise.resolve(null),
    createProduct: (input) => Promise.resolve({ id: input.id }),
    newId: () => "prod_1",
    ...overrides,
  };
}

function post(body: unknown) {
  return new Request("https://example.invalid/api/products", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const validBody = {
  sellerId: "seller_1",
  title: "Course",
  subtitle: "A course",
  category: "education",
  price: { amountMinor: 2500, currency: "USD" },
  description: "Learn things",
  cover: null,
  files: [],
};

describe("createCreateProductHandler", () => {
  it("returns 401 when signed out", async () => {
    const handler = createCreateProductHandler(
      baseDeps({ getSession: () => Promise.resolve(null) }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(401);
  });

  it("returns 403 for a signed-in user who does not own the seller", async () => {
    const handler = createCreateProductHandler(
      baseDeps({ getSellerOwner: () => Promise.resolve("someone_else") }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(403);
  });

  it("allows an operator regardless of ownership", async () => {
    const handler = createCreateProductHandler(
      baseDeps({
        getSession: () => Promise.resolve({ userId: "op_1", role: "operator" }),
        getSellerOwner: () => Promise.resolve("someone_else"),
      }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
  });

  it("returns the offending field names on an invalid body", async () => {
    const handler = createCreateProductHandler(baseDeps());
    const response = await handler(
      post({ sellerId: "seller_1", title: "", category: "", price: {} }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fields: string[] };
    expect(body.error).toBe("invalid_body");
    expect(body.fields.sort()).toEqual(
      ["price.amountMinor", "price.currency", "category", "title"].sort(),
    );
  });

  it("rejects an unsupported currency", async () => {
    const handler = createCreateProductHandler(baseDeps());
    const response = await handler(
      post({ ...validBody, price: { amountMinor: 2500, currency: "GBP" } }),
    );
    expect(response.status).toBe(400);
  });

  it("creates the product and returns 201 with the id", async () => {
    const handler = createCreateProductHandler(baseDeps());
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(body).toEqual({ id: "prod_1" });
  });

  it("derives a slug from the title and passes it to createProduct", async () => {
    let receivedSlug: string | undefined;
    const handler = createCreateProductHandler(
      baseDeps({
        createProduct: (input) => {
          receivedSlug = input.slug;
          return Promise.resolve({ id: input.id });
        },
      }),
    );
    await handler(post(validBody));
    expect(receivedSlug).toBe("course");
  });

  it("appends a numeric suffix when the slug already exists for that seller", async () => {
    let receivedSlug: string | undefined;
    const handler = createCreateProductHandler(
      baseDeps({
        getProductBySlug: (_sellerId, slug) =>
          Promise.resolve(slug === "course" ? { id: "prod_existing" } : null),
        createProduct: (input) => {
          receivedSlug = input.slug;
          return Promise.resolve({ id: input.id });
        },
      }),
    );
    const response = await handler(post(validBody));
    expect(response.status).toBe(201);
    expect(receivedSlug).toBe("course-2");
  });
});
