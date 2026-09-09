import { orderId } from "@ledgerly/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestDb } from "../../../../packages/db/src/client";
import { createOrdersRepo, createSellerLookup } from "../../../../packages/db/src/repos/orders";
import { createProductsRepo } from "../../../../packages/db/src/repos/products";
import { createPublicCatalogRepo } from "../../../../packages/db/src/repos/public-catalog";
import { createRefundRequestsRepo } from "../../../../packages/db/src/repos/refund-requests";
import { createUsersRepo } from "../../../../packages/db/src/repos/users";
import { orders, sellers, user } from "../../../../packages/db/src/schema";
import { createCreateRefundRequestHandler } from "../../src/app/api/orders/[id]/refund-request/route";
import { createGetOrderHandler } from "../../src/app/api/orders/[id]/route";
import { createCreateProductHandler } from "../../src/app/api/products/route";
import { createListRefundsHandler } from "../../src/app/api/refunds/route";
import { OrderRows } from "../../src/components/buyer/OrderRows";
import { RefundList } from "../../src/components/buyer/RefundList";
import { resolveCover, resolveSeller } from "../../src/components/buyer/resolve";
import { ProductCover } from "../../src/components/product-cover";
import { toOrderView, toRefundList } from "../../src/lib/buyer/api";
import { allProducts, allSellers } from "../../src/lib/catalog";
import {
  checkoutProduct,
  findPublicProduct,
  fixtureCatalog,
  projectCatalog,
} from "../../src/lib/catalog/published";

function required<T>(value: T | null | undefined): T {
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
  await db.$client.exec(
    'TRUNCATE refund_requests, orders, products, seller_owners, sellers, "user" CASCADE',
  );
  await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.invalid" });
  for (const id of ["seller_new", "seller_other"]) {
    await db.insert(sellers).values({
      id,
      runId: "test",
      externalId: id,
      displayName: "New Studio",
      email: `${id}@example.invalid`,
      country: "US",
      salePolicy: "platform_only",
    });
    await createUsersRepo(db).attachSellerOwner(id, "owner");
  }
});

const getSession = async () => ({ userId: "buyer", role: "buyer" });
async function getOrder(id: string) {
  const parsed = orderId(id);
  return parsed.ok ? createOrdersRepo(db).get(parsed.value) : null;
}
async function paidOrder(productId = "prod_new", title = "New product", sellerId = "seller_new") {
  await db.insert(orders).values({
    id: "order_1",
    runId: "test",
    sellerId,
    productExternalId: productId,
    productTitle: title,
    grossMinor: 2500,
    feeMinor: 200,
    currency: "USD",
    flow: "platform_transfer",
    status: "paid",
    buyerUserId: "buyer",
    paymentId: "pay_1",
  });
}
async function orderView() {
  const read = createGetOrderHandler({
    getSession,
    getOrder,
    getSeller: createSellerLookup(db).get,
    getProduct: createProductsRepo(db).get,
    getSellerOwner: createUsersRepo(db).getSellerOwner,
  });
  const response = await read(new Request("https://example.invalid/api/orders/order_1"), "order_1");
  expect(response.status).toBe(200);
  const order = toOrderView(await response.json());
  if (!order) throw new Error("Missing order view");
  return order;
}
async function publish(id: string, sellerId: string, title: string) {
  const products = createProductsRepo(db);
  const handler = createCreateProductHandler({
    getSession: async () => ({ userId: "owner", role: "seller" }),
    getSellerOwner: createUsersRepo(db).getSellerOwner,
    getProductBySlug: products.getBySlug,
    createProduct: products.create,
    newId: () => id,
  });
  const response = await handler(
    new Request("https://example.invalid/api/products", {
      method: "POST",
      body: JSON.stringify({
        sellerId,
        title,
        category: "audio",
        price: { amountMinor: 2500, currency: "USD" },
        files: [],
      }),
    }),
  );
  expect(response.status).toBe(201);
}

