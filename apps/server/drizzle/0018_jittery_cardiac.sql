CREATE TABLE `pull_request_review_links` (
	`worktree_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`repository_node_id` text NOT NULL,
	`pull_request_number` integer NOT NULL,
	`pr_url` text NOT NULL,
	`pr_state` text NOT NULL,
	`workspace_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`worktree_managed` integer DEFAULT 1 NOT NULL,
	`head_repository_node_id` text NOT NULL,
	`head_repository_owner` text NOT NULL,
	`head_repository_name` text NOT NULL,
	`head_ref` text NOT NULL,
	`head_oid` text NOT NULL,
	`local_branch` text NOT NULL,
	`push_remote` text NOT NULL,
	`push_ref` text NOT NULL,
	`managed_remote_name` text,
	`primary_thread_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`primary_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pull_request_review_links_identity` ON `pull_request_review_links` (`provider`,`repository_node_id`,`pull_request_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pull_request_review_links_primary_thread` ON `pull_request_review_links` (`primary_thread_id`);--> statement-breakpoint
CREATE INDEX `idx_pull_request_review_links_workspace` ON `pull_request_review_links` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_pull_request_review_links_worktree_path` ON `pull_request_review_links` (`worktree_path`);
