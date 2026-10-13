<script lang="ts">
	import { page } from '$app/state';
	import { msg } from '#lib/shared/i18n';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';
	import { PRIVACY, TERMS } from './content';

	const PAGES: Record<string, { title: string; description: string; sections: typeof PRIVACY }> = {
		privasi: {
			title: msg('Kebijakan privasi'),
			description: msg(
				'Data apa yang kami simpan, apa yang tidak pernah kami simpan, dan bagaimana menghapusnya.'
			),
			sections: PRIVACY
		},
		ketentuan: {
			title: msg('Ketentuan layanan'),
			description: msg('Aturan pemakaian layanan pencatat keuangan ini.'),
			sections: TERMS
		}
	};
	const { tr, locale } = useI18n();
	const legal = $derived(page.params.legal ?? '');
	const current = $derived(PAGES[legal]);
</script>

{#if current}
	<SiteHead title={tr(current.title)} description={tr(current.description)} path="/{legal}" />
	<article class="legal">
		<h1>{tr(current.title)}</h1>
		<p class="draft" role="note">{tr('Draf. Isi lengkap menunggu tinjauan hukum.')}</p>
		{#each current.sections as section (section.id)}
			<section aria-labelledby={section.id}>
				<h2 id={section.id}>{tr(section.title)}</h2>
				{#each section.paragraphs as paragraph, i (i)}
					<p>{tr(paragraph)}</p>
				{/each}
				{#if section.items}
					<ul>
						{#each section.items as item, i (i)}<li>{tr(item)}</li>{/each}
					</ul>
				{/if}
			</section>
		{/each}
		{#if legal === 'privasi'}
			<a class="action" href={localizedSitePath(locale, '/hapus-akun')}>{tr('Hapus akun')}</a>
		{/if}
	</article>
{/if}

<style>
	.legal {
		max-width: 680px;
		padding: 48px 0 0;
	}
	h1 {
		margin: 0;
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.draft {
		display: inline-block;
		margin: 16px 0 0;
		padding: 8px 14px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink-2);
		font-size: 15px;
		font-weight: 600;
	}
	h2 {
		margin: 32px 0 8px;
		font-size: 20px;
		font-weight: 600;
	}
	p,
	ul {
		margin: 0 0 12px;
		color: var(--ink-2);
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 16px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
</style>
