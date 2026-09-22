-- 0007: api_keys for headless access (scripts, Shortcuts, cron).
-- Single active key per user enforced in code (rotate revokes the old row;
-- revoked rows stay as history). Only the SHA-256 hash is stored; the raw key
-- is shown once at creation and never again.
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_hash_uq` ON `api_keys` (`key_hash`);
CREATE INDEX IF NOT EXISTS `api_keys_user_idx` ON `api_keys` (`user_id`);
