import type { TourState } from "./tour";

/**
 * One continuous presentation journey: intro slides, the real product demo,
 * closing slides. Presentation owns the slide anchors; the runtime owns the
 * demo start and end. This module holds the pieces both sides share: return
 * target validation, outcome naming and the session record that survives
 * navigation, refresh and back.
 */

export const JOURNEY_STORAGE_KEY = "ledgerly.demo.journey";
export const DEMO_RUN_COOKIE = "ledgerly_demo_run";

/** Internal paths the demo may return to. Presentation adds its prefix here through contract/tour-journey.md. */
export const DEFAULT_RETURN_ALLOWLIST: readonly string[] = ["/deck", "/present", "/presentation"];

export type JourneyOutcome = "completed" | "partial" | "blocked" | "skipped" | "unavailable";

export interface JourneyRecord {
  run_id: string | null;
  /** Step the run was on when it ended, for blocked, partial and skipped outcomes. */
  step_id?: string | null;
  /** Validated internal return path, e.g. /deck. */
  return_to: string;
  /** Slide id the deck was on when it deep-linked into the demo. */
  from_slide: string | null;
  started_at: string;
  /** Set once the demo ends; the deck reads it to pick the closing slide. */
  outcome: JourneyOutcome | null;
  ended_at: string | null;
}

const SCHEME_AFTER_SLASH = /^\/[a-z][a-z0-9+.-]*:/i;

/** True when the string holds a backslash or any ASCII control character. */
function hasControlOrBackslash(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127 || ch === "\\") return true;
  }
  return false;
}

/**
 * Accepts only same-origin absolute paths under the allowlist. Rejects
 * schemes, protocol-relative URLs, backslashes, control characters, encoded
 * slashes and traversal, so a crafted link cannot bounce a viewer off the site.
 */
export interface ReturnPolicy {
  /** Same-origin path prefixes. */
  paths?: readonly string[];
  /** Absolute deck origins, e.g. http://127.0.0.1:4412; the path must end in / or /index.html. */
  origins?: readonly string[];
}

export function parseReturnTarget(
  raw: string | null | undefined,
  allowlist: readonly string[] | ReturnPolicy = DEFAULT_RETURN_ALLOWLIST,
): string | null {
  const policy: ReturnPolicy = Array.isArray(allowlist)
    ? { paths: allowlist }
    : (allowlist as ReturnPolicy);
  const paths = policy.paths ?? DEFAULT_RETURN_ALLOWLIST;
  const origins = policy.origins ?? [];
  if (!raw) return null;
  if (/%5c/i.test(raw)) return null;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (hasControlOrBackslash(value)) return null;
  // Absolute deck URL on an allowed origin (the deck lives on another origin than the app).
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!origins.includes(url.origin)) return null;
    if (url.username || url.password) return null;
    if (!(url.pathname.endsWith("/") || url.pathname.endsWith("/index.html"))) return null;
    if (url.pathname.includes("..")) return null;
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  }
  if (/%2f/i.test(raw)) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("..")) return null;
  if (SCHEME_AFTER_SLASH.test(value)) return null;
  const path = value.split(/[?#]/)[0] ?? "";
  const ok = paths.some(
    (prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`),
  );
  return ok ? value : null;
}

/** The demo's outcome as the closing slides must state it. Only a full pass is completed. */
export function outcomeOf(state: TourState | null, interrupted = false): JourneyOutcome {
  if (!state || state.steps.length === 0) return "unavailable";
  if (state.outcome === "completed") return "completed";
  if (interrupted && state.outcome === "in-progress") return "skipped";
  if (state.outcome === "blocked") return "blocked";
  return "partial";
}

/** Closing slide anchor per outcome. Presentation implements these ids. */
export const CLOSING_ANCHOR: Record<JourneyOutcome, string> = {
  completed: "closing-completed",
  partial: "closing-partial",
  blocked: "closing-blocked",
  skipped: "closing-skipped",
  unavailable: "closing-unavailable",
};

/** Builds the URL the demo hands back to the deck. Query carries the facts; the hash picks the slide. */
export function buildReturnUrl(record: JourneyRecord, outcome: JourneyOutcome): string {
  const base = record.return_to.split(/[?#]/)[0] ?? "/";
  const q = new URLSearchParams();
  q.set("demo", outcome);
  if (record.run_id) q.set("run", record.run_id);
  if (record.step_id && outcome !== "completed") q.set("step", record.step_id);
  if (record.from_slide) q.set("from", record.from_slide);
  return `${base}?${q.toString()}#${CLOSING_ANCHOR[outcome]}`;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function saveJourney(storage: KeyValueStorage, record: JourneyRecord): void {
  storage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(record));
}

export function loadJourney(storage: KeyValueStorage): JourneyRecord | null {
  const raw = storage.getItem(JOURNEY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<JourneyRecord>;
    if (typeof r.return_to !== "string" || typeof r.started_at !== "string") return null;
    return {
      run_id: r.run_id ?? null,
      return_to: r.return_to,
      from_slide: r.from_slide ?? null,
      started_at: r.started_at,
      outcome: r.outcome ?? null,
      ended_at: r.ended_at ?? null,
    };
  } catch {
    return null;
  }
}

export function clearJourney(storage: KeyValueStorage): void {
  storage.removeItem(JOURNEY_STORAGE_KEY);
}

const SLIDE_ID = /^#?[A-Za-z0-9_-]{1,64}$/;

/** Start record for `/demo/start?return=…&from=…`. Returns null when the return target is not allowed. */
export function startJourney(
  params: URLSearchParams,
  run_id: string | null,
  now: () => Date = () => new Date(),
  allowlist?: readonly string[] | ReturnPolicy,
): JourneyRecord | null {
  const return_to = parseReturnTarget(params.get("return"), allowlist);
  if (!return_to) return null;
  const from = params.get("from");
  return {
    run_id,
    return_to,
    from_slide: from && SLIDE_ID.test(from) ? from : null,
    started_at: now().toISOString(),
    outcome: null,
    ended_at: null,
  };
}

/** End record for Finish demo or Return to slides. `interrupted` is true for Return to slides. */
export function endJourney(
  record: JourneyRecord,
  state: TourState | null,
  interrupted: boolean,
  now: () => Date = () => new Date(),
): { record: JourneyRecord; url: string } {
  const outcome = outcomeOf(state, interrupted);
  const active = state && state.active_index >= 0 ? state.steps[state.active_index] : null;
  const ended: JourneyRecord = {
    ...record,
    step_id: active?.step.id ?? record.step_id ?? null,
    outcome,
    ended_at: now().toISOString(),
  };
  return { record: ended, url: buildReturnUrl(ended, outcome) };
}
