CREATE TABLE `canonical_agent_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`execution_id` text NOT NULL,
	`accepted_sequence` integer NOT NULL,
	`durable_revision` integer NOT NULL,
	`roster_revision` integer,
	`envelope_json` text NOT NULL,
	`accepted_at` text NOT NULL,
	`persisted_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `canonical_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_canonical_agent_events_execution_sequence` ON `canonical_agent_events` (`execution_id`,`accepted_sequence`);--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_events_thread_revision` ON `canonical_agent_events` (`thread_id`,`durable_revision`);--> statement-breakpoint
CREATE TABLE `canonical_agent_ingest_checkpoints` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`last_accepted_sequence` integer NOT NULL,
	`last_durable_sequence` integer NOT NULL,
	`native_cursor_json` text,
	`phase` text NOT NULL,
	`terminal_outcome` text,
	`error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `canonical_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `canonical_agent_turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_checkpoints_thread` ON `canonical_agent_ingest_checkpoints` (`thread_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `canonical_agent_items` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`parent_item_id` text,
	`kind` text NOT NULL,
	`provider_identities_json` text DEFAULT '[]' NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `canonical_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `canonical_agent_turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_items_turn` ON `canonical_agent_items` (`turn_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_items_thread` ON `canonical_agent_items` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `canonical_agent_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`parent_thread_id` text,
	`root_thread_id` text NOT NULL,
	`owning_parent_thread_id` text,
	`provider_id` text NOT NULL,
	`provider_identities_json` text DEFAULT '[]' NOT NULL,
	`activity_state` text NOT NULL,
	`conversation_revision` integer DEFAULT 0 NOT NULL,
	`roster_revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_threads_workspace` ON `canonical_agent_threads` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_threads_root` ON `canonical_agent_threads` (`root_thread_id`);--> statement-breakpoint
CREATE TABLE `canonical_agent_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger_json` text NOT NULL,
	`permission_mode` text NOT NULL,
	`provider_identities_json` text DEFAULT '[]' NOT NULL,
	`started_at` text,
	`ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `canonical_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_canonical_agent_turns_execution` ON `canonical_agent_turns` (`execution_id`);--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_turns_thread` ON `canonical_agent_turns` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `canonical_collaboration_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source_thread_id` text NOT NULL,
	`source_turn_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`target_thread_id` text NOT NULL,
	`target_turn_id` text,
	`status` text NOT NULL,
	`delivery_unknown` integer DEFAULT 0 NOT NULL,
	`provider_identities_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_collaboration_source` ON `canonical_collaboration_actions` (`source_thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_canonical_collaboration_target` ON `canonical_collaboration_actions` (`target_thread_id`,`created_at`);
