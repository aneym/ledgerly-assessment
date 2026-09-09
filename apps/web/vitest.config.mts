import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping. tsc reads tsconfig's `paths`
// directly, but vitest resolves imports through Vite, which does not - without this alias
// any "@/..." import (e.g. apps/web/src/app/api/admin/ledger/route.ts's "@/lib/instrument")
// typechecks but fails to resolve at test time.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
