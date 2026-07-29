ALTER TABLE `thread_control_approvals` ADD `source_turn_id` text;--> statement-breakpoint
ALTER TABLE `thread_control_approvals` ADD `source_provider_id` text;--> statement-breakpoint
ALTER TABLE `thread_control_approvals` ADD `operation` text DEFAULT 'thread_create_batch' NOT NULL;