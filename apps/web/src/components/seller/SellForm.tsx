"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { PillButton } from "@/components/pill";
import { type ApiFail, type SellerCountry, sellerApi, sellerExternalId } from "@/lib/seller/api";
import { NotLive } from "./ApiState";

/** POST /api/sellers accepts the six catalog countries. */
const COUNTRIES: Array<{ code: SellerCountry; name: string }> = [
  { code: "US", name: "United States" },
  { code: "DE", name: "Germany" },
  { code: "BR", name: "Brazil" },
  { code: "CA", name: "Canada" },
  { code: "KR", name: "South Korea" },
  { code: "PT", name: "Portugal" },
];

type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; fail: ApiFail };

export function SellForm({ correlationId }: { correlationId: string | null }) {
  const router = useRouter();
  const id = useId();
  const [country, setCountry] = useState<SellerCountry>("US");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [mounted, setMounted] = useState(false);

  // Keep native controls disabled until React has attached the form handlers.
  useEffect(() => setMounted(true), []);

  // Fields the route named in `{ error: "invalid_body", fields: [...] }`. The form's name
  // becomes the request's title and external id, so either name flags the name field.
  const rejected = phase.kind === "failed" ? (phase.fail.fields ?? []) : [];
  const rejectedName = rejected.includes("title") || rejected.includes("externalId");
  const rejectedEmail = rejected.includes("email");
  const rejectedCountry = rejected.includes("country");

  const nameOk = name.trim().length >= 2 && !rejectedName;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && !rejectedEmail;
  const valid = nameOk && emailOk;

  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      // A rejected field stops being marked once it is edited.
      if (phase.kind === "failed" && phase.fail.fields) setPhase({ kind: "idle" });
    };
  }
  const setCountryEdited = edit(setCountry);
  const setNameEdited = edit(setName);
  const setEmailEdited = edit(setEmail);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (!mounted || !valid || phase.kind === "sending") return;
    setPhase({ kind: "sending" });
    // The route keys create-or-fetch on externalId, so it is derived from the name and the
    // email: the same person resubmitting gets their seller back, not a second one.
    const result = await sellerApi.create(
      {
        externalId: sellerExternalId(name.trim(), email.trim()),
        email: email.trim(),
        country,
        title: name.trim(),
      },
      correlationId,
    );
    if (!result.ok) {
      setPhase({ kind: "failed", fail: result });
      return;
    }
    // Contract shape is the seller at the top level; the pre-contract route nested it.
    const sellerId = result.data.id ?? result.data.seller?.id;
    if (!sellerId) {
      setPhase({
        kind: "failed",
        fail: {
          ok: false,
          kind: "unexpected",
          status: result.status,
          path: "/api/sellers",
          method: "POST",
          correlationId: result.correlationId,
          reason: "unexpected response: no seller id",
        },
      });
      return;
    }
    router.push(`/sell/onboarding?seller=${encodeURIComponent(sellerId)}`);
  }

  return (
    <form method="post" onSubmit={onSubmit} noValidate>
      <fieldset
        disabled={!mounted || phase.kind === "sending"}
        className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
      >
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-country`} className="text-[13px] font-medium text-ink">
            Country
          </label>
          <select
            id={`${id}-country`}
            name="country"
            className="sl-field"
            value={country}
            onChange={(e) => setCountryEdited(e.target.value as SellerCountry)}
            aria-invalid={rejectedCountry ? "true" : undefined}
            data-tour="sell.start.country"
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <p
            className={`text-[12.5px] leading-snug ${rejectedCountry ? "text-bad" : "text-muted"}`}
          >
            {rejectedCountry
              ? "The app API rejected this country."
              : "Where you pay tax. Whop verifies identity for this country during onboarding."}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-name`} className="text-[13px] font-medium text-ink">
            Display name
          </label>
          <input
            id={`${id}-name`}
            name="name"
            data-tour="sell.start.name"
            type="text"
            autoComplete="organization"
            className="sl-field"
            placeholder="Your name or studio"
            value={name}
            onChange={(e) => setNameEdited(e.target.value)}
            aria-invalid={touched && !nameOk ? "true" : undefined}
            aria-describedby={`${id}-name-help`}
          />
          <p
            id={`${id}-name-help`}
            className={`text-[12.5px] leading-snug ${touched && !nameOk ? "text-bad" : "text-muted"}`}
          >
            {rejectedName
              ? "The app API rejected this name."
              : touched && !nameOk
                ? "Enter the name buyers will see, at least two characters."
                : "Shown on your products and receipts."}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-email`} className="text-[13px] font-medium text-ink">
            Email
          </label>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            data-tour="sell.start.email"
            autoComplete="email"
            className="sl-field"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmailEdited(e.target.value)}
            aria-invalid={touched && !emailOk ? "true" : undefined}
            aria-describedby={`${id}-email-help`}
          />
          <p
            id={`${id}-email-help`}
            className={`text-[12.5px] leading-snug ${touched && !emailOk ? "text-bad" : "text-muted"}`}
          >
            {rejectedEmail
              ? "The app API rejected this email address."
              : touched && !emailOk
                ? "Enter a valid email address."
                : "Whop sends onboarding and payout notices here."}
          </p>
        </div>

        <div className="mt-1 flex flex-col gap-3">
          <PillButton
            type="submit"
            tone="buy"
            size="lg"
            wide
            data-tour="sell.start.submit"
            aria-busy={phase.kind === "sending" ? "true" : undefined}
            disabled={!mounted || phase.kind === "sending"}
          >
            {phase.kind === "sending" ? "Creating your seller account" : "Create seller account"}
          </PillButton>
          <p className="text-center text-[12.5px] leading-snug text-muted">
            Next: verify identity and bank details on Whop. Nothing is charged.
          </p>
        </div>

        {phase.kind === "failed" ? (
          <NotLive fail={phase.fail}>
            {phase.fail.reason === "http" || phase.fail.reason === "network"
              ? "The app API could not create the Whop sandbox account; the sandbox status is in the server log, not in this response. Retry with a new display name or email once it is fixed."
              : phase.fail.status === 401
                ? "Sign in first; a seller record belongs to a user."
                : null}
          </NotLive>
        ) : null}
      </fieldset>
    </form>
  );
}
