import { permanentRedirect } from "next/navigation";

/** The assistant links to /admin/sellers/{id}. The sellers table opens a row from the hash. */
export default async function SellerByIdPage({ params }: PageProps<"/admin/sellers/[id]">) {
  const { id } = await params;
  permanentRedirect(`/admin/sellers#${encodeURIComponent(id)}`);
}
