import { createInboxService, type DeliveryId } from "@ledgerly/core";

/** Reuse core's transaction/effect processing while restricting selection to one delivery.
 * The caller must authorize the delivery before invoking processDelivery. */
export function createDeliveryInbox(
  deps: Omit<Parameters<typeof createInboxService>[0], "provenance">,
) {
  const service = createInboxService({ ...deps, provenance: "mock" });
  return {
    receiveWebhook: service.receiveWebhook,
    async processDelivery(id: DeliveryId) {
      const scoped = createInboxService({
        ...deps,
        provenance: "mock",
        uow: {
          exclusive: deps.uow.exclusive.bind(deps.uow),
          run: (fn) =>
            deps.uow.run((repos) =>
              fn({
                ...repos,
                inbox: {
                  ...repos.inbox,
                  pending: async () => [await repos.inbox.get(id)],
                },
              }),
            ),
        },
      });
      return scoped.processInbox({ limit: 1 });
    },
  };
}
