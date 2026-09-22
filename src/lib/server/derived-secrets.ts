/**
 * Secrets the app derives instead of asking for.
 *
 * `APP_ENCRYPTION_KEY` is the only key a deployment has to bring. It cannot be
 * generated at runtime and stored: it encrypts the provider tokens and the TOTP
 * secret that live in D1, so a copy of it in that same database would turn a
 * database leak into a full takeover, and rotating it orphans every stored
 * credential — there is no "start weak, change it later" for it.
 *
 * `AUTH_SECRET` and `SCHEDULER_SECRET` are not like that. Nothing outside the
 * Worker needs to know them (a pinger does, but only if you run one), so they
 * are derived from the master key with HMAC-SHA256 and a fixed label. Same
 * pattern as the media-URL sub-key in public-media.ts.
 *
 * An explicitly configured value always wins, which keeps existing deployments
 * on their current secrets and lets an operator pin an independent one.
 *
 * Changing a label is a rotation: every session signs out (AUTH_SECRET), or
 * whoever holds SCHEDULER_SECRET must be updated. Values are cached per master
 * key, so a request pays for the HMAC once per isolate rather than once per
 * request. `scripts/wrap-worker.mjs` derives the scheduler secret too — a unit
 * test pins both sides to the same label.
 */
import { hmacHex } from './crypto';

/** Wire format: changing either string rotates that secret. */
export const AUTH_SECRET_LABEL = 'subkey:auth-secret:v1';
export const SCHEDULER_SECRET_LABEL = 'subkey:scheduler-secret:v1';

export interface DerivedSecrets {
	authSecret: string;
	schedulerSecret: string;
}

let cachedFor: string | null = null;
let cached: Promise<DerivedSecrets> | null = null;

/** Both derived secrets for a master key, computed once per isolate. */
export function deriveSecrets(masterKey: string): Promise<DerivedSecrets> {
	if (cachedFor !== masterKey || !cached) {
		cachedFor = masterKey;
		cached = Promise.all([
			hmacHex(masterKey, AUTH_SECRET_LABEL),
			hmacHex(masterKey, SCHEDULER_SECRET_LABEL)
		])
			.then(([authSecret, schedulerSecret]) => ({ authSecret, schedulerSecret }))
			.catch((err) => {
				// Never cache a failure: the next request should retry.
				cachedFor = null;
				cached = null;
				throw err;
			});
	}
	return cached;
}
