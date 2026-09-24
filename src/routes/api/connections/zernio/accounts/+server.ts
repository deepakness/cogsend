import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';
import { listAccounts, listProfiles } from '$lib/server/zernio';
import {
	resolveZernioKey,
	storedZernioKey,
	toImportable,
	zernioConnectionRows,
	zernioKeyProblem
} from '$lib/server/zernio-import';
import { parseJson } from '$lib/server/db/client';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as { apiKey?: unknown };
		const stored = await storedZernioKey({ db: locals.db, env: locals.env, userId: user.id });
		const apiKey = await resolveZernioKey({
			db: locals.db,
			env: locals.env,
			userId: user.id,
			apiKey: body.apiKey
		});
		const [profiles, accounts, rows] = await Promise.all([
			listProfiles({ apiKey }),
			listAccounts({ apiKey }),
			zernioConnectionRows({ db: locals.db, userId: user.id })
		]);
		const importedIds = new Set(
			rows.map(
				(row) => parseJson<{ zernioAccountId?: string }>(row.metaJson, {}).zernioAccountId ?? ''
			)
		);
		return ok({
			profiles: profiles.map((p) => ({ id: p._id, name: p.name })),
			accounts: accounts
				.map((account) => toImportable(account, importedIds))
				.filter((account) => account !== null),
			hasStoredKey: stored !== null
		});
	} catch (err) {
		return zernioKeyProblem(err) ?? handleError(err);
	}
};
