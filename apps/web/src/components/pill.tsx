import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Tone = "ink" | "buy" | "ghost" | "plain";
type Size = "sm" | "md" | "lg";

type Base = {
  tone?: Tone;
  size?: Size;
  wide?: boolean;
  className?: string;
  children: ReactNode;
};

function classes({ tone = "plain", size = "md", wide, className }: Base): string {
  return [
    "pill",
    tone !== "plain" ? tone : "",
    size !== "md" ? size : "",
    wide ? "wide" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

type ButtonProps = Base & Omit<ComponentProps<"button">, "className" | "children">;

export function PillButton({ tone, size, wide, className, children, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={classes({ tone, size, wide, className, children })}
      {...rest}
    >
      {children}
    </button>
  );
}

type LinkProps = Base & Omit<ComponentProps<typeof Link>, "className" | "children">;

export function PillLink({ tone, size, wide, className, children, ...rest }: LinkProps) {
  return (
    <Link className={classes({ tone, size, wide, className, children })} {...rest}>
      {children}
    </Link>
  );
}
