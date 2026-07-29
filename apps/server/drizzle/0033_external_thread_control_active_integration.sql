CREATE UNIQUE INDEX `idx_external_thread_control_active_integration`
  ON `external_thread_control_pairings` (`integration_id`)
  WHERE `status` = 'active';
