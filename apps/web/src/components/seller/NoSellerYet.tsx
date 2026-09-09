import { PillLink } from "@/components/pill";

/**
 * The honest state for a seller screen with no seller behind it: the session owns none and
 * the address names none. Fixture sellers are display only, so nothing is fetched here.
 */
export function NoSellerYet({ screen }: { screen: string }) {
  return (
    <section
      className="sl-paper raised p-6 md:p-8"
      role="status"
      aria-label="No seller yet"
      data-tour={`${screen}.no-seller`}
    >
      <h2
        className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
        style={{ fontVariationSettings: "'opsz' 24" }}
      >
        No seller account yet
      </h2>
      <p className="mt-2 max-w-[56ch] text-[13.5px] leading-relaxed text-ink-2">
        This screen reads a seller from the app API. Your session owns no seller and the address
        names none, so there is nothing to read. Create one on the start page; the Whop account and
        the readback follow from there.
      </p>
      <div className="mt-6">
        <PillLink href="/sell" tone="buy">
          Create a seller account
        </PillLink>
      </div>
    </section>
  );
}
