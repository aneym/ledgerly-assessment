// Picks the language model the assistant talks to, and reports gateway configuration
// status. Never logs or returns a credential value, only whether one is present.
//
// A live `gateway.getAvailableModels()` probe against this deployment's Vercel AI Gateway
// on 2026-09-08 listed 14 Anthropic models. The gateway account is on the free tier, which
// returns 403 RestrictedModelsError for every Anthropic model newer than Claude 3 (Haiku
// 4.5, Sonnet 4.5, Opus 4.5, Fable 5.1 all rejected; verified directly). anthropic/claude-3-haiku
// is the newest Anthropic model the account can actually call, and it supports tool calling,
// so it is the default here and is set explicitly as ASSISTANT_MODEL in every Vercel
// environment (production, preview, development) and in local .env.local. Once the gateway
// account has paid credits, ASSISTANT_MODEL should move to the newest available Claude model
// without a code change. See docs/lanes/architecture/operator-assistant-contract.md for the
// full model list and both probe transcripts (success and the 403 case).
const DEFAULT_MODEL = "zai/glm-5.3-flash";

export function getAssistantModelId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ASSISTANT_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_MODEL;
}

// The AI Gateway (bundled in the `ai` package, no separate @ai-sdk/gateway install needed)
// authenticates model requests with, in order of precedence: an explicit AI_GATEWAY_API_KEY,
// a Vercel access token, or an OIDC token. In local development the OIDC token comes from
// `vercel env pull` as VERCEL_OIDC_TOKEN; on a Vercel deployment it is injected and refreshed
// automatically. "configured" only reports whether one of these is present, never its value.
export function isGatewayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim());
}
