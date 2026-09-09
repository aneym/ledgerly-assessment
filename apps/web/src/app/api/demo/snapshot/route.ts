// Authenticated profiles read only their own persisted instrumentation history.
import { snapshotPersistedTour } from "../../../../lib/tour-finish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = snapshotPersistedTour;
