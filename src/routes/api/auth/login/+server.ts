import type { RequestHandler } from './$types';
import { authenticatePassword, createSession, getAdminUser } from '$lib/server/auth';
import { assertAuthGateOpen, clearAuthGate, recordAuthGateFailure } from '$lib/server/auth-gate';
import { setMfaCookie, setSessionCookie } from '$lib/server/cookies';
import { fail, handleError, ok } from '$lib/server/http';
import { startEnrollChallenge, startLoginChallenge } from '$lib/server/totp';

export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const email = String(body.email || '').trim();
		const password = String(body.password || '');
		const remember = body.remember !== false;
		if (!email || !password) return fail('Email and password required');
		// The single account: `npm run setup` wrote it before the first request.
		const admin = await getAdminUser(locals.db);
		if (!admin) return fail('This instance has no account yet', 409);
		// The gate is keyed on the single admin row, so an unknown email must not
		// advance it — otherwise anyone can lock the real owner out with eight
		// guesses at a made-up address. Only a wrong password for the actual
		// admin identity counts.
		const knownEmail = email.trim().toLowerCase() === admin.email.trim().toLowerCase();
		await assertAuthGateOpen(locals.db, locals.env, admin.id, 'password');
		const user = await authenticatePassword(locals.db, email, password);
		if (!user) {
			if (knownEmail) {
				const failGate = await recordAuthGateFailure(locals.db, locals.env, admin.id, 'password');
				if (failGate.locked) return fail('Too many attempts — try again in 15 minutes', 401);
			}
			return fail('Invalid credentials', 401);
		}
		await clearAuthGate(locals.db, locals.env, admin.id, 'password');
		if (locals.env.skipTotp) {
			// Local dev: password is the whole login. Mint a verified session.
			const { raw, maxAge } = await createSession(
				locals.db,
				locals.env,
				user.id,
				remember,
				true,
				user.passwordHash
			);
			setSessionCookie(cookies, locals.env, url.host, raw, maxAge);
			return ok({ user: { id: user.id, email: user.email } });
		}
		if (user.totpEnabled) {
			const token = await startLoginChallenge(locals.db, locals.env, user.id, remember);
			setMfaCookie(cookies, locals.env, url.host, token);
			return ok({ needTotp: true });
		}
		const token = await startEnrollChallenge(locals.db, locals.env, user.id, remember);
		setMfaCookie(cookies, locals.env, url.host, token);
		return ok({ needEnroll: true });
	} catch (err) {
		return handleError(err);
	}
};
