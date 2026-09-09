import type { Provenance } from "@/lib/catalog/types";

const LABEL: Record<Provenance, string> = {
  mock: "MOCK",
  sandbox: "SANDBOX",
  live: "LIVE",
  catalog: "CATALOG",
};

type Props = { provenance: Provenance; className?: string };

/**
 * Small mono badge. Set from data, never hard-coded on a page. Fixture ("mock") data
 * renders nothing: the owner asked for no "mock" wording anywhere in the UI, so the badge
 * only speaks when a record came from the sandbox or a live provider.
 */
export function ProvenanceBadge({ provenance, className }: Props) {
  if (provenance === "mock" || provenance === "catalog") return null;
  return (
    <span
      className={["prov", provenance, className].filter(Boolean).join(" ")}
      title={`${LABEL[provenance]} data`}
    >
      {LABEL[provenance]}
    </span>
  );
}
