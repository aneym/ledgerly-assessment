import { canonicalEventType, err, ok, type Result } from "@ledgerly/core";
import { z } from "zod";
export const envelopeSchema = z
  .looseObject({
    id: z.string().min(1),
    type: z.string().min(1),
    // Absent api_version means "v1". Nothing downstream reads the field itself, so accepting
    // its absence is the whole relaxation.
    api_version: z.literal("v1").optional(),
    // Absent api_version_date means an unpinned webhook. Per the docs, an unpinned webhook uses
    // the pre-2026-08-14 shape (company_id, decimal amount), which the version comparisons below
    // already produce for any value that sorts before that date, including "".
    api_version_date: z.iso.date().optional(),
    // Optional so a body that omits it (Whop's dashboard test event does) still decodes; the
    // caller supplies the verified webhook-timestamp header as a fallback, see decodeEnvelope.
    timestamp: z
      .union([z.iso.datetime({ offset: true }), z.number().int().nonnegative()])
      .optional(),
    account_id: z.string().startsWith("biz_").optional(),
    company_id: z.string().startsWith("biz_").optional(),
    data: z.unknown(),
    previous_attributes: z.unknown().optional(),
  })
  .superRefine((value, context) => {
    const field = (value.api_version_date ?? "") >= "2026-08-14" ? "account_id" : "company_id";
    if (!value[field] || value[field] === "biz_")
      context.addIssue({
        code: "custom",
        message: `Missing ${field} for this version`,
        path: [field],
      });
    if (!("data" in value))
      context.addIssue({ code: "custom", message: "Missing data", path: ["data"] });
    if (value.account_id && value.company_id && value.account_id !== value.company_id)
      context.addIssue({ code: "custom", message: "Conflicting account fields" });
  });
export type DecodedEnvelope = {
  accountId: string;
  originalAccountField: "account_id" | "company_id";
  eventType: string;
  apiVersionDate: string;
  // Narrower than the schema's own inferred type: decodeEnvelope always resolves timestamp,
  // from the body or the caller's fallback, before returning ok, so callers never see undefined.
  raw: z.infer<typeof envelopeSchema> & { timestamp: string | number };
  rawBody: string;
};
export type EnvelopeError =
  | { kind: "invalid_json"; eventType: null }
  | {
      kind: "invalid_envelope";
      // Paths and messages only, never a field's value, so a stored error never leaks payload data.
      issues: { path: string; message: string }[];
      eventType: string | null;
    };
function rawEventType(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = (raw as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : null;
}
// fallbackTimestampSeconds is the already-verified webhook-timestamp header, in seconds, used
// only when the body itself carries no timestamp. An unparseable value is treated as absent.
export function decodeEnvelope(
  rawBody: string,
  fallbackTimestampSeconds?: string,
): Result<DecodedEnvelope, EnvelopeError> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return err({ kind: "invalid_json", eventType: null });
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success)
    return err({
      kind: "invalid_envelope",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.length ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
      eventType: rawEventType(raw),
    });
  const field = (parsed.data.api_version_date ?? "") >= "2026-08-14" ? "account_id" : "company_id";
  const accountId = parsed.data[field];
  if (!accountId) throw new Error("Validated envelope is missing its account");
  const fallbackTimestamp =
    fallbackTimestampSeconds !== undefined && /^\d+$/.test(fallbackTimestampSeconds)
      ? Number(fallbackTimestampSeconds)
      : undefined;
  const timestamp = parsed.data.timestamp ?? fallbackTimestamp;
  if (timestamp === undefined)
    return err({
      kind: "invalid_envelope",
      issues: [
        { path: "timestamp", message: "Missing timestamp and no delivery timestamp available" },
      ],
      eventType: rawEventType(raw),
    });
  return ok({
    accountId,
    originalAccountField: field,
    eventType: canonicalEventType(parsed.data.type),
    apiVersionDate: parsed.data.api_version_date ?? "",
    raw: { ...parsed.data, timestamp },
    rawBody,
  });
}
