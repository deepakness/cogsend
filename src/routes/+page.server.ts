import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { first } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/require';
import { schedulerHealth } from '$lib/server/scheduler';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const [[draftRow], [scheduledRow], [failedRow]] = await Promise.all([
		locals.db
			.select({ n: sql<number>`count(*)` })
			.from(drafts)
			.where(and(eq(drafts.userId, user.id), eq(drafts.status, 'draft'))),
		locals.db
			.select({ n: sql<number>`count(*)` })
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
					inArray(publishTargets.status, ['scheduled', 'pending', 'publishing'])
				)
			),
		locals.db
			// Distinct drafts: the Failed tab renders one card per post, while a
			// post can have several failed destinations.
			.select({ n: sql<number>`count(distinct ${publishTargets.draftId})` })
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
					inArray(publishTargets.status, ['failed'])
				)
			)
	]);
	const userRow = await first(
		locals.db.select({ displayName: users.displayName }).from(users).where(eq(users.id, user.id))
	).catch(() => null);
	const health = await schedulerHealth(locals.db);
	return {
		user: locals.user,
		displayName: userRow?.displayName ?? null,
		scheduledCount: scheduledRow?.n ?? 0,
		draftCount: draftRow?.n ?? 0,
		failedCount: failedRow?.n ?? 0,
		schedulerOk: health.ok,
		schedulerNeverTicked: health.lastTickAt === null,
		schedulerError: health.error ?? null,
		stuckPublishing: health.stuckPublishing,
		overdue: health.overdue
	};
};
