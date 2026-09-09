import { timingSafeEqual } from "node:crypto";
import type { createInboxService, ReceiveInput, ReleaseTransfersResult } from "@ledgerly/core";

type Inbox = ReturnType<typeof createInboxService>;
export type HttpServices = Pick<Inbox, "receiveWebhook" | "processInbox"> & {
  webhookSecret(): string;
  reconcileBounded(): Promise<unknown>;
  releaseTransfers(): Promise<ReleaseTransfersResult>;
  // Only present in WHOP_MODE=mock, where apps/web/src/lib/server.ts wires the stateful
  // simulator in place of the plain mock adapter; sandbox/hybrid mode has no tick to run.
  tick?(): Promise<void>;
};
export async function handleWebhook(
  request: Request,
  services: HttpServices,
  after: (work: () => Promise<void>) => void,
) {
  const input: ReceiveInput = {
    rawBody: await request.text(),
    headers: {
      "webhook-id": request.headers.get("webhook-id") ?? "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
      "webhook-signature": request.headers.get("webhook-signature") ?? "",
    },
    secret: services.webhookSecret(),
    now: new Date(),
  };
  const result = await services.receiveWebhook(input);
  if (!result.ok)
    return Response.json(
      { error: result.error.kind },
      { status: result.error.kind === "signature" ? 401 : 400 },
    );
  if (!result.value.duplicate && result.value.row.status === "received")
    after(async () => {
      await services.processInbox({ limit: 100 });
    });
  // decoded is only ever false for a signed-but-undecodable body (stored as "failed" for
  // diagnosis); omit the field entirely on the ordinary success path so the response shape is
  // unchanged for existing callers.
  return Response.json(
    result.value.decoded
      ? { received: true, duplicate: result.value.duplicate }
      : { received: true, duplicate: result.value.duplicate, decoded: false },
    { status: 200 },
  );
}
export async function handleSweep(
  request: Request,
  secret: string | undefined,
  services: () => HttpServices,
) {
  if (!secret) return Response.json({ error: "cron_unconfigured" }, { status: 503 });
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const server = services();
  // Order: drain deliveries already sitting in the inbox (real webhooks, and anything a
  // prior sweep's tick() delivered) first, then originate any newly-eligible transfers,
  // then advance the simulator. A transfer completed or payout progressed by this sweep's
  // own tick() is picked up on the *next* sweep's processInbox call, not this one — a
  // one-cycle lag that matches how a real provider's webhook delivery would land anyway.
  const inbox = await server.processInbox({ limit: 100 });
  const transfers = await server.releaseTransfers();
  await server.tick?.();
  const reconciliation = await server.reconcileBounded();
  return Response.json({ inbox, transfers, reconciliation });
}
