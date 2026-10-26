import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: [
			'.claude/',
			'.superpowers/',
			'.svelte-kit/',
			'**/.wrangler/',
			'build/',
			'docs/',
			'migrations/',
			// FN-58 Android app: generated Capacitor/Gradle files and its own node_modules.
			'native/android-app/android/',
			'native/android-app/node_modules/',
			// FN-16g: vendored, pinned engine files written by `npm run ocr:assets` (git-ignored).
			'static/_ocr/',
			'.ocr-cache/',
			'test-results/',
			'playwright-report/',
			'**/worker-configuration.d.ts'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: { 'no-undef': 'off' }
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	}
);
