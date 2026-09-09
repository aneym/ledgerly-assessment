CREATE TYPE "public"."account_field" AS ENUM('account_id', 'company_id');--> statement-breakpoint
CREATE TYPE "public"."account_side" AS ENUM('platform', 'seller');--> statement-breakpoint
CREATE TYPE "public"."country" AS ENUM('US', 'DE', 'BR');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('USD', 'EUR', 'BRL');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('received', 'processed', 'failed', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('pending', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."order_flow" AS ENUM('direct', 'platform_transfer');--> statement-breakpoint
CREATE TYPE "public"."sale_policy" AS ENUM('direct', 'platform_only');--> statement-breakpoint
CREATE TYPE "public"."seller_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "business_effects" (
	"effect_key" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"transition" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seller_id" text,
	"account_side" "account_side" NOT NULL,
	"currency" "currency" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"kind" text NOT NULL,
	"provider_resource_type" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"effect_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_effect_side_unique" UNIQUE("effect_key","account_side")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"api_version_date" text NOT NULL,
	"status" "operation_status" DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"provider_resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"product_title" text NOT NULL,
	"gross_minor" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"fee_minor" bigint NOT NULL,
	"flow" "order_flow" NOT NULL,
	"checkout_configuration_id" text,
	"payment_id" text,
	"transfer_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"external_id" text NOT NULL,
	"email" text NOT NULL,
	"country" "country" NOT NULL,
	"whop_account_id" text,
	"sale_policy" "sale_policy" NOT NULL,
	"status" "seller_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sellers_whop_account_id_unique" UNIQUE("whop_account_id"),
	CONSTRAINT "sellers_run_external_unique" UNIQUE("run_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"api_version_date" text NOT NULL,
	"account_field" "account_field" NOT NULL,
	"account_id" text NOT NULL,
	"raw_body" text NOT NULL,
	"headers" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "inbox_status" DEFAULT 'received' NOT NULL,
	"error" text
);
