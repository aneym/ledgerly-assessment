import { execFileSync } from "node:child_process";
import { getServer } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (process.env.LEDGERLY_LOCAL_RUNTIME === undefined) return new Response(null, { status: 404 });
  const server = getServer();
  await server.ready;
  const observed = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    encoding: "utf8",
  }).trim();
  const sourceRevision =
    process.env.LEDGERLY_LOADED_DIRTY === "0" &&
    !dirty &&
    observed === process.env.LEDGERLY_LOADED_REVISION
      ? observed
      : null;
  return Response.json(
    {
      source_revision: sourceRevision,
      source_clean: sourceRevision !== null,
      database: "pglite",
      provider: "mock",
      local_test: true,
      persistent: true,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
