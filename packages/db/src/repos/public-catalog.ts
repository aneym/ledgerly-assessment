import { eq, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { products, sellers } from "../schema";
import type { Database } from "./orders";

/** Inserts publish listings. No draft state exists. Only these public fields may escape. */
export function createPublicCatalogRepo<T extends PgQueryResultHKT>(db: Database<T>) {
  return {
    async list(sellerId?: string) {
      return db
        .select({
          id: products.id,
          sellerId: products.sellerId,
          slug: products.slug,
          title: products.title,
          subtitle: products.subtitle,
          category: products.category,
          description: products.description,
          priceMinor: products.priceMinor,
          currency: products.currency,
          createdAt: products.createdAt,
          sellerName: sellers.displayName,
          country: sellers.country,
          salePolicy: sellers.salePolicy,
          sellerStatus: sellers.status,
          accountReady: sql<boolean>`${sellers.whopAccountId} is not null`,
        })
        .from(products)
        .innerJoin(sellers, eq(products.sellerId, sellers.id))
        .where(sellerId ? eq(sellers.id, sellerId) : eq(sellers.status, "active"));
    },
  };
}
export type PublicCatalogRow = Awaited<
  ReturnType<ReturnType<typeof createPublicCatalogRepo>["list"]>
>[number];
