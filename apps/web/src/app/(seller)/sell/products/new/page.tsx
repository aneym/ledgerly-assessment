import type { Metadata } from "next";
import { PageHead } from "@/components/seller/PageHead";
import { ProductForm } from "@/components/seller/ProductForm";
import { GuidedProductSetup } from "@/components/tour/GuidedProductSetup";
import { correlationParam, currentSeller, type SearchParams } from "@/lib/seller/current";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage({ searchParams }: { searchParams: SearchParams }) {
  const [seller, correlationId, params] = await Promise.all([
    currentSeller(searchParams),
    correlationParam(searchParams),
    searchParams,
  ]);

  return (
    <div data-screen="sell.product.new">
      <PageHead
        title="New product"
        sub="One page. Title, price, cover, files and a description. The preview on the right is the card buyers see."
      />
      {process.env.DEMO_MODE === "1" && params.tour === "C02" && (
        <GuidedProductSetup sellerId={seller.id} correlationId={correlationId} />
      )}
      <ProductForm
        sellerId={seller.id}
        sellerName={seller.name}
        sellerCity={seller.city}
        sellerAvatar={seller.avatar}
        correlationId={correlationId}
      />
    </div>
  );
}
