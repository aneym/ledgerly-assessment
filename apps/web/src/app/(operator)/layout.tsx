import { Wordmark } from "@/components/brand/Wordmark";
import { DevPanelMount } from "@/components/dev/dev-panel-mount";
import { AssistantPanel } from "@/components/operator/assistant/assistant-panel";
import { AssistantProvider } from "@/components/operator/assistant/assistant-provider";
import { AssistantToggle } from "@/components/operator/assistant/assistant-toggle";
import { OperatorTabs } from "@/components/operator/operator-tabs";
import { DashboardShell } from "@/components/table";
import { demoScopeFor } from "@/lib/demo-scope";
import "@/components/table/table.css";
import "@/components/operator/operator.css";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

/**
 * The operator shell: a sticky 56px bar, then the document scrolls. Every table head
 * and inspector inside reads --shell-top from .op-root (docs/design/tables.md 3.2).
 *
 * Gate: no session sends the visitor to sign in (nothing under /admin renders for an
 * anonymous visitor, fixture data included); a session without the operator role sees the
 * plain gate below.
 */
export default async function OperatorLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (session === null) {
    // A layout does not receive the pathname; the group's root is the best "next" it has
    // unless a proxy set x-pathname on the request.
    const requested = (await headers()).get("x-pathname");
    const next = requested?.startsWith("/admin") ? requested : "/admin/sellers";
    redirect(`/signin?next=${encodeURIComponent(next)}`);
  }
  const scope = demoScopeFor(
    session,
    new Request("http://ledgerly.local/admin", { headers: await headers() }),
  );
  const blocked = scope === null;

  return (
    <AssistantProvider>
      <div className="op-root">
        <header className="op-bar">
          <Wordmark variant="operator" />
          <OperatorTabs />
          <div className="op-bar-end">
            <AssistantToggle />
            <span className="chip line">
              {scope?.kind === "demo" ? "Sample operator (demo scope)" : session.role}
            </span>
          </div>
        </header>
        <main className="op-main">
          {blocked ? (
            <div className="op-gate">
              <h1>Operator role needed</h1>
              <p>
                This session is signed in as a {session.role}. The sellers, ledger and issues views
                need the operator role.
              </p>
            </div>
          ) : (
            <DashboardShell>{children}</DashboardShell>
          )}
        </main>
        <AssistantPanel />
        <DevPanelMount />
      </div>
    </AssistantProvider>
  );
}
