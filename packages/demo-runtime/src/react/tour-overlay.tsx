"use client";
import { isStepScreen } from "../steps";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { TourState, TourStepState } from "../tour";

export type NextActionKind = "act" | "fill" | "navigate" | "re-session" | "retry" | "finish" | "wait";
export interface NextActionContext {
  step: TourStepState | null;
  viewing: boolean;
  done: boolean;
  busy: boolean;
  anchorFound: boolean;
  onThisScreen: boolean;
}
export type FillValues = Record<"name" | "email" | "password", string>;

/** Use the native setter so React's value tracker sees each dispatched input event. */
export function fillStep(step: TourStepState, values: FillValues): boolean {
  const fields = (step.step.fill ?? []).map((field) => ({
    element: findAnchor(field.anchor), value: values[field.value],
  }));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!fields.length || !setter || fields.some(({ element }) => !(element instanceof HTMLInputElement))) return false;
  for (const { element, value } of fields) {
    setter.call(element, value);
    element?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
}

/** Exactly one native click, after filling and assigning this attempt's correlation. */
export function performStepAction(
  step: TourStepState,
  element: Pick<HTMLElement, "focus" | "click">,
  onAct?: (step: TourStepState) => void | (() => void),
  fillValues?: (step: TourStepState) => FillValues | null,
): boolean {
  if (step.step.action.kind === "observe" || ("disabled" in element && element.disabled)) return false;
  if (step.step.action.kind === "type") {
    const values = fillValues?.(step);
    if (!values || !fillStep(step, values)) return false;
    // The form's React state (and its submit button's disabled flag) updates after the
    // input events we just dispatched; click on the next task so the submit is enabled.
    const afterClick = onAct?.(step);
    setTimeout(() => {
      element.focus({ preventScroll: true });
      element.click();
      afterClick?.();
    }, 0);
    return true;
  }
  const afterClick = onAct?.(step);
  element.focus({ preventScroll: true });
  element.click();
  afterClick?.();
  return true;
}

export interface TourOverlayProps {
  state: TourState;
  fillValues?: (step: TourStepState) => FillValues | null;
  decideNext?: (context: NextActionContext) => NextActionKind;
  onReSession?: () => void;
  signingIn?: boolean;
  retryFailure?: (step: TourStepState) => TourStepState["failure"];
  /** Called when the step's action runs; the host performs navigation or typing if the control needs it. */
  onAct?: (step: TourStepState) => void | (() => void);
  /**
   * Perform click actions with the visible cursor. Off by default. Whether the presenter
   * drives or the tour drives is an open owner question; both modes read the same state.
   */
  autoplay?: boolean;
  /** Skip the active step. It is recorded as not done, never as passed. */
  onSkip?: (step: TourStepState) => void;
  onFinish?: () => void;
  onReturn?: () => void;
  /** Width of a fixed panel on the right the tooltip must not slide under. */
  rightInset?: number;
  /** Height of a fixed sheet at the bottom (narrow layouts) the tooltip must stay above. */
  bottomInset?: number;
  /** Pause before the tour clicks the next active step, so a viewer can read the tooltip. */
  autoplayDelayMs?: number;
  /** False while a request for this step is in flight; blocks a second click. */
  canAct?: (step: TourStepState) => boolean;
  /** Explicit safe retry of a failed step: a new attempt, a new correlation. */
  onRetry?: (step: TourStepState) => void;
  /** Client-observed response detail for a failed correlation, e.g. the error code. */
  failureNote?: (step: TourStepState) => string | null;
  /**
   * Index of the step the presenter is looking at. Defaults to the active step. Back and
   * Next move it; revisiting a passed step shows its tooltip and anchor without repeating
   * anything. Only the active step can act.
   */
  viewIndex?: number;
  /** Presenter moved the view cursor (Back, or Next while revisiting). */
  onView?: (index: number) => void;
  /** The shown step's control is on another screen: the host navigates there. */
  onNavigate?: (step: TourStepState) => void;
  /** Play/Pause from the persistent control bar. */
  onTogglePlay?: () => void;
  /** Sign in as another account and come back to this step of the same run. */
  onSwitchAccount?: () => void;
  /** Sample persona presenting the demo (fictional account minted by the server). */
  personaName?: string | null;
}

