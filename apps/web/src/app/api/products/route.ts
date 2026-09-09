// POST /api/products: a seller adds one item to their catalog, from
// apps/web/src/components/seller/ProductForm.tsx. The seller owning `sellerId` (or an
// operator) is the only caller allowed to create on their behalf, the same
// authorizeSeller gate apps/web/src/app/api/sellers/[id]/route.ts already uses.
//
// No GET /api/products?seller={id} list route: nothing in the client reads a product list
// today (ProductForm only ever posts), so building one now would be speculative. Flagged as
// a judgment call in the final report.
import { type Currency, money, sellerId as parseSellerId } from "@ledgerly/core";
import type { AuthzDeps } from "../../../lib/authz";
import { authorizeSeller } from "../../../lib/authz";
import { getCommerce } from "../../../lib/commerce";
import { instrumented } from "../../../lib/instrument";
import { getSession } from "../../../lib/session";

export const runtime = "nodejs";

const CURRENCIES = new Set<Currency>(["USD", "EUR", "BRL"]);

type FileMeta = { name: string; size: number; type: string };

type CreateProductBody = {
  sellerId: string;
  title: string;
  subtitle: string;
  category: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  cover: FileMeta | null;
  files: FileMeta[];
};

function parseFileMeta(value: unknown): FileMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name) return null;
  if (typeof raw.size !== "number") return null;
  if (typeof raw.type !== "string") return null;
  return { name: raw.name, size: raw.size, type: raw.type };
}

function parseBody(
  value: unknown,
): { ok: true; value: CreateProductBody } | { ok: false; fields: string[] } {
  if (typeof value !== "object" || value === null) return { ok: false, fields: ["body"] };
  const body = value as Record<string, unknown>;
  const fields: string[] = [];

  const sellerIdValue = body.sellerId ?? body.seller_id;
  if (typeof sellerIdValue !== "string" || !sellerIdValue.trim()) fields.push("sellerId");

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) fields.push("title");

  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!category) fields.push("category");

  const price = typeof body.price === "object" && body.price !== null ? body.price : null;
  const priceBody = price as Record<string, unknown> | null;
  const amountMinor =
    priceBody && typeof priceBody.amountMinor === "number" ? priceBody.amountMinor : undefined;
  if (amountMinor === undefined || amountMinor <= 0) fields.push("price.amountMinor");

  const currencyRaw = priceBody?.currency;
  const currency =
    typeof currencyRaw === "string" && CURRENCIES.has(currencyRaw as Currency)
      ? (currencyRaw as Currency)
      : undefined;
  if (!currency) fields.push("price.currency");

  if (body.files !== undefined && !Array.isArray(body.files)) fields.push("files");
  const files = Array.isArray(body.files)
    ? body.files.map(parseFileMeta).filter((f): f is FileMeta => f !== null)
    : [];
  if (Array.isArray(body.files) && files.length !== body.files.length) fields.push("files");

  if (body.cover !== undefined && body.cover !== null && parseFileMeta(body.cover) === null)
    fields.push("cover");

  if (fields.length > 0) return { ok: false, fields };

  return {
    ok: true,
    value: {
      sellerId: sellerIdValue as string,
      title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle.trim() : "",
      category,
      amountMinor: amountMinor as number,
      currency: currency as Currency,
      description: typeof body.description === "string" ? body.description.trim() : "",
      cover: body.cover ? parseFileMeta(body.cover) : null,
      files,
    },
  };
}

// Kebab-case, ASCII-only, collapsing anything that isn't a letter/digit into one hyphen.
// "" (a title of only punctuation) falls back to "product" so the unique constraint always
// has a real string to work with.
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "product";
}

export type CreateProductDeps = AuthzDeps & {
  getProductBySlug: (sellerId: string, slug: string) => Promise<{ id: string } | null>;
  createProduct: (input: {
    id: string;
    sellerId: string;
    slug: string;
    title: string;
    subtitle: string | null;
    category: string;
    description: string | null;
    priceMinor: number;
    currency: Currency;
    cover: FileMeta | null;
    files: FileMeta[];
  }) => Promise<{ id: string }>;
  newId: () => string;
};

export function createCreateProductHandler(
  deps: CreateProductDeps,
): (request: Request) => Promise<Response> {
  return async function handleCreateProduct(request: Request): Promise<Response> {
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const parsed = parseBody(json);
    if (!parsed.ok)
      return Response.json({ error: "invalid_body", fields: parsed.fields }, { status: 400 });
    const body = parsed.value;

    const parsedSellerId = parseSellerId(body.sellerId);
    if (!parsedSellerId.ok) return Response.json({ error: "seller_not_found" }, { status: 404 });

    const authz = await authorizeSeller(deps, body.sellerId);
    if (!authz.ok) return Response.json({ error: "forbidden" }, { status: authz.status });

    const gross = money(body.amountMinor, body.currency);
    if (!gross.ok) return Response.json({ error: gross.error.kind }, { status: 400 });

    // Slug collisions are expected (two products from the same seller titled alike); append
    // -2, -3, ... on the first free suffix rather than failing the whole publish. Bounded so
    // a pathological loop of identical titles can't hang the request.
    const base = slugify(body.title);
    let slug = base;
    for (let attempt = 1; attempt <= 50; attempt++) {
      const existing = await deps.getProductBySlug(body.sellerId, slug);
      if (!existing) break;
      slug = `${base}-${attempt + 1}`;
    }

    const product = await deps.createProduct({
      id: deps.newId(),
      sellerId: body.sellerId,
      slug,
      title: body.title,
      subtitle: body.subtitle || null,
      category: body.category,
      description: body.description || null,
      priceMinor: body.amountMinor,
      currency: body.currency,
      cover: body.cover,
      files: body.files,
    });

    return Response.json({ id: product.id }, { status: 201 });
  };
}

export const POST = instrumented(
  createCreateProductHandler({
    getSession,
    getSellerOwner: (sellerId) => getCommerce().users.getSellerOwner(sellerId),
    getProductBySlug: (sellerId, slug) => getCommerce().products.getBySlug(sellerId, slug),
    createProduct: (input) => getCommerce().products.create(input),
    newId: () => `prod_${crypto.randomUUID()}`,
  }),
);
