// Readiness probe for the deck (docs/presentation/journey.json probe_url). Anonymous by
// design: it says whether the demo is mounted and configured and whether this browser holds
// an operator session; the gated routes still refuse anything but an operator.
import { publicHealthHandler } from "../../../../lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = publicHealthHandler();
export const GET = handler;
export const OPTIONS = handler;
