import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalRuntime } from "@ledgerly/db";
import { expect, it, vi } from "vitest";
import { GET as operator } from "../src/app/api/local-runtime/operator/route";
import { getAuth } from "../src/lib/auth";
import { localGeneration } from "../src/lib/local-identities";

it("creates a real local operator without granting that role to demo profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledgerly-controls-"));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    LEDGERLY_LOCAL_RUNTIME: "1",
    LEDGERLY_TEST_MODE: "1",
    LEDGERLY_LOCAL_DB_DIR: directory,
    WHOP_MODE: "mock",
    APP_BASE_URL: "http://127.0.0.1:4474",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    WHOP_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    DEMO_MODE: "1",
    DEMO_PROFILES_ENABLED: "1",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("WHOP_API_KEY", undefined);
  const local = getLocalRuntime(env);
  await local.ready;
  try {
    const url = `${env.APP_BASE_URL}/api/local-runtime/operator`;
    expect(
      (
        await operator(
          new Request(url, {
            headers: { host: "127.0.0.1:4474", origin: "https://foreign.invalid" },
          }),
        )
      ).status,
    ).toBe(403);
    const result = await operator(new Request(url, { headers: { host: "127.0.0.1:4474" } }));
    expect(result.status).toBe(303);
    const cookie = result.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const session = await getAuth().api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.role).toBe("operator");
    expect(session?.user.email).toMatch(/^local-operator-[a-f0-9]+@ledgerly\.test$/);
    expect(
      localGeneration({ ...env, BETTER_AUTH_SECRET: randomBytes(32).toString("hex") }),
    ).not.toBe(localGeneration(env));
  } finally {
    await local.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
