import { and, eq, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '$lib/server/db/client';
import { connections, drafts, publishTargets } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { classifyConnections, ensureTargets } from '$lib/server/publish-plan';
import { humanizedCause } from '$lib/domain/human-error';
import { publishTarget } from '$lib/server/publish';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeDraft } from '$lib/server/serialize';
import { connectionIdsOverflow, normalizeConnectionIds } from '$lib/domain/request-limits';

export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		if (connectionIdsOverflow(body.connectionIds))
			return fail('Too many connections (max 10)', 400);
		const connectionIds = normalizeConnectionIds(body.connectionIds);
		if (!connectionIds.length) return fail('connectionIds required');
		const conns = await locals.db
			.select()
			.from(connections)
			.where(
				and(
					eq(connections.userId, user.id),
					inArray(connections.id, connectionIds),
					eq(connections.status, 'active')
				)
			);
		if (conns.length !== connectionIds.length)
			return fail('One or more connections not found', 400);
		// Refuse fast when another request is already publishing these
		// connections: without this, two concurrent POSTs both pass through
		// to publishTarget. Already-published connections intentionally pass
		// through to the skipped-result path below — re-posting a partially
		// published draft (retry the failed platform) must keep working.
		const now = new Date();
		const classified = await classifyConnections(locals.db, params.id, conns, now);
		const inFlight = classified
			.filter((item) => item.kind === 'inFlight')
			.map((item) => item.connectionId);
		if (inFlight.length) {
			return fail('Already publishing', 409, { inFlight });
		}

		const ensured = await ensureTargets(locals.db, params.id, conns, 'now', null, now);
		const results = [];
		/** Set when the batch was cut short by an infrastructure failure. */
		let stopped: string | null = null;
		for (const item of ensured) {
			const conn = conns.find((c) => c.id === item.target.connectionId);
			if (!conn) continue;
			if (item.alreadyPublished) {
				results.push({
					targetId: item.target.id,
					connectionId: conn.id,
					platform: conn.platform,
					handle: conn.handle,
					displayName: conn.displayName,
					status: 'published',
					permalink: item.target.remoteUrl ?? null,
					error: null,
					skipped: true
				});
				continue;
			}
			if (item.inFlight) {
				results.push({
					targetId: item.target.id,
					connectionId: conn.id,
					platform: conn.platform,
					handle: conn.handle,
					displayName: conn.displayName,
					status: 'publishing',
					permalink: null,
					error: null,
					skipped: true,
					inFlight: true
				});
				continue;
			}
			// Keep the publish alive if the browser disconnects (tab close or
			// reload): waitUntil extends execution up to 30s past the
			// disconnect, which covers the common publish. Longer runs that
			// still get cut are rescheduled by the scheduler (retryable
			// failures become `scheduled` with backoff).
			try {
				const task = publishTarget(locals.db, locals.env, locals.media, item.target.id);
				platform?.ctx?.waitUntil(task.then(() => undefined).catch(() => undefined));
				const result = await task;
				const row = await first(
					locals.db.select().from(publishTargets).where(eq(publishTargets.id, item.target.id))
				);
				results.push({
					targetId: item.target.id,
					connectionId: conn.id,
					platform: conn.platform,
					handle: conn.handle,
					displayName: conn.displayName,
					status: result.status,
					permalink: row?.remoteUrl ?? null,
					error: result.error ?? row?.errorMessage ?? null,
					skipped: result.skipped ?? false
				});
			} catch (err) {
				// Infrastructure, not provider: on Workers Free the usual cause is
				// D1's 50-statements-per-invocation budget, and the next target
				// would fail the same way. Stop here and report what did publish
				// (the tick does the same) instead of 500-ing after some accounts
				// already posted — the untouched targets stay due for a retry.
				console.error('[publish] aborted', item.target.id, err);
				// Never null: the flag below is "did this stop", and an error we
				// cannot humanize still stopped the batch.
				stopped =
					humanizedCause(err instanceof Error ? err.message : String(err)) ??
					'Publishing stopped early — try again for the rest';
				break;
			}
		}
		const draftAfter = await first(locals.db.select().from(drafts).where(eq(drafts.id, params.id)));
		const targets = await locals.db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.draftId, params.id));
		return ok({
			results,
			// Only when the batch was cut short: `results` is what happened, and
			// everything after the last entry was not attempted.
			...(stopped !== null ? { stopped: true, stoppedError: stopped } : {}),
			draft: draftAfter
				? serializeDraft(draftAfter, {
						targets: targets.map((t) => ({
							...t,
							connection: conns.find((c) => c.id === t.connectionId)
								? {
										id: conns.find((c) => c.id === t.connectionId)!.id,
										platform: conns.find((c) => c.id === t.connectionId)!.platform,
										handle: conns.find((c) => c.id === t.connectionId)!.handle
									}
								: undefined
						}))
					})
				: null
		});
	} catch (err) {
		return handleError(err);
	}
};