type Rect = { top: number; left: number; width: number; height: number };

function findAnchor(anchor: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(anchor)}"]`);
}

const LEVEL_LABEL: Record<TourStepState["proof"]["level"], string> = {
  none: "waiting",
  "local-ok": "local DB ok",
  "mock-ok": "mock provider",
  "sandbox-unconfirmed": "sandbox, status unconfirmed",
  "sandbox-ok": "sandbox ok",
};

const LEVEL_TONE: Record<TourStepState["proof"]["level"], string> = {
  none: "var(--muted, #6b675e)",
  "local-ok": "var(--ink, #26251f)",
  "mock-ok": "var(--warn, #8a6116)",
  "sandbox-unconfirmed": "var(--warn, #8a6116)",
  "sandbox-ok": "var(--ok, #3f6b4f)",
};

const STATUS_TONE: Record<TourStepState["status"], string> = {
  pending: "var(--line-strong, #c6c2b8)",
  active: "var(--accent, #9c4028)",
  observing: "var(--accent, #9c4028)",
  passed: "var(--ok, #3f6b4f)",
  failed: "var(--bad, #8f2f2f)",
  blocked: "var(--warn, #8a6116)",
  skipped: "var(--line-strong, #c6c2b8)",
};

const PAD = 8;
const TIP_W = 360;
const TIP_GAP = 14;
const TIP_H_ESTIMATE = 240;
/** Height reserved for the persistent control bar at the bottom of the usable viewport. */
const BAR_H = 72;

/** Spring that follows an anchor: no overshoot, settles fast, interruptible. */
const FOLLOW = { type: "spring", bounce: 0, visualDuration: 0.32 } as const;
const CURSOR = { type: "spring", bounce: 0.05, visualDuration: 0.55 } as const;

/**
 * Product-specific guided tour on the real app. A spotlight follows the real control
 * through scroll and resize, a tooltip explains the step, a visible cursor can perform the
 * click, and the status line changes only when the server log says so. Motion here is
 * presentation: nothing in this file advances a step.
 */
