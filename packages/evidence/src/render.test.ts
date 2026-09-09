import { expect, test } from "vitest";
import { deriveState, type Ledger } from "./ledger.ts";
import { renderReport } from "./render.ts";
import { allowlist, minimalRecord, scenario } from "./test-helpers.ts";

const ledger: Ledger = {
  requirements: [
    {
      id: "CODE-03",
      requirement: "Verify signatures",
      evidence_required: "raw tests",
      section: "Code",
      state: "not-run",
    },
  ],
  scenarios: [scenario()],
  records: [minimalRecord({ notes: "<script>alert(1)</script>", sample_payload: true })],
  allowlist,
  schemaIssues: [],
  ruleIssues: [
    { evidence_id: "ev-20260908-000000-test", rule: "second-actor", message: "demo issue" },
  ],
  shapeIssues: [],
};

test("the report is one self-contained page that escapes content and shows every state word", () => {
  const html = renderReport(ledger, deriveState(ledger), {
    generatedAt: "2026-09-08T16:00:00Z",
    codeRevision: "abc1234",
    dirtyTree: true,
    label: "Fixture sample. Not assessment proof.",
  });
  expect(html).toContain("Fixture sample. Not assessment proof.");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("1 validation issue");
  expect(html).toContain("sample payload");
  expect(html).toContain("partly run");
  expect(html).toContain("with uncommitted changes");
  expect(html).not.toContain("undefined");
});

test("an empty ledger says nothing has run", () => {
  const empty = { ...ledger, records: [], ruleIssues: [] };
  const html = renderReport(empty, deriveState(empty), {
    generatedAt: "",
    codeRevision: "unborn",
    dirtyTree: false,
    label: "x",
  });
  expect(html).toContain("No records yet. Nothing has run.");
  expect(html).toContain("no validation issues");
});
