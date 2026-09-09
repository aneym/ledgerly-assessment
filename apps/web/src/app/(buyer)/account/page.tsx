import type { Metadata } from "next";
import { PillLink, Shell } from "@/components";
import { AccountProfile } from "@/components/buyer/AccountProfile";
import { NotLive } from "@/components/buyer/NotLive";
import { OrderRows } from "@/components/buyer/OrderRows";
import { RefundList } from "@/components/buyer/RefundList";
import { toOrderList, toRefundList } from "@/lib/buyer/api";
import { getAccount, getMyOrders, getMyRefunds, serverCorrelationId } from "@/lib/buyer/server";
import { ownedSeller } from "@/lib/seller/owned";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Account · Ledgerly" };

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

export default async function AccountPage(props: PageProps<"/account">) {
  const search = await props.searchParams;
  const correlationId = await serverCorrelationId(first(search.correlationId));
  const session = await getSession();

  const head = (
    <div className="by-head">
      <div>
        <h1 className="by-h1">Account</h1>
        <p className="by-lede">Who you are, what you have bought and what you have asked back.</p>
      </div>
    </div>
  );

  if (!session) {
    return (
      <Shell screen="account">
        <div className="wrap by-page" data-correlation-id={correlationId}>
          {head}
          <section className="by-gate" aria-labelledby="account-gate">
            <h2 id="account-gate" className="by-h2">
              Sign in to see your account
            </h2>
            <p>This page reads your own row from the database, so it needs a session first.</p>
            <div className="act">
              <PillLink href="/signin?next=/account" tone="buy">
                Sign in
              </PillLink>
              <PillLink href="/signup?next=/account" tone="ghost">
                Create an account
              </PillLink>
            </div>
          </section>
        </div>
      </Shell>
    );
  }

  const [account, orders, refunds, owned] = await Promise.all([
    getAccount(correlationId),
    getMyOrders(correlationId),
    getMyRefunds(correlationId),
    ownedSeller(session.userId),
  ]);

  return (
    <Shell screen="account">
      <div className="wrap by-page" data-correlation-id={correlationId}>
        {head}
        <div className="by-acct">
          <AccountProfile
            session={session}
            owned={owned}
            result={account}
            correlationId={correlationId}
          />
          <div className="by-acct-main">
            <section className="by-acct-section" aria-labelledby="account-orders">
              <h2 id="account-orders" className="by-h2">
                Orders
              </h2>
              {orders.ok ? (
                <OrderRows orders={toOrderList(orders.data)} variant="account" />
              ) : (
                <NotLive failure={orders} title="Orders API is not live yet">
                  <p>
                    Orders for the signed-in buyer come from the app API. Until that route answers,
                    nothing is listed.
                  </p>
                </NotLive>
              )}
            </section>
            <section className="by-acct-section" aria-labelledby="account-refunds">
              <h2 id="account-refunds" className="by-h2">
                Refund requests
              </h2>
              {refunds.ok ? (
                <RefundList refunds={toRefundList(refunds.data)} />
              ) : (
                <NotLive failure={refunds} title="Refunds API is not live yet">
                  <p>Refund requests are read from the app API, never guessed from order status.</p>
                </NotLive>
              )}
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
