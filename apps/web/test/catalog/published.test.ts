import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestDb } from "../../../../packages/db/src/client";
import { createProductsRepo } from "../../../../packages/db/src/repos/products";
import { createPublicCatalogRepo } from "../../../../packages/db/src/repos/public-catalog";
import { createUsersRepo } from "../../../../packages/db/src/repos/users";
import { sellers, user } from "../../../../packages/db/src/schema";
import { createCreateProductHandler } from "../../src/app/api/products/route";
import { toFeaturedSlides } from "../../src/components/featured/data";
import { FeeLedger } from "../../src/components/fee-ledger";
import { ProductCard } from "../../src/components/product-card";
import { checkoutHref } from "../../src/lib/catalog/checkout-link";
import {
  checkoutProduct,
  findPublicProduct,
  findPublicSeller,
  fixtureCatalog,
  hasPersistentCatalog,
  productHref,
  projectCatalog,
} from "../../src/lib/catalog/published";
import { createCatalogReader } from "../../src/lib/catalog/reader";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing expected test value");
  return value;
}

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 30000);
afterAll(async () => {
  await db?.$client.close();
});
beforeEach(async () => {
  await db.$client.exec('TRUNCATE products, seller_owners, sellers, "user" CASCADE');
  await db.insert(sellers).values({
    id: "seller_1",
    runId: "private-run",
    externalId: "private-external",
    email: "secret@example.invalid",
    country: "US",
    salePolicy: "direct",
    displayName: "Public Studio",
  });
  await createProductsRepo(db).create({
    id: "prod_1",
    sellerId: "seller_1",
    slug: "new-kit",
    title: "New kit",
    subtitle: null,
    description: "A public description",
    category: "design",
    priceMinor: 2500,
    currency: "USD",
    cover: { name: "secret-cover.png", size: 99, type: "image/png" },
    files: [{ name: "private.zip", size: 42, type: "application/zip" }],
  });
});
it("reads a published product with its seller and immutable price, without private metadata", async () => {
  const rows = await createPublicCatalogRepo(db).list();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "prod_1",
    sellerId: "seller_1",
    priceMinor: 2500,
    currency: "USD",
    sellerName: "Public Studio",
  });
  expect(JSON.stringify(rows)).not.toMatch(/private|secret|coverName|files|email|externalId|runId/);
});

it("keeps colliding seller slugs separate and hides suspended and orphan listings publicly", async () => {
  await db.insert(sellers).values([
    {
      id: "seller_2",
      runId: "run",
      externalId: "b",
      email: "b@example.invalid",
      country: "US",
      salePolicy: "direct",
      displayName: "Second Studio",
      whopAccountId: "biz_two",
    },
    {
      id: "seller_suspended",
      runId: "run",
      externalId: "c",
      email: "c@example.invalid",
      country: "US",
      salePolicy: "direct",
      status: "suspended",
    },
  ]);
  const products = createProductsRepo(db);
  for (const sellerId of ["seller_2", "seller_suspended", "orphan"])
    await products.create({
      id: `prod_${sellerId}`,
      sellerId,
      slug: "new-kit",
      title: "Another kit",
      subtitle: null,
      description: null,
      category: "design",
      priceMinor: 9900,
      currency: "USD",
      cover: null,
      files: [],
    });
  const catalog = projectCatalog(await createPublicCatalogRepo(db).list());
  expect(catalog.products).toHaveLength(2);
  expect(findPublicProduct(catalog, "new-kit")).toBeNull();
  const first = required(findPublicProduct(catalog, "prod_1"));
  const second = required(findPublicProduct(catalog, "prod_seller_2"));
  expect(first.price.amountMinor).toBe(2500);
  expect(second.price.amountMinor).toBe(9900);
  expect(productHref(first)).toBe("/p/prod_1");
  expect(findPublicSeller(catalog, "seller_2")?.name).toBe("Second Studio");
  expect(catalog.sellers.find((s) => s.id === "seller_1")?.salePolicy).toBe(
    "blocked_onboarding_incomplete",
  );
});

it("publishes through the real create route then reads only the authorized seller list", async () => {
  const users = createUsersRepo(db);
  await db
    .insert(user)
    .values({ id: "owner_1", name: "Owner", email: "owner@example.invalid", role: "seller" });
  await users.attachSellerOwner("seller_1", "owner_1");
  const products = createProductsRepo(db);
  const authz = {
    getSession: async () => ({ userId: "owner_1", role: "seller" }),
    getSellerOwner: users.getSellerOwner,
  };
  const publish = createCreateProductHandler({
    ...authz,
    getProductBySlug: products.getBySlug,
    createProduct: products.create,
    newId: () => "prod_fresh",
  });
  const response = await publish(
    new Request("https://example.invalid/api/products", {
      method: "POST",
      body: JSON.stringify({
        sellerId: "seller_1",
        title: "Brand new",
        category: "design",
        price: { amountMinor: 2500, currency: "USD" },
        files: [],
      }),
    }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: "prod_fresh" });
  const reader = createCatalogReader({
    configured: true,
    rows: createPublicCatalogRepo(db).list,
    authz,
  });
  const own = await reader.sellerCatalog({ id: "seller_1", source: "session" });
  expect(own.products.map((p) => p.id)).toContain("prod_fresh");
  expect(own.products.every((p) => p.sellerId === "seller_1")).toBe(true);
  const foreign = await reader.sellerCatalog({ id: "seller_2", source: "param" });
  expect(foreign).toMatchObject({ forbidden: true, products: [] });
  const anonymous = createCatalogReader({
    configured: true,
    rows: createPublicCatalogRepo(db).list,
    authz: { ...authz, getSession: async () => null },
  });
  expect(await anonymous.sellerCatalog({ id: "seller_1", source: "param" })).toMatchObject({
    forbidden: true,
    products: [],
  });
  const publicRead = await reader.publicCatalog();
  expect(findPublicProduct(publicRead, "prod_fresh")).toMatchObject({
    sellerId: "seller_1",
    price: { amountMinor: 2500, currency: "USD" },
  });
});

