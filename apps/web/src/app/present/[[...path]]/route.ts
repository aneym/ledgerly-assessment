import { resolvePresentRoot, servePresent } from "@/lib/present";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ROOT = resolvePresentRoot(process.cwd(), process.env);

export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path: segments = [] } = await ctx.params;
  return servePresent(ROOT, segments, new URL(req.url).pathname);
}
