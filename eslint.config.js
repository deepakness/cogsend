import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			// Static same-app hrefs; resolve() is for dynamic base paths we do not use.
			'svelte/no-navigation-without-resolve': 'off',
			// Local Set/Map snapshots are not reactive stores.
			'svelte/prefer-svelte-reactivity': 'off',
			// QR SVG is generated server-side from uqr, not user HTML.
			'svelte/no-at-html-tags': 'off'
		}
	},
	{
		// Server code runs in a Worker, where the DOM does not exist. TypeScript
		// cannot tell (the DOM lib is global), and `no-undef` is off by design, so
		// `window` in a server module would lint clean and fail at runtime.
		files: ['src/lib/server/**/*.ts', 'src/routes/**/+*.server.ts', 'src/routes/**/+server.ts'],
		rules: {
			'no-restricted-globals': [
				'error',
				{ name: 'window', message: 'Server code runs in a Worker: no DOM.' },
				{ name: 'document', message: 'Server code runs in a Worker: no DOM.' },
				{ name: 'localStorage', message: 'Server code runs in a Worker: no storage.' },
				{ name: 'sessionStorage', message: 'Server code runs in a Worker: no storage.' },
				{ name: 'history', message: 'Server code runs in a Worker: no history.' },
				{ name: 'alert', message: 'Server code runs in a Worker: no UI.' },
				{ name: 'HTMLElement', message: 'Server code runs in a Worker: no DOM.' }
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	}
);
