import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { cancelDelivery } from '$lib/server/api/operations';

export const POST: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await cancelDelivery(locals, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};
