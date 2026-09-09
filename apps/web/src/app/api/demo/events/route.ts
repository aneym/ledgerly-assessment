import { listInstrumentationEvents } from "@ledgerly/db";
import { getServer } from "@/lib/server";
import { getSession } from "@/lib/session";
import { createEventsHandler } from "./handler";

export const runtime = "nodejs";

export const GET = createEventsHandler({
  isDemoMode: () => process.env.DEMO_MODE === "1",
  getSession,
  listEvents: (query) => listInstrumentationEvents(getServer().db, query),
});
