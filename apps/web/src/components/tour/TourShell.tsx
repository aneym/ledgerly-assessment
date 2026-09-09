"use client";
// The guided tour on the real app: overlay on the marketplace's data-tour controls and the
// live trace panel fed by architecture's instrumentation stream. Renders nothing unless a
// demo journey is active (started through /demo/start, or ?tour= on the URL).
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { DemoEvent } from "../../../../../packages/demo-runtime/src/contract";
import {
  CORRELATION_HEADER,
  CorrelationTable,
  mapTourInstrumentation,
  type PersistedInstrumentationRow,
} from "../../../../../packages/demo-runtime/src/instrumentation";
import {
  buildReturnUrl,
  JOURNEY_STORAGE_KEY,
  type JourneyRecord,
  loadJourney,
  saveJourney,
} from "../../../../../packages/demo-runtime/src/journey";
import type {
  FillValues,
  NextActionContext,
} from "../../../../../packages/demo-runtime/src/react/tour-overlay";
import { TourOverlay } from "../../../../../packages/demo-runtime/src/react/tour-overlay";
import { TracePanel } from "../../../../../packages/demo-runtime/src/react/trace-panel";
import { useTour } from "../../../../../packages/demo-runtime/src/react/use-tour";
import { isStepScreen, STEPS } from "../../../../../packages/demo-runtime/src/steps";
import type { TourStepState } from "../../../../../packages/demo-runtime/src/tour";
import { profileUrl } from "../../lib/demo-profile-url";
import { TEST_IDENTITIES } from "../../lib/dev/identities";
import { nextAction, profileForRole } from "./next-action";
import {
  canRetryUnknownAction,
  hasPendingTourProof,
  type PendingTourAction,
} from "./pending-action";

const CORRELATIONS_KEY = "ledgerly.demo.correlations";
const SKIPPED_KEY = "ledgerly.demo.skipped";
const PLAYING_KEY = "ledgerly.demo.playing";
const RETRY_KEY = "ledgerly.demo.retryAfter";
const VIEW_KEY = "ledgerly.demo.view";
const PENDING_KEY = "ledgerly.demo.pendingAction";
const RUN_COOKIE = "ledgerly_demo_run";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Overrides the correlation header on every fetch while a step is active, so the
 * marketplace's own api client needs no change and the server joins the request to the
 * step. Restores the original fetch on unmount.
 */
type ResponseNote = { status: number; error: string | null };

/**
 * Overrides the correlation header on every fetch while a step is active, so the
 * marketplace's own api client needs no change and the server joins the request to the
 * step. Also tracks in-flight correlations and keeps the response status and error code
 * per correlation, so the overlay can show the actual failure and block a second click
 * while the first request is still open. Restores the original fetch on unmount.
 */
function installTourFetch(
  current: () => string | null,
  track: { start: (corr: string) => void; end: (corr: string, note: ResponseNote) => void },
): () => void {
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const target = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    );
    const path = target.pathname;
    if (target.origin !== window.location.origin || path.startsWith("/api/demo/"))
      return original(input, init);
    const corr = current();
    if (!corr) return original(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(CORRELATION_HEADER, corr);
    track.start(corr);
    try {
      const res = await original(input, { ...init, headers });
      let error: string | null = null;
      if (!res.ok) {
        try {
          const body = (await res.clone().json()) as { error?: unknown; message?: unknown };
          const raw = body.error ?? body.message;
          error = typeof raw === "string" ? raw.slice(0, 80) : null;
        } catch {
          error = null;
        }
      }
      track.end(corr, { status: res.status, error });
      return res;
    } catch (err) {
      track.end(corr, { status: 0, error: "network" });
      throw err;
    }
  };
  return () => {
    window.fetch = original;
  };
}

