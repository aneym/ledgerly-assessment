import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  transpilePackages: ["@ledgerly/core", "@ledgerly/whop", "@ledgerly/db"],
  // The app lives in a pnpm workspace. Trace files from the repo root so the
  // serverless bundle on Vercel includes the workspace packages it imports.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // /present serves the deck from docs/presentation (route handler under app/present); the
  // files sit outside apps/web, so they must be traced into the serverless bundle.
  outputFileTracingIncludes: {
    "/present/**": ["../../docs/presentation/**/*"],
    "/handoff": ["./public/demo-clips/final/**/*"],
  },
  // The deck mount adds the trailing slash itself (directory URLs must end in / so the deck's
  // relative ../journey.json resolves); Next's own redirect the other way would loop with it.
  skipTrailingSlashRedirect: true,
  // Browser QA and the Whop onboarding return land on the tailnet host; without this Next's
  // dev server rejects the HMR origin and the page never hydrates there.
  allowedDevOrigins: ["localhost", "127.0.0.1", "localhost", "127.0.0.1"],
};

export default nextConfig;
