import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { seedDemo } from "../scripts/seed-demo";
import { createTestDb } from "../src/client";
import { createProductsRepo } from "../src/repos/products";
import { account, products, sellerOwners, sellers, user } from "../src/schema";

it("applies migrations and seeds all seven sellers and eight products twice without duplicates", async () => {
  const db = await createTestDb();
  try {
    // Reapplying the new SQL must also be safe independently of the migration journal.
    const migration = await readFile(
      new URL("../drizzle/0007_demo_seller_countries.sql", import.meta.url),
      "utf8",
    );
    await db.$client.exec(migration);
    await seedDemo(db);

    const expectedSellers = [
      {
        id: "sel_acme",
        country: "PT",
        whopAccountId: "biz_demo_acme",
        salePolicy: "platform_only",
      },
      {
        id: "sel_form",
        country: "CA",
        whopAccountId: "biz_demo_form",
        salePolicy: "platform_only",
      },
      { id: "sel_juno", country: "CA", whopAccountId: "biz_demo_juno", salePolicy: "direct" },
      {
        id: "sel_kontur",
        country: "DE",
        whopAccountId: "biz_demo_kontur",
        salePolicy: "direct",
      },
      { id: "sel_mara", country: "US", whopAccountId: "biz_demo_mara", salePolicy: "direct" },
      {
        id: "sel_onda",
        country: "BR",
        whopAccountId: "biz_demo_onda",
        salePolicy: "platform_only",
      },
      {
        id: "sel_pixelfern",
        country: "KR",
        whopAccountId: "biz_demo_pixelfern",
        salePolicy: "direct",
      },
    ];
    const readSellers = () =>
      db
        .select({
          id: sellers.id,
          country: sellers.country,
          whopAccountId: sellers.whopAccountId,
          salePolicy: sellers.salePolicy,
        })
        .from(sellers)
        .orderBy(sellers.id);
    expect(await readSellers()).toEqual(expectedSellers);
    const firstProducts = await db.select().from(products).orderBy(products.id);
    expect(firstProducts).toHaveLength(8);
    const identities = await db
      .select({ id: user.id, role: user.role, email: user.email })
      .from(user)
      .orderBy(user.id);
    expect(identities.map((identity) => identity.role).sort()).toEqual([
      "buyer",
      "operator",
      "seller",
    ]);
    const credentials = await db
      .select({ id: account.id, userId: account.userId, providerId: account.providerId })
      .from(account)
      .orderBy(account.id);
    expect(credentials).toHaveLength(3);
    expect(credentials.every((row) => row.providerId === "credential")).toBe(true);
    const owners = await db
      .select({ sellerId: sellerOwners.sellerId, userId: sellerOwners.userId })
      .from(sellerOwners);
    expect(owners).toEqual([
      {
        sellerId: "sel_onda",
        userId: identities.find((identity) => identity.role === "seller")?.id,
      },
    ]);

    // Existing composite keys win over fixture IDs, and reruns restore catalog prices.
    await db
      .update(products)
      .set({ id: "existing-grain", priceMinor: 1, currency: "EUR" })
      .where(eq(products.id, "prd_grain"));
    await db
      .update(sellers)
      .set({ whopAccountId: null, salePolicy: "platform_only" })
      .where(eq(sellers.id, "sel_mara"));
    await seedDemo(db);

    expect(await readSellers()).toEqual(expectedSellers);
    expect(
      (await db.select({ runId: sellers.runId }).from(sellers)).every(
        (row) => row.runId === "demo",
      ),
    ).toBe(true);
    const secondProducts = await db.select().from(products).orderBy(products.id);
    expect(secondProducts).toHaveLength(8);
    expect(new Set(secondProducts.map((row) => `${row.sellerId}/${row.slug}`)).size).toBe(8);
    const repo = createProductsRepo(db);
    for (const [sellerId, slug, priceMinor] of [
      ["sel_mara", "grain-and-gradient", 2500],
      ["sel_kontur", "kontur-type-specimen-kit", 8900],
      ["sel_onda", "onda-drum-library", 6000],
      ["sel_form", "ledger-layouts-for-framer", 14900],
      ["sel_form", "the-quiet-workbook", 4000],
      ["sel_pixelfern", "lowpoly-botanicals", 3500],
      ["sel_acme", "notion-os-for-studios", 2900],
      ["sel_onda", "streetlight-sessions", 1200],
    ] as const) {
      expect(await repo.getBySlug(sellerId, slug)).toMatchObject({
        sellerId,
        slug,
        priceMinor,
        currency: "USD",
      });
    }
    expect((await repo.getBySlug("sel_mara", "grain-and-gradient"))?.id).toBe("existing-grain");
    expect(
      await db
        .select({ id: user.id, role: user.role, email: user.email })
        .from(user)
        .orderBy(user.id),
    ).toEqual(identities);
    expect(
      await db
        .select({ id: account.id, userId: account.userId, providerId: account.providerId })
        .from(account)
        .orderBy(account.id),
    ).toEqual(credentials);
    expect(
      await db
        .select({ sellerId: sellerOwners.sellerId, userId: sellerOwners.userId })
        .from(sellerOwners),
    ).toEqual(owners);
  } finally {
    await db.$client.close();
  }
}, 30000);
