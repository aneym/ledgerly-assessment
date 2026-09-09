import { permanentRedirect } from "next/navigation";

/** The assistant links to /admin/ledger/{id}. The ledger finds a row by searching for its id. */
export default async function LedgerEntryByIdPage({ params }: PageProps<"/admin/ledger/[id]">) {
  const { id } = await params;
  permanentRedirect(`/admin/ledger?q=${encodeURIComponent(id)}`);
}
