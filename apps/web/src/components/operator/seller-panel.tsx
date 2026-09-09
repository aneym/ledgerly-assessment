"use client";

import { useEffect, useState } from "react";
import { PillButton } from "@/components/pill";
import { ProvenanceBadge } from "@/components/provenance-badge";
import {
  CopyId,
  Inspector,
  InspectorBlock,
  InspectorLine,
  InspectorWho,
  StatusChip,
} from "@/components/table";
import {
  type ApiResult,
  getSeller,
  sellerPath,
  setSellerPolicy,
  suspendSeller,
} from "@/lib/operator/api";
import {
  actionLabel,
  CAPABILITY_LABEL,
  longDate,
  POLICY_LABEL,
  POLICY_SENTENCE,
  VERIFICATION_LABEL,
  verificationTone,
} from "@/lib/operator/format";
import type { OperatorSeller, SalePolicy } from "@/lib/operator/types";
import { BusinessMark } from "./business";
import { RouteState } from "./route-state";
import { useTourAttr } from "./tour";

type Request<T> =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "done"; result: ApiResult<T> };

const POLICIES: SalePolicy[] = ["direct", "platform_only"];
export const SELLER_INSPECTOR_ID = "seller-inspector";

/**
 * The open seller in the shared Inspector: properties, then the two operator
 * actions. Change policy posts to /policy; suspend asks once more, then posts to /suspend.
 */
