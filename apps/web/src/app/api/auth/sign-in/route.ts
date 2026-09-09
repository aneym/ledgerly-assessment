// POST /api/auth/sign-in: the path the marketplace pages are coded against (JSON-shapes
// addendum). Better Auth's own handler (mounted by ../[...all]/route.ts) lives at
// /api/auth/sign-in/email, so this is a thin wrapper that forwards the request there and
// normalizes any error body to `{ error }`. A 2xx response, including its session cookie,
// passes through unchanged.

import { createForwardEmailAuthHandler } from "../../../../lib/auth";
import { instrumented } from "../../../../lib/instrument";

export const runtime = "nodejs";

export const POST = instrumented(createForwardEmailAuthHandler("sign-in/email"));
