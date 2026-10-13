-- FN-23 Agen (beta): one new table, no change to any existing one. `agent_runs` holds each requested report: the
-- step machine the jobs Worker advances (steps_done + a lease, compare-and-set per step), the figures computed by
-- code (facts_json) and, once ready, the R2 keys of the CSV and HTML files. Not a synced table (no deleted_at/seq,
-- like `tanya_messages` and `ai_keys`): rows are derived and never edited; "Hapus", the 30-day (ready) or 7-day
-- (unfinished/failed) expiry, account delete and space delete remove them outright, their keys going to
-- `file_deletions` in the same batch. Numbered 0036 with journal idx 36: 0035 is reserved for another branch
-- (whoever merges second re-chains the snapshot prevId and journal idx). Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`type` text NOT NULL,
	`period` text NOT NULL,
	`with_narrative` integer NOT NULL,
	`locale` text NOT NULL,
	`status` text NOT NULL,
	`steps_done` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`narrative_state` text DEFAULT 'none' NOT NULL,
	`narrative_reason` text,
	`facts_json` text,
	`narrative_text` text,
	`csv_key` text,
	`html_key` text,
	`csv_bytes` integer,
	`html_bytes` integer,
	`ai_input_tokens` integer,
	`ai_output_tokens` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ready_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_runs_type_check" CHECK("agent_runs"."type" in ('monthly', 'annual', 'spt_assets')),
	CONSTRAINT "agent_runs_status_check" CHECK("agent_runs"."status" in ('queued', 'running', 'ready', 'failed')),
	CONSTRAINT "agent_runs_locale_check" CHECK("agent_runs"."locale" in ('id', 'en')),
	CONSTRAINT "agent_runs_failure_check" CHECK("agent_runs"."failure" is null or "agent_runs"."failure" in ('plan', 'empty', 'access', 'internal')),
	CONSTRAINT "agent_runs_narrative_check" CHECK("agent_runs"."narrative_state" in ('none', 'ai', 'skipped')
				and ("agent_runs"."narrative_reason" is null or "agent_runs"."narrative_reason" in ('off', 'ai_unconfigured', 'no_key',
					'invalid', 'quota', 'refusal', 'malformed', 'max_tokens', 'model_unavailable', 'network', 'timeout',
					'guard'))
				and ("agent_runs"."narrative_text" is null or length("agent_runs"."narrative_text") between 1 and 2000)
				and (("agent_runs"."narrative_state" = 'ai') = ("agent_runs"."narrative_text" is not null))),
	CONSTRAINT "agent_runs_content_check" CHECK((("agent_runs"."type" = 'monthly' and length("agent_runs"."period") = 7
					and "agent_runs"."period" glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
				or ("agent_runs"."type" <> 'monthly' and length("agent_runs"."period") = 4 and "agent_runs"."period" glob '[0-9][0-9][0-9][0-9]'))
				and "agent_runs"."with_narrative" in (0, 1)
				and "agent_runs"."steps_done" between 0 and 5 and "agent_runs"."attempts" >= 0
				and ("agent_runs"."facts_json" is null or length("agent_runs"."facts_json") <= 262144)
				and "agent_runs"."expires_at" > "agent_runs"."created_at"
				and (("agent_runs"."status" = 'failed') = ("agent_runs"."failure" is not null))
				and ("agent_runs"."status" <> 'ready' or ("agent_runs"."csv_key" is not null and "agent_runs"."html_key" is not null
					and "agent_runs"."csv_bytes" is not null and "agent_runs"."html_bytes" is not null and "agent_runs"."ready_at" is not null))
				and ("agent_runs"."status" = 'ready' or ("agent_runs"."csv_key" is null and "agent_runs"."html_key" is null
					and "agent_runs"."csv_bytes" is null and "agent_runs"."html_bytes" is null and "agent_runs"."ready_at" is null)))
);
--> statement-breakpoint
CREATE INDEX `agent_runs_user_space_idx` ON `agent_runs` (`user_id`,`space_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_space_idx` ON `agent_runs` (`space_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_idx` ON `agent_runs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_expiry_idx` ON `agent_runs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_csv_key_idx` ON `agent_runs` (`csv_key`);--> statement-breakpoint
CREATE INDEX `agent_runs_html_key_idx` ON `agent_runs` (`html_key`);