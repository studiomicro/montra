<script lang="ts">
	import type { Component } from 'svelte';
	import { createTranslator, type Locale } from '#lib/shared/i18n';
	import { setI18n } from '#lib/ui/i18n-context';

	// Server-render harness: gives a page component the translator the root layout normally provides.
	let {
		component: Page,
		locale = 'id',
		props
	}: {
		component: Component<Record<string, unknown>>;
		locale?: Locale;
		props: Record<string, unknown>;
	} = $props();
	// svelte-ignore state_referenced_locally
	setI18n(createTranslator(locale));
</script>

<Page {...props} />
