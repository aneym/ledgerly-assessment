import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, signStandardWebhook, verifyStandardWebhook } from "../src/index";

const now = new Date("2026-09-08T12:00:00Z");
const timestamp = String(now.getTime() / 1000);
const rawBody = '{"type":"payment.succeeded"}';
const secret = "ws_c2VjcmV0";
function signed(keyEncoding: "raw" | "base64-after-prefix" = "raw") {
  return {
    rawBody,
    secret,
    now,
    keyEncoding,
    headers: {
      "webhook-id": "msg_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": signStandardWebhook({
        rawBody,
        id: "msg_1",
        timestamp,
        secret,
        keyEncoding,
      }),
    },
  };
}
describe("Standard Webhooks", () => {
  it.each(["raw", "base64-after-prefix"] as const)("signs and verifies %s keys", (encoding) => {
    expect(verifyStandardWebhook(signed(encoding))).toEqual({ ok: true, value: true });
  });
  it("matches an independently calculated signature", () => {
    const expected = createHmac("sha256", Buffer.from(secret))
      .update(`msg_1.${timestamp}.${rawBody}`)
      .digest("base64");
    expect(signed().headers["webhook-signature"]).toBe(`v1,${expected}`);
  });
  it("decodes the suffix in reference mode", () => {
    const expected = createHmac("sha256", "secret")
      .update(`msg_1.${timestamp}.${rawBody}`)
      .digest("base64");
    expect(signed("base64-after-prefix").headers["webhook-signature"]).toBe(`v1,${expected}`);
  });
  it("rejects a tampered body", () => {
    expect(verifyStandardWebhook({ ...signed(), rawBody: `${rawBody} ` }).ok).toBe(false);
  });
  it.each([-301, 301])("rejects a timestamp outside tolerance by %s seconds", (offset) => {
    expect(
      verifyStandardWebhook({ ...signed(), now: new Date(now.getTime() + offset * 1000) }),
    ).toEqual({ ok: false, error: { kind: "stale_timestamp" } });
  });
  it("accepts the exact tolerance boundary", () => {
    expect(verifyStandardWebhook({ ...signed(), now: new Date(now.getTime() + 300000) }).ok).toBe(
      true,
    );
  });
  it("accepts any matching signature", () => {
    const input = signed();
    input.headers["webhook-signature"] =
      `v1,${Buffer.alloc(32).toString("base64")} v2,ignored ${input.headers["webhook-signature"]}`;
    expect(verifyStandardWebhook(input).ok).toBe(true);
  });
  it("rejects the wrong key encoding", () => {
    expect(verifyStandardWebhook({ ...signed(), keyEncoding: "base64-after-prefix" }).ok).toBe(
      false,
    );
  });
  it("rejects malformed signatures without throwing", () => {
    const input = signed();
    input.headers["webhook-signature"] = "v1,short";
    expect(verifyStandardWebhook(input).ok).toBe(false);
  });
  it("rejects malformed timestamps", () => {
    const input = signed();
    input.headers["webhook-timestamp"] = "NaN";
    expect(verifyStandardWebhook(input)).toEqual({
      ok: false,
      error: { kind: "invalid_timestamp" },
    });
  });
});
describe("envelopes", () => {
  const base = {
    id: "evt_1",
    type: "withdrawal.updated",
    api_version: "v1",
    timestamp: now.toISOString(),
    data: { status: "pending", amount: 1240, currency: "eur" },
    extra: "preserved",
  };
  it.each([
    ["2026-06-01", "company_id"],
    ["2026-08-14", "account_id"],
  ])("decodes the %s account field", (date, field) => {
    const raw = { ...base, api_version_date: date, [field ?? ""]: "biz_seller_de" };
    const rawBody = JSON.stringify(raw);
    const decoded = decodeEnvelope(rawBody);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("Expected valid envelope");
    expect(decoded.value).toMatchObject({
      accountId: "biz_seller_de",
      originalAccountField: field,
      eventType: "payout.updated",
      apiVersionDate: date,
      raw,
      rawBody,
    });
    expect(decoded.value.raw.type).toBe("withdrawal.updated");
  });
  it("rejects an account field from the wrong version", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({ ...base, api_version_date: "2026-06-01", account_id: "biz_seller" }),
      ).ok,
    ).toBe(false);
  });
  it("rejects conflicting account fields", () => {
    expect(
      decodeEnvelope(
        JSON.stringify({
          ...base,
          api_version_date: "2026-08-21",
          account_id: "biz_a",
          company_id: "biz_b",
        }),
      ).ok,
    ).toBe(false);
  });
  it("rejects malformed JSON and incomplete envelopes", () => {
    expect(decodeEnvelope("{").ok).toBe(false);
    expect(decodeEnvelope("{}").ok).toBe(false);
  });
  it("decodes a body with no timestamp using the delivery's webhook-timestamp as a fallback", () => {
    const { timestamp: _timestamp, ...withoutTimestamp } = base;
    const raw = { ...withoutTimestamp, api_version_date: "2026-08-21", account_id: "biz_seller" };
    const fallbackSeconds = String(Math.floor(now.getTime() / 1000));
    const decoded = decodeEnvelope(JSON.stringify(raw), fallbackSeconds);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("Expected valid envelope");
    expect(decoded.value.raw.timestamp).toBe(Number(fallbackSeconds));
  });
  it("fails when timestamp is absent and no fallback timestamp is available", () => {
    const { timestamp: _timestamp, ...withoutTimestamp } = base;
    const raw = { ...withoutTimestamp, api_version_date: "2026-08-21", account_id: "biz_seller" };
    const decoded = decodeEnvelope(JSON.stringify(raw));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("Expected decode failure");
    expect(decoded.error.kind).toBe("invalid_envelope");
    if (decoded.error.kind !== "invalid_envelope") throw new Error("Expected invalid_envelope");
    expect(decoded.error.issues).toEqual([
      { path: "timestamp", message: "Missing timestamp and no delivery timestamp available" },
    ]);
  });
  it("decodes a body with no api_version, defaulting to v1", () => {
    const { api_version: _apiVersion, ...withoutApiVersion } = base;
    const raw = {
      ...withoutApiVersion,
      api_version_date: "2026-08-21",
      account_id: "biz_seller",
    };
    expect(decodeEnvelope(JSON.stringify(raw)).ok).toBe(true);
  });
  it("treats an absent api_version_date as an unpinned pre-2026-08-14 webhook using company_id", () => {
    const { api_version_date: _apiVersionDate, ...withoutApiVersionDate } = base as Record<
      string,
      unknown
    >;
    const raw = { ...withoutApiVersionDate, company_id: "biz_seller" };
    const decoded = decodeEnvelope(JSON.stringify(raw));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("Expected valid envelope");
    expect(decoded.value).toMatchObject({
      accountId: "biz_seller",
      originalAccountField: "company_id",
      apiVersionDate: "",
    });
  });
  it("reports issue paths and messages, never field values, on a decode failure", () => {
    const raw = { ...base, api_version_date: "2026-08-21" };
    const decoded = decodeEnvelope(JSON.stringify(raw));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("Expected decode failure");
    expect(decoded.error.kind).toBe("invalid_envelope");
    if (decoded.error.kind !== "invalid_envelope") throw new Error("Expected invalid_envelope");
    expect(decoded.error.eventType).toBe("withdrawal.updated");
    expect(decoded.error.issues).toEqual([
      { path: "account_id", message: "Missing account_id for this version" },
    ]);
    for (const issue of decoded.error.issues)
      for (const value of ["biz_", "1240", "eur", "preserved"])
        expect(issue.message).not.toContain(value);
  });
});
