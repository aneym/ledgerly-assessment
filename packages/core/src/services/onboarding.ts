import type { WhopPort } from "../ports/whop";
import { err, ok } from "../result";
import type { AccountLookup, Clock, IdGenerator, OnboardInput, UnitOfWork } from "./ports";

export function createOnboardingService(deps: {
  uow: UnitOfWork;
  provider: WhopPort;
  lookup?: AccountLookup;
  clock: Clock;
  ids: IdGenerator;
  apiVersionDate: string;
  returnUrl: string;
  refreshUrl: string;
}) {
  return async function onboardSeller(input: OnboardInput) {
    if (!input.externalId.trim() || input.runId.includes(":") || input.externalId.includes(":"))
      return err({ kind: "invalid_identity" as const });
    const key = `onboard:${input.runId}:${input.externalId}`;
    return deps.uow.exclusive(key, async (work) => {
      const seller = await work.run((r) => r.sellers.createOrFetch(input, deps.ids.seller()));
      if (seller.email !== input.email || seller.country !== input.country)
        return err({ kind: "identity_conflict" as const });
      if (seller.whopAccountId) {
        const link = await deps.provider.createOnboardingLink(
          {
            accountId: seller.whopAccountId,
            returnUrl: deps.returnUrl,
            refreshUrl: deps.refreshUrl,
          },
          `${key}:link`,
        );
        return link.ok ? ok({ seller, operationKey: key, onboardingUrl: link.value.url }) : link;
      }
      const request = {
        externalId: `${input.runId}:${input.externalId}`,
        runId: input.runId,
        email: seller.email,
        country: seller.country,
        title: seller.externalId,
      };
      const saved = await work.run((r) =>
        r.operations.createOrFetch({
          key,
          request,
          apiVersionDate: deps.apiVersionDate,
          status: "pending",
          providerResourceId: null,
        }),
      );
      const account = await work.run(async (r) => {
        const current = await r.sellers.get(seller.id);
        if (!current) throw new Error("Seller disappeared during onboarding");
        if (current.whopAccountId) return ok(current.whopAccountId);
        const operation = await r.operations.get(key);
        if (operation.apiVersionDate !== deps.apiVersionDate)
          return err({ kind: "operation_version_conflict" as const });
        if (operation.status === "failed") return err({ kind: "operation_failed" as const });
        let accountId = operation.providerResourceId;
        if (accountId) {
          const read = await deps.provider.getAccount(accountId, key);
          if (!read.ok) return read;
          if (read.value.id !== accountId) throw new Error("Account readback changed identity");
        } else if (!saved.created) {
          if (!deps.lookup) return err({ kind: "reconciliation_required" as const });
          const read = await deps.lookup.findAccount(operation.request, key);
          if (!read.ok) return read;
          accountId = read.value?.id ?? null;
        }
        if (!accountId) {
          const result = await deps.provider.createOrFetchAccount(operation.request, key);
          if (!result.ok) {
            await r.operations.finish(
              key,
              result.error.kind === "network" || result.error.kind === "http"
                ? "unknown"
                : "failed",
              null,
              deps.clock.now(),
            );
            return result;
          }
          accountId = result.value.id;
        }
        await r.operations.finish(key, "succeeded", accountId, deps.clock.now());
        const existing = await r.sellers.byAccount(accountId);
        if (existing && existing.id !== seller.id)
          return err({ kind: "account_already_mapped" as const });
        await r.sellers.attach(seller.id, accountId);
        return ok(accountId);
      });
      if (!account.ok) return account;
      const link = await deps.provider.createOnboardingLink(
        { accountId: account.value, returnUrl: deps.returnUrl, refreshUrl: deps.refreshUrl },
        `${key}:link`,
      );
      return link.ok
        ? ok({
            seller: { ...seller, whopAccountId: account.value },
            operationKey: key,
            onboardingUrl: link.value.url,
          })
        : link;
    });
  };
}
