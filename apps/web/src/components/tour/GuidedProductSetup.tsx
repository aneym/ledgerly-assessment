"use client";

import { useRef, useState } from "react";
import { callApi, hasStringKey } from "@/lib/seller/api";

/** Explicit fixture preparation through the same authenticated product route as ProductForm. */
export function GuidedProductSetup({
  sellerId,
  correlationId,
}: {
  sellerId: string;
  correlationId: string | null;
}) {
  const pending = useRef(false);
  const [state, setState] = useState<"ready" | "saving" | "saved" | "failed">("ready");
  const [productId, setProductId] = useState<string | null>(null);
  async function publish() {
    if (pending.current || productId) return;
    pending.current = true;
    setState("saving");
    const result = await callApi<{ id: string }>("/api/products", {
      method: "POST",
      correlationId,
      expect: hasStringKey("id"),
      body: {
        sellerId,
        title: "Guided demo sample",
        subtitle: "A sample catalog item for this seller",
        category: "Audio",
        price: { amountMinor: 2500, currency: "USD" },
        description:
          "A fictional sample used to demonstrate checkout and seller earnings. No downloadable file is attached.",
        cover: null,
        files: [],
      },
    });
    pending.current = false;
    if (result.ok) {
      setProductId(result.data.id);
      setState("saved");
    } else setState("failed");
  }
  return (
    <section className="sl-paper p-6 mb-6" aria-label="Guided sample product">
      <h2 className="font-serif text-xl">Publish a sample product</h2>
      <p>
        This creates a $25 fictional catalog item owned by your current seller. No downloadable file
        is attached.
      </p>
      <button
        type="button"
        className="pill ink mt-3"
        data-tour="sell.product.demo"
        disabled={state === "saving" || state === "saved"}
        onClick={() => void publish()}
      >
        {state === "saving"
          ? "Publishing sample"
          : state === "saved"
            ? "Sample published"
            : "Publish sample product"}
      </button>
      {productId && (
        <p>
          <a href={`/p/${encodeURIComponent(productId)}`}>Open the published sample</a>
        </p>
      )}
      {state === "failed" && (
        <p role="alert">The product could not be created. The tour remains on this step.</p>
      )}
    </section>
  );
}
