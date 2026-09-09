import type { Currency } from "@ledgerly/core";
import { and, eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { products } from "../schema";
import type { Database } from "./orders";

export type ProductFile = { name: string; size: number; type: string };

export type Product = {
  id: string;
  sellerId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category: string;
  description: string | null;
  priceMinor: number;
  currency: Currency;
  cover: ProductFile | null;
  files: ProductFile[];
  createdAt: Date;
};

export type NewProduct = {
  id: string;
  sellerId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category: string;
  description: string | null;
  priceMinor: number;
  currency: Currency;
  cover: ProductFile | null;
  files: ProductFile[];
};

export interface ProductsRepo {
  create(input: NewProduct): Promise<Product>;
  get(id: string): Promise<Product | null>;
  // Keyed by (sellerId, slug), not slug alone: two sellers may each title a product the
  // same thing, and POST /api/checkouts's LookupProduct only ever knows a slug in the
  // context of the seller_id the checkout body already carries.
  getBySlug(sellerId: string, slug: string): Promise<Product | null>;
}

function toProduct(row: typeof products.$inferSelect): Product {
  return {
    id: row.id,
    sellerId: row.sellerId,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    category: row.category,
    description: row.description,
    priceMinor: row.priceMinor,
    currency: row.currency,
    cover: row.coverName
      ? { name: row.coverName, size: row.coverSize ?? 0, type: row.coverType ?? "" }
      : null,
    files: (row.files as ProductFile[] | null) ?? [],
    createdAt: row.createdAt,
  };
}

export function createProductsRepo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
): ProductsRepo {
  return {
    async create(input) {
      const rows = await db
        .insert(products)
        .values({
          id: input.id,
          sellerId: input.sellerId,
          slug: input.slug,
          title: input.title,
          subtitle: input.subtitle,
          category: input.category,
          description: input.description,
          priceMinor: input.priceMinor,
          currency: input.currency,
          coverName: input.cover?.name ?? null,
          coverSize: input.cover?.size ?? null,
          coverType: input.cover?.type ?? null,
          files: input.files,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Product missing after insert");
      return toProduct(row);
    },
    async get(id) {
      const rows = await db.select().from(products).where(eq(products.id, id));
      return rows[0] ? toProduct(rows[0]) : null;
    },
    async getBySlug(sellerId, slug) {
      const rows = await db
        .select()
        .from(products)
        .where(and(eq(products.sellerId, sellerId), eq(products.slug, slug)));
      return rows[0] ? toProduct(rows[0]) : null;
    },
  };
}
