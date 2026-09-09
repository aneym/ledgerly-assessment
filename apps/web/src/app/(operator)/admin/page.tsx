import { redirect } from "next/navigation";

/**
 * /admin has no view of its own. The operator shell opens on Sellers, the first tab; the
 * layout already uses /admin/sellers as the group's root for the sign-in return.
 */
export default function AdminRootPage() {
  redirect("/admin/sellers");
}
