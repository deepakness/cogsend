import type { Cookies } from '@sveltejs/kit';
import { cookieSecureFlag, SESSION_COOKIE } from './auth';
import type { AppEnv } from './env';
import { MFA_COOKIE, MFA_MAX_AGE } from './totp';

export function setSessionCookie(
	cookies: Cookies,
	env: AppEnv,
	host: string,
	token: string,
	maxAge: number
) {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecureFlag(env, host),
		maxAge
	});
}

export function setMfaCookie(cookies: Cookies, env: AppEnv, host: string, token: string) {
	cookies.set(MFA_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookieSecureFlag(env, host),
		maxAge: MFA_MAX_AGE
	});
}

export function clearMfaCookie(cookies: Cookies, env?: AppEnv, host?: string) {
	// Mirror set() attributes: some browsers keep a Secure/SameSite cookie
	// when delete() omits them.
	cookies.delete(MFA_COOKIE, {
		path: '/',
		...(env && host ? { secure: cookieSecureFlag(env, host), sameSite: 'lax' as const } : {})
	});
}

export function clearSessionCookie(cookies: Cookies, env?: AppEnv, host?: string) {
	cookies.delete(SESSION_COOKIE, {
		path: '/',
		...(env && host ? { secure: cookieSecureFlag(env, host), sameSite: 'lax' as const } : {})
	});
}