export function TourShell() {
  const [journey, setJourney] = useState<JourneyRecord | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [autoplay, setAutoplayState] = useState(false);
  const setAutoplay = useCallback((v: boolean) => {
    setAutoplayState(v);
    try {
      sessionStorage.setItem(PLAYING_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);
  const [open, setOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const reduced = useReducedMotion() ?? false;
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const table = useRef(new CorrelationTable());
  const runRef = useRef<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const dispatched = useRef(new Set<string>());
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const restoredPending = useRef(false);
  const notes = useRef(new Map<string, ResponseNote>());
  const [inFlightCount, setInFlightCount] = useState(0);
  const [retryAfter, setRetryAfter] = useState<Record<string, number>>({});
  const activeCorrelation = useRef<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingTourAction | null>(null);
  // The presenter's view cursor (Back/Next). null follows the active step. Survives the
  // navigation Back or Next triggers when the step's control is on another screen.
  const [view, setViewState] = useState<string | null>(null);
  // Who is presenting: the sample persona's display name when the deployment configures one.
  const [personaName, setPersonaName] = useState<string | null>(null);
  const [health, setHealth] = useState<{
    step: string | null;
    operator_session: boolean;
    persona: boolean;
    profiles: boolean;
    profile: string | null;
  } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const retryFailures = useRef<
    Record<string, { failure: TourStepState["failure"]; correlation: string }>
  >({});
  const preparedRetry = useRef<string | null>(null);
  const setView = useCallback((id: string | null) => {
    setViewState(id);
    try {
      if (id) sessionStorage.setItem(VIEW_KEY, id);
      else sessionStorage.removeItem(VIEW_KEY);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let record: JourneyRecord | null = null;
    try {
      record = loadJourney(sessionStorage);
    } catch {
      record = null;
    }
    const params = new URLSearchParams(window.location.search);
    const runParam = params.get("run");
    if (record && runParam && record.run_id !== runParam) {
      record = { ...record, run_id: runParam };
      try {
        saveJourney(sessionStorage, record);
      } catch {
        // ignore
      }
    }
    if (!record && params.get("tour")) {
      const ret = params.get("return") ?? "/deck";
      record = {
        run_id: runParam ?? readCookie(RUN_COOKIE),
        return_to: ret,
        from_slide: params.get("from"),
        started_at: new Date().toISOString(),
        outcome: null,
        ended_at: null,
      };
      try {
        saveJourney(sessionStorage, record);
      } catch {
        // Session storage may be unavailable; the tour still runs for this page.
      }
    }
    if (!record) return;
    table.current.load(readJson<Record<string, string>>(CORRELATIONS_KEY, {}));
    setSkipped(new Set(readJson<string[]>(SKIPPED_KEY, [])));
    setRetryAfter(readJson<Record<string, number>>(RETRY_KEY, {}));
    try {
      if (sessionStorage.getItem(PLAYING_KEY) === "1") setAutoplayState(true);
      const v = params.get("view") ?? sessionStorage.getItem(VIEW_KEY);
      if (v && STEPS.some((s) => s.id === v)) setViewState(v);
    } catch {
      // ignore
    }
    const pending = readJson<PendingTourAction | null>(PENDING_KEY, null);
    if (pending?.run === record.run_id) {
      setPendingAction(pending);
      restoredPending.current = true;
    }
    setJourney(record);
    const known = record.run_id ?? runParam ?? readCookie(RUN_COOKIE);
    // The mapper needs the run id before the snapshot answers, or the first frames after a
    // navigation are dropped and a passed step reads as pending.
    runRef.current = known;
    setRunId(known);
  }, []);

  useEffect(
    () =>
      installTourFetch(() => activeCorrelation.current, {
        start: (corr) => {
          dispatched.current.add(corr);
          inFlight.current.add(corr);
          setInFlightCount(inFlight.current.size);
        },
        end: (corr, note) => {
          inFlight.current.delete(corr);
          notes.current.set(corr, note);
          if (note.status === 0)
            setPendingAction((pending) => {
              if (!pending || pending.correlation !== corr) return pending;
              const next = { ...pending, networkUnknown: true };
              try {
                sessionStorage.setItem(PENDING_KEY, JSON.stringify(next));
              } catch {
                /* unavailable storage */
              }
              return next;
            });
          setInFlightCount(inFlight.current.size);
        },
      }),
    [],
  );

  // Reflow the page beside the side drawer so a target control is never under the panel.
  useEffect(() => {
    if (!journey || !open || narrow) return;
    const prev = document.body.style.paddingRight;
    document.body.style.paddingRight = "380px";
    return () => {
      document.body.style.paddingRight = prev;
    };
  }, [journey, open, narrow]);

  const mapReplay = useCallback(
    (rows: unknown[], run: string) =>
      mapTourInstrumentation(rows as PersistedInstrumentationRow[], run),
    [],
  );
  const buildUrl = useCallback(
    (base: string, after: number, run: string) =>
      `${base}?run_id=${encodeURIComponent(run)}&after=${after}`,
    [],
  );
  const tour = useTour({
    eventsUrl: "/api/demo/events",
    snapshotUrl: runId
      ? `/api/demo/snapshot?run=${encodeURIComponent(runId)}`
      : "/api/demo/snapshot",
    runId,
    steps: STEPS,
    skipped,
    mapReplay,
    retryAfter,
    buildUrl,
  });
  const historyReady = tour.ready && tour.connected;
  useEffect(() => {
    if (
      !pendingAction ||
      !tour.ready ||
      !hasPendingTourProof(pendingAction, tour.events, tour.state)
    )
      return;
    setPendingAction(null);
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* unavailable storage */
    }
  }, [pendingAction, tour.ready, tour.events, tour.state]);
  // Playing: when the active step's control is on another screen, go there. The journey,
  // run id, correlations and the playing flag all live in session storage and survive it.
  const navigatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!autoplay || !journey || !historyReady || pendingAction) return;
    const active = tour.state.active_index >= 0 ? tour.state.steps[tour.state.active_index] : null;
    if (!active?.step.path) return;
    if (
      ["admin", "operator", "platform"].includes(active.step.role) &&
      (!health || health.step !== active.step.id || (!health.operator_session && health.persona))
    )
      return;
    if (!health || (health.profiles && profileForRole(active.step.role) !== health.profile)) return;
    if (document.querySelector(`[data-tour="${CSS.escape(active.step.anchor)}"]`)) return;
    if (isStepScreen(active.step.path, window.location)) return;
    if (navigatedFor.current === active.step.id) return;
    navigatedFor.current = active.step.id;
    const url = new URL(active.step.path, window.location.origin);
    const corr = table.current.begin(active.step.id);
    sessionStorage.setItem(CORRELATIONS_KEY, JSON.stringify(table.current.dump()));
    url.searchParams.set("correlationId", corr);
    if (runId) url.searchParams.set("run", runId);
    url.searchParams.set("return", journey.return_to);
    url.searchParams.set("tour", active.step.id);
    window.location.assign(url.toString());
  }, [autoplay, journey, tour.state, health, runId, historyReady, pendingAction]);

  useEffect(() => {
    if (tour.run_id) runRef.current = tour.run_id;
    if (!runId && tour.run_id) setRunId(tour.run_id);
  }, [tour.run_id, runId]);

  // Exactly one stream per viewer: the run-scoped stream inside useTour. The server stamps
  // the run id on every instrumentation row, so a second stream per step attempt only added
  // poll loops against the database; production ran out of connection slots that way.
  const onAct = useCallback((step: TourStepState) => {
    const corr =
      preparedRetry.current === step.step.id && activeCorrelation.current
        ? activeCorrelation.current
        : table.current.begin(step.step.id);
    preparedRetry.current = null;
    activeCorrelation.current = corr;
    setActionNotice(null);
    restoredPending.current = false;
    const pending: PendingTourAction | null = runRef.current
      ? {
          run: runRef.current,
          step: step.step.id,
          anchor: step.step.anchor,
          correlation: corr,
          afterSeq: step.last_seq,
        }
      : null;
    const arm = () => {
      if (!pending) return;
      flushSync(() => setPendingAction(pending));
      try {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch {
        /* unavailable storage */
      }
    };
    try {
      sessionStorage.setItem(CORRELATIONS_KEY, JSON.stringify(table.current.dump()));
    } catch {
      // Best effort; a refresh then starts a fresh correlation for the step.
    }
    const anchor = document.querySelector(`[data-tour="${CSS.escape(step.step.anchor)}"]`);
    if (anchor instanceof HTMLAnchorElement && anchor.origin === window.location.origin) {
      const url = new URL(anchor.href);
      url.searchParams.set("correlationId", corr);
      anchor.href = url.toString();
      arm();
    }
    // The overlay owns the one real click; the shell only mints the correlation so the
    // request joins the step. Two clicks here once produced two POSTs per step.
    return () => {
      if (anchor instanceof HTMLAnchorElement) return;
      if (dispatched.current.has(corr)) arm();
      else
        setActionNotice(
          "No request was sent. Check the highlighted form or control, then try Next again.",
        );
    };
  }, []);

  // A failed step pauses the tour; nothing clicks again until Retry or Skip.
  const activeStep =
    tour.state.active_index >= 0 ? tour.state.steps[tour.state.active_index] : null;
  useEffect(() => {
    if (autoplay && activeStep?.status === "failed") setAutoplay(false);
  }, [autoplay, activeStep, setAutoplay]);

  // Deck bridge (D12): the deck under /present listens on this channel for the tour's step
  // and sends nav commands; both sides stay same-origin and in the same browser profile.
  const activeId = activeStep?.step.id ?? null;
  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    fetch("/api/demo/health", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          value: {
            operator_session?: boolean;
            persona?: { name?: string } | null;
            profiles?: boolean;
            profile?: string | null;
          } | null,
        ) => {
          if (cancelled || !value) return;
          setHealth({
            step: activeId,
            operator_session: value.operator_session === true,
            persona: Boolean(value.persona),
            profiles: value.profiles === true,
            profile: value.profile ?? null,
          });
          setPersonaName(value.persona?.name ?? null);
        },
      )
      .catch(() => {
        /* Unknown health cannot authorize an operator action. */
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);
  const decideNext = useCallback(
    (context: NextActionContext) =>
      nextAction({
        ...context,
        health: health?.step === activeId ? health : null,
        signingIn,
        historyReady,
        awaitingProof: pendingAction !== null,
      }),
    [health, activeId, signingIn, historyReady, pendingAction],
  );
  const fillValues = useCallback(
    (step: TourStepState) => {
      if (!step.step.fill?.length || !runId) return null;
      // Per-run fictional seller identity: a fresh name and plus-address per run, because
      // Whop derives the connected account's external id from name plus email and refuses a
      // second account for the same pair (dev-profiles finding).
      const suffix = runId
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(-10)
        .toLowerCase();
      const [local, domain] = TEST_IDENTITIES.seller.email.split("@");
      return {
        name: `Demo Seller ${suffix}`,
        email: `${local}+demo-${suffix}@${domain}`,
        password: "",
      };
    },
    [runId],
  );
  const lastActive = useRef<string | null>(null);
  useEffect(() => {
    if (lastActive.current !== null && lastActive.current !== activeId) setView(null);
    lastActive.current = activeId;
  }, [activeId, setView]);
  const viewIndex = view ? tour.state.steps.findIndex((s) => s.step.id === view) : -1;

  const goTo = useCallback(
    (step: TourStepState, revisit: boolean) => {
      const url = new URL(step.step.path ?? window.location.pathname, window.location.origin);
      if (!revisit) {
        const corr = table.current.begin(step.step.id);
        activeCorrelation.current = corr;
        sessionStorage.setItem(CORRELATIONS_KEY, JSON.stringify(table.current.dump()));
        url.searchParams.set("correlationId", corr);
      }
      if (runId) url.searchParams.set("run", runId);
      if (journey) url.searchParams.set("return", journey.return_to);
      if (journey?.from_slide) url.searchParams.set("from", journey.from_slide);
      url.searchParams.set("tour", step.step.id);
      if (revisit) url.searchParams.set("view", step.step.id);
      window.location.assign(url.toString());
    },
    [runId, journey],
  );
  const onView = useCallback(
    (index: number) => {
      const target = tour.state.steps[index];
      if (!target) return;
      const revisit = index !== tour.state.active_index;
      setView(revisit ? target.step.id : null);
      const here = document.querySelector(`[data-tour="${CSS.escape(target.step.anchor)}"]`);
      if (!here && target.step.path && !isStepScreen(target.step.path, window.location))
        goTo(target, revisit);
    },
    [tour.state, setView, goTo],
  );
  const onNavigate = useCallback((step: TourStepState) => goTo(step, false), [goTo]);

  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("ledgerly-presenter");
    channel.current = ch;
    return () => {
      ch.close();
      channel.current = null;
    };
  }, []);
  useEffect(() => {
    if (!journey) return;
    const shown = view ? tour.state.steps.find((s) => s.step.id === view) : activeStep;
    if (!shown) return;
    channel.current?.postMessage({
      type: "step",
      id: shown.step.id,
      title: shown.step.title,
      status: shown.status,
      run: runId,
    });
  }, [journey, view, activeStep, tour.state.steps, runId]);

  const canAct = useCallback(
    (step: TourStepState) => {
      if (!historyReady || pendingAction) return false;
      void inFlightCount;
      for (const [corr, sid] of Object.entries(table.current.dump()))
        if (sid === step.step.id && inFlight.current.has(corr)) return false;
      return true;
    },
    [inFlightCount, historyReady, pendingAction],
  );

  const failureNote = useCallback((step: TourStepState) => {
    const corr = (step.failure ?? retryFailures.current[step.step.id]?.failure)?.correlation_id;
    const note = corr ? notes.current.get(corr) : undefined;
    return note?.error ?? null;
  }, []);

  const onRetry = useCallback((step: TourStepState) => {
    const corr = table.current.begin(step.step.id);
    retryFailures.current[step.step.id] = { failure: step.failure, correlation: corr };
    activeCorrelation.current = corr;
    preparedRetry.current = step.step.id;
    try {
      sessionStorage.setItem(CORRELATIONS_KEY, JSON.stringify(table.current.dump()));
    } catch {
      /* best effort */
    }
    setRetryAfter((prev) => {
      const next = { ...prev, [step.step.id]: step.last_seq };
      try {
        sessionStorage.setItem(RETRY_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const onSkip = useCallback((step: TourStepState) => {
    // Explicit abandonment unlocks presentation only; it never supplies terminal proof.
    setPendingAction(null);
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* unavailable storage */
    }
    setSkipped((prev) => {
      const next = new Set(prev).add(step.step.id);
      try {
        sessionStorage.setItem(SKIPPED_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const leave = useCallback(
    (interrupted: boolean) => {
      if (!journey) return;
      const q = new URLSearchParams({ return: journey.return_to });
      if (journey.from_slide) q.set("from", journey.from_slide);
      if (runId) q.set("run", runId);
      if (skipped.size) q.set("skipped", [...skipped].join(","));
      try {
        sessionStorage.removeItem(JOURNEY_STORAGE_KEY);
        sessionStorage.removeItem(CORRELATIONS_KEY);
        sessionStorage.removeItem(SKIPPED_KEY);
        sessionStorage.removeItem(VIEW_KEY);
        sessionStorage.removeItem(PLAYING_KEY);
        sessionStorage.removeItem(RETRY_KEY);
        sessionStorage.removeItem(PENDING_KEY);
      } catch {
        // ignore
      }
      window.location.assign(`/demo/${interrupted ? "return" : "finish"}?${q.toString()}`);
    },
    [journey, runId, skipped],
  );

  // Mid-run account switch (W01 signs a new buyer in; W08 onward needs the operator): hand
  // the run and the current step to the intro, which brings the operator back to that step.
  const onSwitchAccount = useCallback(() => {
    if (!journey) return;
    const q = new URLSearchParams({ return: journey.return_to });
    if (journey.from_slide) q.set("from", journey.from_slide);
    if (runId) q.set("run", runId);
    const step = view ?? activeStep?.step.id ?? null;
    if (step) q.set("step", step);
    window.location.assign(`/demo?${q.toString()}`);
  }, [journey, runId, view, activeStep]);

  const onReSession = useCallback(() => {
    if (!journey || !runId || !activeStep || signingIn) return;
    const purchased = tour.state.steps.find((state) => state.step.id === "C03");
    const orderId = purchased?.proof.observed.tour_order_id;
    // Show the paid receipt while still the buyer before switching to the seller's earnings.
    if (
      activeStep.step.id === "C04" &&
      health?.profile === "buyer" &&
      orderId &&
      window.location.pathname !== `/receipt/${encodeURIComponent(orderId)}`
    ) {
      const receipt = new URL(`/receipt/${encodeURIComponent(orderId)}`, window.location.origin);
      const corr = table.current.begin("C03");
      sessionStorage.setItem(CORRELATIONS_KEY, JSON.stringify(table.current.dump()));
      receipt.searchParams.set("correlationId", corr);
      receipt.searchParams.set("run", runId);
      receipt.searchParams.set("tour", "C03");
      receipt.searchParams.set("return", journey.return_to);
      window.location.assign(receipt.toString());
      return;
    }
    setView(null);
    flushSync(() => setSigningIn(true));
    const q = new URLSearchParams({
      return: journey.return_to,
      run: runId,
      step: activeStep.step.id,
    });
    if (journey.from_slide) q.set("from", journey.from_slide);
    const needed = profileForRole(activeStep.step.role);
    if (health?.profiles && needed) {
      // Per-run profile switch: come back to this chapter's screen in the same run.
      const next = new URL(
        activeStep.step.path ?? window.location.pathname,
        window.location.origin,
      );
      const corr = table.current.begin(activeStep.step.id);
      sessionStorage.setItem(CORRELATIONS_KEY, JSON.stringify(table.current.dump()));
      next.searchParams.set("correlationId", corr);
      next.searchParams.set("tour", activeStep.step.id);
      next.searchParams.set("run", runId);
      next.searchParams.set("return", journey.return_to);
      if (journey.from_slide) next.searchParams.set("from", journey.from_slide);
      window.location.assign(profileUrl(needed, `${next.pathname}${next.search}`));
      return;
    }
    window.location.assign(`/demo/session?${q.toString()}`);
  }, [journey, runId, activeStep, signingIn, setView, health, tour.state.steps]);
  const retryFailure = useCallback(
    (step: TourStepState) => {
      const previous = retryFailures.current[step.step.id];
      if (!previous) return null;
      return pendingRetryFailure(previous.failure, previous.correlation, tour.events);
    },
    [tour.events],
  );

  const disclosure = useMemo(() => {
    const active = tour.state.active_index >= 0 ? tour.state.steps[tour.state.active_index] : null;
    if (!active) return null;
    const mock = active.proof.provider.find((p) => p.source === "mock");
    return mock
      ? `This step used the simulated transport${mock.fallback_gate ? ` (${mock.fallback_gate.id})` : ""}; identity, database and enabled sandbox calls are real.`
      : null;
  }, [tour.state]);

  if (!journey) return null;
  return (
    <>
      {(actionNotice || pendingAction?.networkUnknown) && (
        <aside
          role="alert"
          style={{
            position: "fixed",
            bottom: 85,
            left: 24,
            zIndex: 1010,
            background: "white",
            padding: 16,
            maxWidth: 440,
          }}
        >
          <p>
            {actionNotice ??
              "The request outcome is unknown because the connection failed. Check the saved server history before another action."}
          </p>
          {pendingAction?.networkUnknown && (
            <button type="button" onClick={() => window.location.reload()}>
              Check saved outcome
            </button>
          )}
          {pendingAction &&
            restoredPending.current &&
            canRetryUnknownAction(pendingAction, historyReady) && (
              <button
                type="button"
                onClick={() => {
                  setPendingAction(null);
                  sessionStorage.removeItem(PENDING_KEY);
                  setActionNotice(
                    "Seller setup uses the same saved identity. Next safely creates or fetches that seller.",
                  );
                }}
              >
                Retry seller setup with the same identity
              </button>
            )}
          {pendingAction?.networkUnknown && pendingAction.step !== "C01" && (
            <p>
              The tour will not repeat a payment or repair with an unknown outcome. Return to the
              presentation if the saved history cannot resolve it.
            </p>
          )}
        </aside>
      )}
      <TourOverlay
        state={tour.state}
        fillValues={fillValues}
        decideNext={decideNext}
        onReSession={onReSession}
        signingIn={signingIn}
        retryFailure={retryFailure}
        autoplay={autoplay && historyReady && !pendingAction}
        onAct={onAct}
        onSkip={onSkip}
        onFinish={() => leave(false)}
        onReturn={() => leave(true)}
        canAct={canAct}
        onRetry={onRetry}
        failureNote={failureNote}
        rightInset={open && !narrow ? 380 : 0}
        bottomInset={open && narrow ? Math.round(window.innerHeight * 0.42) : 0}
        viewIndex={viewIndex >= 0 ? viewIndex : undefined}
        onView={onView}
        onNavigate={onNavigate}
        onTogglePlay={() => setAutoplay(!autoplay)}
        onSwitchAccount={personaName ? undefined : onSwitchAccount}
        personaName={personaName}
      />
      <AnimatePresence initial={false}>
        {open ? (
          <motion.aside
            key={narrow ? "tour-panel-sheet" : "tour-panel-side"}
            aria-label="Backend log panel"
            initial={reduced ? false : narrow ? { y: "100%" } : { x: 400 }}
            animate={narrow ? { y: 0 } : { x: 0 }}
            exit={reduced ? undefined : narrow ? { y: "100%" } : { x: 400 }}
            transition={
              reduced ? { duration: 0 } : { type: "spring", bounce: 0, visualDuration: 0.36 }
            }
            style={{
              position: "fixed",
              zIndex: 1001,
              display: "flex",
              flexDirection: "column",
              background: "var(--paper, #fff)",
              color: "var(--ink, #26251f)",
              fontFamily: "var(--font-sans, system-ui, sans-serif)",
              ...(narrow
                ? {
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: "42vh",
                    borderTop: "1px solid var(--line, #e3e0d9)",
                    boxShadow: "var(--sh-3, 0 -12px 28px rgba(38,37,31,.12))",
                  }
                : {
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 380,
                    borderLeft: "1px solid var(--line, #e3e0d9)",
                    boxShadow: "var(--sh-3, -12px 0 28px rgba(38,37,31,.1))",
                  }),
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--line, #e3e0d9)",
                fontSize: 12,
                display: "flex",
                gap: 10,
                alignItems: "center",
                background: "var(--plate, #efede8)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-serif, Georgia, serif)",
                  fontSize: 15,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                Guided demo
              </span>
              <span
                aria-live="polite"
                style={{
                  color: tour.connected ? "var(--ok, #3f6b4f)" : "var(--warn, #8a6116)",
                  whiteSpace: "nowrap",
                }}
              >
                {tour.error ??
                  (!tour.ready ? "restoring history" : tour.connected ? "live" : "reconnecting")}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Hide backend log"
                style={{
                  font: "inherit",
                  border: "1px solid var(--line, #e3e0d9)",
                  background: "var(--paper, #fff)",
                  borderRadius: 999,
                  padding: "2px 10px",
                  cursor: "pointer",
                }}
              >
                Hide
              </button>
            </div>
            {disclosure ? (
              <div
                style={{
                  padding: "6px 14px",
                  background: "var(--warn-soft, #f2e7d1)",
                  color: "var(--warn, #8a6116)",
                  fontSize: 12,
                }}
              >
                {disclosure}
              </div>
            ) : null}
            <div style={{ flex: 1, minHeight: 0 }}>
              <TracePanel events={tour.events} />
            </div>
          </motion.aside>
        ) : (
          <motion.button
            key="tour-panel-toggle"
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Show backend log"
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: 8 }}
            style={{
              position: "fixed",
              zIndex: 999,
              right: 16,
              bottom: 16,
              font: "inherit",
              fontSize: 13,
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid var(--line, #e3e0d9)",
              background: "var(--paper, #fff)",
              color: "var(--ink, #26251f)",
              boxShadow: "var(--sh-2, 0 6px 16px rgba(38,37,31,.08))",
              cursor: "pointer",
            }}
          >
            Backend log · {tour.events.length}
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

export { buildReturnUrl };

/** Only the session-local record retains the generated password between renders and navigations. */
export function w01Values(
  storage: Pick<Storage, "getItem" | "setItem">,
  runId: string,
): FillValues {
  const key = "ledgerly.demo.w01";
  const raw = storage.getItem(key);
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      if (
        saved.run === runId &&
        typeof saved.password === "string" &&
        saved.password.length === 16 &&
        typeof saved.name === "string" &&
        typeof saved.email === "string"
      )
        return { name: saved.name, email: saved.email, password: saved.password };
    } catch {
      /* Replace a malformed session-local record. */
    }
  }
  const suffix = runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-32);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const values = {
    name: `Demo Buyer ${suffix}`,
    email: `demo-buyer-${suffix}@ledgerly.test`,
    password: Array.from(bytes, (byte) => alphabet[byte & 63]).join(""),
  };
  storage.setItem(key, JSON.stringify({ run: runId, ...values }));
  return values;
}

/** Starting a request is not an outcome; only this retry's response replaces the old error. */
export function pendingRetryFailure(
  failure: TourStepState["failure"],
  correlation: string,
  events: readonly Pick<DemoEvent, "kind" | "correlation_id">[],
): TourStepState["failure"] {
  return events.some(
    (event) =>
      event.correlation_id === correlation &&
      (event.kind === "request.finished" ||
        event.kind === "operation.responded" ||
        event.kind === "step.finished"),
  )
    ? null
    : failure;
}
