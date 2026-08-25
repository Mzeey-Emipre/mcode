CREATE TABLE `workspace_environment_command_approvals` (
	`workspace_id` text NOT NULL,
	`command_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`approved_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_environment_command_approvals_command` ON `workspace_environment_command_approvals` (`workspace_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `workspace_environment_storage_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`storage_mode` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
