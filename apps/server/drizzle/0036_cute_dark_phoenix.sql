CREATE TABLE `workspace_terminal_preferences` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`default_profile_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
