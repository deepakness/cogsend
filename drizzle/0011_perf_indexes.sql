CREATE INDEX IF NOT EXISTS `drafts_user_updated_idx` ON `drafts` (`user_id`, `updated_at`);
CREATE INDEX IF NOT EXISTS `connections_user_status_idx` ON `connections` (`user_id`, `status`);
CREATE INDEX IF NOT EXISTS `connections_user_created_idx` ON `connections` (`user_id`, `created_at`);
CREATE INDEX IF NOT EXISTS `publish_targets_status_updated_idx` ON `publish_targets` (`status`, `updated_at`);
CREATE INDEX IF NOT EXISTS `sessions_expires_idx` ON `sessions` (`expires_at`);
