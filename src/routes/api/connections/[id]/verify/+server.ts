import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { decryptJson, encryptJson } from '$lib/server/crypto';
import { first } from '$lib/server/db/client';
import { connections } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import {
	blueskyCreateSession,
	getProvider,
	linkedinVerify,
	threadsVerify,
	xVerify,
	type ConnectionCredentials
} from '$lib/server/providers';
import { sanitizeMastodonInstanceUrl } from '$lib/server/providers/mastodon';
import { requireSession } from '$lib/server/require';

export const POST: RequestHandler = async ({ params, locals }) => {
	const { id } = params;
	// Authorisation and ownership are settled before any write: a 401/403 from
	// these gates is a credentials problem, never a provider auth failure, and
	// must not reach the expiry write at the bottom of this handler.
	let conn: typeof connections.$inferSelect | undefined;
	try {
		// Session-only: this route refreshes and persists credentials, which is
		// the same class of action as connecting or disconnecting an account —
		// and docs/api.md promises a key cannot rotate credentials. `requireScope`
		// is deliberately not used: a session has no scopes to check.
		const user = requireSession(locals.user, locals.authMethod);
		conn = await first(
			locals.db
				.select()
				.from(connections)
				.where(and(eq(connections.id, id), eq(connections.userId, user.id)))
		);
	} catch (err) {
		return handleError(err);
	}
	if (!conn) return fail('Not found', 404);
	// Tombstoned rows are archive-only: credentials are wiped, so a
	// verify must go through a fresh connect (which revives the row).
	if (conn.status === 'disconnected') {
		return fail('Account disconnected — reconnect to verify', 409);
	}
	// Ownership is proven above, so every write carries the owner filter too.
	const owned = and(eq(connections.id, id), eq(connections.userId, conn.userId));

	try {
		const creds = await decryptJson<ConnectionCredentials>(
			conn.credentialsEncrypted,
			locals.env.APP_ENCRYPTION_KEY
		);

		if (conn.platform === 'bluesky') {
			const session = await blueskyCreateSession(
				creds.handle || conn.handle || '',
				creds.appPassword || '',
				creds.pdsHost || 'https://bsky.social'
			);
			await locals.db
				.update(connections)
				.set({
					status: 'active',
					handle: session.handle || conn.handle,
					displayName: session.displayName || conn.displayName,
					avatarUrl: session.avatarUrl || conn.avatarUrl,
					credentialsEncrypted: await encryptJson(
						{ ...creds, ...session },
						locals.env.APP_ENCRYPTION_KEY
					),
					updatedAt: new Date()
				})
				.where(owned);
		} else if (conn.platform === 'linkedin') {
			// Try a refresh first: expired-but-refreshable tokens verify without
			// forcing a manual reconnect. Auth rejection expires the row;
			// transients fall through to verify with the current token.
			let checkCreds = creds;
			const refresher = getProvider('linkedin').refreshIfNeeded;
			if (refresher) {
				try {
					const refreshed = await refresher(creds);
					if (refreshed.accessToken && refreshed.accessToken !== creds.accessToken) {
						checkCreds = refreshed;
						await locals.db
							.update(connections)
							.set({
								credentialsEncrypted: await encryptJson(refreshed, locals.env.APP_ENCRYPTION_KEY),
								updatedAt: new Date()
							})
							.where(owned);
					}
				} catch (err) {
					if ((err as { status?: number } | null)?.status === 401) {
						await locals.db
							.update(connections)
							.set({ status: 'expired', updatedAt: new Date() })
							.where(owned);
						return fail('Token expired — reconnect', 401);
					}
				}
			}
			const info = await linkedinVerify(checkCreds);
			await locals.db
				.update(connections)
				.set({
					status: 'active',
					displayName: info.displayName || conn.displayName,
					avatarUrl: info.avatarUrl || conn.avatarUrl,
					handle: info.handle || conn.handle,
					updatedAt: new Date()
				})
				.where(owned);
		} else if (conn.platform === 'threads') {
			let checkCreds = creds;
			const refresher = getProvider('threads').refreshIfNeeded;
			if (refresher) {
				try {
					const refreshed = await refresher(creds);
					if (refreshed.accessToken && refreshed.accessToken !== creds.accessToken) {
						checkCreds = refreshed;
						await locals.db
							.update(connections)
							.set({
								credentialsEncrypted: await encryptJson(refreshed, locals.env.APP_ENCRYPTION_KEY),
								updatedAt: new Date()
							})
							.where(owned);
					}
				} catch (err) {
					if ((err as { status?: number } | null)?.status === 401) {
						await locals.db
							.update(connections)
							.set({ status: 'expired', updatedAt: new Date() })
							.where(owned);
						return fail('Token expired — reconnect', 401);
					}
				}
			}
			const info = await threadsVerify(checkCreds);
			// Persist the resolved username into creds so permalinks keep working
			// even for rows connected before the profile fix (numeric fallback).
			const resolvedUsername = info.handle?.replace(/^@/, '').trim();
			const needsCredsUsername =
				resolvedUsername &&
				resolvedUsername !== checkCreds.threadsUsername &&
				checkCreds.threadsUserId &&
				resolvedUsername !== checkCreds.threadsUserId;
			// /me can report a different user id than the one stored at
			// connect time (the OAuth user_id Meta then refuses to publish
			// to). Persist the healed id so Verify alone repairs the row.
			const needsCredsUserId = Boolean(info.userId) && info.userId !== checkCreds.threadsUserId;
			const credsPatch = {
				...(needsCredsUsername ? { threadsUsername: resolvedUsername } : {}),
				...(needsCredsUserId && info.userId ? { threadsUserId: info.userId } : {})
			};
			await locals.db
				.update(connections)
				.set({
					status: 'active',
					displayName: info.displayName || conn.displayName,
					avatarUrl: info.avatarUrl || conn.avatarUrl,
					handle: info.handle || conn.handle,
					...(Object.keys(credsPatch).length
						? {
								credentialsEncrypted: await encryptJson(
									{ ...checkCreds, ...credsPatch },
									locals.env.APP_ENCRYPTION_KEY
								)
							}
						: {}),
					updatedAt: new Date()
				})
				.where(owned);
		} else if (conn.platform === 'x') {
			let checkCreds = creds;
			const refresher = getProvider('x').refreshIfNeeded;
			if (refresher) {
				try {
					const refreshed = await refresher(creds);
					if (refreshed.accessToken && refreshed.accessToken !== creds.accessToken) {
						checkCreds = refreshed;
						await locals.db
							.update(connections)
							.set({
								credentialsEncrypted: await encryptJson(refreshed, locals.env.APP_ENCRYPTION_KEY),
								updatedAt: new Date()
							})
							.where(owned);
					}
				} catch (err) {
					if ((err as { status?: number } | null)?.status === 401) {
						await locals.db
							.update(connections)
							.set({ status: 'expired', updatedAt: new Date() })
							.where(owned);
						return fail('Token expired — reconnect', 401);
					}
				}
			}
			const info = await xVerify(checkCreds);
			const resolvedUsername = info.handle?.replace(/^@/, '').trim();
			const needsCredsUsername =
				resolvedUsername &&
				resolvedUsername !== checkCreds.xUsername &&
				checkCreds.xUserId &&
				resolvedUsername !== checkCreds.xUserId;
			await locals.db
				.update(connections)
				.set({
					status: 'active',
					displayName: info.displayName || conn.displayName,
					avatarUrl: info.avatarUrl || conn.avatarUrl,
					handle: info.handle || conn.handle,
					...(needsCredsUsername
						? {
								credentialsEncrypted: await encryptJson(
									{ ...checkCreds, xUsername: resolvedUsername },
									locals.env.APP_ENCRYPTION_KEY
								)
							}
						: {}),
					updatedAt: new Date()
				})
				.where(owned);
		} else if (conn.platform === 'mastodon' && creds.instanceUrl && creds.accessToken) {
			// Re-normalize + re-block stored instances (fail closed on poisoned rows).
			const instanceUrl = sanitizeMastodonInstanceUrl(creds.instanceUrl);
			const res = await fetch(`${instanceUrl}/api/v1/accounts/verify_credentials`, {
				headers: { Authorization: `Bearer ${creds.accessToken}` }
			});
			if (res.status === 401 || res.status === 403) {
				await locals.db
					.update(connections)
					.set({ status: 'expired', updatedAt: new Date() })
					.where(owned);
				return fail('Mastodon token expired — reconnect', 401);
			}
			if (!res.ok) {
				// Transient (429/5xx/network): keep status, report 502 so the UI
				// does not flap a healthy connection to `expired`.
				return fail('Mastodon verify temporarily unavailable', 502);
			}
			await locals.db
				.update(connections)
				.set({ status: 'active', updatedAt: new Date() })
				.where(owned);
		}
		return ok({ ok: true, status: 'active' });
	} catch (err) {
		// Only auth failures expire the connection. Transients (network, 5xx,
		// bad stored instance) keep their status so a blip cannot flap a
		// healthy connection to `expired`.
		const status = (err as { status?: number } | null)?.status;
		if (status === 401 || status === 403) {
			await locals.db
				.update(connections)
				.set({ status: 'expired', updatedAt: new Date() })
				.where(owned);
		}
		return handleError(err);
	}
};
