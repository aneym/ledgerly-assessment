import type { Metadata } from "next";
import { PillLink, Shell } from "@/components";
import { NotLive } from "@/components/buyer/NotLive";
import { OrderRows } from "@/components/buyer/OrderRows";
import { toOrderList } from "@/lib/buyer/api";
import { getMyOrders, serverCorrelationId } from "@/lib/buyer/server";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Library · Ledgerly" };

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export default async function LibraryPage(props: PageProps<"/library">) {
  const search = await props.searchParams;
  const correlationId = await serverCorrelationId(first(search.correlationId));
  const session = await getSession();

  const head = (
    <div className="by-head">
      <div>
        <h1 className="by-h1">Library</h1>
        <p className="by-lede">Everything you have bought, with a receipt beside each item.</p>
      </div>
    </div>
  );

  if (!session) {
    return (
      <Shell screen="library">
        <div className="wrap by-page" data-correlation-id={correlationId}>
          {head}
          <section className="by-gate" aria-labelledby="library-gate">
            <h2 id="library-gate" className="by-h2">
              Sign in to see your library
            </h2>
            <p>Purchases are tied to your account, so the list needs a session first.</p>
            <div className="act">
              <PillLink href="/signin?next=/library" tone="buy">
                Sign in
              </PillLink>
              <PillLink href="/signup?next=/library" tone="ghost">
                Create an account
              </PillLink>
            </div>
          </section>
        </div>
      </Shell>
    );
  }

  const result = await getMyOrders(correlationId);

  return (
    <Shell screen="library">
      <div className="wrap by-page" data-correlation-id={correlationId}>
        {head}
        {result.ok ? (
          <OrderRows orders={toOrderList(result.data)} variant="library" />
        ) : (
          <NotLive
            failure={result}
            title="Orders API is not live yet"
            actions={
              <PillLink href="/browse" tone="ink">
                Browse the catalog
              </PillLink>
            }
          >
            <p>
              The library lists orders from the app API for the signed-in buyer. Until that route
              answers, the list stays empty rather than showing sample purchases.
            </p>
          </NotLive>
        )}
      </div>
    </Shell>
  );
}
