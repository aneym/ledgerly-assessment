// Seed all demo sellers, catalog products, and the existing three auth identities.
// Apply Drizzle migrations first. Reruns update fixture rows without truncation.
// No Whop calls are made; sandbox account IDs come from sellers.json.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { account, country, createDb, createUsersRepo, products, sellers, user } from "../src";
import type { Database } from "../src/repos/orders";
import { createProductsRepo, type NewProduct } from "../src/repos/products";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

type FixtureSeller = {
  id: string;
  name: string;
  handle: string;
  country: string;
  sale_policy: string;
  sandbox: { account_id: string | null };
};

type FixtureSellersFile = { sellers: FixtureSeller[] };

type FixtureTestUsers = {
  buyer: { name: string; email: string; password: string };
  seller: { name: string; email: string; password: string; country: string };
  operator: { name: string; email: string; password: string };
  sellerForms: Record<string, { name: string; email: string; country: string }>;
};

// The fixture's UI-facing sale_policy labels, mapped onto the db's narrower enum
// (packages/db/src/schema.ts's `sale_policy` pgEnum: "direct" | "platform_only").
const SALE_POLICY_MAP: Record<string, "direct" | "platform_only"> = {
  direct_charge: "direct",
  platform_charge_transfer: "platform_only",
  blocked_onboarding_incomplete: "platform_only",
};

async function loadFixture<T>(relativePath: string): Promise<T> {
  const url = new URL(`../../../${relativePath}`, import.meta.url);
  const raw = await readFile(url, "utf8");
  return JSON.parse(raw) as T;
}

async function seedSellers<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  runId: string,
  fixture: FixtureSellersFile,
  testUsers: FixtureTestUsers,
) {
  const seeded: string[] = [];
  for (const source of fixture.sellers) {
    const sellerCountry = country.enumValues.find((value) => value === source.country);
    if (!sellerCountry) throw new Error(`Unsupported country for ${source.id}`);
    const email =
      testUsers.sellerForms[source.country]?.email ?? `${source.handle}@example.invalid`;
    const accountId = source.sandbox.account_id;
    if (!accountId) throw new Error(`No sandbox account id mapped for ${source.id}`);
    const salePolicy = SALE_POLICY_MAP[source.sale_policy];
    if (!salePolicy)
      throw new Error(`Unmapped sale_policy "${source.sale_policy}" for ${source.id}`);

    await db
      .insert(sellers)
      .values({
        id: source.id,
        runId,
        externalId: source.handle,
        email,
        country: sellerCountry,
        whopAccountId: accountId,
        salePolicy,
        status: "active",
        displayName: source.name,
      })
      .onConflictDoUpdate({
        target: sellers.id,
        set: {
          externalId: source.handle,
          email,
          country: sellerCountry,
          whopAccountId: accountId,
          salePolicy,
          displayName: source.name,
        },
      });
    seeded.push(`${source.id} (${sellerCountry})`);
  }
  return seeded;
}

// Upserts one Better Auth identity (user + credential account row) by email, bypassing the
// HTTP sign-up flow entirely so the seed script needs no running server. Mirrors exactly
// what better-auth's own email/password sign-up does under the hood (see
// node_modules/better-auth/dist/api/routes/sign-up.mjs): a `user` row, plus an `account` row
// with providerId "credential" and accountId equal to the user's own id, holding the hashed
// password. Returns the user id so callers can attach a seller_owners row.
async function upsertAuthUser<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  input: { name: string; email: string; password: string; role: "buyer" | "seller" | "operator" },
): Promise<string> {
  const existing = await db.select().from(user).where(eq(user.email, input.email));
  const passwordHash = await hashPassword(input.password);
  const userId = existing[0]?.id ?? randomUUID();

  if (existing[0]) {
    await db
      .update(user)
      .set({ name: input.name, role: input.role, emailVerified: true })
      .where(eq(user.id, userId));
  } else {
    await db.insert(user).values({
      id: userId,
      name: input.name,
      email: input.email,
      emailVerified: true,
      role: input.role,
    });
  }

  const existingAccount = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")));
  if (existingAccount[0]) {
    await db
      .update(account)
      .set({ password: passwordHash })
      .where(eq(account.id, existingAccount[0].id));
  } else {
    await db.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    });
  }

  return userId;
}

type FixtureCatalog = {
  products: {
    id: string;
    seller_id: string;
    slug: string;
    title: string;
    subtitle: string;
    category: string;
    description: string[];
    price: { amount_minor: number; currency: NewProduct["currency"] };
  }[];
};

async function seedProducts<TQueryResult extends PgQueryResultHKT>(db: Database<TQueryResult>) {
  const catalog = await loadFixture<FixtureCatalog>("fixtures/demo/catalog.json");
  const repo = createProductsRepo(db);
  for (const source of catalog.products) {
    const values = {
      title: source.title,
      subtitle: source.subtitle,
      category: source.category,
      description: source.description.join("\n\n"),
      priceMinor: source.price.amount_minor,
      currency: source.price.currency,
    };
    const existing = await repo.getBySlug(source.seller_id, source.slug);
    if (existing) {
      await db
        .update(products)
        .set(values)
        .where(and(eq(products.sellerId, source.seller_id), eq(products.slug, source.slug)));
    } else {
      await repo.create({
        id: source.id,
        sellerId: source.seller_id,
        slug: source.slug,
        ...values,
        cover: null,
        files: [],
      });
    }
  }
  console.log(`products: ${catalog.products.length}`);
}

export async function seedDemo<TQueryResult extends PgQueryResultHKT>(
  db: Database<TQueryResult>,
  runId = "demo",
) {
  const users = createUsersRepo(db);

  const sellersFixture = await loadFixture<FixtureSellersFile>("fixtures/demo/sellers.json");
  const testUsers = await loadFixture<FixtureTestUsers>("fixtures/demo/test-users.json");

  const seededSellers = await seedSellers(db, runId, sellersFixture, testUsers);
  console.log(`sellers: ${seededSellers.join(", ")}`);

  const buyerId = await upsertAuthUser(db, { ...testUsers.buyer, role: "buyer" });
  console.log(`buyer: ${testUsers.buyer.email} (${buyerId})`);

  const operatorId = await upsertAuthUser(db, { ...testUsers.operator, role: "operator" });
  await users.setRole(operatorId, "operator");
  console.log(`operator: ${testUsers.operator.email} (${operatorId})`);

  const sellerUserId = await upsertAuthUser(db, { ...testUsers.seller, role: "seller" });
  await users.setRole(sellerUserId, "seller");
  const onda = sellersFixture.sellers.find((row) => row.country === testUsers.seller.country);
  if (!onda) throw new Error(`No fixtures/demo/sellers.json entry for ${testUsers.seller.country}`);
  await users.attachSellerOwner(onda.id, sellerUserId);
  console.log(`seller: ${testUsers.seller.email} (${sellerUserId}) owns ${onda.id}`);

  await seedProducts(db);
  console.log("seed:demo complete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createDb(required(process.env, "DATABASE_URL"));
  await seedDemo(db, process.env.RUN_ID ?? "demo");
}
