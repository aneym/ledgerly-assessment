import { after } from "next/server";
import { instrumented } from "../../../../lib/instrument";
import { getServer } from "../../../../lib/server";
import { handleWebhook } from "../../../../lib/service-http";

export const runtime = "nodejs";

// Startup or handler failures surface as a JSON 500 with the error name and
// message (never a stack, never a secret) so a provider delivery log shows why
// a delivery failed. The body is a diagnostic aid, not a contract.
export const POST = instrumented(async (request) => {
  try {
    return await handleWebhook(request, getServer(), after);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    console.error("webhook route failed", error.name, error.message);
    return Response.json({ error: error.name, message: error.message }, { status: 500 });
  }
});
