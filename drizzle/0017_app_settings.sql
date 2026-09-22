-- 0017: instance-level values that are discovered or set at runtime rather than
-- configured: the public URL (the Worker cannot know its own hostname before it
-- exists, so the first authenticated visit records the origin here, and
-- context-free invocations — the cron tick, queue consumers — read it back for
-- absolute links and signed media URLs), the instance name, what the last deploy
-- did with the cron trigger, the tick token, and the cached release check.
CREATE TABLE IF NOT EXISTS `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
