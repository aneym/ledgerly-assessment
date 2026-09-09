CREATE TYPE "public"."resolution_action_outcome" AS ENUM('succeeded', 'no_change', 'failed', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."resolution_action_type" AS ENUM('refetch', 'import_confirmed', 'recheck', 'escalate', 'resolve', 'note');--> statement-breakpoint
CREATE TYPE "public"."resolution_case_kind" AS ENUM('missing_local_payment', 'unconfirmed_transfer', 'amount_mismatch');--> statement-breakpoint
CREATE TYPE "public"."resolution_case_status" AS ENUM('detected', 'investigating', 'action_pending', 'rechecking', 'resolved', 'escalated');--> statement-breakpoint
CREATE TABLE "resolution_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"action" "resolution_action_type" NOT NULL,
	"actor_user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"outcome" "resolution_action_outcome" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolution_actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "resolution_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "resolution_case_kind" NOT NULL,
	"status" "resolution_case_status" DEFAULT 'detected' NOT NULL,
	"seller_id" text,
	"order_id" text,
	"provider_resource_type" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"expected" jsonb,
	"observed" jsonb,
	"impact" text NOT NULL,
	"next_safe_action" text,
	"assigned_to" text,
	"provenance" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"correlation_id" text,
	CONSTRAINT "resolution_cases_kind_resource_unique" UNIQUE("kind","provider_resource_id")
);
--> statement-breakpoint
UPDATE "orders" SET "provenance" = 'mock' WHERE "provenance" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "provenance" SET DEFAULT 'mock';--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "provenance" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "provenance" text DEFAULT 'mock' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "resolution_actions" ADD CONSTRAINT "resolution_actions_case_id_resolution_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."resolution_cases"("id") ON DELETE no action ON UPDATE no action;