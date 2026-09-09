import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { PlusIcon } from "@/components/icons";
import { Ledger, LedgerLine } from "@/components/ledger-line";
import { PillButton } from "@/components/pill";
import { ProductCard } from "@/components/product-card";
import { Shell } from "@/components/shell";
import { policyLabel, policySentence } from "@/lib/catalog/load";
import { readPublicCatalog } from "@/lib/catalog/public";
import { findPublicSeller } from "@/lib/catalog/published";
import type { Seller } from "@/lib/catalog/types";

export async function generateMetadata({ params }: PageProps<"/c/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  const catalog = await readPublicCatalog();
  const seller = findPublicSeller(catalog, handle);
  return { title: seller ? `${seller.name} on Ledgerly` : "Ledgerly" };
}

function terms(seller: Seller): Array<{ label: string; value: string }> {
  switch (seller.salePolicy) {
    case "direct_charge":
      return [
        { label: "Charged by", value: `${seller.name}, via Whop` },
        { label: "Refunds", value: `${seller.shortName}, within 14 days` },
        { label: "Ledgerly fee", value: "8% of each sale" },
        { label: "Delivery", value: "See product details" },
      ];
    case "platform_charge_transfer":
      return [
        { label: "Charged by", value: "Ledgerly, via Whop" },
        { label: "Seller share", value: `To ${seller.shortName} after settlement` },
        { label: "Refunds", value: "Ledgerly, within 14 days" },
        { label: "Ledgerly fee", value: "8% of each sale" },
        { label: "Delivery", value: "See product details" },
      ];
    case "blocked_onboarding_incomplete":
      return [
        { label: "Status", value: "Whop onboarding incomplete" },
        { label: "Buying", value: "Closed until onboarding is done" },
        { label: "Ledgerly fee", value: "8% of each sale" },
      ];
  }
}

export default async function CreatorPage({ params }: PageProps<"/c/[handle]">) {
  const { handle } = await params;
  const catalog = await readPublicCatalog();
  const seller = findPublicSeller(catalog, handle);
  if (!seller) notFound();
  const products = catalog.products.filter((p) => p.sellerId === seller.id);
  const count =
    products.length === 0
      ? "No products yet"
      : `${products.length} ${products.length === 1 ? "product" : "products"}`;
  const chipTone =
    seller.salePolicy === "blocked_onboarding_incomplete" ? "chip warn" : "chip line";

  return (
    <Shell screen="creator" section="creators">
      <section className="prof-head">
        <div className="wrap">
          <Avatar src={seller.avatar} alt={seller.name} size="xl" data-tour="creator.avatar" />
          <div>
            <h1>{seller.name}</h1>
            <p className="bio" data-tour="creator.bio">
              {seller.bio}
            </p>
            <div className="meta">
              <span>
                {seller.city}, {seller.countryName}
              </span>
              <i className="dot" aria-hidden="true" />
              <span>{count}</span>
              <i className="dot" aria-hidden="true" />
              <span>{seller.kind === "studio" ? "Studio" : "Independent"}</span>
            </div>
            <p className="policy" data-tour="creator.policy">
              <span className={chipTone}>{policyLabel(seller)}</span>
              <span>{policySentence(seller)}</span>
            </p>
          </div>
          <div className="act">
            <PillButton tone="ghost" aria-pressed="false" data-tour="creator.follow">
              <PlusIcon />
              Follow
            </PillButton>
          </div>
        </div>
      </section>

      <div className="wrap prof-body">
        <div>
          <h2>Products</h2>
          {products.length === 0 ? (
            <p className="empty-state" data-tour="creator.products">
              {seller.shortName} has not listed anything yet.
            </p>
          ) : (
            <div className="pgrid tight" data-tour="creator.products">
              {products.map((p) => (
                <ProductCard key={p.id} product={p} seller={seller} />
              ))}
            </div>
          )}
        </div>
        <div className="about">
          <h2>Terms</h2>
          <p>
            {seller.kind === "studio" ? "The studio" : seller.shortName} sets the price. Ledgerly
            keeps 8% of each sale and prints the split on every product.
          </p>
          <Ledger>
            {terms(seller).map((t) => (
              <LedgerLine key={t.label} label={t.label} value={t.value} wrap />
            ))}
          </Ledger>
        </div>
      </div>
    </Shell>
  );
}
