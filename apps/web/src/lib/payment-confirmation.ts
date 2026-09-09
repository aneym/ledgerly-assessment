import {
  createPaymentConfirmationService,
  err,
  type PaymentConfirmationInput,
  type PaymentConfirmationResult,
  whopAccountId,
} from "@ledgerly/core";
import { createPaymentObservationReader } from "@ledgerly/whop";
import { getServer } from "./server";

export async function confirmOrderPayment(
  input: PaymentConfirmationInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaymentConfirmationResult> {
  if (env.WHOP_MODE !== "hybrid") return err({ kind: "not_available" });
  const platform = whopAccountId(env.WHOP_PLATFORM_ACCOUNT_ID ?? "");
  if (!platform.ok) return err({ kind: "not_available" });
  const server = getServer(env);
  await server.ready;
  return createPaymentConfirmationService({
    uow: server.uow,
    platformAccountId: platform.value,
    clock: { now: () => new Date() },
    readPayment: createPaymentObservationReader(server.provider, () => new Date()),
  })(input);
}
