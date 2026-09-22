import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

// Shown in Settings so a bug report can name the version it runs.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// SvelteKit adapter + compilerOptions live in svelte.config.js (required).
// Do not pass `adapter` here: the Vite plugin ignores it, which previously
// left clean-checkout builds on adapter-auto and broke wrangler `main`.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: { __APP_VERSION__: JSON.stringify(version) },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
