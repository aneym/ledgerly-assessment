"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Column,
  CopyId,
  DataTable,
  InspectorLayout,
  StatusChip,
  TableCard,
  TableScroll,
} from "@/components/table";
import { POLICY_LABEL, VERIFICATION_LABEL, verificationTone } from "@/lib/operator/format";
import type { OperatorSeller } from "@/lib/operator/types";
import { useAssistantSelection } from "./assistant/assistant-provider";
import { BusinessCell } from "./business";
import { CapabilityDots } from "./chips";
import { SELLER_INSPECTOR_ID, SellerInspector } from "./seller-panel";
import { useRowTour } from "./tour";

/**
 * The sellers sheet, compact density, with the shared Inspector for the open seller.
 * Columns per docs/design/tables.md section 7.1: Seller, Handle, Country, Sale policy,
 * Verification, Capabilities, Whop account, Status.
 */
export function SellersTable({
  initial,
  foot,
}: {
  initial: OperatorSeller[];
  foot: { left: string; right: string };
}) {
  const [sellers, setSellers] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // /admin/sellers#sel_onda opens that seller. Links from the ledger and issues use it.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && initial.some((seller) => seller.id === id)) setOpen(id);
  }, [initial]);

  const keys = useMemo(() => sellers.map((seller) => seller.id), [sellers]);
  useRowTour(ref, "admin.sellers.item", keys);

  const current = open ? (sellers.find((seller) => seller.id === open) ?? null) : null;
  useAssistantSelection(
    current
      ? {
          kind: "seller",
          id: current.id,
          label: current.name,
          href: `/admin/sellers#${current.id}`,
        }
      : null,
  );

  function update(next: OperatorSeller) {
    setSellers((list) => list.map((seller) => (seller.id === next.id ? next : seller)));
  }

  const columns: Column<OperatorSeller>[] = [
    {
      key: "seller",
      header: "Seller",
      kind: "text",
      render: (seller) => <BusinessCell seller={seller} />,
      title: (seller) => (seller.city ? `${seller.name}, ${seller.city}` : seller.name),
    },
    {
      key: "handle",
      header: "Handle",
      kind: "id",
      width: 104,
      priority: 3,
      render: (seller) =>
        seller.handle ? `@${seller.handle}` : <span className="dash">none</span>,
    },
    {
      key: "country",
      header: "Country",
      kind: "text",
      width: 104,
      priority: 2,
      render: (seller) => seller.country_name,
      title: (seller) => seller.country,
    },
    {
      key: "policy",
      header: "Sale policy",
      kind: "status",
      width: 118,
      render: (seller) => (
        <StatusChip tone={seller.sale_policy === "direct" ? "line" : "plain"} size="table">
          {POLICY_LABEL[seller.sale_policy]}
        </StatusChip>
      ),
    },
    {
      key: "verification",
      header: "Verification",
      kind: "status",
      width: 112,
      render: (seller) => (
        <StatusChip tone={verificationTone(seller.verification)} size="table">
          {VERIFICATION_LABEL[seller.verification]}
        </StatusChip>
      ),
    },
    {
      key: "capabilities",
      header: "Capabilities",
      kind: "text",
      width: 84,
      priority: 2,
      render: (seller) => <CapabilityDots capabilities={seller.capabilities} />,
    },
    {
      key: "whop",
      header: "Whop account",
      kind: "id",
      width: 128,
      priority: 3,
      render: (seller) =>
        seller.whop_account_id ? (
          <CopyId value={seller.whop_account_id} />
        ) : (
          <span className="dash">not created</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      kind: "status",
      width: 92,
      render: (seller) =>
        seller.status === "active" ? (
          <StatusChip tone="ok" size="table">
            Active
          </StatusChip>
        ) : (
          <StatusChip tone="bad" size="table">
            Suspended
          </StatusChip>
        ),
    },
  ];

  return (
    <InspectorLayout
      inspector={
        current ? (
          <SellerInspector seller={current} onChange={update} onClose={() => setOpen(null)} />
        ) : undefined
      }
    >
      <div ref={ref} data-tour="admin.sellers.list">
        <TableCard
          id="admin-sellers-title"
          title="Sellers"
          count={`${sellers.length} sellers`}
          density="compact"
          foot={foot}
        >
          <TableScroll labelledBy="admin-sellers-caption">
            <DataTable
              caption="Sellers with their sale policy, verification, capabilities and status."
              captionId="admin-sellers-caption"
              columns={columns}
              rows={sellers}
              rowKey={(seller) => seller.id}
              rowHeader="seller"
              rowName={(seller) => `${seller.name}, ${seller.id}`}
              state={{ kind: "rows" }}
              selectedKey={current ? current.id : null}
              onRowOpen={(seller) => setOpen(open === seller.id ? null : seller.id)}
              inspectorId={current ? SELLER_INSPECTOR_ID : undefined}
            />
          </TableScroll>
        </TableCard>
      </div>
    </InspectorLayout>
  );
}
