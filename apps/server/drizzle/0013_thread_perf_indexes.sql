CREATE INDEX `idx_threads_workspace_deleted` ON `threads` (`workspace_id`, `deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_workspace_recency` ON `threads` (`workspace_id`, `updated_at` DESC);
