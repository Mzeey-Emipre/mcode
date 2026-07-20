CREATE TABLE `provider_catalog_snapshots` (
	`context_key` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`workspace_id` text,
	`cwd` text,
	`snapshot_json` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_catalog_snapshots_workspace` ON `provider_catalog_snapshots` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_provider_catalog_snapshots_provider` ON `provider_catalog_snapshots` (`provider_id`);