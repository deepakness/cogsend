import { and, eq, sql } from 'drizzle-orm';
import { first, newId, type AppDb } from './db/client';
import { mfaChallenges } from './db/schema';
import { hashToken } from './auth';
import type { AppEnv } from './env';

export const AUTH_GATE_MAX_FAILURES = 8;
export const AUTH_GATE_WINDOW_MS = 15 * 60_000;

export type AuthGateKind = 'password' | 'rotate-gate' | 'totp-gate';

function gateExpires(now = new Date()) {
	return new Date(now.getTime() + AUTH_GATE_WINDOW_MS);
}

async function gateTokenHash(env: AppEnv, kind: AuthGateKind, userId: string) {
	return hashToken(`gate:${kind}:${userId}`, env.AUTH_SECRET);
}

export async function assertAuthGateOpen(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind
) {
	const tokenHash = await gateTokenHash(env, kind, userId);
	const row = await first(
		db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, tokenHash))
	);
	if (!row) return;
	const now = new Date();
	if (row.expiresAt < now) {
		await db.delete(mfaChallenges).where(eq(mfaChallenges.id, row.id));
		return;
	}
	if (row.failedAttempts >= AUTH_GATE_MAX_FAILURES) {
		throw Object.assign(new Error('Too many attempts — try again in 15 minutes'), { status: 401 });
	}
}

export async function recordAuthGateFailure(
	db: AppDb,
	env: AppEnv,
	userId: string,
	kind: AuthGateKind
) {
	const tokenHash = await gateTokenHash(env, kind, userId);
	const now = new Date();
	const nowMs = now.getTime();
	const expiry = gateExpires(now);
	// One UPSERT so the increment happens inside SQLite. The read-then-write it
	// replaced let two concurrent failures both persist `count + 1`, which is
	// exactly the timing a guessing burst produces. A row past its window is
	// reset to a fresh count, and the window is extended once the row is locked
	// (matching the previous behavior).
	const rows = await db
		.insert(mfaChallenges)
		.values({
			id: newId(),
			userId,
			tokenHash,
			kind,
			remember: false,
			failedAttempts: 1,
			expiresAt: expiry,
			createdAt: now
		})
		.onConflictDoUpdate({
			target: mfaChallenges.tokenHash,
			set: {
				failedAttempts: sql`CASE WHEN ${mfaChallenges.expiresAt} < ${nowMs} THEN 1 ELSE ${mfaChallenges.failedAttempts} + 1 END`,
				expiresAt: sql`CASE
						WHEN ${mfaChallenges.expiresAt} < ${nowMs} THEN ${expiry.getTime()}
						WHEN ${mfaChallenges.failedAttempts} + 1 >= ${AUTH_GATE_MAX_FAILURES} THEN ${expiry.getTime()}
						ELSE ${mfaChallenges.expiresAt}
					END`
			}
		})
		.returning({ failedAttempts: mfaChallenges.failedAttempts });
	const failedAttempts = rows[0]?.failedAttempts ?? 1;
	return { locked: failedAttempts >= AUTH_GATE_MAX_FAILURES };
}

export async function clearAuthGate(db: AppDb, env: AppEnv, userId: string, kind: AuthGateKind) {
	const tokenHash = await gateTokenHash(env, kind, userId);
	await db.delete(mfaChallenges).where(and(eq(mfaChallenges.tokenHash, tokenHash)));
}
