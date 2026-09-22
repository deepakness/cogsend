import type { RequestHandler } from './$types';
import { and, asc, desc, eq, inArray, sql, type InferSelectModel } from 'drizzle-orm';
import { connections, draftMedia, drafts, publishTargets } from '$lib/server/db/schema';
import { batchQueries, chunkIds } from '$lib/server/db/client';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeMedia } from '$lib/server/serialize';

const QUEUE_LIST_LIMIT = 100;
const QUEUE_LIST_MAX_LIMIT = 500;

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const requested = parseInt(url?.searchParams.get('limit') ?? '', 10);
		const limit = Number.isFinite(requested)
			? Math.min(QUEUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(requested)))
			: QUEUE_LIST_LIMIT;
		// No SQL join between publishTargets and drafts: both tables share column
		// names (id, status, created_at, updated_at) and D1 collapses same-named
		// join columns, which mis-mapped target and draft fields. Flat reads
		// + in-memory join — the pattern the drafts list endpoint uses.
		// NOTE: drafts are fetched by queued ids only (not all user drafts),
		// so 100s of drafts don't blow up this endpoint.
		const targetsQuery = locals.db
			.select()
			.from(publishTargets)
			.where(
				and(
					inArray(
						publishTargets.connectionId,
						locals.db
							.select({ id: connections.id })
							.from(connections)
							.where(eq(connections.userId, user.id))
					),
					inArray(publishTargets.status, [
						'scheduled',
						'pending',
						'publishing',
						'failed',
						'published'
					])
				)
			)
			// Upcoming first. SQLite sorts NULLs ahead of values, so the old
			// ascending order put every row with no schedule (manually
			// published, pending, failed) before the posts that are actually
			// due — a busy history then pushed future posts out of the window
			// entirely. History still fills the rest, newest first.
			.orderBy(
				sql`${publishTargets.scheduledFor} is null`,
				asc(publishTargets.scheduledFor),
				desc(publishTargets.updatedAt)
			)
			.limit(limit + 1);

		type TargetRow = InferSelectModel<typeof publishTargets>;
		type ConnectionRow = Pick<
			InferSelectModel<typeof connections>,
			'id' | 'platform' | 'handle' | 'displayName' | 'avatarUrl' | 'status'
		>;
		type DraftLite = { id: string; title: string | null; baseBody: string; status: string };
		type MediaRow = InferSelectModel<typeof draftMedia>;
		// First round trip: targets + connections. Drafts come second, scoped
		// to queued ids only. Connections select avoids credentialsEncrypted.
		const [allTargetRows, allConns] = (await batchQueries(locals.db, [
			targetsQuery,
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
				.where(eq(connections.userId, user.id))
		])) as [TargetRow[], ConnectionRow[]];

		const hasMore = allTargetRows.length > limit;
		const targetRows = hasMore ? allTargetRows.slice(0, limit) : allTargetRows;
		const connById = new Map(allConns.map((c) => [c.id, c]));

		// Drafts for the queued targets only. Ids come from already-
		// ownership-filtered target rows; the query re-checks userId so
		// another user's draft can never leak in.
		const queuedDraftIds = [...new Set(targetRows.map((t) => t.draftId))];
		const draftRows: DraftLite[] = [];
		for (const chunk of chunkIds(queuedDraftIds)) {
			draftRows.push(
				...(await locals.db
					.select({
						id: drafts.id,
						title: drafts.title,
						baseBody: drafts.baseBody,
						status: drafts.status
					})
					.from(drafts)
					.where(and(eq(drafts.userId, user.id), inArray(drafts.id, chunk))))
			);
		}
		const draftById = new Map(draftRows.map((d) => [d.id, d]));

		// Media for the queued drafts only (not every draft the user owns).
		// Draft ids are already ownership-checked via draftById, and we
		// re-check below so another user's media can never leak in.
		const ownedQueuedIds = queuedDraftIds.filter((id) => draftById.has(id));
		const mediaRows: MediaRow[] = [];
		for (const chunk of chunkIds(ownedQueuedIds)) {
			mediaRows.push(
				...(await locals.db.select().from(draftMedia).where(inArray(draftMedia.draftId, chunk)))
			);
		}
		const mediaByDraft = new Map<string, ReturnType<typeof serializeMedia>[]>();
		for (const m of mediaRows) {
			if (!draftById.has(m.draftId)) continue;
			const list = mediaByDraft.get(m.draftId) ?? [];
			list.push(serializeMedia(m));
			mediaByDraft.set(m.draftId, list);
		}
		for (const list of mediaByDraft.values()) {
			list.sort(
				(a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0) || a.sortOrder - b.sortOrder
			);
		}

		const targets = [];
		for (const t of targetRows) {
			const connection = connById.get(t.connectionId);
			const draft = draftById.get(t.draftId);
			if (!connection || !draft) continue;
			// A disconnected tombstone may only surface published history. A
			// non-published row still pointing at one is orphaned (historical
			// FK-off data, a partial failure) and must not become an
			// actionable card: the scheduler refuses to claim it and target
			// actions refuse the dead account.
			if (connection.status === 'disconnected' && !t.remotePostId) continue;
			targets.push({
				id: t.id,
				status: t.status,
				scheduledFor: t.scheduledFor,
				updatedAt: t.updatedAt,
				remoteUrl: t.remoteUrl,
				errorMessage: t.errorMessage,
				draft: {
					id: draft.id,
					title: draft.title,
					baseBody: draft.baseBody,
					status: draft.status,
					media: mediaByDraft.get(draft.id) ?? []
				},
				connection: {
					id: connection.id,
					platform: connection.platform,
					handle: connection.handle,
					displayName: connection.displayName,
					avatarUrl: connection.avatarUrl,
					status: connection.status
				}
			});
		}
		return ok({ targets, hasMore });
	} catch (err) {
		return handleError(err);
	}
};
