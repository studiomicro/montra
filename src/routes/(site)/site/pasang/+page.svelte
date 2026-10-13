<script lang="ts">
	import { canonicalSiteOrigin } from '#lib/shared/hosts';
	import { msg } from '#lib/shared/i18n';
	import { qrMatrix, qrPath } from '#lib/shared/qr';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';

	/**
	 * The install guide (FN-13's content, public since FN-32): static, so it shows both platforms; the app's
	 * /pengaturan/instal keeps only what needs the app's own origin (the browser's install prompt) and links here.
	 */
	const { tr, locale } = useI18n();

	const SECTIONS = [
		{
			title: msg('iPhone dan iPad (Safari)'),
			steps: [
				msg('Buka aplikasinya di Safari.'),
				msg('Ketuk tombol Bagikan (kotak dengan panah ke atas).'),
				msg('Pilih Tambah ke Layar Utama.'),
				msg('Pastikan Buka sebagai App Web aktif, lalu ketuk Tambah.')
			]
		},
		{
			title: msg('Android (Chrome)'),
			steps: [
				msg('Buka aplikasinya di Chrome.'),
				msg('Ketuk menu ⋮ di pojok kanan atas.'),
				msg('Pilih Instal aplikasi atau Tambahkan ke layar utama.'),
				msg('Ketuk Instal.')
			]
		}
	];

	// Drawn here at build time: no QR service is ever called (no request, no CSP change). It opens this guide
	// on the canonical site host, where the phone then follows the steps above.
	const matrix = qrMatrix(`${canonicalSiteOrigin()}${localizedSitePath(locale, '/pasang')}`);
	const qr = { size: matrix.length + 8, path: qrPath(matrix) };
</script>

<SiteHead
	title={tr('Pasang aplikasi')}
	description={tr(
		'Pasang aplikasi ke layar utama agar terbuka seperti aplikasi biasa, tanpa toko aplikasi. Pembaruan masuk sendiri.'
	)}
	path="/pasang"
/>
<article class="guide">
	<h1>{tr('Pasang aplikasi')}</h1>
	<p class="intro">
		{tr(
			'Pasang aplikasi ke layar utama agar terbuka seperti aplikasi biasa, tanpa toko aplikasi. Pembaruan masuk sendiri.'
		)}
	</p>
	<a class="open" href={localizedSitePath(locale, '/mulai')}>{tr('Buka aplikasi')}</a>

	{#each SECTIONS as section, i (i)}
		<section class="steps" aria-labelledby="steps-{i}">
			<h2 id="steps-{i}">{tr(section.title)}</h2>
			<ol>
				{#each section.steps as step, j (j)}
					<li>{tr(step)}</li>
				{/each}
			</ol>
		</section>
	{/each}

	<p class="note">
		{tr(
			'Dibuka dari Instagram, TikTok atau aplikasi chat? Buka dulu di Safari atau Chrome: browser di dalam aplikasi lain tidak bisa memasang aplikasi.'
		)}
	</p>

	<section class="steps qr-section" aria-labelledby="qr-title">
		<h2 id="qr-title">{tr('Buka di ponsel')}</h2>
		<p class="note">
			{tr('Pindai kode ini dengan kamera ponsel untuk membuka panduan ini di ponselmu.')}
		</p>
		<svg
			class="qr"
			viewBox="0 0 {qr.size} {qr.size}"
			role="img"
			aria-label={tr('Kode QR ke panduan pemasangan')}
			shape-rendering="crispEdges"
		>
			<rect width={qr.size} height={qr.size} fill="#ffffff" />
			<path d={qr.path} fill="#000000" />
		</svg>
		<p class="note">
			{tr(
				'Di Chrome atau Edge di komputer, kamu juga bisa memasang lewat ikon pasang di kolom alamat.'
			)}
		</p>
	</section>
</article>

<style>
	.guide {
		max-width: 680px;
		padding: 48px 0 0;
	}
	h1 {
		margin: 0;
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.intro {
		margin: 8px 0 16px;
		color: var(--muted);
	}
	.open {
		display: inline-flex;
		align-items: center;
		min-height: 52px;
		padding: 0 24px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
		text-decoration: none;
	}
	.steps {
		margin-top: 28px;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 19px;
		font-weight: 600;
	}
	ol {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 14px 16px 14px 36px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.note {
		margin: 12px 0 0;
		font-size: 15px;
		color: var(--muted);
	}
	/* The code stays black on white in both themes: scanners need the contrast and the quiet zone. */
	.qr {
		display: block;
		width: 200px;
		height: 200px;
		margin-top: 12px;
		border-radius: var(--r-s);
	}
	/* A phone does not need a code to reach the page it is already showing. */
	@media (pointer: coarse) and (max-width: 1023px) {
		.qr-section {
			display: none;
		}
	}
</style>
