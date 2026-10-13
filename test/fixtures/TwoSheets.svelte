<script lang="ts">
	import { createTranslator } from '#lib/shared/i18n';
	import { setI18n } from '#lib/ui/i18n-context';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	setI18n(createTranslator('id'));
</script>

<Sheet title="Satu"><p>a</p></Sheet>
<Sheet title="Dua"><p>b</p></Sheet>
