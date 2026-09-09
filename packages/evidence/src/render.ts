import type { DerivedState, Ledger, ScenarioStatus } from "./ledger.ts";
import type { EvidenceRecord } from "./types.ts";

export interface ReportMeta {
  generatedAt: string;
  codeRevision: string;
  dirtyTree: boolean;
  /** Shown in the banner. Fixture sample runs must say so. */
  label: string;
}

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const STATUS_WORD: Record<ScenarioStatus, string> = {
  verified: "verified",
  passed: "passed, awaiting review",
  failed: "failed",
  blocked: "blocked",
  partial: "partly run",
  "not-run": "not run",
};

/** One self-contained HTML file. No script, no external assets, no editable state. */
export function renderReport(ledger: Ledger, state: DerivedState, meta: ReportMeta): string {
  const issueCount =
    ledger.schemaIssues.reduce((n, f) => n + f.issues.length, 0) +
    ledger.ruleIssues.length +
    ledger.shapeIssues.length;
  const gates = new Map<string, string[]>();
  for (const s of state.scenarios)
    for (const g of new Set([...s.scenario.gates, ...s.blockedBy]))
      gates.set(g, [...(gates.get(g) ?? []), s.scenario.scenario_id]);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ledgerly evidence report</title><style>${CSS}</style></head><body>
<header>
<div class="eyebrow">${esc(meta.label)}</div>
<h1>Evidence report</h1>
<p class="meta">Generated ${esc(meta.generatedAt)} from revision <code>${esc(meta.codeRevision)}</code>${meta.dirtyTree ? " with uncommitted changes" : ""}. Every number below is counted from records under <code>evidence/records</code>. Nothing on this page is typed in.</p>
</header>
<main>
${banner(ledger, issueCount)}
<section id="totals"><h2>Requirements by state</h2>${totals(state)}</section>
<section id="gates"><h2>Owner gates</h2>${gates.size ? `<ul>${[...gates].map(([g, ids]) => `<li><strong>${esc(g)}</strong> holds ${ids.map(esc).join(", ")}</li>`).join("")}</ul>` : "<p>No gates recorded.</p>"}</section>
<section id="scenarios"><h2>Scenarios in handover order</h2><div class="table"><table><thead><tr><th>#</th><th>Scenario</th><th>State</th><th>Evidence required</th><th>Requirements</th></tr></thead><tbody>${state.scenarios.map(scenarioRow).join("")}</tbody></table></div></section>
<section id="requirements"><h2>Requirement matrix</h2><div class="table"><table><thead><tr><th>ID</th><th>Requirement</th><th>Proof required</th><th>State</th><th>Scenarios</th><th>Records</th></tr></thead><tbody>${state.requirements.map(requirementRow).join("")}</tbody></table></div></section>
<section id="records"><h2>Records</h2>${
    ledger.records.length
      ? state.scenarios
          .flatMap((s) => s.records)
          .map(recordCard)
          .join("")
      : "<p>No records yet. Nothing has run.</p>"
  }</section>
<section id="issues"><h2>Validation issues</h2>${issues(ledger)}</section>
</main>
<footer>Ledgerly is fictional. Fixture records never satisfy a sandbox, browser or human requirement. Verified needs a second actor and a readback.</footer>
</body></html>`;
}

function banner(ledger: Ledger, issueCount: number): string {
  const parts = [
    `${ledger.records.length} record${ledger.records.length === 1 ? "" : "s"}`,
    `${ledger.scenarios.length} scenarios`,
    `${ledger.requirements.length} requirements`,
    issueCount
      ? `<strong class="bad">${issueCount} validation issue${issueCount === 1 ? "" : "s"}</strong>`
      : "no validation issues",
  ];
  return `<p class="notice">${parts.join(" · ")}. Allowlist ${esc(ledger.allowlist.version)}.</p>`;
}

function totals(state: DerivedState): string {
  const order: ScenarioStatus[] = ["verified", "passed", "partial", "blocked", "failed", "not-run"];
  const n = state.requirements.length;
  return `<div class="table"><table><thead><tr><th>State</th><th>Count</th><th></th></tr></thead><tbody>${order
    .map((s) => {
      const c = state.totals[s];
      return `<tr><td><span class="pill ${s}">${STATUS_WORD[s]}</span></td><td class="num">${c}</td><td><div class="bar"><div class="fill ${s}" style="width:${n ? Math.round((c / n) * 100) : 0}%"></div></div></td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

function scenarioRow(s: DerivedState["scenarios"][number]): string {
  const cats = s.categories
    .map(
      (c) =>
        `<span class="pill ${c.status === "missing" ? "not-run" : c.status}">${esc(c.category)}: ${c.status === "missing" ? "missing" : c.status}</span>`,
    )
    .join(" ");
  return `<tr id="${esc(s.scenario.scenario_id)}"><td class="num">${s.scenario.handover_step}</td><td><strong>${esc(s.scenario.scenario_id)}</strong> ${esc(s.scenario.title)}${s.blockedBy.length ? `<div class="small">blocked by ${s.blockedBy.map(esc).join(", ")}</div>` : ""}</td><td><span class="pill ${s.status}">${STATUS_WORD[s.status]}</span></td><td>${cats}</td><td class="small">${s.scenario.requirement_ids.map(esc).join(", ")}</td></tr>`;
}

function requirementRow(r: DerivedState["requirements"][number]): string {
  return `<tr id="${esc(r.requirement.id)}"><td><strong>${esc(r.requirement.id)}</strong></td><td>${esc(r.requirement.requirement)}</td><td class="small">${esc(r.requirement.evidence_required)}</td><td><span class="pill ${r.status}">${STATUS_WORD[r.status]}</span></td><td class="small">${r.scenarioIds.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(", ")}</td><td class="small">${r.records.map((x) => `<a href="#${esc(x.evidence_id)}">${esc(x.evidence_id)}</a>`).join("<br>") || "none"}</td></tr>`;
}

function recordCard(r: EvidenceRecord): string {
  const row = (k: string, v: unknown) =>
    v === undefined || v === ""
      ? ""
      : `<tr><th>${esc(k)}</th><td>${esc(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`;
  return `<details id="${esc(r.evidence_id)}" class="record"><summary><span class="pill ${r.status}">${esc(r.status)}</span> <span class="pill cat">${esc(r.category)}</span> <code>${esc(r.evidence_id)}</code> ${esc(r.scenario_id)} · ${r.requirement_ids.map(esc).join(", ")} · ${esc(r.observed_at)}${r.sample_payload ? ' <span class="pill not-run">sample payload</span>' : ""}</summary><table class="kv">${[
    row("owner", r.owner),
    row("environment", r.environment),
    row("revision", `${r.code_revision}${r.dirty_tree ? " (dirty)" : ""}`),
    row("command", r.command),
    row("exit code", r.exit_code),
    row("api base", r.api_base),
    row("rest version", r.rest_version),
    row("webhook version", r.webhook_version),
    row("sdk", r.sdk_version),
    row("provider ids", r.provider_resource_ids?.join(", ")),
    row("request", r.request_reference),
    row("response", r.response_reference),
    row(
      "artifacts",
      r.artifact_paths.map((p) => `${p} ${r.artifact_hashes[p]?.slice(0, 12) ?? "?"}`).join(" | "),
    ),
    row(
      "redaction",
      `removed ${r.redaction_review.removed_fields.join(", ") || "nothing"}; allowlist ${r.redaction_review.allowlist_version}`,
    ),
    row("limitations", r.limitations),
    row("blocked by", r.blocked_by),
    row("supersedes", r.supersedes),
    row(
      "correlation",
      r.correlation
        ? [r.correlation.run_id, r.correlation.correlation_id, r.correlation.step_id]
            .filter(Boolean)
            .join(" / ")
        : undefined,
    ),
    row(
      "readback",
      r.readback
        ? `${r.readback.method} ${r.readback.reference} at ${r.readback.read_at}`
        : undefined,
    ),
    row("reviewer", r.reviewer ? `${r.reviewer} at ${r.reviewed_at ?? "?"}` : undefined),
    row("notes", r.notes),
  ].join("")}</table></details>`;
}

function issues(ledger: Ledger): string {
  const items: string[] = [];
  for (const f of ledger.schemaIssues)
    for (const i of f.issues)
      items.push(
        `<li class="bad"><code>${esc(f.file)}</code> ${esc(i.path)}: ${esc(i.message)}</li>`,
      );
  for (const i of ledger.ruleIssues)
    items.push(
      `<li class="bad"><code>${esc(i.evidence_id)}</code> ${esc(i.rule)}: ${esc(i.message)}</li>`,
    );
  for (const s of ledger.shapeIssues) items.push(`<li class="bad">${esc(s)}</li>`);
  return items.length ? `<ul>${items.join("")}</ul>` : "<p>None.</p>";
}

/* Provisional neutral styling with the orange accent from the wiki index. Replace when the measured Whop tokens land. */
const CSS = `:root{font:15px/1.5 system-ui;color:#202020;background:#fafafa}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:1100px;margin:auto;padding:24px}header{border-bottom:1px solid #ddd}h1{font-size:36px;letter-spacing:-.03em;margin:6px 0}h2{font-size:20px;margin-top:32px}.eyebrow{color:#bb310b;font-weight:650}.meta{color:#555}.notice{border-left:4px solid #fa4616;padding:10px 14px;background:#fff}a{color:#ab2d09}code{font-size:.92em}table{border-collapse:collapse;width:100%}td,th{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.table{overflow:auto}.num{text-align:right;font-variant-numeric:tabular-nums}.small{font-size:13px;color:#555}.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;background:#eee;white-space:nowrap}.pill.verified{background:#d9f2e3;color:#0b5a2a}.pill.passed{background:#e3ecfa;color:#173e8a}.pill.partial,.pill.running{background:#fff1d6;color:#7a4b00}.pill.blocked{background:#f3e5f5;color:#5e1a6b}.pill.failed{background:#fde2e0;color:#8a1b12}.pill.not-run{background:#eee;color:#555}.pill.cat{background:#fff;border:1px solid #ccc}.bar{height:8px;background:#eee;border-radius:4px;min-width:120px}.fill{height:100%;border-radius:4px;background:#bbb}.fill.verified{background:#1f8a4c}.fill.passed{background:#2f5fc4}.fill.partial{background:#d98c00}.fill.blocked{background:#8e3fa0}.fill.failed{background:#c8352a}.record{border:1px solid #ddd;border-radius:8px;padding:8px 12px;margin:8px 0;background:#fff}.record summary{cursor:pointer}.kv th{width:140px;font-weight:600;color:#444}.bad{color:#8a1b12}footer{font-size:13px;color:#646464}`;
