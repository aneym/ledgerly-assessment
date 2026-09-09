CREATE TABLE "demo_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"kind" text NOT NULL,
	"step_id" text,
	"at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_events_run_seq_idx" ON "demo_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "demo_events_correlation_id_idx" ON "demo_events" USING btree ("correlation_id");