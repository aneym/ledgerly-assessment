// Integration coverage for packages/db/src/repos/products.ts against a real (PGlite) Postgres
// instance, migrated through the actual schema and migrations.
//
// NOTE: this depends on a migration for the `products` table (schema.ts's addition) that has
// not been generated yet - drizzle-kit was intentionally not run this round, per the brief's
// "do not run drizzle-kit" constraint. Until that migration (expected as 0006) exists, this
// suite fails at createTestDb() / the first insert with "relation \"products\" does not exist".
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../src/client";
import { createProductsRepo } from "../src/repos/products";
import { products, sellers } from "../src/schema";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec("TRUNCATE products, sellers RESTART IDENTITY");
  await db.insert(sellers).values({
    id: "seller_1",
    runId: "run_1",
    externalId: "alice",
    email: "alice@example.invalid",
    country: "US",
    salePolicy: "direct",
  });
});

describe("createProductsRepo", () => {
  it("creates a product and reads it back by id", async () => {
    const repo = createProductsRepo(db);
    const created = await repo.create({
      id: "prod_1",
      sellerId: "seller_1",
      slug: "course",
      title: "Course",
      subtitle: "A course",
      category: "education",
      description: "Learn things",
      priceMinor: 2500,
      currency: "USD",
      cover: { name: "cover.png", size: 1024, type: "image/png" },
      files: [{ name: "lesson-1.mp4", size: 2048, type: "video/mp4" }],
    });
    expect(created.id).toBe("prod_1");

    const fetched = await repo.get("prod_1");
    expect(fetched).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    const repo = createProductsRepo(db);
    expect(await repo.get("missing")).toBeNull();
  });

  it("finds a product by (sellerId, slug), scoped per seller", async () => {
    const repo = createProductsRepo(db);
    await db.insert(sellers).values({
      id: "seller_2",
      runId: "run_1",
      externalId: "bob",
      email: "bob@example.invalid",
      country: "US",
      salePolicy: "direct",
    });
    await repo.create({
      id: "prod_1",
      sellerId: "seller_1",
      slug: "course",
      title: "Alice's Course",
      subtitle: null,
      category: "education",
      description: null,
      priceMinor: 2500,
      currency: "USD",
      cover: null,
      files: [],
    });
    await repo.create({
      id: "prod_2",
      sellerId: "seller_2",
      slug: "course",
      title: "Bob's Course",
      subtitle: null,
      category: "education",
      description: null,
      priceMinor: 3500,
      currency: "USD",
      cover: null,
      files: [],
    });

    const aliceProduct = await repo.getBySlug("seller_1", "course");
    expect(aliceProduct?.id).toBe("prod_1");
    const bobProduct = await repo.getBySlug("seller_2", "course");
    expect(bobProduct?.id).toBe("prod_2");
    expect(await repo.getBySlug("seller_1", "missing")).toBeNull();
  });

  it("stores no cover as null fields rather than empty strings", async () => {
    const repo = createProductsRepo(db);
    const created = await repo.create({
      id: "prod_1",
      sellerId: "seller_1",
      slug: "course",
      title: "Course",
      subtitle: null,
      category: "education",
      description: null,
      priceMinor: 2500,
      currency: "USD",
      cover: null,
      files: [],
    });
    expect(created.cover).toBeNull();
    const rows = await db.select().from(products);
    expect(rows[0]?.coverName).toBeNull();
  });
});
