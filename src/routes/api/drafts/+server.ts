import type { RequestHandler } from './$types';
import { listDrafts, createDraft } from '$lib/server/api/operations';
import { fail, handleError, ok } from '$lib/server/http';
import {
	DRAFTS_LIST_LIMIT,
	DRAFTS_LIST_MAX_LIMIT,
	loadDraftSummaries,
	parseListLimit
} from '$lib/server/post-list';
import { requireScope, requireUser } from '$lib/server/require';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const limit = parseListLimit(
			url?.searchParams.get('limit'),
			DRAFTS_LIST_LIMIT,
			DRAFTS_LIST_MAX_LIMIT
		);
		if (url?.searchParams.get('view') === 'summary') {
			return ok(await loadDraftSummaries(locals.db, user.id, limit));
		}
		return ok(await listDrafts(locals, user.id, limit));
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const raw = await request.text().catch(() => '');
		let body: unknown = {};
		if (raw.trim()) {
			try {
				body = JSON.parse(raw);
			} catch {
				return fail('Invalid JSON body', 400);
			}
		}
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const result = await createDraft(locals, user.id, body as Record<string, unknown>);
		return ok(result, 201);
	} catch (err) {
		return handleError(err);
	}
};
