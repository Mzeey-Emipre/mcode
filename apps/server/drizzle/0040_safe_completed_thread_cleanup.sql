PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cleanup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`worktree_path` text,
	`branch` text,
	`kind` text DEFAULT 'explicit' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_cleanup_jobs`("id", "thread_id", "workspace_path", "worktree_path", "branch", "kind", "attempts", "next_retry_at", "last_error", "created_at") SELECT "id", "thread_id", "workspace_path", "worktree_path", "branch", 'explicit', "attempts", "next_retry_at", "last_error", "created_at" FROM `cleanup_jobs`;--> statement-breakpoint
DROP TABLE `cleanup_jobs`;--> statement-breakpoint
ALTER TABLE `__new_cleanup_jobs` RENAME TO `cleanup_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cleanup_jobs_thread_id_unique` ON `cleanup_jobs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_cleanup_jobs_retry` ON `cleanup_jobs` (`next_retry_at`,`attempts`,`created_at`);--> statement-breakpoint
ALTER TABLE `threads` ADD `cleanup_state` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `cleanup_reason` text;
