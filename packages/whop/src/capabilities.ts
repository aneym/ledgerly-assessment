import type { WhopAccountId, WhopPort } from "@ledgerly/core";
import { z } from "zod";

// The platform account's `capabilities` and `required_actions` fields are not part of
// WhopPort's typed WhopAccount shape (packages/core has no reason to know about them),
// but the sandbox adapter's account schema is a `looseObject`, so both fields survive
// unparsed on `.raw`. This is the one place in the hybrid path that reaches into `.raw`
// to decode them, at the boundary, the same way every other Whop payload is decoded.
const capabilityStatusSchema = z.enum(["active", "inactive"]);
const platformAccountRawSchema = z.looseObject({
  capabilities: z.record(z.string(), capabilityStatusSchema).optional(),
  required_actions: z.array(z.looseObject({ action: z.string() })).optional(),
});

export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export type CapabilitySnapshot = {
  capabilities: Record<string, CapabilityStatus>;
  requiredActions: string[];
  // Null means no read has ever succeeded (initial state, or every attempt so far
  // returned a provider error) — never fabricate a stale-but-present timestamp for that.
  readAt: Date | null;
};

export type CapabilityReader = {
  // Returns the cached snapshot when it is still within the TTL; otherwise performs a
  // fresh read (recording success or failure) before returning it.
  read(): Promise<CapabilitySnapshot>;
  // Always performs a fresh read regardless of TTL, and re-caches the outcome.
  refresh(): Promise<CapabilitySnapshot>;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const EMPTY_SNAPSHOT: CapabilitySnapshot = { capabilities: {}, requiredActions: [], readAt: null };

export function readPlatformCapabilities(
  sandbox: WhopPort,
  platformAccountId: WhopAccountId,
  options: { ttlMs?: number; now?: () => Date } = {},
): CapabilityReader {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => new Date());
  let cached: CapabilitySnapshot = EMPTY_SNAPSHOT;
  let cachedAtMs: number | null = null;
  let sequence = 0;

  async function load(): Promise<CapabilitySnapshot> {
    const idempotencyKey = `capabilities-read-${++sequence}`;
    const response = await sandbox.getAccount(platformAccountId, idempotencyKey);
    cachedAtMs = now().getTime();
    if (!response.ok) {
      // A failed read must not silently keep serving a prior success as if it still
      // held: gated operations fall back to mock, and readAt: null says the read
      // never landed rather than pretending nothing changed.
      cached = EMPTY_SNAPSHOT;
      return cached;
    }
    const parsed = platformAccountRawSchema.safeParse(response.value.raw);
    cached = {
      capabilities: parsed.success ? (parsed.data.capabilities ?? {}) : {},
      requiredActions: parsed.success
        ? (parsed.data.required_actions ?? []).map((action) => action.action)
        : [],
      readAt: new Date(cachedAtMs),
    };
    return cached;
  }

  return {
    async read() {
      const isFresh = cachedAtMs !== null && now().getTime() - cachedAtMs < ttlMs;
      return isFresh ? cached : load();
    },
    refresh: load,
  };
}
