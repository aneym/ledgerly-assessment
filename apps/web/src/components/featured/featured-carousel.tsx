"use client";

import {
  animate,
  type MotionValue,
  motion,
  type PanInfo,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FeaturedSlideCard } from "./featured-slide";
import type { FeaturedSlide } from "./types";

type Props = { slides: FeaturedSlide[] };

/** Seconds one slide stays before autoplay turns the shelf. */
const DWELL_S = 6;
/** Slide width plus gap before the first measurement. Only the sign matters until then. */
const DEFAULT_STEP = 1040;
/** Beyond this many cards the shelf crossfades instead of sliding, so wrapping never blurs past six covers. */
const SLIDE_LIMIT = 3;
/** Near critical damping, heavy and unhurried. A print being set down, not a bounce. Settles in about 0.8s. */
const SPRING = {
  type: "spring",
  stiffness: 140,
  damping: 24,
  mass: 1.2,
  restDelta: 0.5,
  restSpeed: 5,
} as const;
const VEIL_OUT = { duration: 0.14, ease: "linear" } as const;
const VEIL_IN = { duration: 0.22, ease: "easeOut" } as const;
/** Seconds of drag velocity projected forward when picking the slide to settle on. */
const FLING_PROJECTION_S = 0.18;
const FLING_MIN_VELOCITY = 350;

type PauseFlags = { hover: boolean; focus: boolean; drag: boolean; hidden: boolean };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Motion structure. One track motion value `x` drives everything: each slide derives its
 * scale, opacity and origin from `x` and `step` (slide width plus gap, measured). Index changes
 * spring `x` to `-index * step`; a resize jumps it. Autoplay is a linear animation of `progress`
 * 0 to 1 over six seconds whose completion advances the index; hover, focus, drag and a hidden
 * tab pause that animation in place. Reduced motion never autoplays, disables drag, and swaps the
 * spring for a crossfade: the shelf fades under `veil`, `x` jumps, the shelf fades back.
 */
