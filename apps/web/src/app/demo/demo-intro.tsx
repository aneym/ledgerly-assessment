import { AuthForm } from "@/components/buyer/AuthForm";
import { SignOut } from "@/components/buyer/SignOut";
import { PillLink } from "@/components/pill";

type DemoIntroProps = {
  personaName: string | null;
  operator: boolean;
  user: { email: string; isPersona?: boolean } | null;
  why: string | null;
  startUrl: string;
  returnTo: string | null;
  resumeStep: { id: string; title: string; path?: string | null } | null;
  run: string | null;
};

/** Session-free presentation; the route owns authentication and redirects. */
export function DemoIntro({
  personaName,
  operator,
  user,
  why,
  startUrl,
  returnTo,
  resumeStep,
  run,
}: DemoIntroProps) {
  const introQuery = new URLSearchParams(startUrl.split("?")[1]);
  if (resumeStep && run) {
    introQuery.delete("tour");
    introQuery.set("run", run);
    introQuery.set("step", resumeStep.id);
  }
  const introUrl = `/demo${introQuery.size ? `?${introQuery.toString()}` : ""}`;

  return (
    <div className="by-wash">
      <div className="demo-intro wrap">
        <section className="demo-intro-card" aria-labelledby="demo-intro-title">
          <h1 id="demo-intro-title" className="by-h1">
            Explore Ledgerly in a guided demo.
          </h1>
          {operator || user?.isPersona ? (
            <div className="demo-intro-act">
              <PillLink href={startUrl} tone="buy" size="lg" data-tour="demo.intro.start">
                Start demo
              </PillLink>
            </div>
          ) : why === "persona" ? (
            <p className="demo-intro-warn" role="status">
              The demo account could not sign in; see Details.
            </p>
          ) : user ? (
            <div className="demo-intro-act">
              <p className="demo-intro-warn" role="status">
                This account is not an operator; sign out to switch accounts.
              </p>
              <SignOut correlationId="demo-intro" next={introUrl} />
            </div>
          ) : null}
          <p className="by-lede">
            This runs on the real Ledgerly app and the Whop sandbox. Where the sandbox cannot
            complete a step today the demo says so on that step and uses a labelled simulation.
          </p>
          <details className="demo-intro-details">
            <summary className="by-link">Details</summary>
            <div className="demo-intro-detail-body">
              <p>Real: app sign-in, database records and supported Whop sandbox calls.</p>
              <p>Simulated: steps the sandbox cannot complete, labelled on the step.</p>
              <p>
                Return to deck:{" "}
                {returnTo ? (
                  <a className="by-link" href={returnTo}>
                    {returnTo}
                  </a>
                ) : (
                  "No deck target; the demo ends in the app."
                )}
              </p>
              {why === "persona" && personaName ? (
                <p>The presenter needs to check the demo account setup before trying again.</p>
              ) : null}
              {!personaName ? (
                <details className="demo-intro-signin">
                  <summary className="by-link">Presenter sign-in</summary>
                  <AuthForm mode="signin" next={startUrl} correlationId={null} />
                </details>
              ) : null}
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}
