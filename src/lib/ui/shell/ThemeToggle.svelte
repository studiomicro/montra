<script lang="ts">
	import { page } from '$app/state';
	import { isThemePref, THEME_LABELS, type ThemePref } from '#lib/shared/theme';
	import { useI18n } from '#lib/ui/i18n-context';
	import IconButton from '#lib/ui/kit/IconButton.svelte';
	import { applyThemeColor, nextTheme, THEME_ICONS, themeCookie } from './theme';

	const { tr, trf } = useI18n();
	/** The choice in force: the server's, then whatever this button or Pengaturan › Tampilan set since. */
	let current = $state<ThemePref>(page.data.theme ?? 'system');

	$effect(() => {
		void page.data.theme;
		const stored = document.documentElement.dataset.theme ?? '';
		current = isThemePref(stored) ? stored : 'system';
	});

	function toggle() {
		const next = nextTheme(document.documentElement.dataset.theme);
		document.documentElement.dataset.theme = next;
		document.cookie = themeCookie(next, location.protocol === 'https:');
		applyThemeColor(document, next);
		current = next;
	}
</script>

<IconButton
	icon={THEME_ICONS[current]}
	label={trf('Tampilan: {tema}', { tema: tr(THEME_LABELS[current]) })}
	onclick={toggle}
/>
