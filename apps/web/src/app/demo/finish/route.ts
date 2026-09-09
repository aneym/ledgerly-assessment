// Completion comes from authenticated, run-scoped persisted server instrumentation.
import { finishPersistedTour } from "../../../lib/tour-finish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => finishPersistedTour(request);
