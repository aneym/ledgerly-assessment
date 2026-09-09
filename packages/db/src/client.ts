import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { neon } from "@neondatabase/serverless";
import { drizzle as neonDrizzle } from "drizzle-orm/neon-http";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
export function createDb(url: string) {
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !(parsed.hostname === "neon.tech" || parsed.hostname.endsWith(".neon.tech"))
  )
    throw new Error("createDb requires a Neon Postgres URL; use createTestDb for local tests");
  return neonDrizzle(neon(url), { schema });
}
export async function createTestDb() {
  const client = new PGlite();
  const db = pgliteDrizzle(client, { schema });
  try {
    await migrate(db, {
      migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle"),
    });
  } catch (cause) {
    await client.close();
    throw cause;
  }
  return db;
}
