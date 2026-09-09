import { createHmac } from "node:crypto";
import { getAuth } from "@/lib/auth";
import { getCommerce } from "@/lib/commerce";
import { localGeneration, requireLocalRequest } from "@/lib/local-identities";
import { getServer } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (process.env.LEDGERLY_LOCAL_RUNTIME === undefined) return new Response(null, { status: 404 });
  if (!requireLocalRequest(request)) return new Response(null, { status: 403 });
  await getServer().ready;
  const generation = localGeneration();
  const email = `local-operator-${generation}@ledgerly.test`;
  const password = createHmac("sha256", process.env.BETTER_AUTH_SECRET as string)
    .update("local-operator-password")
    .digest("base64url");
  const auth = getAuth();
  const headers = new Headers(request.headers);
  headers.set("origin", process.env.APP_BASE_URL as string);
  let signed = await auth.api.signInEmail({ body: { email, password }, headers, asResponse: true });
  if (!signed.ok)
    signed = await auth.api.signUpEmail({
      body: { email, password, name: "Local test operator" },
      headers,
      asResponse: true,
    });
  if (!signed.ok) return new Response("Local operator sign-in failed", { status: 503 });
  const body = await signed.clone().json();
  if (typeof body.user?.id !== "string") throw new Error("Missing local operator user");
  await getCommerce().users.setRole(body.user.id, "operator");
  const output = new Headers({ location: "/admin/sellers", "cache-control": "no-store" });
  for (const cookie of signed.headers.getSetCookie()) output.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers: output });
}
