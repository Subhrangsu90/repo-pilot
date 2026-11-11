CREATE TABLE "audit_entries" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"run_id" uuid,
	"tool" text NOT NULL,
	"risk" text NOT NULL,
	"summary" text NOT NULL,
	"prompt" text,
	"input" jsonb NOT NULL,
	"approved_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kept_by_user" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"ok" boolean NOT NULL,
	"result" text NOT NULL,
	"response" jsonb,
	"inverse" jsonb,
	"undone_at" timestamp with time zone,
	"undo_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"prompt" text,
	"status" text NOT NULL,
	"events" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"repo" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"model" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_session_idx" ON "audit_entries" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "runs_session_idx" ON "runs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_updated_idx" ON "sessions" USING btree ("updated_at");