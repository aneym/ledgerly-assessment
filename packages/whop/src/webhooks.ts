import { createHmac, timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "@ledgerly/core";
export type KeyEncoding = "raw" | "base64-after-prefix";
export type WebhookHeaders = {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
};
export type SignatureError = {
  kind: "invalid_headers" | "invalid_timestamp" | "stale_timestamp" | "invalid_signature";
};
type SigningInput = {
  rawBody: string;
  id: string;
  timestamp: string;
  secret: string;
  keyEncoding?: KeyEncoding;
};
function key(secret: string, encoding: KeyEncoding): Buffer {
  // The correct key encoding is confirmed only by the first real sandbox delivery.
  return encoding === "raw"
    ? Buffer.from(secret, "utf8")
    : Buffer.from(secret.slice(secret.indexOf("_") + 1), "base64");
}
export function signStandardWebhook(input: SigningInput): string {
  return `v1,${createHmac("sha256", key(input.secret, input.keyEncoding ?? "raw"))
    .update(`${input.id}.${input.timestamp}.${input.rawBody}`)
    .digest("base64")}`;
}
export function verifyStandardWebhook(input: {
  rawBody: string;
  headers: WebhookHeaders;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
  keyEncoding?: KeyEncoding;
}): Result<true, SignatureError> {
  const {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  } = input.headers;
  if (!id || !timestamp || !signature) return err({ kind: "invalid_headers" });
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)))
    return err({ kind: "invalid_timestamp" });
  const now = (input.now ?? new Date()).getTime();
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isFinite(now) || !Number.isFinite(tolerance) || tolerance < 0)
    throw new Error("Invalid signature clock or tolerance");
  if (Math.abs(now / 1000 - Number(timestamp)) > tolerance) return err({ kind: "stale_timestamp" });
  const expected = Buffer.from(
    signStandardWebhook({
      rawBody: input.rawBody,
      id,
      timestamp,
      secret: input.secret,
      keyEncoding: input.keyEncoding ?? "raw",
    }).slice(3),
    "base64",
  );
  for (const part of signature.split(/\s+/)) {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(part)) continue;
    const actual = Buffer.from(part.slice(3), "base64");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return ok(true);
  }
  return err({ kind: "invalid_signature" });
}
