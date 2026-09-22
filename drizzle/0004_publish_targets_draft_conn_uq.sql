DELETE FROM `publish_targets`
WHERE `id` NOT IN (
	SELECT `id` FROM (
		SELECT `id`,
			ROW_NUMBER() OVER (
				PARTITION BY `draft_id`, `connection_id`
				ORDER BY
					CASE WHEN `remote_post_id` IS NOT NULL THEN 0 ELSE 1 END,
					`updated_at` DESC,
					`id` DESC
			) AS `rn`
		FROM `publish_targets`
	) AS `ranked`
	WHERE `rn` = 1
);
DROP INDEX IF EXISTS `publish_targets_draft_conn_idx`;
CREATE UNIQUE INDEX IF NOT EXISTS `publish_targets_draft_conn_idx`
	ON `publish_targets` (`draft_id`, `connection_id`);
