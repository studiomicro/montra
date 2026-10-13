<script lang="ts">
	import { createTranslator } from '#lib/shared/i18n';
	import { setI18n } from '#lib/ui/i18n-context';
	import PickerSheet from '#lib/ui/kit/PickerSheet.svelte';
	import type { PickerOption } from '#lib/ui/kit/picker';

	let { options, value }: { options: PickerOption<string>[]; value: string | null } = $props();
	setI18n(createTranslator('id'));
</script>

<PickerSheet open title="Pilih" {options} {value} />
