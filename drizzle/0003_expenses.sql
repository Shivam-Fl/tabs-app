CREATE TYPE "public"."expense_category" AS ENUM('food', 'travel', 'rent', 'utilities', 'shopping', 'entertainment', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_split_type" AS ENUM('equal', 'exact', 'percentage', 'shares');--> statement-breakpoint
CREATE TABLE "expense_payer" (
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "expense_payer_expense_id_member_id_pk" PRIMARY KEY("expense_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expense_share" (
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "expense_share_expense_id_member_id_pk" PRIMARY KEY("expense_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expense_split_input" (
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"input_value" bigint,
	CONSTRAINT "expense_split_input_expense_id_member_id_pk" PRIMARY KEY("expense_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"split_type" "expense_split_type" NOT NULL,
	"category" "expense_category",
	"note" text,
	"date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "expense_payer" ADD CONSTRAINT "expense_payer_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payer" ADD CONSTRAINT "expense_payer_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_share" ADD CONSTRAINT "expense_share_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_share" ADD CONSTRAINT "expense_share_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_split_input" ADD CONSTRAINT "expense_split_input_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_split_input" ADD CONSTRAINT "expense_split_input_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_group_date_idx" ON "expenses" USING btree ("group_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_description_idx" ON "expenses" USING btree ("description");