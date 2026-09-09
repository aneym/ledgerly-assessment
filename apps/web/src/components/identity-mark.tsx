import type { IdentityMark as Mark } from "@/lib/identity/mark";
import { Avatar } from "./avatar";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * The picture that stands for a person or a business: the resolved portrait, or the
 * initials on a plate when there is none. Decorative by default; the name printed next
 * to it is the accessible label. Resolve the mark with `resolveMark` so every surface
 * draws the same picture for the same identity.
 */
export function IdentityMark({
  mark,
  size = "sm",
  alt = "",
  className,
  ...rest
}: {
  mark: Pick<Mark, "avatar" | "initials">;
  size?: Size;
  /** Set when no name is printed beside the mark. */
  alt?: string;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  if (mark.avatar) {
    return <Avatar src={mark.avatar} alt={alt} size={size} className={className} {...rest} />;
  }
  const sizeClass = size === "sm" ? "" : size;
  return (
    <span
      className={["av", sizeClass, "av-initials", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      title={alt || undefined}
      {...rest}
    >
      {mark.initials || "?"}
    </span>
  );
}
