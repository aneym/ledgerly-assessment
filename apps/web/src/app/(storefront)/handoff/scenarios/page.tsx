import type { Metadata } from "next";
import { ASSESSMENT_SCENARIOS } from "@/lib/assessment-scenarios";
import { ScenarioExplorer } from "./scenario-explorer";
import "./scenarios.css";

export const metadata: Metadata = {
  title: "Assessment scenarios | Ledgerly",
  description: "Run isolated Demo/Mock assessment scenarios with inspectable state and balances.",
};

export default function AssessmentScenariosPage() {
  return (
    <main className="asc">
      <nav aria-label="Assessment navigation">
        <a href="/handoff">← Assessment handoff</a>
        <a href="/handoff/evidence">Recorded evidence</a>
        <a href="/handoff/engineering">Engineering notes</a>
      </nav>
      <header className="asc-heading">
        <p className="asc-label">Demo/Mock · Isolated memory</p>
        <h1>Explore integration scenarios</h1>
        <p>
          Explore verification, refunds and money movement using fixed fictional accounts. Each run
          shows what changed and checks that retries cannot repeat the effect.
        </p>
      </header>
      <aside className="asc-limit" aria-label="Simulation limits">
        <strong>These results are simulations.</strong> They do not complete identity checks, move
        funds, or prove Whop delivered an event. Private provider captures are excluded from this
        source export. See the <a href="/handoff/evidence">evidence limits</a>.
      </aside>
      <ScenarioExplorer scenarios={ASSESSMENT_SCENARIOS} />
    </main>
  );
}
