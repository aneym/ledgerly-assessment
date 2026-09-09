import { describe, expect, it } from "vitest";
import { personaSessionHandler } from "../src/app/demo/session/route";
import { demoPersona, isPersona } from "../src/lib/demo-persona";

const env = (over: Record<string, string>) =>
  ({ DEMO_MODE: "1", ...over }) as unknown as NodeJS.ProcessEnv;

describe("sample persona configuration", () => {
  it("exists only with demo mode, the isolation attestation and both credentials", () => {
    expect(demoPersona(env({}))).toBeNull();
    expect(
      demoPersona(env({ DEMO_PERSONA_EMAIL: "p@x.test", DEMO_PERSONA_PASSWORD: "s" })),
    ).toBeNull();
    expect(
      demoPersona(env({ DEMO_PERSONA_ISOLATED: "1", DEMO_PERSONA_EMAIL: "p@x.test" })),
    ).toBeNull();
    const p = demoPersona(
      env({
        DEMO_PERSONA_ISOLATED: "1",
        DEMO_PERSONA_EMAIL: "p@x.test",
        DEMO_PERSONA_PASSWORD: "s",
      }),
    );
    expect(p).toEqual({ email: "p@x.test", password: "s", name: "Sample presenter" });
    expect(
      demoPersona(
        env({
          DEMO_PERSONA_ENABLED: "1",
          DEMO_PERSONA_EMAIL: "p@x.test",
          DEMO_PERSONA_PASSWORD: "s",
        }),
      ),
    ).toEqual({ email: "p@x.test", password: "s", name: "Sample presenter" });
    expect(isPersona(p, "P@X.test")).toBe(true);
    expect(isPersona(p, "other@x.test")).toBe(false);
    expect(isPersona(null, "p@x.test")).toBe(false);
  });
});

describe("persona session route", () => {
  const persona = { email: "p@x.test", password: "s", name: "Mara" };
  it("mints the session server-side and forwards to /demo/start with the deck target kept", async () => {
    let seen: { email: string; password: string } | null = null;
    const handler = personaSessionHandler({
      isDemoMode: () => true,
      persona: () => persona,
      signIn: async ({ email, password }) => {
        seen = { email, password };
        const h = new Headers({ "content-type": "application/json" });
        h.append("set-cookie", "better-auth.session_token=abc.sig; Path=/; HttpOnly");
        return new Response("{}", { status: 200, headers: h });
      },
    });
    const res = await handler(new Request("http://x/demo/session?return=%2Fdeck&from=launch"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/demo/start?return=%2Fdeck&from=launch");
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=abc.sig");
    expect(seen).toEqual({ email: "p@x.test", password: "s" });
  });
  it("is 404 without a configured persona and sends a failed sign-in back to the intro", async () => {
    const none = personaSessionHandler({
      isDemoMode: () => true,
      persona: () => null,
      signIn: async () => new Response(null),
    });
    expect((await none(new Request("http://x/demo/session"))).status).toBe(404);
    const failed = personaSessionHandler({
      isDemoMode: () => true,
      persona: () => persona,
      signIn: async () => new Response("{}", { status: 401 }),
    });
    const res = await failed(new Request("http://x/demo/session?return=%2Fdeck"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/demo?return=%2Fdeck&why=persona");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
