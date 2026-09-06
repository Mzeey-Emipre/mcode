CREATE TABLE `turn_diff_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`fidelity` text NOT NULL,
	`patch` text,
	`revision` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_turn_diff_snapshots_message` ON `turn_diff_snapshots` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_diff_snapshots_thread` ON `turn_diff_snapshots` (`thread_id`);