import { redirect } from '@sveltejs/kit';
import { isFullyVerified, needsSetup, needsTotpEnroll } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// No account yet: `npm run setup` creates it from the terminal, before the
	// deployment answers its first request. Nothing here can create one, so say so
	// plainly rather than offering a form that could not succeed.
	if (await needsSetup(locals.db)) return { notConfigured: true };
	if (isFullyVerified(locals.user)) redirect(303, '/');
	if (needsTotpEnroll(locals.user)) redirect(303, '/login/setup-2fa');
	return {};
};
