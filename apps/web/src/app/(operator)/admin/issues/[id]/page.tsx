import { permanentRedirect } from "next/navigation";

/** The assistant and the API link to /admin/issues/{id}. The center keeps its selection in the query. */
export default async function IssueByIdPage({ params }: PageProps<"/admin/issues/[id]">) {
  const { id } = await params;
  permanentRedirect(`/admin/issues?issue=${encodeURIComponent(id)}`);
}
