import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { duplicateDraft } from '$lib/server/api/operations';

export const POST: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await duplicateDraft(locals, user.id, params.id), 201);
	} catch (error) {
		return handleError(error);
	}
};
