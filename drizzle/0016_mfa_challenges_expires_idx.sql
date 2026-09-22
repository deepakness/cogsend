-- Every scheduler tick purges expired MFA challenges by this column
-- (`purgeExpiredMfaChallenges`), and `mfa_challenges` was the only
-- expiry-purged table without an index on its expiry — a full table scan
-- roughly once a minute.
CREATE INDEX IF NOT EXISTS `mfa_challenges_expires_idx` ON `mfa_challenges` (`expires_at`);
