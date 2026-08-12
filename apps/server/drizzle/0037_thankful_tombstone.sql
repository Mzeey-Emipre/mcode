ALTER TABLE `threads` ADD `user_completed_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `scheduled_deletion_at` text;--> statement-breakpoint
CREATE INDEX `idx_threads_workspace_completed` ON `threads` (`workspace_id`,`user_completed_at`);