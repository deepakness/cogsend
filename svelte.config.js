import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		csp: {
			// 'auto' nonces the inline scripts SvelteKit emits for hydration,
			// which is why script-src needs no 'unsafe-inline' here.
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// Server-rendered <img onload/onerror> gets Svelte's inline
				// `this.__e=event`, which records a load that finishes before
				// hydration so it can be replayed. Blocked, a cached image loads
				// unseen and its handler never runs. The hash admits that one
				// string and nothing else.
				'script-src': [
					'self',
					'unsafe-hashes',
					'sha256-7dQwUgLau1NFCCGjfn9FsYptB6ZtWxJin6VohGIu20I='
				],
				'base-uri': ['self'],
				'object-src': ['none'],
				'frame-ancestors': ['none'],
				'form-action': ['self'],
				// Svelte writes inline style attributes and Tailwind injects a
				// stylesheet at build time; style attributes need 'unsafe-inline'.
				'style-src': ['self', 'unsafe-inline'],
				// Avatars come from five different provider CDNs, preview images
				// from arbitrary hosts, and media from this origin or
				// MEDIA_PUBLIC_BASE_URL, so images are limited to https rather
				// than enumerated.
				'img-src': ['self', 'data:', 'blob:', 'https:'],
				'media-src': ['self', 'blob:', 'https:'],
				// Every fetch the app makes goes to its own origin.
				'connect-src': ['self'],
				'font-src': ['self', 'data:'],
				'manifest-src': ['self']
			}
		}
	}
};

export default config;