it("renders real published card links, seller, and fee split without invented ratings", async () => {
  const catalog = projectCatalog(await createPublicCatalogRepo(db).list());
  const product = required(findPublicProduct(catalog, "prod_1"));
  const seller = required(findPublicSeller(catalog, "seller_1"));
  const markup = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(ProductCard, { product, seller }),
      createElement(FeeLedger, { product, seller }),
    ),
  );
  expect(markup).toContain('href="/p/prod_1"');
  expect(markup).toContain("Public Studio");
  expect(markup).toContain("$25.00");
  expect(markup).toContain("$2.00");
  expect(markup).toContain("$23.00");
  expect(markup).not.toContain("Rated");
  expect(markup).not.toContain("private.zip");
});

it("retains fixture URLs only for the same persisted seller and rejects missing fixture aliases", async () => {
  const fixture = fixtureCatalog();
  const product = required(fixture.products[0]);
  expect(productHref(product)).toBe(`/p/${product.slug}`);
  expect(findPublicProduct(fixture, product.slug)?.id).toBe(product.id);
  const rows = await createPublicCatalogRepo(db).list();
  const collision = projectCatalog([{ ...required(rows[0]), slug: product.slug }]);
  expect(findPublicProduct(collision, product.slug)).toBeNull();
  expect(findPublicProduct(collision, "prod_1")?.sellerId).toBe("seller_1");
});

it("supports static no-DB rendering and never substitutes fixtures after configured failure", async () => {
  const authz = { getSession: async () => null, getSellerOwner: async () => null };
  const rows = async (): Promise<never> => {
    throw new Error("database unavailable");
  };
  const staticRead = createCatalogReader({ configured: false, rows, authz });
  expect((await staticRead.publicCatalog()).source).toBe("fixture");
  expect(hasPersistentCatalog({ DATABASE_URL: "configured" })).toBe(true);
  expect(hasPersistentCatalog({ LEDGERLY_LOCAL_RUNTIME: "0" })).toBe(true);
  expect(hasPersistentCatalog({})).toBe(false);
  expect(hasPersistentCatalog({ WHOP_MODE: "sandbox" })).toBe(true);
  expect(hasPersistentCatalog({ WHOP_MODE: "hybrid" })).toBe(true);
  await expect(
    createCatalogReader({ configured: true, rows, authz }).publicCatalog(),
  ).rejects.toThrow("database unavailable");
});

it("preserves a validated purchase correlation and uses the immutable public identity", () => {
  expect(checkoutHref("prod_fresh", "a1b2c3d4-1234-4567-89ab-123456789abc")).toBe(
    "/checkout/new?product=prod_fresh&correlationId=a1b2c3d4-1234-4567-89ab-123456789abc",
  );
  expect(checkoutHref("prod_fresh", "bad&seller=foreign")).toBe("/checkout/new?product=prod_fresh");
});

it("rejects foreign seller overrides for persisted and fixture purchases before sign-in", async () => {
  const catalog = projectCatalog(await createPublicCatalogRepo(db).list());
  expect(checkoutProduct(catalog, "prod_1", "foreign_seller")).toBeNull();
  expect(checkoutProduct(catalog, "new-kit", "foreign_seller")).toBeNull();
  expect(checkoutProduct(catalog, "prod_1", "seller_1")).toMatchObject({
    id: "prod_1",
    sellerId: "seller_1",
    price: { amountMinor: 2500 },
  });
  const fixtures = fixtureCatalog();
  expect(
    checkoutProduct(fixtures, required(fixtures.products[0]).slug, "foreign_run_seller"),
  ).toBeNull();
});

it("does not assign another seller fixture art or copy and keeps platform-only checkout available", async () => {
  const row = required((await createPublicCatalogRepo(db).list())[0]);
  const catalog = projectCatalog([
    { ...row, slug: "onda-drum-library", salePolicy: "platform_only", accountReady: false },
  ]);
  const product = required(catalog.products[0]);
  const seller = required(catalog.sellers[0]);
  expect(seller.salePolicy).toBe("platform_charge_transfer");
  const markup = renderToStaticMarkup(createElement(ProductCard, { product, seller }));
  expect(markup).not.toContain("cv-onda");
  expect(product.artworkKey).toBe("");
  expect(toFeaturedSlides([product], () => seller)[0]).toMatchObject({
    href: "/p/prod_1",
    blurb: "",
    artworkKey: "",
  });
});
