import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

// Mounts every Better Auth endpoint (sign-up, sign-in, sign-out, session)
// under /api/auth/*. getAuth() is called per request, not at module load,
// so the handler stays lazy the same way the rest of the app's routes are.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler((request: Request) =>
  getAuth().handler(request),
);
