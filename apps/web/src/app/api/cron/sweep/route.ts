import { instrumented } from "../../../../lib/instrument";
import { getServer } from "../../../../lib/server";
import { handleSweep } from "../../../../lib/service-http";

export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = instrumented((request) =>
  handleSweep(request, process.env.CRON_SECRET, getServer),
);
