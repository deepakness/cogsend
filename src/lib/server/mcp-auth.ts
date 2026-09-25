import { isApiKeyFormat, verifyApiKey } from './api-keys';
import { isFullyVerified } from './auth';
import type { AppDb } from './db/client';
import type { SessionUser } from './auth';

export type McpAuthState = {
	authMethod: 'session' | 'bearer' | null;
	authCredential: 'session' | 'personal_api_key' | 'api_token' | null;
	user: SessionUser | null;
};

export type McpAuthResult = { ok: true } | { ok: false; status: 401 | 403 };

/** Every asserted browser origin must match. Native clients may omit both headers. */
export function hasAllowedMcpOrigin(request: Request, url: URL): boolean {
	for (const header of ['origin', 'referer']) {
		const rawValue = request.headers.get(header);
		if (rawValue === null) continue;
		const value = rawValue.trim();
		try {
			if (new URL(value).origin !== url.origin) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** MCP is stricter than the ordinary API: only a live personal key in Authorization works. */
export async function authorizeMcpRequest(
	request: Request,
	url: URL,
	db: AppDb,
	state: McpAuthState
): Promise<McpAuthResult> {
	if (!hasAllowedMcpOrigin(request, url)) return { ok: false, status: 403 };
	const user = state.user;
	const authorization = request.headers.get('authorization')?.trim() ?? '';
	const match = /^Bearer\s+(\S+)$/i.exec(authorization);
	const token = match?.[1] ?? null;
	if (
		state.authMethod !== 'bearer' ||
		state.authCredential !== 'personal_api_key' ||
		!isFullyVerified(user) ||
		!isApiKeyFormat(token)
	) {
		return { ok: false, status: 401 };
	}
	const verified = await verifyApiKey(db, token);
	return verified && verified.userId === user?.id ? { ok: true } : { ok: false, status: 401 };
}
