// Apply the SQL migrations in packages/db/drizzle to the database named by
// DATABASE_URL. Used for the Neon main, dev and ci branches. Idempotent: the
// Drizzle migrator records applied migrations in drizzle.__drizzle_migrations.
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const db = drizzle(neon(url));
await migrate(db, { migrationsFolder });
console.log(`migrations applied from ${migrationsFolder} to ${new URL(url).hostname}`);
