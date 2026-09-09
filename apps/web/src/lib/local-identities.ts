import { createHmac } from "node:crypto";
import { assertLocalRuntimeEnvironment } from "@ledgerly/db";
export function localGeneration(env: NodeJS.ProcessEnv = process.env) {
  assertLocalRuntimeEnvironment(env);
  if (!env.BETTER_AUTH_SECRET) throw new Error("Missing local auth secret");
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("local-identity-generation")
    .digest("hex")
    .slice(0, 16);
}
export function requireLocalRequest(request: Request, env = process.env) {
  assertLocalRuntimeEnvironment(env);
  const base = new URL(env.APP_BASE_URL as string);
  const origin = request.headers.get("origin");
  return (
    // Next custom-server route Requests normalize 127.0.0.1 to localhost.
    [base.origin, `http://localhost:${base.port}`].includes(new URL(request.url).origin) &&
    request.headers.get("host") === base.host &&
    (!origin || origin === base.origin) &&
    request.headers.get("sec-fetch-site") !== "cross-site"
  );
}
