ALTER TABLE `tool_call_records` ADD `output_truncated` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tool_call_records` ADD `output_total_bytes` integer;
--> statement-breakpoint
ALTER TABLE `tool_call_records` ADD `output_artifact_path` text;
