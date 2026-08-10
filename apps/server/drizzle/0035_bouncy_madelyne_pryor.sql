DROP INDEX `idx_hook_executions_message`;--> statement-breakpoint
CREATE INDEX `idx_hook_executions_message_sort_order` ON `hook_executions` (`message_id`,`sort_order`);--> statement-breakpoint
DROP INDEX `idx_plan_question_answers_thread`;--> statement-breakpoint
CREATE INDEX `idx_plan_question_answers_thread_answered_at` ON `plan_question_answers` (`thread_id`,`answered_at`);--> statement-breakpoint
DROP INDEX `idx_thought_segments_message`;--> statement-breakpoint
CREATE INDEX `idx_thought_segments_message_sort_order` ON `thought_segments` (`message_id`,`sort_order`);--> statement-breakpoint
DROP INDEX `idx_tool_call_records_message`;--> statement-breakpoint
CREATE INDEX `idx_tool_call_records_message_sort_order` ON `tool_call_records` (`message_id`,`sort_order`);