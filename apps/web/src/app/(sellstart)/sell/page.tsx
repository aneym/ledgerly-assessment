import { Ledger, LedgerLine } from "@/components/ledger-line";
import { PillLink } from "@/components/pill";
import { SellForm } from "@/components/seller/SellForm";
import { formatMoney } from "@/lib/catalog/money";
import { correlationParam, fixtureSellers, type SearchParams } from "@/lib/seller/current";
import { resolveSellerIdentity, type SellerIdentity, sellerHref } from "@/lib/seller/identity";
import { splitGross } from "@/lib/seller/ledger";
import { ownedSeller } from "@/lib/seller/owned";
import { getSession, type Session } from "@/lib/session";

const EXAMPLE = { amountMinor: 2500, currency: "USD" as const };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** A seller only counts as existing from the session's own seller or an explicit ?seller=; no demo fallback here. */
async function existingSeller(
  session: Session | null,
  searchParams: SearchParams,
): Promise<SellerIdentity | null> {
  const [owned, params] = await Promise.all([ownedSeller(session?.userId), searchParams]);
  const sellerParam = first(params.seller);
  if (!owned && !sellerParam) return null;
  const identity = resolveSellerIdentity({
    session,
    ownedSeller: owned,
    sellerParam,
    fixtures: fixtureSellers(),
  });
  return identity.source === "demo" ? null : identity;
}

export default async function SellStartPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  const [correlationId, existing] = await Promise.all([
    correlationParam(searchParams),
    existingSeller(session, searchParams),
  ]);
  const { fee, net } = splitGross(EXAMPLE);

  return (
    <div>
      <section className="sl-wash pt-12 pb-10 md:pt-16 md:pb-14">
        <div className="wrap">
          <p className="font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
            For sellers
          </p>
          <h1
            className="mt-3 max-w-[14ch] font-serif text-[44px] leading-[1.02] font-normal tracking-[-0.02em] text-balance text-ink md:text-[64px]"
            style={{ fontVariationSettings: "'opsz' 144" }}
          >
            Sell on Ledger<em className="font-light italic">ly</em>
          </h1>
          <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-pretty text-ink-2">
            Sell digital products with payments through Whop.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            {existing ? (
              <PillLink
                href={sellerHref("/sell/onboarding", existing)}
                tone="buy"
                size="lg"
                data-tour="sell.start.cta"
              >
                Continue as {existing.name}
              </PillLink>
            ) : (
              <a href="#sell-form" className="pill buy lg" data-tour="sell.start.cta">
                Start selling
              </a>
            )}
            <span className="text-[13px] text-muted">Identity verification happens on Whop.</span>
          </div>
        </div>
      </section>

      <section className="wrap pt-8 pb-16 md:pt-12 md:pb-24">
        <div className="sl-grid grid-cols-1 gap-8 md:grid-cols-[1fr_400px] md:items-start md:gap-12">
          <div className="flex flex-col gap-10">
            <div>
              <h2
                className="font-serif text-[26px] leading-[1.15] font-medium text-ink"
                style={{ fontVariationSettings: "'opsz' 24" }}
              >
                What a {formatMoney(EXAMPLE)} sale looks like
              </h2>
              <p className="mt-2 max-w-[56ch] text-[14.5px] leading-relaxed text-ink-2">
                The 8% fee rounds to the cent. Whop shows its separate processing fee on each
                payment.
              </p>
              <div className="sl-paper mt-6 max-w-[440px] p-6">
                <Ledger>
                  <LedgerLine label="Buyer pays" value={formatMoney(EXAMPLE)} />
                  <LedgerLine label="Ledgerly fee 8%" value={formatMoney(fee)} quiet />
                  <LedgerLine
                    label="You keep"
                    value={formatMoney(net)}
                    fine="before processing fees"
                    total
                  />
                </Ledger>
              </div>
            </div>

            <dl className="sl-grid max-w-[560px] grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
              <div>
                <dt className="text-[14px] font-medium text-ink">Two ways to get paid</dt>
                <dd className="mt-1 text-[13.5px] leading-relaxed text-ink-2">
                  Direct charge: the buyer pays your Whop account and you handle refunds. Platform
                  charge: Ledgerly collects, then transfers your share.
                </dd>
              </div>
              <div>
                <dt className="text-[14px] font-medium text-ink">Available, pending, held</dt>
                <dd className="mt-1 text-[13.5px] leading-relaxed text-ink-2">
                  Transfers fund your Whop balance. Payouts move that balance to your bank.
                </dd>
              </div>
              <div>
                <dt className="text-[14px] font-medium text-ink">Identity stays on Whop</dt>
                <dd className="mt-1 text-[13.5px] leading-relaxed text-ink-2">
                  Verification and bank details go to Whop's hosted onboarding. Ledgerly stores your
                  seller id and reads the status back.
                </dd>
              </div>
              <div>
                <dt className="text-[14px] font-medium text-ink">Digital products only</dt>
                <dd className="mt-1 text-[13.5px] leading-relaxed text-ink-2">
                  One-time purchases in US dollars. Files are delivered from the buyer's library
                  after payment.
                </dd>
              </div>
            </dl>
          </div>

          {existing ? (
            <div className="sl-paper raised p-6 md:sticky md:top-6 md:p-8">
              <h2
                className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
                style={{ fontVariationSettings: "'opsz' 24" }}
              >
                You already have a seller account
              </h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
                {existing.name}
                {existing.city ? `, ${existing.city}` : ""}
              </p>
              <div className="mt-6 flex flex-col gap-3">
                <PillLink href={sellerHref("/sell/onboarding", existing)} tone="buy" wide>
                  Check Whop onboarding
                </PillLink>
                <PillLink href={sellerHref("/sell/earnings", existing)} tone="ghost" wide>
                  Go to earnings
                </PillLink>
              </div>
            </div>
          ) : session ? (
            <div id="sell-form" className="sl-paper raised p-6 md:sticky md:top-6 md:p-8">
              <h2
                className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
                style={{ fontVariationSettings: "'opsz' 24" }}
              >
                Create your seller account
              </h2>
              <p className="mt-1 mb-6 text-[13.5px] leading-relaxed text-muted">
                Creates your connected account on Whop.
              </p>
              <SellForm correlationId={correlationId} />
            </div>
          ) : (
            <div id="sell-form" className="sl-paper raised p-6 md:sticky md:top-6 md:p-8">
              <h2
                className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
                style={{ fontVariationSettings: "'opsz' 24" }}
              >
                Sign in to create a seller account
              </h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
                New to Ledgerly? Create an account first.
              </p>
              <div className="mt-6 flex flex-col gap-3">
                <PillLink href="/signin?next=/sell" tone="buy" wide data-tour="sell.start.submit">
                  Sign in
                </PillLink>
                <PillLink href="/signup?next=/sell" tone="ghost" wide>
                  Create an account
                </PillLink>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
