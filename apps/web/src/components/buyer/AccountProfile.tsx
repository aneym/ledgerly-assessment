import { IdentityMark, Ledger, LedgerLine } from "@/components";
import type { AccountView, ApiResult } from "@/lib/buyer/api";
import { toAccountView } from "@/lib/buyer/api";
import { formatDate } from "@/lib/buyer/format";
import { resolveMark } from "@/lib/identity/mark";
import type { OwnedSellerLike } from "@/lib/seller/identity";
import type { Session } from "@/lib/session";
import { NotLive } from "./NotLive";
import { SignOut } from "./SignOut";

/**
 * Who is signed in, from the users table. The session proves the row exists;
 * the account API fills in the name, the email and the join date. The portrait is the
 * same one the rest of the app draws for this identity (lib/identity/mark).
 */
export function AccountProfile({
  session,
  owned = null,
  result,
  correlationId,
}: {
  session: Session;
  /** The seller this user owns, when the server found one. */
  owned?: OwnedSellerLike | null;
  result: ApiResult<unknown>;
  correlationId: string;
}) {
  const account: AccountView | null = result.ok ? toAccountView(result.data) : null;
  const name = account?.name ?? null;
  const since = formatDate(account?.createdAt ?? null);
  const mark = resolveMark({
    id: session.userId,
    sellerId: owned?.id,
    externalId: owned?.name,
    name: name ?? session.userId,
    email: account?.email,
  });

  return (
    <section
      className="card raised by-profile"
      aria-labelledby="account-name"
      data-tour="account.profile"
    >
      <div className="who">
        <IdentityMark mark={mark} size="lg" />
        <div>
          <h2 id="account-name" className="by-h2">
            {name ?? "Your account"}
          </h2>
          <p className="role">{account?.email ?? `Signed in as ${session.role}`}</p>
        </div>
      </div>

      <Ledger>
        <LedgerLine label="Name" value={name ?? "—"} quiet={name === null} wrap />
        <LedgerLine label="Email" value={account?.email ?? "—"} quiet={!account?.email} wrap />
        <LedgerLine label="Member since" value={since ?? "—"} quiet={since === null} />
        <LedgerLine label="User id" value={<span className="by-mono">{session.userId}</span>} />
      </Ledger>

      {!result.ok ? (
        <NotLive failure={result} title="Account API is not live yet" inline>
          <p>
            The session is real, so the user id above comes from the database. The rest of the row
            waits for this route.
          </p>
        </NotLive>
      ) : account === null ? (
        <NotLive
          failure={{
            ok: false,
            kind: "unexpected",
            status: result.status,
            method: result.method,
            path: result.path,
            correlationId: result.correlationId,
            message: "unexpected response: no user id",
          }}
          title="Account payload is missing fields"
          inline
        />
      ) : null}

      <p className="note">
        Identity comes from the users table.
        {mark.avatar
          ? " The portrait is the catalog picture for this seller."
          : " Nothing on this card is fixture data."}
      </p>
      <SignOut correlationId={correlationId} />
    </section>
  );
}
