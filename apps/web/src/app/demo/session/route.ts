// Mints the sample persona's session for a visitor of the guided demo and forwards to
// /demo/start. 404 unless the deployment configures an isolated persona (lib/demo-persona).
// The sign-in runs server-side through Better Auth's own API with the env-held password;
// the browser receives only the session cookie Better Auth sets.
import { headers } from "next/headers";
import { parseReturnTarget } from "../../../../../../packages/demo-runtime/src/journey";
import { STEPS } from "../../../../../../packages/demo-runtime/src/steps";
import { getAuth } from "../../../lib/auth";
import { isDemoMode, returnPolicy } from "../../../lib/demo";
import { demoPersona } from "../../../lib/demo-persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PersonaSignIn = (input: {
  email: string;
  password: string;
  headers: Headers;
}) => Promise<Response>;

export function personaSessionHandler(deps: {
  persona: () => ReturnType<typeof demoPersona>;
  signIn: PersonaSignIn;
  isDemoMode?: () => boolean;
}) {
  return async (req: Request): Promise<Response> => {
    if (!(deps.isDemoMode ?? isDemoMode)()) return new Response(null, { status: 404 });
    const persona = deps.persona();
    if (!persona) return new Response(null, { status: 404 });
    const url = new URL(req.url);
    const stepId = url.searchParams.get("step");
    const run = url.searchParams.get("run");
    const step = stepId ? STEPS.find((candidate) => candidate.id === stepId) : null;
    if (
      (stepId !== null && !step?.path) ||
      (stepId !== null && (!run || !/^[A-Za-z0-9_-]{1,64}$/.test(run)))
    )
      return new Response("Invalid demo step or run", { status: 400 });
    const q = new URLSearchParams();
    const ret = parseReturnTarget(url.searchParams.get("return"), returnPolicy());
    if (ret) q.set("return", ret);
    const from = url.searchParams.get("from");
    if (from) q.set("from", from);
    if (step && run) {
      q.set("tour", step.id);
      q.set("run", run);
    }
    const failureQuery = new URLSearchParams(q);
    failureQuery.delete("tour");
    if (step) failureQuery.set("step", step.id);
    failureQuery.set("why", "persona");
    const failureUrl = `/demo?${failureQuery.toString()}`;
    let signed: Response;
    try {
      signed = await deps.signIn({
        email: persona.email,
        password: persona.password,
        headers: req.headers,
      });
    } catch {
      return redirect(failureUrl);
    }
    if (!signed.ok) return redirect(failureUrl);
    const out = new Headers({ "cache-control": "no-store" });
    // Every Set-Cookie Better Auth produced (session token and its signature).
    const cookies =
      typeof signed.headers.getSetCookie === "function"
        ? signed.headers.getSetCookie()
        : [signed.headers.get("set-cookie") ?? ""].filter(Boolean);
    for (const c of cookies) out.append("set-cookie", c);
    out.set(
      "location",
      `${step && run ? step.path : "/demo/start"}${q.size ? `?${q.toString()}` : ""}`,
    );
    return new Response(null, { status: 303, headers: out });
  };
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

export const GET = personaSessionHandler({
  persona: () => demoPersona(),
  signIn: async ({ email, password }) =>
    getAuth().api.signInEmail({
      body: { email, password },
      headers: await headers(),
      asResponse: true,
    }),
});
