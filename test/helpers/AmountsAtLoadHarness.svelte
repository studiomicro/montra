<script lang="ts">
	import type { Component } from 'svelte';
	import { createTranslator } from '#lib/shared/i18n';
	import { setI18n } from '#lib/ui/i18n-context';
	import { provideAmountsHiddenAtLoad } from '#lib/ui/kit/amounts.svelte';

	// Server-render harness: what the root layout provides, with the "hide amounts" cookie choice set.
	let {
		component: Page,
		hidden,
		props
	}: {
		component: Component<Record<string, unknown>>;
		hidden: boolean;
		props: Record<string, unknown>;
	} = $props();
	setI18n(createTranslator('id'));
	provideAmountsHiddenAtLoad(() => hidden);
</script>

<Page {...props} />
