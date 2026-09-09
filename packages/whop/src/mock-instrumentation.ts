import { randomUUID } from "node:crypto";
import type { InstrumentationEvent, WhopPort } from "@ledgerly/core";
import { WHOP_OPERATION_ROUTES } from "./sandbox-adapter";

const accountOperations = new Set([
  "createAccount",
  "createOrFetchAccount",
  "updateAccount",
  "getAccount",
]);
const safeAccountId = (value: unknown): value is string =>
  typeof value === "string" && /^biz_[A-Za-z0-9_-]{1,124}$/.test(value);

/** Observes local mock calls. Route labels identify port operations, never an HTTP exchange. */
export function instrumentMockAdapter<T extends WhopPort>(
  adapter: T,
  onEvent?: (event: InstrumentationEvent) => void,
): T {
  if (!onEvent) return adapter;
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached) return cached;
      // Simulator helpers retain their original return types, side effects and this binding.
      if (typeof property !== "string" || !Object.hasOwn(WHOP_OPERATION_ROUTES, property)) {
        const helper = value.bind(target);
        methods.set(property, helper);
        return helper;
      }
      const operation = property as keyof WhopPort;
      const route = WHOP_OPERATION_ROUTES[operation];
      const wrapped = async (...args: unknown[]) => {
        const started = Date.now();
        const correlationId = randomUUID();
        const path =
          operation === "getAccount" && safeAccountId(args[0])
            ? `/accounts/${args[0]}`
            : route.path;
        const emit = (
          phase: "start" | "end",
          status: InstrumentationEvent["status"],
          outcome?: "succeeded" | "failed" | "threw",
          accountId?: string,
        ) => {
          const safeIds: Record<string, string> = {};
          if (outcome) safeIds.mock_result = outcome;
          if (accountId) safeIds.account_id = accountId;
          onEvent({
            source: "whop",
            provenance: "mock",
            phase,
            status,
            method: route.method,
            path,
            correlationId,
            safeIds,
            summary: `mock ${operation} ${outcome ?? "started"}`,
            at: new Date(),
            ...(phase === "end" ? { durationMs: Date.now() - started } : {}),
          });
        };
        emit("start", null);
        let result: unknown;
        try {
          result = await Reflect.apply(value, target, args);
        } catch (cause) {
          // Exception messages may carry caller data. Report the outcome and rethrow unchanged.
          emit("end", "error", "threw");
          throw cause;
        }
        const response = result as { ok?: unknown; value?: { id?: unknown } } | null;
        const succeeded = response?.ok === true;
        const accountId =
          succeeded && accountOperations.has(operation) && safeAccountId(response.value?.id)
            ? response.value.id
            : undefined;
        emit("end", succeeded ? "ok" : "error", succeeded ? "succeeded" : "failed", accountId);
        return result;
      };
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}
