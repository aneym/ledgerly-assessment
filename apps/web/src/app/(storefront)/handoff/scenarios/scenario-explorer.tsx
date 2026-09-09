"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ASSESSMENT_SCENARIOS,
  AssessmentScenarioRun,
  ScenarioState,
} from "@/lib/assessment-scenarios";

import { ScenarioOutcome } from "./scenario-outcome";

type Definition = (typeof ASSESSMENT_SCENARIOS)[number];
const money = (value: { amountMinor: number; currency: string }) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(
    value.amountMinor / 100,
  );

const fieldLabels: Record<string, string> = {
  platformAvailable: "Available platform balance",
  platformHeld: "Held platform balance",
  sellerAvailable: "Seller balance",
  seller: "Seller balance",
  platform: "Platform balance",
  buyerRefund: "Buyer refunded",
  accountId: "Account",
  verification: "Verification",
  capability: "Capability",
  order: "Order",
  book: "Balance model",
  settlement: "Settlement",
  decodedDeliveries: "Decoded deliveries",
  uniqueEffectPreviews: "Unique effect previews",
  financialPosting: "Financial posting",
};
function readable(value: string) {
  return value.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function StateChange({ before, after }: { before: ScenarioState; after: ScenarioState }) {
  const accounts = [...new Set([...Object.keys(before.balances), ...Object.keys(after.balances)])];
  const states = [...new Set([...Object.keys(before.states), ...Object.keys(after.states)])];
  return (
    <div className="asc-state">
      {accounts.length > 0 && (
        <table>
          <caption>Simulated balances</caption>
          <thead>
            <tr>
              <th scope="col">Balance</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account}>
                <th scope="row">{fieldLabels[account] ?? readable(account)}</th>
                <td>{before.balances[account] ? money(before.balances[account]) : "—"}</td>
                <td>{after.balances[account] ? money(after.balances[account]) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {states.length > 0 && (
        <dl>
          {states.map((key) => (
            <div key={key}>
              <dt>{fieldLabels[key] ?? readable(key)}</dt>
              <dd>
                {key === "accountId"
                  ? (before.states[key] ?? "unset")
                  : readable(before.states[key] ?? "unset")}{" "}
                →{" "}
                {key === "accountId"
                  ? (after.states[key] ?? "unset")
                  : readable(after.states[key] ?? "unset")}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function ScenarioStep({ step }: { step: AssessmentScenarioRun["steps"][number] }) {
  return (
    <article className="asc-step">
      <h3>{step.title}</h3>
      <ScenarioOutcome result={step.result} />
      <StateChange before={step.before} after={step.after} />
      <details>
        <summary>Inspect input and result</summary>
        <pre>{JSON.stringify({ input: step.input, result: step.result }, null, 2)}</pre>
      </details>
    </article>
  );
}

export function ScenarioExplorer({ scenarios }: { scenarios: readonly Definition[] }) {
  const [selected, setSelected] = useState(scenarios[0].id);
  const [run, setRun] = useState<AssessmentScenarioRun | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const definition = scenarios.find((item) => item.id === selected) ?? scenarios[0];
  const step = run?.steps[activeStep];

  async function execute() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError(null);
    setRun(null);
    setActiveStep(0);
    try {
      const response = await fetch("/api/demo/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: selected, mode: "mock" }),
        signal: current.signal,
      });
      if (!response.ok) throw new Error(`Scenario request failed (${response.status}). Try again.`);
      const result: AssessmentScenarioRun = await response.json();
      if (result.mode !== "mock" || result.isolated !== true || result.scenarioId !== selected)
        throw new Error("The response did not match this isolated simulation.");
      if (!current.signal.aborted) setRun(result);
    } catch (cause) {
      if (!current.signal.aborted)
        setError(cause instanceof Error ? cause.message : "The simulation could not run.");
    } finally {
      if (!current.signal.aborted) setPending(false);
    }
  }

  return (
    <section className="asc-explorer" aria-label="Interactive mock scenarios">
      <div className="asc-selector">
        <label htmlFor="scenario-selection">Choose a scenario</label>
        <select
          id="scenario-selection"
          value={selected}
          disabled={pending}
          onChange={(event) => {
            setSelected(event.target.value as Definition["id"]);
            setRun(null);
            setError(null);
            setActiveStep(0);
          }}
        >
          {scenarios.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <h2>{definition.title}</h2>
        <p>{definition.description}</p>
        <button type="button" className="asc-run" disabled={pending} onClick={execute}>
          {pending
            ? "Running simulation…"
            : run
              ? "Run again with fresh fixtures"
              : "Run Demo/Mock scenario"}
        </button>
        <p className="asc-small">
          Each run starts from the same fixtures. Replays and refusals are checked inside the run.
        </p>
        <details>
          <summary>Scenario limits</summary>
          <ul>
            {definition.limitations.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </details>
      </div>
      <div className="asc-results" aria-busy={pending}>
        <p role="status" className="asc-small">
          {pending
            ? "Running fixed inputs against isolated memory."
            : run
              ? `${run.steps.length} simulated steps. ${run.assertions.filter((item) => item.passed).length} of ${run.assertions.length} assertions passed.`
              : "Choose a scenario and run it to inspect its results."}
        </p>
        {error && (
          <p role="alert" className="asc-error">
            {error}
          </p>
        )}
        {run && (
          <>
            <p className="asc-label">
              {run.label} · {run.summary}
            </p>
            <ol className="asc-steps" aria-label="Simulation steps">
              {run.steps.map((item, index) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={activeStep === index ? "step" : undefined}
                    onClick={() => setActiveStep(index)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {item.title}
                  </button>
                </li>
              ))}
            </ol>
            {step && <ScenarioStep step={step} />}
            <div className="asc-assertions">
              <h3>Assertions from this run</h3>
              <ul>
                {run.assertions.map((item) => (
                  <li key={item.id} data-passed={item.passed}>
                    <span>{item.passed ? "PASS" : "FAIL"}</span>
                    {item.description}
                  </li>
                ))}
              </ul>
            </div>
            <details>
              <summary>Full simulation output</summary>
              <pre>{JSON.stringify(run, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
