// The sample persona for the guided demo: a dedicated fictional account whose session the
// server mints for a visitor of /demo, so nobody types credentials on camera. Two ways a
// deployment turns it on: DEMO_PERSONA_ENABLED=1, where the persona is the restricted "demo"
// role (lib/session.ts: reads filtered to its own run, writes outside the run refused), or
// DEMO_PERSONA_ISOLATED=1, where the deployment attests its database is an isolated demo copy
// and the persona may hold the real operator role. The password stays in server env; the app
// never sends it to a browser or a log.

export interface DemoPersona {
  email: string;
  password: string;
  /** Shown in the tour bar; the email is not. */
  name: string;
}

export function demoPersona(env: NodeJS.ProcessEnv = process.env): DemoPersona | null {
  if (env.DEMO_MODE !== "1") return null;
  if (env.DEMO_PERSONA_ENABLED !== "1" && env.DEMO_PERSONA_ISOLATED !== "1") return null;
  const email = env.DEMO_PERSONA_EMAIL?.trim();
  const password = env.DEMO_PERSONA_PASSWORD;
  if (!email || !password) return null;
  return { email, password, name: env.DEMO_PERSONA_NAME?.trim() || "Sample presenter" };
}

/** True when the signed-in user is the persona (by email, case-insensitive). */
export function isPersona(persona: DemoPersona | null, email: string | null | undefined): boolean {
  return Boolean(persona && email && email.toLowerCase() === persona.email.toLowerCase());
}
