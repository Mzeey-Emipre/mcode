ALTER TABLE `messages` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `outcome_execution_id` text;
--> statement-breakpoint
UPDATE `canonical_agent_ingest_checkpoints`
SET `terminal_outcome` = 'interrupted'
WHERE `phase` = 'interrupted' AND `terminal_outcome` = 'cancelled';