export function TourOverlay({
  state,
  onAct,
  autoplay = false,
  onSkip,
  onFinish,
  onReturn,
  rightInset = 0,
  bottomInset = 0,
  autoplayDelayMs = 1200,
  canAct,
  onRetry,
  failureNote,
  viewIndex,
  onView,
  onNavigate,
  onTogglePlay,
  onSwitchAccount,
  personaName,
  fillValues,
  decideNext,
  onReSession,
  signingIn,
  retryFailure,
}: TourOverlayProps) {
  const reduced = useReducedMotion() ?? false;
  // The step on screen: the presenter's view cursor when it points at another step, else the
  // active one. Spotlight and tooltip follow `active`; acting is only ever on the active step.
  const shownIndex =
    viewIndex !== undefined && viewIndex >= 0 && viewIndex < state.steps.length
      ? viewIndex
      : state.active_index;
  const viewing = shownIndex !== state.active_index && shownIndex >= 0;
  const active = shownIndex >= 0 ? (state.steps[shownIndex] ?? null) : null;
  const activeId = active?.step.id ?? null;
  const [anchorFound, setAnchorFound] = useState(false);
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  const actedFor = useRef<string | null>(null);
  const activeFailed = active?.status === "failed";
  useEffect(() => {
    // A retry returns the step to active; allow one more tour click for it.
    if (active && !activeFailed && actedFor.current === `${active.step.id}:${active.step.anchor}` && active.status === "active" && active.proof.request === null)
      actedFor.current = null;
  }, [active, activeFailed]);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // Raw measurements, then springs that follow them. Reduced motion reads the raw values.
  const rawTop = useMotionValue(0);
  const rawLeft = useMotionValue(0);
  const rawW = useMotionValue(0);
  const rawH = useMotionValue(0);
  const sTop = useSpring(rawTop, FOLLOW);
  const sLeft = useSpring(rawLeft, FOLLOW);
  const sW = useSpring(rawW, FOLLOW);
  const sH = useSpring(rawH, FOLLOW);
  const top = reduced ? rawTop : sTop;
  const left = reduced ? rawLeft : sLeft;
  const width = reduced ? rawW : sW;
  const height = reduced ? rawH : sH;
  const spotTop = useTransform(() => top.get() - PAD);
  const spotLeft = useTransform(() => left.get() - PAD);
  const spotW = useTransform(() => width.get() + PAD * 2);
  const spotH = useTransform(() => height.get() + PAD * 2);

  // Measured tooltip height, so placement uses the real box, not a guess.
  const tipH = useMotionValue(TIP_H_ESTIMATE);
  const tipRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => tipH.set(el.offsetHeight || TIP_H_ESTIMATE));
    ro.observe(el);
    tipH.set(el.offsetHeight || TIP_H_ESTIMATE);
    return () => ro.disconnect();
  }, [tipH]);

  // Placement order: below, right, left. The tooltip never covers the control:
  // when none of the four fit, it goes to the viewport corner farthest from the anchor.
  const usableW = () => viewport.w - rightInset;
  const usableH = () => viewport.h - bottomInset - BAR_H;
  const placement = useTransform(() => {
    const t = top.get();
    const l = left.get();
    const w = width.get();
    const h = height.get();
    const th = tipH.get();
    // Never above: a submit control sits under the fields the presenter types into, and a
    // tooltip above it would cover them. Below, beside, else the far corner.
    if (t + h + TIP_GAP + th <= usableH() - 12) return "below";
    if (l + w + TIP_GAP + TIP_W <= usableW() - 12) return "right";
    if (l - TIP_GAP - TIP_W >= 12) return "left";
    return "corner";
  });
  const tipTop = useTransform(() => {
    const t = top.get();
    const h = height.get();
    const th = tipH.get();
    switch (placement.get()) {
      case "below":
        return t + h + TIP_GAP;
      case "right":
      case "left":
        return Math.max(12, Math.min(t, usableH() - th - 12));
      default:
        return t + h / 2 < usableH() / 2 ? usableH() - th - 12 : 12;
    }
  });
  const tipLeft = useTransform(() => {
    const l = left.get();
    const w = width.get();
    switch (placement.get()) {
      case "right":
        return l + w + TIP_GAP;
      case "left":
        return l - TIP_GAP - TIP_W;
      case "corner":
        return l + w / 2 < usableW() / 2 ? usableW() - TIP_W - 12 : 12;
      default:
        return Math.max(12, Math.min(l, usableW() - TIP_W - 12));
    }
  });

  const cursorX = useMotionValue(40);
  const cursorY = useMotionValue(40);
  const cursorScale = useMotionValue(1);
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);

  // Measure the anchor every frame: scroll in any container, resize, layout shift. A missing
  // anchor keeps the last position and the tooltip says so.
  useLayoutEffect(() => {
    if (!active) {
      setAnchorFound(false);
      return;
    }
    let raf = 0;
    let last: Rect | null = null;
    const measure = () => {
      const el = findAnchor(active.step.anchor);
      if (!el) {
        setAnchorFound(false);
        raf = requestAnimationFrame(measure);
        return;
      }
      const r = el.getBoundingClientRect();
      if (
        !last ||
        last.top !== r.top ||
        last.left !== r.left ||
        last.width !== r.width ||
        last.height !== r.height
      ) {
        last = { top: r.top, left: r.left, width: r.width, height: r.height };
        rawTop.set(r.top);
        rawLeft.set(r.left);
        rawW.set(r.width);
        rawH.set(r.height);
      }
      setAnchorFound(true);
      raf = requestAnimationFrame(measure);
    };
    const onViewport = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    onViewport();
    measure();
    window.addEventListener("resize", onViewport);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onViewport);
    };
  }, [active, rawTop, rawLeft, rawW, rawH]);

  // Bring the control into view and, when the tour drives, move the cursor to it and click.
  useEffect(() => {
    if (viewing || !active || !anchorFound || !["active", "observing"].includes(active.status)) return;
    const el = findAnchor(active.step.anchor);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    if (!autoplay || active.step.action.kind === "observe" || actedFor.current === `${active.step.id}:${active.step.anchor}`)
      return;
    if (canAct && !canAct(active)) return;
    const decision = decideNext?.({ step: active, viewing, done: false, busy: false, anchorFound, onThisScreen: isStepScreen(active.step.path, window.location) });
    if (decision && decision !== "act" && decision !== "fill") return;
    actedFor.current = `${active.step.id}:${active.step.anchor}`;
    let cancelled = false;
    const run = async () => {
      await new Promise((r) => setTimeout(r, reduced ? 0 : autoplayDelayMs));
      if (cancelled) return;
      // Re-measure right before moving: the page may have shifted while we waited.
      const now = el.getBoundingClientRect();
      const point = { x: now.left + now.width / 2, y: now.top + now.height / 2 };
      if (reduced) {
        cursorX.set(point.x);
        cursorY.set(point.y);
      } else {
        await Promise.all([animate(cursorX, point.x, CURSOR), animate(cursorY, point.y, CURSOR)]);
        if (cancelled) return;
        await animate(cursorScale, 0.85, { duration: 0.08 });
        await animate(cursorScale, 1, { duration: 0.12 });
      }
      if (cancelled) return;
      setRipple({ x: point.x, y: point.y, id: Date.now() });
      performStepAction(active, el, onAct, fillValues);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    viewing,
    active,
    anchorFound,
    autoplay,
    reduced,
    onAct,
    cursorX,
    cursorY,
    cursorScale,
    autoplayDelayMs,
    canAct,
    decideNext,
    fillValues,
  ]);

  // Keyboard: when focus is already inside the tour, keep it on the primary action as steps
  // change; never pull focus away from the product control the presenter is using.
  useEffect(() => {
    const el = primaryRef.current;
    if (!el) return;
    if (document.activeElement?.closest("[data-tour-overlay]")) el.focus();
  }, []);

  // The primary button: the presenter's click on the tooltip becomes exactly one real click
  // on the control, after the host has minted this attempt's correlation.
  const act = useCallback(() => {
    if (!active || viewing) return;
    if (canAct && !canAct(active)) return;
    const el = findAnchor(active.step.anchor);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!reduced && autoplay) {
      animate(cursorX, r.left + r.width / 2, CURSOR);
      animate(cursorY, r.top + r.height / 2, CURSOR);
    }
    performStepAction(active, el, onAct, fillValues);
  }, [active, viewing, onAct, reduced, autoplay, cursorX, cursorY, canAct, fillValues]);

  const done = state.active_index === -1;
  const onThisScreen = (step: TourStepState) =>
    typeof window === "undefined" ||
    isStepScreen(step.step.path, window.location);
  // Next: one explicit primary. Revisiting: move the cursor forward. Otherwise it is the
  // active step's own action, gated by the server outcome, or the navigation to its screen.
  const next = ((): { label: string; run: (() => void) | null; hint: string | null } => {
    const busy = Boolean(active && canAct && !canAct(active));
    const context = { step: active, viewing, done, busy, anchorFound, onThisScreen: !active || onThisScreen(active) };
    // Standalone consumers retain the original behavior; the app supplies its pure policy.
    const decision = decideNext?.(context) ?? (
      viewing ? "navigate" : done ? "finish" : !active || busy ? "wait" :
      active.status === "failed" ? "retry" :
      active.status === "blocked" || active.status === "observing" ? "wait" :
      !anchorFound ? context.onThisScreen ? "wait" : "navigate" :
      active.step.action.kind === "type" ? "fill" : active.step.action.kind === "click" ? "act" : "wait"
    );
    switch (decision) {
      case "re-session":
        return { label: "Next", run: onReSession ?? null, hint: null };
      case "finish":
        return { label: "Finish demo", run: onFinish ?? null, hint: null };
      case "navigate":
        if (viewing) return { label: "Next", run: () => shownIndex + 1 < state.steps.length ? onView?.(shownIndex + 1) : onFinish?.(), hint: null };
        return { label: "Next", run: active && onNavigate ? () => onNavigate(active) : null, hint: null };
      case "retry":
        return { label: "Retry", run: active && onRetry ? () => onRetry(active) : null, hint: "retry with a new request" };
      case "act":
      case "fill":
        return { label: `Next: ${active?.step.action.label ?? "continue"}`, run: act, hint: null };
      case "wait":
        return { label: "Next", run: null, hint: signingIn ? "Signing the sample operator in" :
          active?.status === "blocked" ? `blocked by ${active.gate?.id ?? "a gate"}; skip to continue` :
          active && !anchorFound && context.onThisScreen ? `waiting for ${active.step.anchor} on this screen` :
          "waiting for the server outcome" };
    }
  })();
  const back =
    shownIndex > 0 && onView ? () => onView(shownIndex - 1) : null;
  const passed = state.steps.filter((s) => s.status === "passed").length;
  const blocked = state.steps.filter((s) => s.status === "blocked").length;
  const failed = state.steps.filter((s) => s.status === "failed").length;
  const fade = reduced ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] as const };
  const anchored = Boolean(active && anchorFound);
  const displayedFailure = active ? active.failure ?? retryFailure?.(active) : null;

  return (
    <div
      data-tour-overlay=""
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        pointerEvents: "none",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        color: "var(--ink, #26251f)",
      }}
    >
      <AnimatePresence>
        {anchored ? (
          <motion.div
            key="spotlight"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            style={{
              position: "fixed",
              top: spotTop,
              left: spotLeft,
              width: spotW,
              height: spotH,
              borderRadius: "var(--r-ctl, 12px)",
              boxShadow:
                "0 0 0 9999px rgba(38, 37, 31, 0.42), 0 0 0 1.5px var(--paper, #fff), var(--sh-2, 0 6px 16px rgba(38,37,31,.08))",
              willChange: "top, left, width, height",
            }}
          />
        ) : null}
      </AnimatePresence>

      {autoplay ? (
        <motion.div
          aria-hidden
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            x: cursorX,
            y: cursorY,
            scale: cursorScale,
            marginLeft: -4,
            marginTop: -3,
            width: 26,
            height: 30,
            transformOrigin: "4px 3px",
            filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))",
          }}
        >
          <svg width="26" height="30" viewBox="0 0 26 30" role="presentation">
            <path
              d="M3 2 L3 24 L8.5 18.5 L12.5 27.5 L16.5 25.5 L12.5 16.8 L20 16.8 Z"
              fill="var(--ink, #26251f)"
              stroke="var(--paper, #fff)"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>
      ) : null}
      <AnimatePresence>
        {ripple && !reduced ? (
          <motion.span
            key={ripple.id}
            aria-hidden
            initial={{ opacity: 0.45, scale: 0.2 }}
            animate={{ opacity: 0, scale: 1 }}
            transition={{ duration: 0.45, ease: [0.2, 0, 0, 1] }}
            onAnimationComplete={() => setRipple(null)}
            style={{
              position: "fixed",
              left: ripple.x - 22,
              top: ripple.y - 22,
              width: 44,
              height: 44,
              borderRadius: 999,
              border: "2px solid var(--accent, #9c4028)",
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          ref={tipRef}
          key={activeId ?? (done ? "done" : "starting")}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-live="polite"
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -6 }}
          transition={fade}
          style={{
            position: "fixed",
            pointerEvents: "auto",
            top: anchored ? tipTop : 24,
            left: anchored ? tipLeft : 24,
            width: `min(${TIP_W}px, calc(100vw - 24px))`,
            background: "var(--paper, #fff)",
            borderRadius: "var(--r-in, 16px)",
            boxShadow: "var(--sh-3, 0 12px 40px rgba(0,0,0,.2)), var(--ring, 0 0 0 1px #e3e0d9)",
            padding: 18,
            fontSize: 15,
            lineHeight: 1.5,
          }}
        >
          {active ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Dots steps={state.steps} activeId={active.step.id} reduced={reduced} />
                <span style={{ fontSize: 12, color: "var(--muted, #6b675e)" }}>
                  {state.active_index + 1} of {state.steps.length}
                </span>
              </div>
              <h2 id={titleId} style={heading}>
                {active.step.title}
              </h2>
              <p style={{ margin: 0, color: "var(--ink-2, #55524a)" }}>{active.step.content}</p>
              {viewing ? (
                <p style={{ margin: "8px 0 0", color: "var(--muted, #6b675e)", fontSize: 12 }}>
                  Revisiting: this step is {active.status}. Nothing runs again; Next moves on.
                </p>
              ) : null}
              {!anchorFound && !viewing ? (
                <p style={{ margin: "8px 0 0", color: "var(--bad, #8f2f2f)", fontSize: 12 }}>
                  {onThisScreen(active)
                    ? `Waiting for the ${active.step.action.label} button.`
                    : `This step's control is on ${active.step.path}. Press Next to go there.`}
                </p>
              ) : null}
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  minHeight: 22,
                }}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={active.proof.level}
                    initial={{ opacity: 0, y: reduced ? 0 : 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduced ? 0 : -4 }}
                    transition={fade}
                    style={{
                      fontSize: 12,
                      padding: "2px 10px",
                      borderRadius: "var(--r-pill, 999px)",
                      border: "1px solid var(--line, #e3e0d9)",
                      color: LEVEL_TONE[active.proof.level],
                      background: "var(--plate, #efede8)",
                    }}
                  >
                    {LEVEL_LABEL[active.proof.level]}
                  </motion.span>
                </AnimatePresence>
                {active.gate ? (
                  <span style={{ fontSize: 12, color: "var(--warn, #8a6116)" }}>
                    blocked by {active.gate.id}
                  </span>
                ) : null}
                {active.status === "observing" && active.proof.missing.length ? (
                  <span style={{ fontSize: 12, color: "var(--muted, #6b675e)" }}>
                    waiting for {active.proof.missing.join(", ")}
                  </span>
                ) : null}
              </div>
              {displayedFailure ? (
                <div
                  role="alert"
                  style={{
                    marginTop: 10,
                    padding: "8px 10px",
                    borderRadius: "var(--r-chip, 8px)",
                    background: "var(--bad-soft, #f0dfdb)",
                    color: "var(--bad, #8f2f2f)",
                    fontSize: 13,
                  }}
                >
                  Failed: {displayedFailure.route ?? "request"}
                  {displayedFailure.http_status !== null ? ` answered ${displayedFailure.http_status}` : ""}
                  {failureNote?.(active) ? ` (${failureNote(active)})` : ""}. {displayedFailure.summary} Nothing advanced. Fix the input
                  and retry, or skip.
                </div>
              ) : null}
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {/* The one action lives in the control bar (Next); the tooltip keeps Skip only. */}
                {viewing ? null : (
                  <button type="button" onClick={() => onSkip?.(active)} style={btn("ghost")}>
                    Skip
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <h2 id={titleId} style={heading}>
                {done ? `Demo ${state.outcome}` : "Demo starting"}
              </h2>
              <p style={{ margin: 0, color: "var(--ink-2, #55524a)" }}>
                {passed} passed, {blocked} blocked, {failed} not done.
              </p>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button
                  ref={primaryRef}
                  type="button"
                  onClick={onFinish}
                  disabled={!done}
                  style={btn("primary")}
                >
                  Finish demo
                </button>
              </div>
            </>
          )}
        </motion.section>
      </AnimatePresence>

      <nav
        aria-label="Tour controls"
        data-tour-controls=""
        style={{
          position: "fixed",
          pointerEvents: "auto",
          left: 0,
          right: rightInset,
          bottom: bottomInset + 16,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: "var(--r-pill, 999px)",
            background: "var(--paper, #fff)",
            boxShadow: "var(--sh-3, 0 12px 40px rgba(0,0,0,.2)), var(--ring, 0 0 0 1px #e3e0d9)",
            fontSize: 14,
            maxWidth: "calc(100vw - 24px)",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <span
            aria-live="polite"
            style={{ fontSize: 12, color: "var(--muted, #6b675e)", padding: "0 6px", whiteSpace: "nowrap" }}
          >
            {shownIndex >= 0 ? `Step ${shownIndex + 1} of ${state.steps.length}` : done ? "Demo finished" : "Starting"}
            {viewing ? " · revisiting" : ""}
            {personaName ? ` · as ${personaName}` : ""}
          </span>
          <button
            type="button"
            onClick={back ?? undefined}
            disabled={!back}
            aria-label="Previous: revisit the previous step"
            style={btn("ghost", !back)}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={next.run ?? undefined}
            disabled={!next.run}
            aria-label={next.hint ? `${next.label}: ${next.hint}` : next.label}
            title={next.hint ?? undefined}
            style={btn("primary", !next.run)}
          >
            {next.label}
          </button>
          {next.hint ? (
            <span style={{ fontSize: 12, color: "var(--muted, #6b675e)", whiteSpace: "nowrap" }}>
              {next.hint}
            </span>
          ) : null}
          {onTogglePlay ? (
            <button
              type="button"
              onClick={onTogglePlay}
              aria-pressed={autoplay}
              aria-label={autoplay ? "Pause: you press Next" : "Play: the tour presses Next for you"}
              style={btn("ghost")}
            >
              {autoplay ? "Pause" : "Play"}
            </button>
          ) : null}
          {onSwitchAccount ? (
            <button
              type="button"
              onClick={onSwitchAccount}
              aria-label="Switch account: sign in as another user and continue this run at this step"
              style={btn("ghost")}
            >
              Switch account
            </button>
          ) : null}
          <button
            type="button"
            onClick={onReturn}
            aria-label="Exit the demo and return to the slides"
            style={btn("ghost")}
          >
            Exit
          </button>
        </div>
      </nav>
    </div>
  );
}

const heading: CSSProperties = {
  fontFamily: "var(--font-serif, Georgia, serif)",
  fontWeight: 500,
  fontSize: 21,
  letterSpacing: "-0.01em",
  margin: "0 0 6px",
};

function btn(kind: "primary" | "ghost", disabled = false): CSSProperties {
  const base: CSSProperties =
    kind === "primary"
      ? {
          font: "inherit",
          fontWeight: 600,
          padding: "8px 14px",
          borderRadius: "var(--r-pill, 999px)",
          border: "1px solid var(--accent, #9c4028)",
          background: "var(--accent, #9c4028)",
          color: "var(--white, #fff)",
          cursor: "pointer",
        }
      : {
          font: "inherit",
          padding: "8px 12px",
          borderRadius: "var(--r-pill, 999px)",
          border: "1px solid var(--line, #e3e0d9)",
          background: "var(--paper, #fff)",
          color: "var(--ink, #26251f)",
          cursor: "pointer",
        };
  return disabled ? { ...base, opacity: 0.55, cursor: "not-allowed" } : base;
}

/** Step dots: the active ring slides between dots; each dot's tone follows observed status. */
function Dots({
  steps,
  activeId,
  reduced,
}: {
  steps: TourStepState[];
  activeId: string;
  reduced: boolean;
}) {
  return (
    <div aria-hidden style={{ display: "flex", gap: 5, alignItems: "center" }}>
      {steps.map((s) => (
        <span
          key={s.step.id}
          style={{
            position: "relative",
            width: 6,
            height: 6,
            borderRadius: 999,
            background: STATUS_TONE[s.status],
          }}
        >
          {s.step.id === activeId ? (
            <motion.span
              layoutId="tour-active-dot"
              transition={reduced ? { duration: 0 } : FOLLOW}
              style={{
                position: "absolute",
                inset: -3,
                borderRadius: 999,
                border: "1.5px solid var(--accent, #9c4028)",
              }}
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}
