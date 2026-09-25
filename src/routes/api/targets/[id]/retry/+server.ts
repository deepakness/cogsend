import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { retryDelivery } from '$lib/server/api/operations';

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(
			await retryDelivery(
				{ ...locals, waitUntil: platform?.ctx?.waitUntil.bind(platform.ctx) },
				user.id,
				params.id
			)
		);
	} catch (err) {
		return handleError(err);
	}
};
