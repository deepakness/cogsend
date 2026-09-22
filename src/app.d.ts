import type { AppDb } from '$lib/server/db/client';
import type { AppEnv } from '$lib/server/env';
import type { SessionUser } from '$lib/server/auth';
import type { MediaStore } from '$lib/server/media';
import type { QueueLike } from '$lib/server/scheduler';

declare global {
	/** Injected by vite.config.ts from package.json — the running version. */
	const __APP_VERSION__: string;

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		interface Locals {
			db: AppDb;
			env: AppEnv;
			media: MediaStore;
			queue: QueueLike | null;
			user: SessionUser | null;
			// How locals.user was established: interactive cookie session vs
			// a bearer credential (API_TOKEN machine user or API key).
			authMethod: 'session' | 'bearer' | null;
			// API-key scopes (null for sessions and the env API_TOKEN operator
			// key, which stay unrestricted). Null = no scope check.
			apiKeyScopes: string[] | null;
		}
	}
}

export {};
