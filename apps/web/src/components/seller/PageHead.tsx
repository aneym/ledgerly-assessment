import type { ReactNode } from "react";

/** Title in Fraunces at the page's top, a plain sentence under it, and an optional right slot. */
export function PageHead({
  title,
  sub,
  aside,
}: {
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between md:gap-6">
      <div className="min-w-0">
        <h1
          className="font-serif text-[34px] leading-[1.05] font-normal tracking-[-0.015em] text-balance text-ink md:text-[40px]"
          style={{ fontVariationSettings: "'opsz' 72" }}
        >
          {title}
        </h1>
        {sub ? (
          <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-pretty text-ink-2">
            {sub}
          </p>
        ) : null}
      </div>
      {aside ? <div className="flex flex-none items-center gap-3">{aside}</div> : null}
    </header>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2
        className="font-serif text-[22px] leading-[1.2] font-medium text-ink"
        style={{ fontVariationSettings: "'opsz' 24" }}
      >
        {children}
      </h2>
      {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}
