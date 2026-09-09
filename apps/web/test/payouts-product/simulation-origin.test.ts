import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/sellers/[id]/payouts/simulation/route";
import { setInstrumentationEmitter } from "../../src/lib/instrument";

const boundary = vi.hoisted(() => ({ authorize: vi.fn(), seller: vi.fn() }));
vi.mock("@/lib/authz", () => ({ authorizeSeller: boundary.authorize }));
vi.mock("@/lib/commerce", () => ({ getCommerce: () => ({ sellers: { get: boundary.seller } }) }));
vi.mock("@/lib/session", () => ({ getSession: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEMO_MODE", "1");
  vi.stubEnv("LEDGERLY_LOCAL_RUNTIME", "1");
  vi.stubEnv("LEDGERLY_TEST_MODE", "1");
  vi.stubEnv("WHOP_MODE", "mock");
  vi.stubEnv("APP_BASE_URL", "http://127.0.0.1:4474");
  vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:4474");
  vi.stubEnv("LEDGERLY_LOCAL_DB_DIR", "/unused-offline-fixture");
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("WHOP_API_KEY", undefined);
  boundary.authorize.mockResolvedValue({ ok: true, userId: "owner_origin" });
  boundary.seller.mockResolvedValue({ id: "seller_origin", runId: "run_origin", country: "US" });
  setInstrumentationEmitter({ emit() {} });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  setInstrumentationEmitter();
});

function request(
  overrides: Record<string, string | null | undefined> = {},
  url = "http://localhost:4474",
) {
  const headers = new Headers({
    origin: "http://127.0.0.1:4474",
    host: "127.0.0.1:4474",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request(`${url}/api/sellers/seller_origin/payouts/simulation`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "start" }),
  });
}
const context = () => ({ params: Promise.resolve({ id: "seller_origin" }) });

it("accepts the verified 127.0.0.1 origin with Next's localhost Request URL", async () => {
  const response = await POST(request(), context());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    source: "mock",
    kind: "ready",
    available: { amountMinor: 10000 },
    payouts: [],
  });
  expect(boundary.authorize).toHaveBeenCalledTimes(1);
});

it.each([
  { origin: "http://evil.invalid" },
  { origin: "null" },
  { origin: null },
  { host: "evil.invalid" },
  { host: null },
  { host: "localhost:4474" },
  { "sec-fetch-site": "cross-site" },
  { origin: "http://localhost:4474" },
  {
    origin: "http://evil.invalid",
    "x-forwarded-host": "127.0.0.1:4474",
    "x-forwarded-proto": "http",
  },
])("rejects untrusted local boundary %j before mutation", async (headers) => {
  const response = await POST(request(headers), context());
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ source: "mock", error: "invalid_origin" });
  expect(boundary.authorize).not.toHaveBeenCalled();
  expect(boundary.seller).not.toHaveBeenCalled();
});

it("rejects a foreign internal URL despite matching claimed Host and Origin", async () => {
  expect((await POST(request({}, "http://evil.invalid"), context())).status).toBe(403);
});
it("preserves nonlocal origin checks and authorization denial", async () => {
  vi.stubEnv("LEDGERLY_LOCAL_RUNTIME", undefined);
  expect((await POST(request(), context())).status).toBe(403);
  boundary.authorize.mockResolvedValue({ ok: false, status: 401 });
  expect((await POST(request({}, "http://127.0.0.1:4474"), context())).status).toBe(401);
});
it("keeps disabled demo requests unavailable without origin normalization", async () => {
  vi.stubEnv("DEMO_MODE", "0");
  expect((await POST(request({ origin: null }), context())).status).toBe(404);
  expect(boundary.authorize).not.toHaveBeenCalled();
});
