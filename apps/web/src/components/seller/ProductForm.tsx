"use client";

import { fromDecimalString, type Money } from "@ledgerly/core/money";
import { type ChangeEvent, type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { LedgerLine } from "@/components/ledger-line";
import { PillButton } from "@/components/pill";
import { formatMoney } from "@/lib/catalog/money";
import { CATEGORIES, type Category } from "@/lib/catalog/types";
import { type ApiFail, callApi, hasStringKey } from "@/lib/seller/api";
import { splitGross } from "@/lib/seller/ledger";
import { NotLive } from "./ApiState";

type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; fail: ApiFail };

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProductForm({
  sellerId,
  sellerName,
  sellerCity,
  sellerAvatar,
  correlationId,
}: {
  sellerId: string;
  sellerName: string;
  sellerCity: string | null;
  sellerAvatar: string | null;
  correlationId: string | null;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [category, setCategory] = useState<Category>("Audio");
  const [priceText, setPriceText] = useState("25.00");
  const [cover, setCover] = useState<File | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (!cover) {
      setCoverUrl(null);
      return;
    }
    const url = URL.createObjectURL(cover);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  const price: Money | null = useMemo(() => {
    const parsed = fromDecimalString(priceText.trim(), "USD");
    return parsed.ok && parsed.value.amountMinor > 0 ? parsed.value : null;
  }, [priceText]);
  const split = price ? splitGross(price) : null;

  const titleOk = title.trim().length >= 2;
  const priceOk = price !== null && price.amountMinor >= 100;
  const filesOk = files.length > 0;
  const valid = titleOk && priceOk && filesOk;

  function onCover(event: ChangeEvent<HTMLInputElement>) {
    setCover(event.target.files?.[0] ?? null);
  }
  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (!valid || !price || phase.kind === "sending") return;
    setPhase({ kind: "sending" });
    // Published only when the route answers a product id.
    const result = await callApi<{ id: string }>("/api/products", {
      method: "POST",
      correlationId,
      expect: hasStringKey("id", "product_id", "productId"),
      body: {
        sellerId,
        title: title.trim(),
        subtitle: subtitle.trim(),
        category,
        price: { amountMinor: price.amountMinor, currency: price.currency },
        description: description.trim(),
        cover: cover ? { name: cover.name, size: cover.size, type: cover.type } : null,
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      },
    });
    setPhase(result.ok ? { kind: "idle" } : { kind: "failed", fail: result });
  }

  const previewTitle = title.trim() || "Untitled product";
  const previewSub = subtitle.trim() || "One line about what is inside";

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="sl-grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_320px] md:items-start md:gap-12"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-title`} className="text-[13px] font-medium text-ink">
            Title
          </label>
          <input
            id={`${id}-title`}
            className="sl-field font-serif text-[18px]"
            style={{ fontVariationSettings: "'opsz' 20" }}
            placeholder="Onda Drum Library"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-tour="sell.product.title"
            aria-invalid={touched && !titleOk ? "true" : undefined}
            aria-describedby={`${id}-title-help`}
          />
          <p
            id={`${id}-title-help`}
            className={`text-[12.5px] ${touched && !titleOk ? "text-bad" : "text-muted"}`}
          >
            {touched && !titleOk ? "Give the product a title." : "Shown on the card in Fraunces."}
          </p>
        </div>

        <div className="sl-grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-sub`} className="text-[13px] font-medium text-ink">
              Subtitle
            </label>
            <input
              id={`${id}-sub`}
              className="sl-field"
              placeholder="600 one-shots and loops"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-cat`} className="text-[13px] font-medium text-ink">
              Category
            </label>
            <select
              id={`${id}-cat`}
              className="sl-field"
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-price`} className="text-[13px] font-medium text-ink">
            Price
          </label>
          <div className="sl-grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr] sm:items-start">
            <div className="sl-field-prefix">
              <span aria-hidden="true">$</span>
              <input
                id={`${id}-price`}
                className="sl-field tabular-nums"
                inputMode="decimal"
                placeholder="25.00"
                value={priceText}
                onChange={(e) => setPriceText(e.target.value)}
                data-tour="sell.product.price"
                aria-invalid={touched && !priceOk ? "true" : undefined}
                aria-describedby={`${id}-price-help`}
              />
            </div>
            <div className="text-[12.5px] leading-relaxed text-muted">
              {split && price ? (
                <span className="tabular-nums">
                  Ledgerly fee 8% {formatMoney(split.fee)}. You keep {formatMoney(split.net)} before
                  processing fees.
                </span>
              ) : (
                <span id={`${id}-price-help`} className={touched ? "text-bad" : ""}>
                  US dollars, at least $1.00, two decimals. Stored as whole cents.
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="sl-grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-ink">Cover</span>
            <label className="sl-slot" data-tour="sell.product.cover">
              <input type="file" accept="image/*" onChange={onCover} />
              {cover ? (
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-ink">{cover.name}</span>
                  <span className="font-mono text-[11px]">
                    {fileSize(cover.size)}. Click to replace.
                  </span>
                </span>
              ) : (
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-ink">Choose a cover image</span>
                  <span className="font-mono text-[11px]">4:5 works best. PNG or JPG.</span>
                </span>
              )}
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-ink">Files</span>
            <label
              className="sl-slot"
              data-tour="sell.product.files"
              aria-invalid={touched && !filesOk ? "true" : undefined}
            >
              <input type="file" multiple onChange={onFiles} />
              {files.length > 0 ? (
                <span className="flex w-full flex-col gap-1 text-left">
                  {files.slice(0, 4).map((f) => (
                    <span key={`${f.name}-${f.size}`} className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">{f.name}</span>
                      <span className="font-mono text-[11px]">{fileSize(f.size)}</span>
                    </span>
                  ))}
                  {files.length > 4 ? (
                    <span className="font-mono text-[11px]">and {files.length - 4} more</span>
                  ) : null}
                </span>
              ) : (
                <span className="flex flex-col gap-1">
                  <span className={`font-medium ${touched && !filesOk ? "text-bad" : "text-ink"}`}>
                    Add the files buyers download
                  </span>
                  <span className="font-mono text-[11px]">
                    ZIP, WAV, PDF, anything. Up to 2 GB.
                  </span>
                </span>
              )}
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-desc`} className="text-[13px] font-medium text-ink">
            Description
          </label>
          <textarea
            id={`${id}-desc`}
            className="sl-field"
            placeholder="What is inside, who it is for, what format the files come in."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-4 border-t border-line pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <PillButton
              type="submit"
              tone="buy"
              size="lg"
              data-tour="sell.product.publish"
              disabled={phase.kind === "sending"}
              aria-busy={phase.kind === "sending" ? "true" : undefined}
            >
              {phase.kind === "sending" ? "Publishing" : "Publish"}
            </PillButton>
            <span className="text-[12.5px] text-muted">
              Listed at {price ? formatMoney(price) : "the price above"} once the products API
              accepts it.
            </span>
          </div>
          {phase.kind === "failed" ? (
            <NotLive fail={phase.fail}>Your entries stay on this page.</NotLive>
          ) : null}
        </div>
      </div>

      <aside className="md:sticky md:top-12" aria-label="Live preview">
        <p className="mb-3 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
          Preview
        </p>
        <article className="card raised">
          <div className="plate">
            <div className={`cover ${coverUrl ? "" : "light"}`} aria-hidden="true">
              {coverUrl ? (
                // biome-ignore lint/performance/noImgElement: local object URL preview
                <img src={coverUrl} alt="" className="absolute inset-0 size-full object-cover" />
              ) : (
                <span
                  className="absolute inset-0 sl-grid place-items-center font-serif text-[36cqw] leading-none text-ink/20"
                  style={{ fontVariationSettings: "'opsz' 144" }}
                >
                  {previewTitle.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <div className="card-body">
            <h3 className="card-title">{previewTitle}</h3>
            <p className="card-sub">{previewSub}</p>
            <div className="byline">
              {sellerAvatar ? (
                <Avatar src={sellerAvatar} alt="" size="xs" />
              ) : (
                <span className="av xs" aria-hidden="true" />
              )}
              <span className="who">{sellerName}</span>
              {sellerCity ? <span className="loc">{sellerCity}</span> : null}
            </div>
            <LedgerLine label={category} value={price ? formatMoney(price) : "$0.00"} />
          </div>
        </article>
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
          This is the card buyers see on the store. Nothing is saved until Publish succeeds.
        </p>
      </aside>
    </form>
  );
}
