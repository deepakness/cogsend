import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { STALE_CLAIM_MS } from '$lib/domain/due-jobs';
import { first } from '$lib/server/db/client';
import { connections, drafts, publishTargets } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { refreshDraftStatus } from '$lib/server/publish';
import { refuseInFlightOrPublished } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';
import { runAtError } from '$lib/domain/request-limits';

export const POST: RequestHandler = async ({ params, request, locals }) => {
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
		const blocked = refuseInFlightOrPublished(target, now);
		if (blocked) return fail(blocked, 409);
		if (target.status === 'cancelled') return fail('Cancelled — retry instead');
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const runAt = body.runAt ? new Date(body.runAt) : null;
		const runAtProblem = runAtError(body.runAt, now);
		if (runAtProblem) return fail(runAtProblem, 400);
		if (!runAt) return fail('runAt required', 400);

		const conn = await first(
			locals.db.select().from(connections).where(eq(connections.id, target.connectionId))
		);
		if (!conn || conn.userId !== user.id) return fail('Not found', 404);
		if (conn.status !== 'active') return fail('Account needs reconnect', 409);

		const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
		const updated = await locals.db
			.update(publishTargets)
			.set({
				status: 'scheduled',
				scheduledFor: runAt,
				errorMessage: null,
				jobId: null,
				attemptCount: 0,
				updatedAt: now
			})
			.where(
				and(
					eq(publishTargets.id, params.id),
					isNull(publishTargets.remotePostId),
					or(
						inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
						and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, staleBefore))
					)
				)
			)
			.returning({ id: publishTargets.id });
		if (!updated.length) {
			const latest = await first(
				locals.db.select().from(publishTargets).where(eq(publishTargets.id, params.id))
			);
			if (latest?.remotePostId) return fail('Already published', 409);
			return fail('Already publishing', 409);
		}

		await refreshDraftStatus(locals.db, target.draftId);
		return ok({ ok: true, scheduledFor: runAt.toISOString() });
	} catch (err) {
		return handleError(err);
	}
};
