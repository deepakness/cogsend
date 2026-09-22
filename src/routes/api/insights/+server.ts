import { and, eq, gte, inArray, isNull, max } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import {
	buildInsightSeries,
	bucketKind,
	groupFailureReasons,
	parseInsightRange,
	rangeSpanDays,
	rateOf,
	type InsightTargetRow
} from '$lib/domain/insights';
import { platformName } from '$lib/domain/platforms';
import { batchQueries } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';

const DAY_MS = 86_400_000;

/** D1 returns raw SQLite integers for aggregates; tests may hand back Dates. */
function toMs(value: unknown): number | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return null;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');

		const days = parseInsightRange(url.searchParams.get('days'));
		const span = rangeSpanDays(days);
		const nowMs = Date.now();
		const sinceMs = nowMs - span * DAY_MS;
		const previousSinceMs = sinceMs - span * DAY_MS;

		// One batch: the whole two-window row set (split in memory), the
		// owner's connections, their timezone, all-time last-published per
		// connection, and the scheduled queue snapshot. Five statements, well
		// inside D1's per-invocation budget.
		const [windowRows, connectionRows, userRows, lastRows, scheduledRows] = (await batchQueries(
			locals.db,
			[
				locals.db
					.select({
						connectionId: publishTargets.connectionId,
						status: publishTargets.status,
						updatedAt: publishTargets.updatedAt,
						errorMessage: publishTargets.errorMessage
					})
					.from(publishTargets)
					.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
					.where(
						and(
							eq(drafts.userId, user.id),
							inArray(publishTargets.status, ['published', 'failed']),
							gte(publishTargets.updatedAt, new Date(previousSinceMs))
						)
					),
				// Explicit columns: the account list never needs (and must not
				// pull) the encrypted credential blob into memory.
				locals.db
					.select({
						id: connections.id,
						platform: connections.platform,
						handle: connections.handle,
						displayName: connections.displayName,
						avatarUrl: connections.avatarUrl,
						status: connections.status
					})
					.from(connections)
					.where(eq(connections.userId, user.id)),
				locals.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, user.id)),
				locals.db
					.select({
						connectionId: publishTargets.connectionId,
						lastAt: max(publishTargets.updatedAt)
					})
					.from(publishTargets)
					.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
					.where(and(eq(drafts.userId, user.id), eq(publishTargets.status, 'published')))
					.groupBy(publishTargets.connectionId),
				locals.db
					.select({
						connectionId: publishTargets.connectionId,
						scheduledFor: publishTargets.scheduledFor
					})
					.from(publishTargets)
					.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
					.where(
						and(
							eq(drafts.userId, user.id),
							isNull(publishTargets.remotePostId),
							inArray(publishTargets.status, ['scheduled', 'pending', 'publishing'])
						)
					)
			]
		)) as [
			{
				connectionId: string;
				status: string;
				updatedAt: Date | number;
				errorMessage: string | null;
			}[],
			{
				id: string;
				platform: string;
				handle: string | null;
				displayName: string | null;
				avatarUrl: string | null;
				status: string;
			}[],
			{ timezone: string }[],
			{ connectionId: string; lastAt: unknown }[],
			{ connectionId: string; scheduledFor: Date | number | null }[]
		];

		const platformByConnection = new Map(connectionRows.map((c) => [c.id, c.platform]));
		const currentRows: InsightTargetRow[] = [];
		const previousRows: InsightTargetRow[] = [];
		for (const row of windowRows) {
			const updatedAtMs = toMs(row.updatedAt);
			if (updatedAtMs === null) continue;
			const target: InsightTargetRow = {
				connectionId: row.connectionId,
				status: row.status,
				updatedAtMs,
				errorMessage: row.errorMessage
			};
			if (updatedAtMs >= sinceMs) currentRows.push(target);
			else previousRows.push(target);
		}

		const countByStatus = (rows: InsightTargetRow[], status: string) =>
			rows.reduce((n, r) => (r.status === status ? n + 1 : n), 0);
		const published = countByStatus(currentRows, 'published');
		const failed = countByStatus(currentRows, 'failed');
		const previousPublished = countByStatus(previousRows, 'published');
		const previousFailed = countByStatus(previousRows, 'failed');

		const byConnection = new Map<string, { published: number; failed: number }>();
		for (const row of currentRows) {
			const agg = byConnection.get(row.connectionId) ?? { published: 0, failed: 0 };
			if (row.status === 'published') agg.published += 1;
			else if (row.status === 'failed') agg.failed += 1;
			byConnection.set(row.connectionId, agg);
		}

		const lastPublishedByConnection = new Map<string, number>();
		for (const row of lastRows) {
			const ms = toMs(row.lastAt);
			if (ms !== null) lastPublishedByConnection.set(row.connectionId, ms);
		}

		let nextScheduledAt: number | null = null;
		for (const row of scheduledRows) {
			const ms = toMs(row.scheduledFor);
			if (ms === null) continue;
			if (nextScheduledAt === null || ms < nextScheduledAt) nextScheduledAt = ms;
		}

		const accounts = connectionRows
			// Archived tombstones stay only while they still anchor history in
			// the window; live accounts always appear, even at zero.
			.filter(
				(c) =>
					c.status !== 'disconnected' ||
					(byConnection.get(c.id)?.published ?? 0) + (byConnection.get(c.id)?.failed ?? 0) > 0
			)
			.map((c) => {
				const agg = byConnection.get(c.id) ?? { published: 0, failed: 0 };
				return {
					connectionId: c.id,
					platform: c.platform,
					handle: c.handle,
					displayName: c.displayName,
					avatarUrl: c.avatarUrl,
					connected: c.status !== 'disconnected',
					published: agg.published,
					failed: agg.failed,
					rate: rateOf(agg.published, agg.failed),
					lastPublishedAt: lastPublishedByConnection.get(c.id) ?? null
				};
			})
			.sort(
				(a, b) =>
					b.published - a.published ||
					(platformName(a.platform) + (a.displayName ?? a.handle ?? '')).localeCompare(
						platformName(b.platform) + (b.displayName ?? b.handle ?? '')
					)
			);

		const failureRows = currentRows.map((row) => ({
			...row,
			platform: platformByConnection.get(row.connectionId) ?? ''
		}));
		const failures = groupFailureReasons(failureRows);

		const timeZone = userRows[0]?.timezone || 'UTC';
		const series = buildInsightSeries({ currentRows, previousRows, nowMs, days, timeZone });

		return ok({
			range: { days, spanDays: span, bucket: bucketKind(days), buckets: series.current.length },
			now: nowMs,
			totals: {
				published,
				failed,
				rate: rateOf(published, failed),
				scheduled: scheduledRows.length,
				nextScheduledAt
			},
			previous: {
				published: previousPublished,
				failed: previousFailed,
				rate: rateOf(previousPublished, previousFailed)
			},
			series,
			failures,
			accounts
		});
	} catch (err) {
		return handleError(err);
	}
};
