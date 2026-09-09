// Canonical demo start: /demo/start?return=/deck&from=<slide>. Validates the return target,
// sets the run cookie and redirects to the first step's screen. Owned by demo-runtime.
import { gated, getDemo } from "../../../lib/demo";
import { runIdFromRequest } from "../../../lib/instrument";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One run per take: reuse the browser's run cookie when the profile route already minted one,
// else mint a fresh id. Never the process-wide run.
export const GET = gated(
  (req) =>
    getDemo()
      .journeyFor(runIdFromRequest(req) ?? undefined)
      .start(req),
  { redirectToSignIn: true },
);
