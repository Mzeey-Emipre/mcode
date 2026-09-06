ALTER TABLE `messages` ADD `system_notice` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `current_notice_session_id` text;--> statement-breakpoint
UPDATE `threads`
SET `current_notice_session_id` = (
  SELECT json_extract(`system_notice`, '$.sessionId')
  FROM `messages`
  WHERE `thread_id` = `threads`.`id`
    AND json_extract(`system_notice`, '$.sessionId') IS NOT NULL
  ORDER BY `sequence` DESC
  LIMIT 1
);--> statement-breakpoint
CREATE INDEX `idx_messages_notice_session_sequence`
ON `messages` (`thread_id`, json_extract(`system_notice`, '$.sessionId'), `sequence` DESC);
