-- 0014: singleton state for scheduled notifications. Today this only tracks
-- the failure-digest cadence (one email per 24h window); keep it a generic
-- state row so future digests do not need another table.
CREATE TABLE IF NOT EXISTS `notification_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_failure_digest_at` integer
);
