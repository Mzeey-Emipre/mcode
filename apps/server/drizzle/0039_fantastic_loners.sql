CREATE TABLE `terminal_cleanup_ledger` (
	`session_id` text PRIMARY KEY NOT NULL,
	`host_generation` text NOT NULL,
	`root_pid` integer NOT NULL,
	`process_group_id` text NOT NULL,
	`containment` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
