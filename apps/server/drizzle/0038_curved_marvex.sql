CREATE TABLE `canonical_legacy_message_provenance` (
	`message_id` text PRIMARY KEY NOT NULL,
	`migration_version` integer NOT NULL,
	`mapping_status` text NOT NULL,
	`canonical_thread_id` text,
	`canonical_turn_id` text,
	`canonical_item_id` text,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_legacy_message_mapping` ON `canonical_legacy_message_provenance` (`mapping_status`,`message_id`);--> statement-breakpoint
CREATE TABLE `canonical_legacy_migration_checkpoints` (
	`version` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`migrated_messages` integer DEFAULT 0 NOT NULL,
	`ambiguous_messages` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text
);
