ALTER TABLE `canonical_agent_turns` ADD `approval_review_mode` text NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE `canonical_agent_turns` ADD `approval_review_reason` text NOT NULL DEFAULT 'manual-requested';
