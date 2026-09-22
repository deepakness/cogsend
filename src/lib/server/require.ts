import { hasApiScope, type ApiScope } from '$lib/domain/api-scopes';
import { anySecretMatches, extractBearerToken } from '$lib/domain/bearer';
import { isFullyVerified, type SessionUser } from './auth';
import { unauthorized } from './http';

export function requireUser(user: SessionUser | null): SessionUser {
	if (!isFullyVerified(user)) unauthorized();
	return user!;
}

/** Session-only: rejects bearer credentials (API_TOKEN machine user, API
 *  keys). Use for credential/key management — connection OAuth flows,
 *  disconnects, key rotation — which must never be reachable by a leaked
 *  token that already impersonates the user. */
export function requireSession(
	user: SessionUser | null,
	authMethod: 'session' | 'bearer' | null
): SessionUser {
	if (authMethod !== 'session' || !isFullyVerified(user)) unauthorized();
	return user!;
}

export function assertScheduler(
	request: Request,
	env: { AUTH_SECRET: string; SCHEDULER_SECRET?: string; API_TOKEN?: string }
) {
	const token = extractBearerToken(request.headers);
	// Least privilege: the session-signing AUTH_SECRET must never travel as a
	// bearer credential. Scheduler callers use SCHEDULER_SECRET (preferred) or
	// the long-lived API_TOKEN that GitHub Actions already holds.
	if (!anySecretMatches(token, [env.SCHEDULER_SECRET, env.API_TOKEN])) {
		unauthorized();
	}
}

/**
 * API-key scope gate. Sessions and the env API_TOKEN operator key carry
 * apiKeyScopes === null and bypass it. A scoped key must include the route's
 * scope (`write` implies `read`). Call AFTER requireUser/requireSession so
 * unauthenticated callers still get 401, not 403.
 */
export function requireScope(locals: { apiKeyScopes?: string[] | null }, scope: ApiScope): void {
	const scopes = locals.apiKeyScopes;
	if (!scopes) return;
	if (!hasApiScope(scopes as ApiScope[], scope)) {
		throw Object.assign(new Error('Insufficient scope'), { status: 403 });
	}
}
