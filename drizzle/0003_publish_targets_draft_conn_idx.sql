CREATE INDEX IF NOT EXISTS `publish_targets_draft_conn_idx`
	ON `publish_targets` (`draft_id`, `connection_id`);
