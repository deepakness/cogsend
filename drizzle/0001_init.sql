CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`timezone` text NOT NULL DEFAULT 'UTC',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);

CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`remember` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token`);
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);

CREATE TABLE `oauth_pending` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`instance_url` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX `oauth_pending_expires_idx` ON `oauth_pending` (`expires_at`);

CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`display_name` text,
	`handle` text,
	`avatar_url` text,
	`instance_url` text,
	`credentials_encrypted` text NOT NULL,
	`meta_json` text NOT NULL DEFAULT '{}',
	`status` text NOT NULL DEFAULT 'active',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE INDEX `connections_user_platform_idx` ON `connections` (`user_id`, `platform`);

CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`base_body` text NOT NULL DEFAULT '',
	`status` text NOT NULL DEFAULT 'draft',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE INDEX `drafts_user_status_idx` ON `drafts` (`user_id`, `status`);

CREATE TABLE `draft_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`platform` text NOT NULL,
	`body` text,
	`options_json` text NOT NULL DEFAULT '{}',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `draft_variants_draft_platform_uq` ON `draft_variants` (`draft_id`, `platform`);

CREATE TABLE `draft_media` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`alt_text` text,
	`sort_order` integer NOT NULL DEFAULT 0,
	`segment_index` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON DELETE CASCADE
);
CREATE INDEX `draft_media_draft_idx` ON `draft_media` (`draft_id`);
CREATE INDEX `draft_media_draft_segment_idx` ON `draft_media` (`draft_id`, `segment_index`);

CREATE TABLE `publish_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`variant_id` text,
	`status` text NOT NULL DEFAULT 'pending',
	`scheduled_for` integer,
	`remote_post_id` text,
	`remote_url` text,
	`error_message` text,
	`attempt_count` integer NOT NULL DEFAULT 0,
	`job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`variant_id`) REFERENCES `draft_variants`(`id`) ON DELETE SET NULL
);
CREATE INDEX `publish_targets_status_when_idx` ON `publish_targets` (`status`, `scheduled_for`);
CREATE INDEX `publish_targets_draft_idx` ON `publish_targets` (`draft_id`);

CREATE TABLE `publish_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`publish_target_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`success` integer NOT NULL DEFAULT 0,
	`error` text,
	`response_summary` text,
	FOREIGN KEY (`publish_target_id`) REFERENCES `publish_targets`(`id`) ON DELETE CASCADE
);
CREATE INDEX `publish_attempts_target_idx` ON `publish_attempts` (`publish_target_id`);

CREATE TABLE `scheduler_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`last_ok_at` integer NOT NULL
);
