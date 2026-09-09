// Names of the environment variables the app reads, so process.env carries
// them as optional string properties for typing. Values still come from Vercel
// or apps/web/.env.local; see .env.example.
declare namespace NodeJS {
  interface ProcessEnv {
    WHOP_MODE?: string;
    WHOP_API_BASE?: string;
    WHOP_API_VERSION_DATE?: string;
    WHOP_PLATFORM_ACCOUNT_ID?: string;
    DEMO_MODE?: string;
    RUN_ID?: string;
    APP_BASE_URL?: string;
    ONBOARDING_RETURN_URL?: string;
    ONBOARDING_REFRESH_URL?: string;
    ASSISTANT_MODEL?: string;
  }
}
