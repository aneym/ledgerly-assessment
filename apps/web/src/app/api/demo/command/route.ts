// Dev-mode commands: reset (local only), switch-role, and fixture rehearsal of a step.
import { gated, getDemo } from "../../../../lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = gated((req) => getDemo().command(req));
