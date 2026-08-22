CREATE TABLE `workspace_environment_automatic_setup_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`launch_snapshot_json` text,
	`outcome` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`exit_code` integer,
	`output` text DEFAULT '' NOT NULL,
	`output_truncated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_environment_automatic_setup_attempts_thread` ON `workspace_environment_automatic_setup_attempts` (`thread_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `workspace_environment_queued_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`state` text NOT NULL,
	`submission_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`released_at` text,
	`dispatching_at` text,
	`dispatched_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_environment_queued_turns_thread_id_unique` ON `workspace_environment_queued_turns` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_environment_queued_turns_state` ON `workspace_environment_queued_turns` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_environment_setup_gates` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`attempt_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
