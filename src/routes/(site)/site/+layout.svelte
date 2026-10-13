<script lang="ts">
	import { page } from '$app/state';
	import { appName } from '#lib/shared/sanity';
	import { localizedSitePath, switchedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';

	let { children } = $props();
	const { tr, trf, locale } = useI18n();
	const href = (path: string) => localizedSitePath(locale, path);
	// The same page in the other language (the URL carries the language, FN-32); error pages link to the root.
	const other = $derived(
		locale === 'id'
			? {
					href: switchedSitePath('en', page.url.pathname, page.status),
					label: 'English',
					lang: 'en'
				}
			: {
					href: switchedSitePath('id', page.url.pathname, page.status),
					label: 'Bahasa Indonesia',
					lang: 'id'
				}
	);
</script>

<a class="skip" href="#isi">{tr('Langsung ke isi')}</a>
<header class="site-header">
	<a class="brand" href={href('/')}>{appName()}</a>
	<nav class="nav" aria-label={tr('Navigasi situs')}>
		<a class="nav-link wide" href={href('/blog')}>{tr('Blog')}</a>
		<a class="nav-link wide" href={href('/pasang')}>{tr('Pasang')}</a>
		<a class="nav-link" href={other.href} hreflang={other.lang} lang={other.lang}>{other.label}</a>
		<a class="cta" href={href('/mulai')}>{tr('Mulai gratis')}</a>
	</nav>
</header>

<main class="site-main" id="isi">{@render children()}</main>

<footer class="site-footer">
	<div class="footer-inner">
		<p class="footer-brand">{appName()}</p>
		<nav aria-label={tr('Tautan kaki')}>
			<a href={href('/blog')}>{tr('Blog')}</a>
			<a href={href('/pasang')}>{tr('Pasang aplikasi')}</a>
			<a href={href('/privasi')}>{tr('Privasi')}</a>
			<a href={href('/ketentuan')}>{tr('Ketentuan')}</a>
			<a href={href('/hapus-akun')}>{tr('Hapus akun')}</a>
			<a href={other.href} hreflang={other.lang} lang={other.lang}>{other.label}</a>
		</nav>
		<p class="fine">
			{trf(
				'{app} bukan bank atau dompet digital: tidak menyimpan dana, tidak memindahkan uang, dan tidak pernah meminta PIN, OTP atau kata sandi bank. Isi situs ini informasi, bukan nasihat keuangan.',
				{ app: appName() }
			)}
		</p>
	</div>
</footer>

<style>
	.skip {
		position: absolute;
		left: -9999px;
	}
	.skip:focus {
		left: 8px;
		top: 8px;
		z-index: 20;
		padding: 10px 16px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
	}
	.site-header {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		height: var(--header-h);
		padding: 0 var(--gutter);
		background: var(--bg);
		border-bottom: 1px solid var(--line);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--ink);
		text-decoration: none;
	}
	.nav {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.nav-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 10px;
		color: var(--ink-2);
		font-size: 15px;
		text-decoration: none;
	}
	/* On narrow phones the header keeps the language switch and the start button; Blog and Pasang stay in the footer. */
	@media (max-width: 520px) {
		.wide {
			display: none;
		}
	}
	.cta {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 18px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-size: 15px;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
	}
	.site-main {
		max-width: var(--maxw);
		margin: 0 auto;
		padding: 0 var(--gutter);
	}
	.site-footer {
		margin-top: 64px;
		padding: 40px var(--gutter);
		background: var(--panel);
	}
	.footer-inner {
		max-width: var(--maxw);
		margin: 0 auto;
	}
	.footer-brand {
		margin: 0 0 8px;
		font-weight: 700;
	}
	.site-footer nav {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 20px;
	}
	.site-footer a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		text-decoration: none;
	}
	.fine {
		max-width: 72ch;
		margin: 16px 0 0;
		color: var(--muted);
		font-size: 14px;
	}
</style>
