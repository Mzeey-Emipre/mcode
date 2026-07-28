CREATE TABLE `workspace_worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canonical_path` text NOT NULL,
	`label` text NOT NULL,
	`branch` text,
	`base_ref` text,
	`managed` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`stale` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_worktrees_path` ON `workspace_worktrees` (`workspace_id`,`canonical_path`);--> statement-breakpoint
CREATE INDEX `idx_workspace_worktrees_workspace` ON `workspace_worktrees` (`workspace_id`,`stale`);
--> statement-breakpoint
ALTER TABLE `threads` ADD `delegation_coordinator_thread_id` text REFERENCES `threads`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `threads` ADD `delegation_creator_turn_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `delegation_creator_tool_call_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `delegation_creation_kind` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `created_by_integration_id` text;--> statement-breakpoint
CREATE INDEX `idx_threads_delegation_coordinator` ON `threads` (`delegation_coordinator_thread_id`);--> statement-breakpoint
CREATE INDEX `idx_threads_created_by_integration` ON `threads` (`created_by_integration_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `origin_type` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `source_thread_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `source_turn_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `source_provider_id` text;
