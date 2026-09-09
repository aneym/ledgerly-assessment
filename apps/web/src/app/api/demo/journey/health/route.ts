// { available, reason } for the deck to check before deep-linking into the demo.
import { gated, getDemo } from "../../../../../lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = gated((req) => getDemo().journey.health(req));
