CREATE TABLE `thread_startups` (
	`startup_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`phase` text NOT NULL,
	`steps_json` text NOT NULL,
	`transcript_json` text NOT NULL,
	`cancellation` text DEFAULT 'none' NOT NULL,
	`revision` integer NOT NULL,
	`thread_id` text,
	`error_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_thread_startups_workspace_updated` ON `thread_startups` (`workspace_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `idx_thread_startups_state` ON `thread_startups` (`state`);