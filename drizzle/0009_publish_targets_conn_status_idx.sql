CREATE INDEX IF NOT EXISTS `publish_targets_conn_status_idx` ON `publish_targets` (`connection_id`, `status`, `scheduled_for`);
