CREATE TABLE `thread_control_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`caller_id` text NOT NULL,
	`source_thread_id` text,
	`workspace_id` text,
	`thread_id` text,
	`operation` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_thread_control_audit_thread` ON `thread_control_audit` (`thread_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `thread_control_approvals` ADD `turn_id` text;--> statement-breakpoint
UPDATE `thread_control_approvals` SET `turn_id` = lower(hex(randomblob(16))) WHERE `turn_id` IS NULL;--> statement-breakpoint
ALTER TABLE `thread_control_approvals` ADD `operation_phase` text DEFAULT 'pre_provision' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_control_approvals` ADD `processing_started_at` text;
