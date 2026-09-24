import { ZERNIO_API_BASE } from '$lib/domain/zernio';
import { ProviderError, type FetchLike } from './providers/types';
import { providerFetch } from './providers/timed-fetch';

export interface ZernioProfile {
	_id: string;
	name: string;
	isDefault?: boolean;
}

export interface ZernioAccount {
	_id: string;
	platform: string;
	profileId: string | { _id: string; name?: string };
	username?: string;
	displayName?: string;
	profilePicture?: string | null;
	profileUrl?: string;
	isActive?: boolean;
	needsReconnection?: boolean;
	enabled?: boolean;
}

export interface ZernioPlatformEntry {
	platform: string;
	accountId: string | { _id: string };
	status?: string;
	platformPostId?: string;
	platformPostUrl?: string;
	errorMessage?: string;
	errorCategory?: string;
}

export interface ZernioPost {
	_id: string;
	status?: string;
	platforms?: ZernioPlatformEntry[];
}

export function zernioProfileId(account: ZernioAccount): string {
	return typeof account.profileId === 'string' ? account.profileId : account.profileId._id;
}

export function zernioEntryAccountId(entry: ZernioPlatformEntry): string {
	return typeof entry.accountId === 'string' ? entry.accountId : entry.accountId._id;
}

function apiMessageFrom(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
	} catch {
		return null;
	}
}

/**
 * 401 is the key: expire the connection. 429 and 5xx come back later. Every
 * other 4xx (validation, the billing gate, a missing permission, the 24-hour
 * duplicate rejection) is a refusal the same request cannot get past, so it is
 * non-retryable without expiring the connection: `forbidden` is the code that
 * carries exactly that pair of decisions through publish.ts.
 */
export function zernioHttpError(prefix: string, status: number, body: string): ProviderError {
	const message = `Zernio ${prefix} failed (${status}): ${apiMessageFrom(body) ?? body.slice(0, 300)}`;
	const detail = body.slice(0, 2000);
	if (status === 401) return new ProviderError(message, { status, code: 'auth', detail });
	if (status === 429) return new ProviderError(message, { status, code: 'rate_limited', detail });
	if (status >= 500) return new ProviderError(message, { status, code: 'upstream', detail });
	return new ProviderError(message, { status, code: 'forbidden', detail });
}

export function zernioApiMessage(err: unknown): string {
	if (err instanceof ProviderError && err.detail) {
		const own = apiMessageFrom(err.detail);
		if (own) return own;
	}
	return err instanceof Error ? err.message : String(err);
}

async function request<T>(opts: {
	apiKey: string;
	path: string;
	method?: 'GET' | 'POST';
	body?: unknown;
	headers?: Record<string, string>;
	prefix: string;
	fetchImpl?: FetchLike;
}): Promise<T> {
	const fetchImpl = opts.fetchImpl ?? providerFetch;
	const res = await fetchImpl(`${ZERNIO_API_BASE}${opts.path}`, {
		method: opts.method ?? 'GET',
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			Accept: 'application/json',
			...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...(opts.headers ?? {})
		},
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
	});
	if (!res.ok) throw zernioHttpError(opts.prefix, res.status, await res.text());
	return (await res.json()) as T;
}

export async function listProfiles(opts: {
	apiKey: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioProfile[]> {
	const data = await request<{ profiles?: ZernioProfile[] }>({
		...opts,
		path: '/v1/profiles',
		prefix: 'list profiles'
	});
	return data.profiles ?? [];
}

export async function listAccounts(opts: {
	apiKey: string;
	profileId?: string;
	platform?: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioAccount[]> {
	const params = new URLSearchParams({ limit: '200' });
	if (opts.profileId) params.set('profileId', opts.profileId);
	if (opts.platform) params.set('platform', opts.platform);
	const data = await request<{ accounts?: ZernioAccount[] }>({
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
		path: `/v1/accounts?${params}`,
		prefix: 'list accounts'
	});
	return data.accounts ?? [];
}

export async function connectUrl(opts: {
	apiKey: string;
	platform: string;
	profileId: string;
	redirectUrl: string;
	fetchImpl?: FetchLike;
}): Promise<string> {
	const params = new URLSearchParams({ profileId: opts.profileId, redirect_url: opts.redirectUrl });
	const data = await request<{ authUrl?: string }>({
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
		path: `/v1/connect/${encodeURIComponent(opts.platform)}?${params}`,
		prefix: 'connect'
	});
	if (!data.authUrl) throw new ProviderError('Zernio connect returned no authorization URL');
	return data.authUrl;
}

function unwrapPost(data: { post?: ZernioPost } | ZernioPost): ZernioPost {
	const post = 'post' in data && data.post ? data.post : (data as ZernioPost);
	if (!post || typeof post._id !== 'string') throw new ProviderError('Zernio returned no post');
	return post;
}

export async function createPost(opts: {
	apiKey: string;
	body: Record<string, unknown>;
	requestId: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioPost> {
	return unwrapPost(
		await request({
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
			path: '/v1/posts',
			method: 'POST',
			body: opts.body,
			headers: { 'x-request-id': opts.requestId },
			prefix: 'create post'
		})
	);
}

export async function getPost(opts: {
	apiKey: string;
	postId: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioPost> {
	return unwrapPost(
		await request({
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
			path: `/v1/posts/${encodeURIComponent(opts.postId)}`,
			prefix: 'read post'
		})
	);
}
