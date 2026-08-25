ALTER TABLE `workspace_environment_queued_turns` ADD `queue_position` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH ranked_turns AS (
  SELECT rowid, ROW_NUMBER() OVER (PARTITION BY `thread_id` ORDER BY `created_at` ASC, rowid ASC) AS `queue_position`
  FROM `workspace_environment_queued_turns`
)
UPDATE `workspace_environment_queued_turns`
SET `queue_position` = (
  SELECT `queue_position` FROM ranked_turns WHERE ranked_turns.rowid = workspace_environment_queued_turns.rowid
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_environment_queued_turns_thread_state_position`
  ON `workspace_environment_queued_turns` (`thread_id`, `state`, `queue_position`);
--> statement-breakpoint
DROP INDEX `workspace_environment_queued_turns_thread_id_unique`;
