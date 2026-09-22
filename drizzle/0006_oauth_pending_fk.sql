-- 0006: oauth_pending user FK + index.
-- Prior state: user_id plain text, no FK, only expires_idx. Orphan rows on
-- admin sweep; per-user lookups full-scan.
-- SQLite cannot ADD REFERENCES to an existing column, so rebuild the table.
-- Rows are transient (10-minute TTL); a failed migration loses only pending
-- OAuth flows, which users retry. No user data at risk.
PRAGMA foreign_keys = OFF;
CREATE TABLE `__oauth_pending_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`instance_url` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
INSERT INTO `__oauth_pending_new` (`id`, `user_id`, `instance_url`, `client_id`, `client_secret_enc`, `expires_at`, `created_at`)
	SELECT `id`, `user_id`, `instance_url`, `client_id`, `client_secret_enc`, `expires_at`, `created_at`
	FROM `oauth_pending`
	WHERE `user_id` IN (SELECT `id` FROM `users`);
DROP TABLE `oauth_pending`;
ALTER TABLE `__oauth_pending_new` RENAME TO `oauth_pending`;
CREATE INDEX IF NOT EXISTS `oauth_pending_expires_idx` ON `oauth_pending` (`expires_at`);
CREATE INDEX IF NOT EXISTS `oauth_pending_user_idx` ON `oauth_pending` (`user_id`);
PRAGMA foreign_keys = ON;
