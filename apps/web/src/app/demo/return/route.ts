// Matching buyer, seller and operator demo profiles can leave their own run safely.
import { finishPersistedTour } from "../../../lib/tour-finish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => finishPersistedTour(request, true);
