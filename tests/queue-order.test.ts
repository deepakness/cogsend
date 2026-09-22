import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, publishTargets, users } from '$lib/server/db/schema';
import { createTestDb } from '$lib/server/db/test';
import { GET as queueGET } from '../src/routes/api/queue/+server';

/**
 * SQLite sorts NULLs before values, so the queue's old `ORDER BY scheduled_for`
 * put every row with no schedule — manually published, pending, failed — ahead
 * of the posts that are actually due. With more than a window's worth of
 * history the Scheduled tab rendered empty while posts were waiting.
 */
describe('GET /api/queue ordering', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const queue = () =>
		queueGET({
			locals: {
				db,
				user: {
					id: userId,
					email: 'queue-order@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never) as Promise<Response>;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'queue-order@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const connId = newId();
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'mastodon',
			handle: 'queue@example.social',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});

		// More history rows than the 100-row window, all with a NULL schedule.
		const historyDrafts = [];
		const historyTargets = [];
		for (let i = 0; i < 105; i++) {
			const id = newId();
			historyDrafts.push({
				id,
				userId,
				baseBody: `history ${i}`,
				status: 'published',
				createdAt: now,
				updatedAt: new Date(now.getTime() - i * 60_000)
			});
			historyTargets.push({
				id: newId(),
				draftId: id,
				connectionId: connId,
				status: 'published',
				remotePostId: `remote-${i}`,
				attemptCount: 1,
				createdAt: now,
				updatedAt: new Date(now.getTime() - i * 60_000)
			});
		}
		await db.insert(drafts).values(historyDrafts);
		await db.insert(publishTargets).values(historyTargets);

		// Two posts that are actually waiting.
		const upcomingDrafts = [];
		const upcomingTargets = [];
		for (const [i, when] of [
			new Date(now.getTime() + 60_000),
			new Date(now.getTime() + 120_000)
		].entries()) {
			const id = newId();
			upcomingDrafts.push({
				id,
				userId,
				baseBody: `upcoming ${i}`,
				status: 'scheduled',
				createdAt: now,
				updatedAt: now
			});
			upcomingTargets.push({
				id: newId(),
				draftId: id,
				connectionId: connId,
				status: 'scheduled',
				scheduledFor: when,
				attemptCount: 0,
				createdAt: now,
				updatedAt: now
			});
		}
		await db.insert(drafts).values(upcomingDrafts);
		await db.insert(publishTargets).values(upcomingTargets);
	});
	afterAll(() => close());

	it('lists upcoming posts before unscheduled history', async () => {
		const res = await queue();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { targets: Array<{ id: string; status: string }> };
		expect(body.targets).toHaveLength(100);
		// Both waiting posts are in the window, soonest first.
		expect(body.targets[0].status).toBe('scheduled');
		expect(body.targets[1].status).toBe('scheduled');
		expect(body.targets[2].status).toBe('published');
	});
});
