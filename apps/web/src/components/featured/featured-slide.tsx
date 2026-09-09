"use client";

import { type MotionValue, motion, useTransform } from "motion/react";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { LedgerLine } from "@/components/ledger-line";
import { ProductCover } from "@/components/product-cover";
import type { FeaturedSlide } from "./types";

type Props = {
  slide: FeaturedSlide;
  index: number;
  count: number;
  active: boolean;
  /** Track position in px. 0 shows slide 0; -step shows slide 1. */
  x: MotionValue<number>;
  /** Distance between two slides (width plus gap), kept in sync by the carousel. */
  step: MotionValue<number>;
  linkRef: (el: HTMLAnchorElement | null) => void;
};

const PEEK_SCALE = 0.94;
const PEEK_OPACITY = 0.55;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * One slide on the shelf. Everything that moves is a motion value derived from the track
 * position, so a drag or a spring never re-renders React. `rel` is the slide's distance from
 * the centre in slide units: 0 when active, +1 when it is the next card, -1 the previous.
 */
export function FeaturedSlideCard({ slide, index, count, active, x, step, linkRef }: Props) {
  const rel = useTransform(() => {
    const s = step.get();
    return (x.get() + index * s) / s;
  });
  const scale = useTransform(rel, [-1, 0, 1], [PEEK_SCALE, 1, PEEK_SCALE]);
  const opacity = useTransform(rel, [-1, 0, 1], [PEEK_OPACITY, 1, PEEK_OPACITY]);
  // Neighbours shrink away from the active card, so the peeking edge stays put.
  const originX = useTransform(rel, [-1, 0, 1], [1, 0.5, 0]);

  return (
    <motion.div
      className="fc-slide"
      role="group"
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${count}`}
      data-tour-item={slide.slug}
      inert={!active}
      style={{ scale, opacity, originX }}
    >
      <Link
        ref={linkRef}
        className="fc-card"
        href={slide.href ?? `/p/${slide.slug}`}
        data-tour={active ? "home.featured" : undefined}
        draggable={false}
      >
        <div className="plate fc-plate">
          <ProductCover product={slide} wide />
        </div>
        <div className="fc-copy">
          <div className="kick">
            <span>
              Featured {pad(index + 1)} / {pad(count)}
            </span>
            <i aria-hidden="true" />
            <span>{slide.category}</span>
          </div>
          <h2 className="fc-title">{slide.title}</h2>
          <div className="byline fc-byline">
            <Avatar src={slide.avatar} alt="" size="xs" draggable={false} />
            <span className="who">{slide.sellerName}</span>
            <span className="loc">{slide.city}</span>
          </div>
          <p className="fc-blurb">{slide.blurb}</p>
          <div className="ledger fc-ledger">
            <LedgerLine label="You pay" value={slide.price} />
            <LedgerLine
              label={`${slide.sellerShort} receives, after the 8% fee`}
              value={slide.sellerShare}
              quiet
            />
          </div>
          <div className="fc-cta">
            <span className="pill buy">View</span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
