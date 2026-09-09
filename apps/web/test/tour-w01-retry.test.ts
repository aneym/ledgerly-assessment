import { expect, it } from "vitest";
import { pendingRetryFailure, w01Values } from "../src/components/tour/TourShell";

function storage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
it("creates fictional W01 values once per run, stored only under ledgerly.demo.w01", () => {
  const session = storage();
  const first = w01Values(session, "run_42");
  expect(first.name).toBe("Demo Buyer run_42");
  expect(first.email).toBe("demo-buyer-run_42@ledgerly.test");
  expect(first.password).toMatch(/^[A-Za-z0-9_-]{16}$/);
  expect(w01Values(session, "run_42")).toEqual(first);
  expect([...session.entries.keys()]).toEqual(["ledgerly.demo.w01"]);
  const next = w01Values(session, "run_43");
  expect(next.email).toBe("demo-buyer-run_43@ledgerly.test");
  expect(next.password).not.toBe(first.password);
  expect(session.getItem("ledgerly.demo.w01")).not.toContain(first.password);
});
it("replaces malformed session values", () => {
  const session = storage();
  session.setItem("ledgerly.demo.w01", "not json");
  expect(w01Values(session, "run_42").password).toHaveLength(16);
});
it("does not silently use another storage location if sessionStorage is unavailable", () => {
  expect(() =>
    w01Values(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage denied");
        },
      },
      "run_42",
    ),
  ).toThrow("storage denied");
});
const failure = {
  http_status: 409,
  route: "POST /api/auth/sign-up/email",
  summary: "Already registered",
  correlation_id: "old",
  seq: 10,
};
it("retains the failed error through retry start and unrelated or late old outcomes", () => {
  expect(pendingRetryFailure(failure, "retry", [])).toBe(failure);
  expect(
    pendingRetryFailure(failure, "retry", [
      { kind: "request.started", correlation_id: "retry" },
      { kind: "request.finished", correlation_id: "old" },
      { kind: "request.finished", correlation_id: "another-step" },
    ]),
  ).toBe(failure);
});
it.each(["request.finished", "operation.responded", "step.finished"] as const)(
  "replaces the old failure only on the retry's %s",
  (kind) => {
    expect(pendingRetryFailure(failure, "retry", [{ kind, correlation_id: "retry" }])).toBeNull();
  },
);
