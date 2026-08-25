CREATE TABLE `project_action_runs` (
	`thread_id` text NOT NULL,
	`action_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`terminal_session_id` text,
	`action_name` text NOT NULL,
	`status` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`exit_code` integer,
	`transcript` text DEFAULT '' NOT NULL,
	`transcript_truncated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_action_runs_slot` ON `project_action_runs` (`thread_id`,`action_id`);--> statement-breakpoint
CREATE INDEX `idx_project_action_runs_thread` ON `project_action_runs` (`thread_id`);