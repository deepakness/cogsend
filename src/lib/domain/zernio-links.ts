const AFFILIATE_SLUG = 'deepak-kumar';
const AFFILIATE_LINK = `https://zernio.link/${AFFILIATE_SLUG}`;

export function zernioLink({
	path = '/',
	placement
}: {
	path?: string;
	placement: string;
}): string {
	if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(path)) throw new Error('Expected a Zernio path');
	const page = path.replace(/^\/+/, '');
	// The short link only redirects to the home page (a path after the slug does
	// not resolve), so a deep link goes to the page itself with ?via=, which
	// zernio.com's analytics credits to the same affiliate.
	const url = page ? new URL(page, 'https://zernio.com/') : new URL(AFFILIATE_LINK);
	if (url.hostname !== 'zernio.com' && url.hostname !== 'zernio.link') {
		throw new Error('Expected a Zernio destination');
	}
	if (page) url.searchParams.set('via', AFFILIATE_SLUG);
	url.searchParams.set('utm_source', 'cogsend');
	url.searchParams.set('utm_medium', 'sponsorship');
	url.searchParams.set('utm_campaign', 'cogsend-integration');
	url.searchParams.set('utm_content', placement);
	return url.toString();
}
