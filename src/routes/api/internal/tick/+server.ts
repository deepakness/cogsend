import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { assertScheduler } from '$lib/server/require';
import { runSchedulerTick } from '$lib/server/scheduler';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	try {
		assertScheduler(request, locals.env);
		// The cron pinger can time out mid-tick; waitUntil keeps the current
		// invocation alive up to 30s past the disconnect. A large batch can
		// still outlast that — leftovers stay due and run on the next tick.
		const task = runSchedulerTick(locals.db, locals.env, {
			store: locals.media,
			queue: locals.queue
		});
		platform?.ctx?.waitUntil(task.then(() => undefined).catch(() => undefined));
		const result = await task;
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};
