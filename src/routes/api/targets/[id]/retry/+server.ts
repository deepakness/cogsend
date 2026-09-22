import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { STALE_CLAIM_MS } from '$lib/domain/due-jobs';
import { first } from '$lib/server/db/client';
import { connections, drafts, publishTargets } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { publishTarget } from '$lib/server/publish';
import { refuseInFlightOrPublished } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const target = await first(
			locals.db.select().from(publishTargets).where(eq(publishTargets.id, params.id))
		);
		if (!target) return fail('Not found', 404);
		const draft = await first(locals.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
		if (!draft || draft.userId !== user.id) return fail('Not found', 404);
		const now = new Date();
		if (target.remotePostId) {
			return ok({ status: 'published', remotePostId: target.remotePostId, skipped: true });
		}
		const blocked = refuseInFlightOrPublished(target, now);
		if (blocked) return fail(blocked, 409);

		// The connection must still be usable: publishing into a dead account
		// wastes an attempt and flips nothing useful. (publish-now/schedule
		// routes already filter `status=active`; retry/reschedule did not.)
		const conn = await first(
			locals.db.select().from(connections).where(eq(connections.id, target.connectionId))
		);
		if (!conn || conn.userId !== user.id) return fail('Not found', 404);
		if (conn.status !== 'active') return fail('Account needs reconnect', 409);

		const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
		const reset = await locals.db
			.update(publishTargets)
			.set({
				status: 'pending',
				scheduledFor: null,
				errorMessage: null,
				// Clear orphaned queue claims and reset the attempt budget: an
				// explicit manual retry is fresh user intent.
				jobId: null,
				attemptCount: 0,
				updatedAt: now
			})
			.where(
				and(
					eq(publishTargets.id, params.id),
					isNull(publishTargets.remotePostId),
					or(
						inArray(publishTargets.status, ['pending', 'scheduled', 'failed', 'cancelled']),
						and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, staleBefore))
					)
				)
			)
			.returning({ id: publishTargets.id });
		if (!reset.length) {
			const latest = await first(
				locals.db.select().from(publishTargets).where(eq(publishTargets.id, params.id))
			);
			if (latest?.remotePostId) {
				return ok({ status: 'published', remotePostId: latest.remotePostId, skipped: true });
			}
			return fail('Already publishing', 409);
		}

		// Survive a tab close mid-retry (see the publish route).
		const task = publishTarget(locals.db, locals.env, locals.media, params.id, { now });
		platform?.ctx?.waitUntil(task.then(() => undefined).catch(() => undefined));
		const result = await task;
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};
