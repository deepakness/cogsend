ALTER TABLE `users` ADD COLUMN `totp_enabled` integer NOT NULL DEFAULT 0;
ALTER TABLE `users` ADD COLUMN `totp_secret_enc` text;
ALTER TABLE `users` ADD COLUMN `totp_enrolled_at` integer;
ALTER TABLE `users` ADD COLUMN `totp_last_step` integer;
ALTER TABLE `sessions` ADD COLUMN `mfa_verified` integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS `totp_backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS `totp_backup_user_idx` ON `totp_backup_codes` (`user_id`);

CREATE TABLE IF NOT EXISTS `mfa_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`secret_enc` text,
	`backup_codes_enc` text,
	`remember` integer NOT NULL DEFAULT 1,
	`failed_attempts` integer NOT NULL DEFAULT 0,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS `mfa_challenges_token_uq` ON `mfa_challenges` (`token_hash`);
CREATE INDEX IF NOT EXISTS `mfa_challenges_user_idx` ON `mfa_challenges` (`user_id`);
