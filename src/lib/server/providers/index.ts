import { blueskyProvider } from './bluesky';
import { linkedinProvider } from './linkedin';
import { mastodonProvider } from './mastodon';
import { threadsProvider } from './threads';
import { xProvider } from './x';
import type { PlatformId, PlatformProvider } from './types';

const providers: Record<PlatformId, PlatformProvider> = {
	bluesky: blueskyProvider,
	mastodon: mastodonProvider,
	linkedin: linkedinProvider,
	threads: threadsProvider,
	x: xProvider
};

export function getProvider(platform: PlatformId | string): PlatformProvider {
	const p = providers[platform as PlatformId];
	if (!p) throw new Error(`Unknown platform: ${platform}`);
	return p;
}

export * from './types';
export { providerFetch, timedFetch } from './timed-fetch';
export { blueskyProvider, blueskyCreateSession, buildLinkFacets } from './bluesky';
export {
	mastodonProvider,
	mastodonRegisterApp,
	mastodonAuthorizeUrl,
	mastodonExchangeCode,
	sanitizeMastodonInstanceUrl
} from './mastodon';
export {
	linkedinProvider,
	linkedinAuthorizeUrl,
	linkedinExchangeCode,
	linkedinVerify,
	LINKEDIN_MAX_CHARS,
	LINKEDIN_MAX_IMAGES,
	LINKEDIN_MAX_IMAGE_BYTES
} from './linkedin';
export {
	threadsProvider,
	threadsAuthorizeUrl,
	threadsExchangeCode,
	threadsVerify,
	THREADS_MAX_CHARS
} from './threads';
export {
	xProvider,
	xAuthorizeUrl,
	xExchangeCode,
	xVerify,
	xPostUrl,
	generateCodeVerifier,
	codeChallenge,
	packXPendingSecret,
	unpackXPendingSecret,
	X_SCOPES,
	X_MAX_CHARS,
	X_MAX_IMAGES,
	X_MAX_IMAGE_BYTES
} from './x';
