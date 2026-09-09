// Shared structural narrowing for a failed provider call's error shape, used by every
// seller route that can surface a raw Whop HTTP failure to its own caller (POST
// /api/sellers and POST /api/sellers/[id]/onboarding-link).
//
// WhopError (packages/core/src/ports/whop-types.ts) and WhopHttpError (packages/whop's own
// client) both carry `status`/`body` under those exact names but are not a single named
// type at the point these routes see them (onboardSeller's error is a union of its own
// onboarding-specific kinds plus whatever the provider call it wraps returned raw), so this
// narrows structurally instead of importing either type.
import { parseWhopErrorBody } from "./seller-view";

type ProviderErrorLike = { status?: number; body?: unknown };

function isProviderErrorLike(value: unknown): value is ProviderErrorLike {
  return typeof value === "object" && value !== null;
}

export function extractProviderError(error: unknown): {
  status?: number;
  whop_error_code?: string;
  message?: string;
} {
  if (!isProviderErrorLike(error)) return {};
  const parsed = parseWhopErrorBody(error.body);
  return {
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(parsed.code !== undefined ? { whop_error_code: parsed.code } : {}),
    ...(parsed.message !== undefined ? { message: parsed.message } : {}),
  };
}
