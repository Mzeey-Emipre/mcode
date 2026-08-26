CREATE TABLE `workspace_environment_automatic_setup_repairs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`failed_attempt_id` text NOT NULL,
	`state` text NOT NULL,
	`failure_context_json` text NOT NULL,
	`submission_json` text NOT NULL,
	`rerun_attempt_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_environment_automatic_setup_repairs_failed_attempt` ON `workspace_environment_automatic_setup_repairs` (`failed_attempt_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_environment_automatic_setup_repairs_thread` ON `workspace_environment_automatic_setup_repairs` (`thread_id`,"created_at" desc);