CREATE TABLE `external_thread_control_pairings` (
  `pairing_id` text PRIMARY KEY NOT NULL,
  `integration_id` text NOT NULL,
  `credential_hash` text NOT NULL UNIQUE,
  `workspace_ids_json` text DEFAULT '[]' NOT NULL,
  `scopes_json` text DEFAULT '[]' NOT NULL,
  `calls_per_minute` integer NOT NULL,
  `max_active_threads` integer NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `authority_epoch` integer NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `replaced_by_pairing_id` text,
  `replaces_pairing_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_external_thread_control_pairings_integration`
  ON `external_thread_control_pairings` (`integration_id`, `status`);
--> statement-breakpoint
CREATE TABLE `external_thread_control_deliveries` (
  `pairing_id` text NOT NULL,
  `authority_epoch` integer NOT NULL,
  `delivery_id` text NOT NULL,
  `fingerprint` text NOT NULL,
  `status` text DEFAULT 'in_flight' NOT NULL,
  `result_json` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `expires_at` text NOT NULL,
  PRIMARY KEY (`pairing_id`, `authority_epoch`, `delivery_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_external_thread_control_delivery_retention`
  ON `external_thread_control_deliveries` (`pairing_id`, `status`, `expires_at`);