it("renders a persisted refund request from the real request and list routes", async () => {
  await paidOrder();
  const requests = createRefundRequestsRepo(db);
  const submit = createCreateRefundRequestHandler({
    getSession,
    getOrder,
    getRefundRequest: requests.getForOrder,
    createRefundRequest: requests.create,
  });
  const response = await submit(
    new Request("https://example.invalid/api/orders/order_1/refund-request", {
      method: "POST",
      headers: { "content-length": "0" },
    }),
    "order_1",
  );
  expect(response.status).toBe(201);
  const list = createListRefundsHandler({ getSession, listForBuyer: requests.listForBuyer });
  const refunds = toRefundList(
    await (await list(new Request("https://example.invalid/api/refunds?buyer=me"))).json(),
  );
  expect(refunds).toMatchObject([
    { orderId: "order_1", status: "requested", amount: { amountMinor: 2500, currency: "USD" } },
  ]);
  const html = renderToStaticMarkup(createElement(RefundList, { refunds }));
  expect(html).toContain("Requested");
  expect(html).toContain("$25.00");
  expect(html).toContain('href="/receipt/order_1"');
  expect(html).not.toContain("No refund requests");
  expect((await getOrder("order_1"))?.status).toBe("paid");
});

it.each(["Onda Drum Library", "Shared independent kit"])(
  "keeps a newly published %s purchase attached to its immutable product",
  async (title) => {
    await publish("prod_new", "seller_new", title);
    await publish("prod_other", "seller_other", title);
    const catalog = projectCatalog(await createPublicCatalogRepo(db).list());
    const product = required(findPublicProduct(catalog, "prod_new"));
    expect(product?.title).toBe(title);
    expect(findPublicProduct(catalog, product.slug)).toBeNull();
    expect(checkoutProduct(catalog, "prod_new", "seller_new")?.price.amountMinor).toBe(2500);
    expect(checkoutProduct(catalog, "prod_new", "seller_other")).toBeNull();
    await paidOrder("prod_new", title);
    const order = await orderView();
    expect(order.product.id).toBe("prod_new");
    const cover = resolveCover(order.product);
    expect(cover.title).toBe(title);
    expect(renderToStaticMarkup(createElement(ProductCover, { product: cover }))).not.toContain(
      "cv-onda",
    );
    for (const variant of ["library", "account"] as const) {
      const html = renderToStaticMarkup(createElement(OrderRows, { orders: [order], variant }));
      expect(html).not.toContain("cv-onda");
      const href = html.match(/href="(\/p\/[^"]+)"/)?.[1];
      expect(href).toBe("/p/prod_new");
      expect(findPublicProduct(catalog, decodeURIComponent(required(href).slice(3)))?.id).toBe(
        "prod_new",
      );
    }
  },
);

it("preserves fixture URLs and art while keeping the order's purchased title", () => {
  const fixture = required(allProducts().find((p) => p.slug === "onda-drum-library"));
  const order = required(
    toOrderView({
      id: "order_fixture",
      product: { id: fixture.id, slug: fixture.slug, title: "Purchased title" },
      seller: { id: fixture.sellerId },
      gross: { amountMinor: 2500, currency: "USD" },
    }),
  );
  const html = renderToStaticMarkup(
    createElement(ProductCover, { product: resolveCover(order.product) }),
  );
  expect(html).toContain("cv-onda");
  expect(html).toContain("Purchased title cover:");
  expect(findPublicProduct(fixtureCatalog(), fixture.slug)?.id).toBe(fixture.id);
  const library = renderToStaticMarkup(
    createElement(OrderRows, { orders: [order], variant: "library" }),
  );
  expect(library).toContain(`href="/p/${fixture.id}"`);
  expect(findPublicProduct(fixtureCatalog(), fixture.id)?.id).toBe(fixture.id);
});

it("does not use fixture art for a slug alone or a conflicting seller identity", () => {
  const fixture = required(allProducts()[0]);
  for (const product of [
    { id: null, slug: fixture.slug },
    { id: fixture.id, slug: fixture.slug },
  ]) {
    const order = required(
      toOrderView({
        id: "order_foreign",
        product: { ...product, title: "Own title" },
        seller: { id: "seller_new" },
        gross: { amountMinor: 2500, currency: "USD" },
      }),
    );
    expect(
      renderToStaticMarkup(createElement(ProductCover, { product: resolveCover(order.product) })),
    ).toContain("cv-plain");
  }
  const seller = required(allSellers()[0]);
  expect(
    resolveSeller({
      id: "seller_new",
      name: seller.name,
      handle: seller.handle,
      city: null,
      salePolicy: null,
    }).fixture,
  ).toBeNull();
  const unidentified = required(
    toOrderView({
      id: "order_unknown_seller",
      product: { id: fixture.id, slug: fixture.slug, title: "Own title" },
      gross: { amountMinor: 2500, currency: "USD" },
    }),
  );
  expect(resolveCover(unidentified.product).artworkKey).toBe("");
});
