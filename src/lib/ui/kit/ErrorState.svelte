<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from './Button.svelte';

	let { text, onretry }: { text: string; onretry: () => void } = $props();
	const { tr } = useI18n();
</script>

<div class="error" role="alert">
	<p>{text}</p>
	<Button variant="secondary" onclick={onretry}>{tr('Coba lagi')}</Button>
</div>

<style>
	.error {
		display: grid;
		justify-items: center;
		gap: 12px;
		padding: 32px 0;
		text-align: center;
	}
	p {
		margin: 0;
	}
</style>
