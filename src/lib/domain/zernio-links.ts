/** Swapped for the maintainer's affiliate URL once it exists; nothing else changes. */
const ZERNIO_LINK_BASE = 'https://zernio.com';

const ZERNIO_HOSTS = ['zernio.com', 'zernio.link', 'docs.zernio.com'];

export function zernioLink({
	path = '/',
	placement
}: {
	path?: string;
	placement: string;
}): string {
	if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(path)) throw new Error('Expected a Zernio path');
	const url = new URL(path.replace(/^\/+/, ''), `${ZERNIO_LINK_BASE}/`);
	if (url.protocol !== 'https:' || !ZERNIO_HOSTS.includes(url.hostname)) {
		throw new Error('Expected a Zernio destination');
	}
	url.searchParams.set('utm_source', 'cogsend');
	url.searchParams.set('utm_medium', 'sponsorship');
	url.searchParams.set('utm_campaign', 'cogsend-integration');
	url.searchParams.set('utm_content', placement);
	return url.toString();
}
