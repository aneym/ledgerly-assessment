import { compiledConfiguration, verifyArtifact } from "./compiled-artifact.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createOnboardingService, runId, sellerId } from "../../packages/core/src/index";
import { getLocalRuntime, createProductsRepo } from "../../packages/db/src/index";
import { getServer } from "../../apps/web/src/lib/server";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const next = require("next") as typeof import("next").default;
const port = Number(process.argv[2]);
const compiled = process.env.LEDGERLY_RUNTIME_MODE === "compiled-test";
if (compiled) {
  if (process.env.NODE_ENV !== "test" || process.env.LEDGERLY_REPOSITORY_ROOT !== root) throw new Error("Invalid compiled runtime environment");
  verifyArtifact(root, process.env.LEDGERLY_COMPILED_ARTIFACT, process.env.LEDGERLY_COMPILED_SHA,
    compiledConfiguration(root, port, process.env.LEDGERLY_COMPILED_FIXTURE));
}
const local = getLocalRuntime(process.env);
await local.ready;
// Prior application data must have its matching provider state; never fabricate a restore.
const existing = await local.db.query.sellers.findFirst();
if (existing && !existsSync(join(process.env.LEDGERLY_LOCAL_DB_DIR as string, "mock-provider.bin"))) {
  await local.close();
  throw new Error("Existing local DB has no matching mock provider snapshot; preserve it and use a new disposable directory");
}
const server = getServer();
await server.ready;
const source = JSON.parse(await readFile(new URL("../../fixtures/demo/sellers.json", import.meta.url), "utf8"));
const run = runId("run_localcatalog");
if (!run.ok) throw new Error("Invalid fixture run");
for (const row of source.sellers) {
  const id = sellerId(row.id);
  if (!id.ok) throw new Error("Invalid fixture seller");
  const onboard = createOnboardingService({
    uow: server.uow, provider: server.provider, clock: { now: () => new Date() },
    ids: { seller: () => id.value }, apiVersionDate: "2026-08-21",
    returnUrl: `${process.env.APP_BASE_URL}/sell`, refreshUrl: `${process.env.APP_BASE_URL}/sell`,
  });
  const result = await onboard({ runId: run.value, externalId: row.handle, email: `${row.handle}@ledgerly.test`, country: row.country });
  if (!result.ok) throw new Error(`Local catalog onboarding failed: ${result.error.kind}`);
}
const catalog = JSON.parse(await readFile(new URL("../../fixtures/demo/catalog.json", import.meta.url), "utf8"));
const products = createProductsRepo(local.db);
for (const row of catalog.products) {
  if (await products.getBySlug(row.seller_id, row.slug)) continue;
  await products.create({ id: row.id, sellerId: row.seller_id, slug: row.slug, title: row.title,
    subtitle: row.subtitle, category: row.category, description: row.description.join("\n\n"),
    priceMinor: row.price.amount_minor, currency: row.price.currency, cover: null, files: [] });
}
const app = next({ dev: !compiled, ...(compiled ? {} : { webpack: true }), dir: `${root}apps/web`, hostname: "127.0.0.1", port });
await app.prepare();
const handler = app.getRequestHandler();
const http = createHttpServer((request, response) => {
  // Bind and Host/Origin checks prevent remote origins from reaching local test actions.
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (host !== `127.0.0.1:${port}` || (origin && origin !== process.env.APP_BASE_URL)) {
    response.writeHead(403); response.end("Local runtime requires its exact loopback origin"); return;
  }
  // The isolated server is the final hop. Do not let client-supplied forwarding headers
  // make server-rendered pages send authenticated reads to another host.
  request.headers["x-forwarded-host"] = `127.0.0.1:${port}`;
  request.headers["x-forwarded-proto"] = "http";
  request.headers["x-forwarded-port"] = String(port);
  void handler(request, response);
});
http.listen(port, "127.0.0.1", () => {
  console.log(`Ledgerly local test runtime: http://127.0.0.1:${port}. Database PGlite, provider mock. Fictional catalog ready.`);
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  http.close();
  await app.close();
  await local.close();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
