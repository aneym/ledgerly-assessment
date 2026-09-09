import { IdentityMark } from "@/components/identity-mark";
import { resolveMark } from "@/lib/identity/mark";
import type { OperatorSeller } from "@/lib/operator/types";

/**
 * The business mark: the canonical portrait for this seller (lib/identity/mark), or
 * initials when there is none. Decorative. The name printed next to it is the
 * accessible label.
 */
export function BusinessMark({
  seller,
  size = "xs",
}: {
  seller: Pick<OperatorSeller, "name" | "avatar"> & Partial<Pick<OperatorSeller, "id" | "handle">>;
  size?: "xs" | "sm" | "md";
}) {
  const mark = resolveMark({
    id: seller.id,
    handle: seller.handle,
    name: seller.name,
    avatar: seller.avatar,
  });
  return (
    <IdentityMark mark={mark} size={size} className={mark.avatar ? undefined : "op-initials"} />
  );
}

/** Mark plus name on one line, the first thing a row says. The row button wraps it. */
export function BusinessCell({
  seller,
}: {
  seller: Pick<OperatorSeller, "name" | "avatar"> & Partial<Pick<OperatorSeller, "id" | "handle">>;
}) {
  return (
    <>
      <BusinessMark seller={seller} />
      <span>{seller.name}</span>
    </>
  );
}
