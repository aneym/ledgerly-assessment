import Image from "next/image";
import type { ComponentProps } from "react";

const SIZES = { xs: 22, sm: 28, md: 44, lg: 72, xl: 128 } as const;

type Props = Omit<ComponentProps<typeof Image>, "src" | "alt" | "width" | "height" | "sizes"> & {
  src: string;
  /** Empty when the name is already printed next to the avatar. */
  alt: string;
  size?: keyof typeof SIZES;
};

export function Avatar({ src, alt, size = "sm", className, ...rest }: Props) {
  const px = SIZES[size];
  const sizeClass = size === "sm" ? "" : size;
  if (!src)
    return (
      <span
        className={["av", sizeClass, className].filter(Boolean).join(" ")}
        role="img"
        aria-label={alt || "Seller"}
        style={{ width: px, height: px, display: "inline-block", background: "var(--line)" }}
      />
    );
  return (
    <Image
      src={src}
      alt={alt}
      width={px}
      height={px}
      sizes={`${px}px`}
      className={["av", sizeClass, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}
