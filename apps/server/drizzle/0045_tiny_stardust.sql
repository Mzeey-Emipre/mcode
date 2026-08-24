CREATE TABLE `parent_assistant_text_checkpoint_chunks` (
	`execution_id` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`text` text NOT NULL,
	`byte_length` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `parent_assistant_text_checkpoints`(`execution_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_parent_assistant_text_checkpoint_chunks_sequence` ON `parent_assistant_text_checkpoint_chunks` (`execution_id`,`first_sequence`);--> statement-breakpoint
CREATE TABLE `parent_assistant_text_checkpoints` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`last_sequence` integer NOT NULL,
	`retained_bytes` integer NOT NULL,
	`retained_chunks` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `canonical_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `canonical_agent_turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_parent_assistant_text_checkpoints_thread` ON `parent_assistant_text_checkpoints` (`thread_id`,`updated_at`);