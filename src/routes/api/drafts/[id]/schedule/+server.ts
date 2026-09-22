import { and, eq, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '$lib/server/db/client';
import { connections, drafts } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { classifyConnections, ensureTargets } from '$lib/server/publish-plan';
import { refreshDraftStatus } from '$lib/server/publish';
import { requireScope, requireUser } from '$lib/server/require';
import {
	connectionIdsOverflow,
	normalizeConnectionIds,
	runAtError
} from '$lib/domain/request-limits';

export const POST: RequestHandler = async ({ params, request, locals }) => {
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
		const now = new Date();
		if (connectionIdsOverflow(body.connectionIds))
			return fail('Too many connections (max 10)', 400);
		const connectionIds = normalizeConnectionIds(body.connectionIds);
		const runAt = body.runAt ? new Date(body.runAt) : null;
		if (!connectionIds.length) return fail('connectionIds required');
		const runAtProblem = runAtError(body.runAt, now);
		if (runAtProblem) return fail(runAtProblem, 400);
		if (!runAt) return fail('runAt required (ISO date)', 400);

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

		const classified = await classifyConnections(locals.db, params.id, conns, now);
		const alreadyPublished = classified
			.filter((item) => item.kind === 'published')
			.map((item) => item.connectionId);
		const inFlight = classified
			.filter((item) => item.kind === 'inFlight')
			.map((item) => item.connectionId);
		if (alreadyPublished.length || inFlight.length) {
			const error = inFlight.length ? 'Already publishing' : 'Already published';
			return fail(error, 409, { alreadyPublished, inFlight });
		}

		const ensured = await ensureTargets(locals.db, params.id, conns, 'schedule', runAt, now);
		const blocked = ensured.filter((item) => item.alreadyPublished || item.inFlight);
		if (blocked.length) {
			return fail(
				blocked.some((item) => item.inFlight) ? 'Already publishing' : 'Already published',
				409,
				{
					alreadyPublished: blocked
						.filter((item) => item.alreadyPublished)
						.map((item) => item.target.connectionId),
					inFlight: blocked.filter((item) => item.inFlight).map((item) => item.target.connectionId)
				}
			);
		}

		await refreshDraftStatus(locals.db, params.id);
		return ok({ targets: ensured.map((item) => item.target), scheduledFor: runAt.toISOString() });
	} catch (err) {
		return handleError(err);
	}
};
