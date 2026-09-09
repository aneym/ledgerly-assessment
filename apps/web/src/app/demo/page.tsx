import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components";
import { getAuth } from "@/lib/auth";
import { isDemoMode, returnPolicy } from "@/lib/demo";
import { demoPersona, isPersona } from "@/lib/demo-persona";
import { profileUrl } from "@/lib/demo-profile-url";
import { demoProfilesEnabled } from "@/lib/demo-profiles";
import { parseReturnTarget } from "../../../../../packages/demo-runtime/src/journey";
import { STEPS } from "../../../../../packages/demo-runtime/src/steps";
import "@/components/buyer/buyer.css";
import "./demo-intro.css";
import { DemoIntro } from "./demo-intro";

export const metadata: Metadata = { title: "Guided demo · Ledgerly" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/** Resolve the session and demo destination before rendering the entry. */
export default async function DemoIntroPage(props: PageProps<"/demo">) {
  if (!isDemoMode()) notFound();
  const search = await props.searchParams;
  const returnRaw = first(search.return);
  const from = first(search.from);
  const why = first(search.why);
  const returnTo = parseReturnTarget(returnRaw, returnPolicy());
  // Account switch mid-run: the tour sends `run` and `step` here; after the operator signs
  // in, the destination is that step's screen with the same run, not a fresh /demo/start.
  const runRaw = first(search.run);
  const run = runRaw && /^[A-Za-z0-9_-]{1,64}$/.test(runRaw) ? runRaw : null;
  const stepRaw = first(search.step);
  const resumeStep = STEPS.find((s) => s.id === stepRaw && s.path) ?? null;

  const auth = await getAuth().api.getSession({ headers: await headers() });
  const user = auth?.user ?? null;
  const role = typeof user?.role === "string" ? user.role : null;
  const operator = role === "operator";
  // Sample persona configured (isolated demo deployment): the visitor never signs in by hand.
  // /demo/session mints the persona's session server-side and forwards to /demo/start.
  const persona = demoPersona();
  const asPersona = isPersona(persona, user?.email);
  if (persona && !operator && why !== "persona" && !(resumeStep && run)) {
    const q = new URLSearchParams();
    if (returnTo) q.set("return", returnTo);
    if (from) q.set("from", from);
    redirect(`/demo/session${q.size ? `?${q.toString()}` : ""}`);
  }

  const startQuery = new URLSearchParams();
  if (returnTo) startQuery.set("return", returnTo);
  if (from) startQuery.set("from", from);
  let startUrl = `/demo/start${startQuery.size ? `?${startQuery.toString()}` : ""}`;
  if (resumeStep && run) {
    const q = new URLSearchParams(startQuery);
    q.set("tour", resumeStep.id);
    q.set("run", run);
    startUrl = `${resumeStep.path}?${q.toString()}`;
  }
  // Per-run sample profiles: the visitor becomes this run's operator profile and starts.
  if (
    demoProfilesEnabled() &&
    !operator &&
    role !== "demo" &&
    why !== "persona" &&
    !(resumeStep && run)
  ) {
    redirect(profileUrl("operator", startUrl));
  }
  return (
    <Shell screen="demo-intro">
      <DemoIntro
        personaName={persona?.name ?? null}
        operator={operator}
        user={user ? { email: user.email, isPersona: asPersona } : null}
        why={why}
        startUrl={startUrl}
        returnTo={returnTo}
        resumeStep={resumeStep}
        run={run}
      />
    </Shell>
  );
}
