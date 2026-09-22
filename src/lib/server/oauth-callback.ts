import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { PlatformId } from '$lib/domain/platforms';
import { SESSION_COOKIE } from './auth';
import { encryptJson } from './crypto';
import { first, newId, type AppDb } from './db/client';
import { connections, oauthPending } from './db/schema';
import type { AppEnv } from './env';
import { splitOAuthState, verifyOAuthState } from './oauth-state';

type PendingRow = typeof oauthPending.$inferSelect;

export interface CallbackExchange {
	/** Stored encrypted; decrypted by verify/publish, so the shape is the provider's. */
	credentials: Record<string, unknown>;
	displayName?: string | null;
	handle?: string | null;
	avatarUrl?: string | null;
	instanceUrl?: string | null;
	meta: Record<string, unknown>;
}

export interface OAuthCallbackOptions {
	platform: PlatformId;
	/**
	 * Marker the connect route stored in `oauth_pending.instance_url`, used to
	 * tell this provider's pending rows apart. Mastodon stores the real
	 * instance URL there instead, so it passes none.
	 */
	pendingMarker?: string;
	/** Also match an existing row on its instance URL (one row per instance). */
	matchInstanceUrl?: boolean;
	complete(input: {
		pending: PendingRow;
		code: string;
		db: AppDb;
		env: AppEnv;
	}): Promise<CallbackExchange>;
}

/**
 * The four connect flows share everything but the token exchange and the
 * credential payload: parameter handling and error redirects, CSRF state
 * verification against the pending row, the upsert that keeps one connection
 * per account, and the pending-row cleanup. Keeping that in one place means a
 * fix to the state check cannot land in three of four routes.
 */
export function createOAuthCallback(opts: OAuthCallbackOptions): RequestHandler {
	return async ({ url, locals, cookies }) => {
		const appUrl = locals.env.APP_URL.replace(/\/$/, '');
		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		const error = url.searchParams.get('error');
		if (error) redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(error)}`);
		if (!code || !state) redirect(302, `${appUrl}/accounts?error=missing_code`);

		const candidate = splitOAuthState(state);
		const pending = candidate
			? await first(locals.db.select().from(oauthPending).where(eq(oauthPending.id, candidate)))
			: null;
		const sessionId = cookies.get(SESSION_COOKIE) ?? (pending ? `machine:${pending.userId}` : null);
		const pendingId = await verifyOAuthState({
			secret: locals.env.AUTH_SECRET,
			state,
			sessionId
		});
		const wrongProvider =
			opts.pendingMarker !== undefined && pending?.instanceUrl !== opts.pendingMarker;
		if (
			!pending ||
			!pendingId ||
			pending.id !== pendingId ||
			pending.expiresAt < new Date() ||
			wrongProvider
		) {
			if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
			redirect(302, `${appUrl}/accounts?error=oauth_expired`);
		}

		try {
			const exchanged = await opts.complete({ pending, code, db: locals.db, env: locals.env });
			const encrypted = await encryptJson(exchanged.credentials, locals.env.APP_ENCRYPTION_KEY);
			const now = new Date();
			const data = {
				displayName: exchanged.displayName || exchanged.handle || null,
				handle: exchanged.handle || null,
				avatarUrl: exchanged.avatarUrl || null,
				...(exchanged.instanceUrl !== undefined ? { instanceUrl: exchanged.instanceUrl } : {}),
				credentialsEncrypted: encrypted,
				metaJson: JSON.stringify(exchanged.meta),
				status: 'active' as const,
				updatedAt: now
			};
			const existing = await first(
				locals.db
					.select()
					.from(connections)
					.where(
						and(
							eq(connections.userId, pending.userId),
							eq(connections.platform, opts.platform),
							eq(connections.handle, exchanged.handle || ''),
							...(opts.matchInstanceUrl
								? [eq(connections.instanceUrl, exchanged.instanceUrl || '')]
								: [])
						)
					)
			);
			if (existing) {
				await locals.db.update(connections).set(data).where(eq(connections.id, existing.id));
			} else {
				await locals.db.insert(connections).values({
					id: newId(),
					userId: pending.userId,
					platform: opts.platform,
					...data,
					createdAt: now
				});
			}
			await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
			redirect(302, `${appUrl}/accounts?connected=${opts.platform}`);
		} catch (e) {
			if (isRedirect(e)) throw e;
			const message = e instanceof Error ? e.message : 'oauth_failed';
			redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`);
		}
	};
}
