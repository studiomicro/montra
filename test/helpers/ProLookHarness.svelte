<script lang="ts">
	import type { Component } from 'svelte';
	import { createTranslator } from '#lib/shared/i18n';
	import { setI18n } from '#lib/ui/i18n-context';
	import { setProLook } from '#lib/ui/kit/pro-look-context';

	// Server-render harness: what the (app) layout provides — the translator and the Pro look (FN-46) of `pro`.
	let {
		component: Inner,
		pro,
		props
	}: {
		component: Component<Record<string, unknown>>;
		pro: boolean;
		props: Record<string, unknown>;
	} = $props();
	setI18n(createTranslator('id'));
	setProLook(() => pro);
</script>

<Inner {...props} />
