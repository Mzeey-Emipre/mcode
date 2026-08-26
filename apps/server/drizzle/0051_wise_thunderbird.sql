ALTER TABLE `tool_call_records` ADD `subagent_prompt` text;--> statement-breakpoint
ALTER TABLE `tool_call_records` ADD `subagent_type` text;--> statement-breakpoint
ALTER TABLE `tool_call_records` ADD `subagent_agent_id` text;--> statement-breakpoint
ALTER TABLE `tool_call_records` ADD `subagent_duration_ms` integer;