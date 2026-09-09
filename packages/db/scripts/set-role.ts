// Set a user's role by email. Operator promotion is server-side only; there is
// no route for it. Usage: DATABASE_URL=... pnpm --filter @ledgerly/db set-role <email> <buyer|seller|operator>
import { neon } from "@neondatabase/serverless";

const [email, role] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (!email || !["buyer", "seller", "operator"].includes(role ?? "")) {
  throw new Error("usage: set-role <email> <buyer|seller|operator>");
}
const sql = neon(url);
const rows =
  await sql`update "user" set role = ${role} where email = ${email} returning id, email, role`;
if (rows.length === 0) throw new Error(`no user with email ${email}`);
console.log(JSON.stringify(rows[0]));
