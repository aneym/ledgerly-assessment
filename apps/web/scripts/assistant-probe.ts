/**
 * One-off probe for real Vercel AI Gateway access. Not part of the app build.
 *
 * Run with (from apps/web/): node scripts/assistant-probe.ts
 * (tsx is not installed in this repo; Node 26's native TypeScript support runs this
 * file directly, printing a benign MODULE_TYPELESS_PACKAGE_JSON warning first.)
 *
 * Lists the models the gateway actually returns, then makes one small
 * generateText call to confirm end-to-end auth. Prints no secrets: only
 * model ids/names and, on failure, the error name/message/status.
 */
import { gateway, generateText } from "ai";

async function main() {
  console.log("Listing available AI Gateway models...");
  const available = await gateway.getAvailableModels();
  const anthropicModels = available.models.filter((m) => m.id.startsWith("anthropic/"));
  console.log(`Total models: ${available.models.length}`);
  console.log(`Anthropic models: ${anthropicModels.length}`);
  for (const m of anthropicModels) {
    console.log(`  ${m.id}  (${m.name})`);
  }

  const chosen = anthropicModels[0]?.id ?? available.models[0]?.id;
  if (!chosen) {
    throw new Error("gateway returned zero models");
  }
  console.log(`\nProbing generateText with model: ${chosen}`);

  const result = await generateText({
    model: chosen,
    prompt: "Reply with the single word: ok.",
    maxOutputTokens: 20,
  });

  console.log("generateText succeeded.");
  console.log(`  text: ${result.text}`);
  console.log(`  finishReason: ${result.finishReason}`);
  console.log(`  usage: ${JSON.stringify(result.usage)}`);
}

main().catch((error: unknown) => {
  console.error("PROBE FAILED");
  if (error instanceof Error) {
    console.error(`  name: ${error.name}`);
    console.error(`  message: ${error.message}`);
    const withStatus = error as { statusCode?: number; status?: number; cause?: unknown };
    if (withStatus.statusCode !== undefined)
      console.error(`  statusCode: ${withStatus.statusCode}`);
    if (withStatus.status !== undefined) console.error(`  status: ${withStatus.status}`);
    if (withStatus.cause !== undefined) console.error(`  cause: ${String(withStatus.cause)}`);
  } else {
    console.error(`  ${String(error)}`);
  }
  process.exitCode = 1;
});
