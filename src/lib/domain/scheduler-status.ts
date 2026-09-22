/**
 * Wording for "is anything ticking?", shared by the health endpoint, the
 * Settings card and `npm run doctor`.
 *
 * The app cannot read its own cron schedules, so it reports what it can see:
 * whether a tick has ever run, how long ago, and what the last deploy recorded
 * about the trigger. Never ticking is the state a fresh instance lands in when
 * the account had no trigger slot left — the case the recommendation exists
 * for. Kept pure so the wording and the branching are testable.
 */
import type { DeployCronState } from './deploy-cron';

interface TickStatus {
	ok: boolean;
	lastTickAt: Date | null;
	stuckPublishing?: number;
}

/** The one-line status: short, because it also renders next to the version. */
export function schedulerMessage(status: TickStatus, deployCron: DeployCronState | null): string {
	const stuck = status.stuckPublishing ?? 0;
	if (stuck) {
		return `${stuck} post${stuck === 1 ? '' : 's'} stuck publishing — retry from Posts`;
	}
	if (status.lastTickAt === null) {
		if (deployCron?.status === 'unavailable') {
			return 'Scheduled publishing is idle: Cloudflare refused the cron trigger (error 10072)';
		}
		if (deployCron?.status === 'disabled') {
			return 'Scheduled publishing is idle: no cron trigger is configured';
		}
		return 'Scheduled publishing is idle: no tick yet';
	}
	if (!status.ok) return 'Scheduled publishing is delayed — scheduled posts are waiting';
	return 'Scheduled publishing is on time';
}

export interface TickAdvice {
	/** `warn` renders a highlighted box: scheduled posts will not publish. */
	level: 'ok' | 'info' | 'warn';
	message: string;
}

/**
 * What to tell the operator about the tick, and how loudly.
 *
 * Warns only when publishing is actually in doubt: the deploy knows it could
 * not attach the trigger, or the scheduler has gone quiet for far longer than a
 * throttled pinger could explain. A single tick still missing right after a
 * deploy is informational, not alarming.
 */
export function tickAdvice(status: TickStatus, deployCron: DeployCronState | null): TickAdvice {
	if (status.stuckPublishing) {
		return {
			level: 'warn',
			message: `${status.stuckPublishing} post${
				status.stuckPublishing === 1 ? ' is' : 's are'
			} stuck publishing. Retry them from Posts.`
		};
	}
	if (status.lastTickAt === null) {
		if (deployCron?.status === 'unavailable') {
			return {
				level: 'warn',
				message:
					'This deployment has no cron trigger: Cloudflare refused it because the account is at its free-plan limit of 5 cron triggers (error 10072). Scheduled posts will wait until something ticks — free a trigger slot on another Worker, upgrade the plan, or point an external cron at the tick URL below.'
			};
		}
		if (deployCron?.status === 'disabled') {
			return {
				level: 'warn',
				message:
					'This deployment has no cron trigger, so scheduled posts only publish when something calls the tick URL. Point an external cron at it with the token below.'
			};
		}
		return {
			level: 'info',
			message:
				'No tick has arrived yet. The built-in cron runs every minute once the Worker has a trigger; if scheduled posts do not fire, use the tick URL below with an external cron.'
		};
	}
	if (!status.ok) {
		return {
			level: 'warn',
			message:
				'The scheduler has gone quiet, so scheduled posts are waiting. Check the Worker cron trigger (Settings → Trigger events), or drive the tick URL below from an external cron.'
		};
	}
	return { level: 'ok', message: 'Ticks are arriving on schedule.' };
}