export function SellerInspector({
  seller,
  onChange,
  onClose,
}: {
  seller: OperatorSeller;
  onChange: (next: OperatorSeller) => void;
  onClose: () => void;
}) {
  useTourAttr(SELLER_INSPECTOR_ID, "admin.sellers.detail", true);
  const [read, setRead] = useState<Request<OperatorSeller>>({ state: "idle" });
  const [policy, setPolicy] = useState<Request<OperatorSeller> & { target?: SalePolicy }>({
    state: "idle",
  });
  const [confirming, setConfirming] = useState(false);
  const [suspend, setSuspend] = useState<Request<OperatorSeller>>({ state: "idle" });

  // One live read per open seller. A miss is shown as a miss, never filled in from the fixture.
  useEffect(() => {
    let cancelled = false;
    setRead({ state: "pending" });
    setPolicy({ state: "idle" });
    setSuspend({ state: "idle" });
    setConfirming(false);
    getSeller(seller.id).then((result) => {
      if (!cancelled) setRead({ state: "done", result });
    });
    return () => {
      cancelled = true;
    };
  }, [seller.id]);

  async function changePolicy(target: SalePolicy) {
    if (target === seller.sale_policy || policy.state === "pending") return;
    setPolicy({ state: "pending", target });
    const result = await setSellerPolicy(seller.id, target);
    setPolicy({ state: "done", result, target });
    if (result.ok) onChange({ ...seller, ...result.data, sale_policy: target });
  }

  async function confirmSuspend() {
    if (suspend.state === "pending") return;
    setSuspend({ state: "pending" });
    const result = await suspendSeller(seller.id);
    setSuspend({ state: "done", result });
    setConfirming(false);
    if (result.ok) onChange({ ...seller, ...result.data, status: "suspended" });
  }

  const path = sellerPath(seller.id);
  const suspended = seller.status === "suspended";

  return (
    <Inspector
      id={SELLER_INSPECTOR_ID}
      open
      onClose={onClose}
      label="Seller"
      idValue={seller.id}
      title={seller.name}
      status={
        <>
          {suspended ? (
            <StatusChip tone="bad">Suspended</StatusChip>
          ) : (
            <StatusChip tone="ok">Active</StatusChip>
          )}
          <span>
            {POLICY_LABEL[seller.sale_policy]}, {seller.city}, {seller.country}
          </span>
        </>
      }
    >
      <InspectorBlock title="Properties">
        <InspectorWho
          mark={<BusinessMark seller={seller} size="md" />}
          name={seller.name}
          sub={seller.handle ? `@${seller.handle}` : `${seller.country_name || seller.country}`}
        />
        <InspectorLine k="External id" v={<CopyId value={seller.external_id} />} />
        <InspectorLine k="Created" v={longDate(seller.created_at)} />
        <InspectorLine
          k="Whop account"
          v={seller.whop_account_id ? <CopyId value={seller.whop_account_id} /> : "not created"}
          quiet={!seller.whop_account_id}
        />
        <InspectorLine
          k="Verification"
          v={
            <StatusChip tone={verificationTone(seller.verification)}>
              {VERIFICATION_LABEL[seller.verification]}
            </StatusChip>
          }
        />
        <InspectorLine
          k="Required actions"
          v={
            seller.required_actions.length === 0 ? (
              "none"
            ) : (
              <span className="op-wrap">{seller.required_actions.map(actionLabel).join(", ")}</span>
            )
          }
          quiet={seller.required_actions.length === 0}
        />
        <InspectorLine
          k="Capabilities"
          v={
            <span className="op-wrap">
              {(["payments", "transfers", "payouts"] as const)
                .map((gate) => `${gate} ${CAPABILITY_LABEL[seller.capabilities[gate]]}`)
                .join(", ")}
            </span>
          }
        />
        <InspectorLine k="Record" v={<ProvenanceBadge provenance={seller.provenance} />} />
      </InspectorBlock>

      <InspectorBlock title="App API">
        {read.state === "pending" && <RouteState kind="pending" method="GET" path={path} />}
        {read.state === "done" && !read.result.ok && <RouteState kind="miss" miss={read.result} />}
        {read.state === "done" && read.result.ok && (
          <RouteState
            kind="ok"
            method="GET"
            path={path}
            status={read.result.status}
            summary={`Returned verification ${String(read.result.data.verification ?? "unknown")}, ${Array.isArray(read.result.data.required_actions) ? read.result.data.required_actions.length : 0} required actions.`}
          />
        )}
      </InspectorBlock>

      <InspectorBlock title="Sale policy">
        <div className="op-action">
          <fieldset className="op-seg" data-tour="admin.sellers.policy">
            <legend className="op-sr">Sale policy</legend>
            {POLICIES.map((option) => {
              const checked =
                policy.state === "pending"
                  ? policy.target === option
                  : seller.sale_policy === option;
              return (
                <label key={option}>
                  <input
                    type="radio"
                    name={`policy-${seller.id}`}
                    value={option}
                    checked={checked}
                    disabled={policy.state === "pending" || suspended}
                    onChange={() => changePolicy(option)}
                  />
                  <span>{POLICY_LABEL[option]}</span>
                </label>
              );
            })}
          </fieldset>
          <p className="op-fine">
            {POLICY_SENTENCE[seller.sale_policy]} Enforced in core before any checkout is created.
          </p>
          {policy.state === "pending" && (
            <RouteState kind="pending" method="POST" path={`${path}/policy`} />
          )}
          {policy.state === "done" && !policy.result.ok && (
            <RouteState kind="miss" miss={policy.result} />
          )}
          {policy.state === "done" && policy.result.ok && (
            <RouteState
              kind="ok"
              method="POST"
              path={`${path}/policy`}
              status={policy.result.status}
              summary={`Policy is now ${POLICY_LABEL[seller.sale_policy].toLowerCase()}.`}
            />
          )}
        </div>
      </InspectorBlock>

      <InspectorBlock title="Suspension">
        <div className="op-action">
          {suspended ? (
            <div className="op-action-row">
              <StatusChip tone="bad">Suspended</StatusChip>
              <span className="op-fine">Every checkout for this seller is refused in core.</span>
            </div>
          ) : confirming ? (
            <fieldset className="op-confirm">
              <legend className="op-sr">Confirm suspension</legend>
              <span>
                <b>Suspend {seller.name}?</b> Every new checkout for this seller stops. Balances,
                transfers and payouts already in flight are not touched.
              </span>
              <div className="op-action-row">
                <PillButton
                  size="sm"
                  className="op-bad op-solid"
                  onClick={confirmSuspend}
                  disabled={suspend.state === "pending"}
                >
                  Confirm suspend
                </PillButton>
                <PillButton
                  tone="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={suspend.state === "pending"}
                >
                  Keep active
                </PillButton>
              </div>
            </fieldset>
          ) : (
            <div className="op-action-row">
              <PillButton
                size="sm"
                className="op-bad"
                data-tour="admin.sellers.suspend"
                onClick={() => setConfirming(true)}
              >
                Suspend seller
              </PillButton>
              <span className="op-fine">Asks once more before it posts.</span>
            </div>
          )}
          {suspend.state === "pending" && (
            <RouteState kind="pending" method="POST" path={`${path}/suspend`} />
          )}
          {suspend.state === "done" && !suspend.result.ok && (
            <RouteState kind="miss" miss={suspend.result} />
          )}
          {suspend.state === "done" && suspend.result.ok && (
            <RouteState
              kind="ok"
              method="POST"
              path={`${path}/suspend`}
              status={suspend.result.status}
              summary="Seller suspended."
            />
          )}
        </div>
      </InspectorBlock>
    </Inspector>
  );
}