export function FeaturedCarousel({ slides }: Props) {
  const count = slides.length;
  const reduced = useReducedMotion() === true;

  const [index, setIndex] = useState(0);
  const [step, setStep] = useState(DEFAULT_STEP);
  const [paused, setPaused] = useState(false);

  const x = useMotionValue(0);
  const stepMV = useMotionValue(DEFAULT_STEP);
  const progress = useMotionValue(0);
  const veil = useMotionValue(1);
  const activeMV = useMotionValue(0);

  const trackRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const indexRef = useRef(0);
  const prevIndex = useRef(0);
  const prevStep = useRef(DEFAULT_STEP);
  const transitionSeq = useRef(0);
  const dragMoved = useRef(false);
  const focusAfterMove = useRef(false);
  const flags = useRef<PauseFlags>({ hover: false, focus: false, drag: false, hidden: false });
  const autoplay = useRef<ReturnType<typeof animate> | null>(null);

  indexRef.current = index;

  const setFlag = useCallback((key: keyof PauseFlags, value: boolean) => {
    const f = flags.current;
    f[key] = value;
    setPaused(f.hover || f.focus || f.drag || f.hidden);
  }, []);

  const go = useCallback(
    (delta: number, viaKeyboard = false) => {
      focusAfterMove.current = viaKeyboard;
      setIndex((i) => (i + delta + count) % count);
    },
    [count],
  );

  /* Measure the step from the DOM so CSS owns widths and gaps. offsetLeft ignores transforms. */
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const a = track.children[0] as HTMLElement | undefined;
      const b = track.children[1] as HTMLElement | undefined;
      if (!a || !b) return;
      const s = b.offsetLeft - a.offsetLeft;
      if (s > 0) {
        stepMV.set(s);
        setStep(s);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, [stepMV]);

  /* Move the track when the index or the step changes. */
  useEffect(() => {
    const target = -index * step;
    activeMV.set(index);
    const stepChanged = step !== prevStep.current;
    const delta = Math.abs(index - prevIndex.current);
    prevStep.current = step;
    prevIndex.current = index;

    if (stepChanged) {
      x.jump(target);
      return;
    }
    if (delta === 0) return;

    const seq = ++transitionSeq.current;
    if (reduced || delta > SLIDE_LIMIT) {
      animate(veil, 0, VEIL_OUT).then(() => {
        if (seq !== transitionSeq.current) return;
        x.jump(target);
        animate(veil, 1, VEIL_IN);
      });
      return;
    }
    const ctrl = animate(x, target, SPRING);
    return () => ctrl.stop();
  }, [index, step, reduced, x, veil, activeMV]);

  /* Keyboard moves land focus on the new active card. */
  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    linkRefs.current[index]?.focus({ preventScroll: true });
  }, [index]);

  /* Autoplay: fill the active rail segment over DWELL_S, then turn the shelf. */
  useEffect(() => {
    if (reduced) {
      progress.jump(1);
      return;
    }
    progress.jump(0);
    const ctrl = animate(progress, 1, {
      duration: DWELL_S,
      ease: "linear",
      onComplete: () => {
        focusAfterMove.current = false;
        setIndex((index + 1) % count);
      },
    });
    if (flags.current.hover || flags.current.focus || flags.current.drag || flags.current.hidden) {
      ctrl.pause();
    }
    autoplay.current = ctrl;
    return () => {
      ctrl.stop();
      autoplay.current = null;
    };
  }, [index, count, reduced, progress]);

  useEffect(() => {
    const ctrl = autoplay.current;
    if (!ctrl) return;
    if (paused) ctrl.pause();
    else ctrl.play();
  }, [paused]);

  useEffect(() => {
    const onVisibility = () => setFlag("hidden", document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [setFlag]);

  /* Drag: snap to the nearest slide after projecting the release velocity a little forward. */
  const onDragStart = () => {
    dragMoved.current = true;
    setFlag("drag", true);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const cur = indexRef.current;
    const projected = x.get() + info.velocity.x * FLING_PROJECTION_S;
    let next = Math.round(-projected / step);
    if (next === cur && Math.abs(info.velocity.x) > FLING_MIN_VELOCITY) {
      next = cur - Math.sign(info.velocity.x);
    }
    next = clamp(next, 0, count - 1);
    if (next === cur) animate(x, -cur * step, SPRING);
    else setIndex(next);
    setFlag("drag", false);
    // The click that follows pointerup must not open the card after a drag.
    setTimeout(() => {
      dragMoved.current = false;
    }, 0);
  };
  const onClickCapture = (e: MouseEvent) => {
    if (!dragMoved.current) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAfterMove.current = true;
      setIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAfterMove.current = true;
      setIndex(count - 1);
    }
  };

  const onPointerEnter = (e: PointerEvent) => {
    if (e.pointerType === "mouse") setFlag("hover", true);
  };
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") setFlag("hover", false);
  };
  /* Pause for keyboard focus only. A mouse click on an arrow focuses it too, and must not stop the shelf. */
  const onFocus = (e: FocusEvent) => {
    if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) {
      setFlag("focus", true);
    }
  };
  const onBlur = (e: FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFlag("focus", false);
  };

  return (
    <section
      className="fc"
      aria-roledescription="carousel"
      aria-label="Featured releases"
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <motion.div className="fc-viewport" style={{ opacity: veil }}>
        <motion.div
          ref={trackRef}
          className="fc-track"
          style={{ x }}
          drag="x"
          dragListener={!reduced}
          dragConstraints={{ left: -(count - 1) * step, right: 0 }}
          dragElastic={0.16}
          dragMomentum={false}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClickCapture={onClickCapture}
          aria-live={paused ? "polite" : "off"}
        >
          {slides.map((slide, i) => (
            <FeaturedSlideCard
              key={slide.href ?? slide.slug}
              slide={slide}
              index={i}
              count={count}
              active={i === index}
              x={x}
              step={stepMV}
              linkRef={(el) => {
                linkRefs.current[i] = el;
              }}
            />
          ))}
        </motion.div>
      </motion.div>

      <div className="fc-bar">
        <div className="fc-arrows">
          <button
            type="button"
            className="pill ghost fc-arrow"
            aria-label="Previous"
            onClick={() => go(-1)}
          >
            <ChevronLeft />
          </button>
          <button
            type="button"
            className="pill ghost fc-arrow"
            aria-label="Next"
            onClick={() => go(1)}
          >
            <ChevronRight />
          </button>
        </div>
        <div className="fc-rail">
          {slides.map((slide, i) => (
            <RailSegment
              key={slide.href ?? slide.slug}
              index={i}
              title={slide.title}
              current={i === index}
              active={activeMV}
              progress={progress}
              onSelect={() => setIndex(i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

type SegmentProps = {
  index: number;
  title: string;
  current: boolean;
  active: MotionValue<number>;
  progress: MotionValue<number>;
  onSelect: () => void;
};

/** Past segments stay filled, the active one fills over the dwell, the rest wait. */
function RailSegment({ index, title, current, active, progress, onSelect }: SegmentProps) {
  const scaleX = useTransform(() => {
    const a = active.get();
    if (index < a) return 1;
    if (index === a) return progress.get();
    return 0;
  });
  return (
    <button
      type="button"
      className="fc-seg"
      aria-label={`Go to ${index + 1}, ${title}`}
      aria-current={current ? "true" : undefined}
      onClick={onSelect}
    >
      <motion.span className="fc-fill" style={{ scaleX }} />
    </button>
  );
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10 3.5 5.5 8 10 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m6 3.5 4.5 4.5L6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
