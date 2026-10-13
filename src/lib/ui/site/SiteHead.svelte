<script lang="ts">
	import { canonicalSiteOrigin } from '#lib/shared/hosts';
	import { appName } from '#lib/shared/sanity';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';

	/**
	 * Title, description, canonical link, language alternates and Open Graph tags of one public site page
	 * (FN-32). `path` is the page's language-free path (`/`, `/blog`); every URL names the canonical site host
	 * from src/lib/shared/hosts.ts, never a hard-coded domain. Our own text only; the image is our own app icon.
	 */
	let {
		title,
		description,
		path,
		type = 'website'
	}: { title: string; description: string; path: string; type?: 'website' | 'article' } = $props();

	const { locale } = useI18n();
	const origin = canonicalSiteOrigin();
	const url = (l: 'id' | 'en') => `${origin}${localizedSitePath(l, path)}`;
	const fullTitle = $derived(path === '/' ? title : `${title} · ${appName()}`);
</script>

<svelte:head>
	<title>{fullTitle}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url(locale)} />
	<link rel="alternate" hreflang="id" href={url('id')} />
	<link rel="alternate" hreflang="en" href={url('en')} />
	<link rel="alternate" hreflang="x-default" href={url('id')} />
	<meta property="og:site_name" content={appName()} />
	<meta property="og:type" content={type} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url(locale)} />
	<meta property="og:locale" content={locale === 'en' ? 'en_US' : 'id_ID'} />
	<meta property="og:image" content="{origin}/icons/icon-512.png" />
	<meta name="twitter:card" content="summary" />
</svelte:head>
