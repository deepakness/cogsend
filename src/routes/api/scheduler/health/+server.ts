import type { RequestHandler } from './$types';
import { readDeployCronState } from '$lib/server/app-settings';
import { schedulerMessage } from '$lib/domain/scheduler-status';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { schedulerHealth } from '$lib/server/scheduler';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'read');
		const ping = await schedulerHealth(locals.db);
		// What the last deploy managed to do with the trigger. Null when nothing
		// recorded it — a deploy that bypassed scripts/wrangler.mjs, or one made
		// before the state was tracked — in which case the heartbeat decides.
		const deployCron = await readDeployCronState(locals.db);
		return ok({
			ok: ping.ok,
			error: ping.error,
			stuckPublishing: ping.stuckPublishing,
			overdue: ping.overdue,
			lastTickAt: ping.lastTickAt,
			neverTicked: ping.lastTickAt === null,
			deployCron,
			message: schedulerMessage(ping, deployCron)
		});
	} catch (err) {
		return handleError(err);
	}
};
