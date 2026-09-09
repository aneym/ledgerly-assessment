import { readFile } from "node:fs/promises";
import { assert, test } from "vitest";
import {
  CONTRACT_VERSION,
  EVENT_KINDS,
  findSecretLeak,
  ROLES,
  redact,
  SANDBOX_API_BASE,
  SOURCES,
  STATES,
  validateEvent,
} from "../src/contract";
import { sampleEvent } from "./helpers";

test("a well-formed fixture event validates", () => {
  assert.deepEqual(validateEvent(sampleEvent()), { ok: true, errors: [] });
});

test("the JSON schema file agrees with the code enums", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../contract/demo-event.v2.schema.json", import.meta.url), "utf8"),
  );
  const p = schema.properties;
  assert.deepEqual(p.kind.enum, EVENT_KINDS);
  assert.deepEqual(p.role.enum, ROLES);
  assert.deepEqual(p.source.enum, SOURCES);
  assert.deepEqual(p.state.enum, STATES);
  assert.equal(p.contract_version.const, CONTRACT_VERSION);
  assert.deepEqual(Object.keys(p).sort(), Object.keys(sampleEvent()).sort());
});

test("wrong contract major is rejected", () => {
  const r = validateEvent(sampleEvent({ contract_version: "3.0.0" as never }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /major must be 2/);
});

test("runtime can never emit verified", () => {
  const r = validateEvent(sampleEvent({ kind: "step.finished", state: "verified" }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /verified cannot be emitted/);
});

test("blocked requires a named gate", () => {
  assert.equal(validateEvent(sampleEvent({ kind: "step.finished", state: "blocked" })).ok, false);
  assert.equal(
    validateEvent(
      sampleEvent({
        kind: "step.finished",
        state: "blocked",
        gate: { id: "G01", reason: "payouts unavailable" },
      }),
    ).ok,
    true,
  );
});

test("a sandbox pass needs an observed response from the explicit sandbox base", () => {
  const noProvider = sampleEvent({
    kind: "step.finished",
    state: "passed",
    source: "sandbox",
    environment: "sandbox",
  });
  assert.match(validateEvent(noProvider).errors.join(), /requires a provider reference/);
  const wrongBase = sampleEvent({
    kind: "step.finished",
    state: "passed",
    source: "sandbox",
    environment: "sandbox",
    provider: {
      base_url: "https://api.whop.com/api/v1",
      http_status: 200,
      request_id: null,
      resource_ids: [],
      api_version_date: null,
      operation: null,
      duration_ms: null,
    },
  });
  assert.match(validateEvent(wrongBase).errors.join(), /base_url must be/);
  const noStatus = sampleEvent({
    kind: "step.finished",
    state: "passed",
    source: "sandbox",
    environment: "sandbox",
    provider: {
      base_url: SANDBOX_API_BASE,
      http_status: null,
      request_id: null,
      resource_ids: [],
      api_version_date: null,
      operation: null,
      duration_ms: null,
    },
  });
  assert.match(validateEvent(noStatus).errors.join(), /observed http_status/);
  const good = sampleEvent({
    kind: "step.finished",
    state: "passed",
    source: "sandbox",
    environment: "sandbox",
    provider: {
      base_url: SANDBOX_API_BASE,
      http_status: 200,
      request_id: "req_1",
      resource_ids: ["acc_1"],
      api_version_date: "2026-08-21",
      operation: null,
      duration_ms: null,
    },
  });
  assert.equal(validateEvent(good).ok, true);
});

test("a mock event cannot borrow the sandbox base url", () => {
  const r = validateEvent(
    sampleEvent({
      kind: "operation.responded",
      source: "mock",
      provider: {
        base_url: SANDBOX_API_BASE,
        http_status: 200,
        request_id: null,
        resource_ids: [],
        api_version_date: null,
        operation: null,
        duration_ms: null,
      },
    }),
  );
  assert.match(r.errors.join(), /cannot claim the sandbox base/);
});

test("sandbox source cannot occur in a local-only environment", () => {
  assert.match(
    validateEvent(sampleEvent({ source: "sandbox", environment: "local" })).errors.join(),
    /local-only environment/,
  );
});

test("run-level events carry no step id", () => {
  assert.match(
    validateEvent(sampleEvent({ kind: "run.reset", state: "pending" })).errors.join(),
    /must not carry a step_id/,
  );
  assert.equal(
    validateEvent(sampleEvent({ kind: "run.reset", state: "pending", step_id: null })).ok,
    true,
  );
});

test("secret-shaped payload values are rejected and redact() removes them", () => {
  const leaky = {
    api_key: "sk_live_abcdefghijklmnop",
    nested: { Authorization: "Bearer xyz", ok: "acc_123", list: ["ws_secret"] },
  };
  assert.equal(findSecretLeak(leaky), "payload.api_key");
  assert.equal(validateEvent(sampleEvent({ payload: leaky })).ok, false);
  const { value, removed } = redact(leaky);
  assert.deepEqual(removed, [
    "payload.api_key",
    "payload.nested.Authorization",
    "payload.nested.list[0]",
  ]);
  assert.equal(findSecretLeak(value), null);
  assert.equal((value.nested as { ok: string }).ok, "acc_123");
  assert.deepEqual(redact(value).removed, [], "redaction is idempotent");
});
