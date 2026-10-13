<script lang="ts">
	import { API_SCOPE_LABELS, isApiTokenScope } from '#lib/shared/api-tokens';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	const { tr } = useI18n();
	const ref = $derived(data.reference);

	const scopeLabel = (scope: string) =>
		isApiTokenScope(scope) ? tr(API_SCOPE_LABELS[scope]) : scope;

	/** An index link opens the endpoint it points to (the endpoints are collapsed). */
	function reveal(id: string) {
		const target = document.getElementById(`ep-${id}`)?.closest('details');
		if (target) target.open = true;
	}

	const listExample = $derived(
		`curl -H "Authorization: Bearer fin_…" \\\n  "${data.origin}/api/v1/transactions?space_id=<space_id>&from=2026-10-01&to=2026-10-31"`
	);
	const createExample = $derived(
		`curl -X POST -H "Authorization: Bearer fin_…" \\\n  -H "Content-Type: application/json" \\\n  "${data.origin}/api/v1/transactions?space_id=<space_id>" \\\n  -d '{"client_id":"<uuid>","type":"expense","amount_minor":2500000,\n       "wallet_id":"<wallet_id>","category_id":"<category_id>",\n       "title":"Kopi","occurred_on":"2026-10-08"}'`
	);
</script>

<svelte:head><title>{tr('Dokumentasi API')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/api', label: tr('Kembali ke API') }}
	title={tr('Dokumentasi API')}
	subtitle="/api/v1"
>
	{#snippet actions()}
		<Button href="/pengaturan/api" variant="secondary" size="sm">{tr('Kelola token')}</Button>
		<Button href="/api/v1/openapi.json" variant="secondary" size="sm">OpenAPI</Button>
	{/snippet}
</ScreenTitle>

<section class="panel" aria-labelledby="doc-intro">
	<h2 id="doc-intro">{tr('Ringkasan')}</h2>
	<p>{ref.intro}</p>
	<p>
		{tr(
			'Tanggal transaksi (occurred_on) selalu tanggal kalender WIB. Data demo ditampilkan tetapi tidak pernah dihitung dalam total.'
		)}
	</p>
</section>

<section class="panel" aria-labelledby="doc-auth">
	<h2 id="doc-auth">{tr('Autentikasi')}</h2>
	<p>{ref.auth}</p>
	<p>{ref.limits}</p>
</section>

<section class="panel" aria-labelledby="doc-errors">
	<h2 id="doc-errors">{tr('Kesalahan')}</h2>
	<p>{ref.errors}</p>
</section>

<section class="panel" aria-labelledby="doc-examples">
	<h2 id="doc-examples">{tr('Contoh')}</h2>
	<h3>{tr('Daftar transaksi bulan Oktober')}</h3>
	<pre><code>{listExample}</code></pre>
	<h3>{tr('Catat pengeluaran Rp 25.000')}</h3>
	<pre><code>{createExample}</code></pre>
	<p class="meta">
		{tr('amount_minor 2500000 = Rp 25.000,00: rupiah disimpan dalam sen.')}
	</p>
</section>

<h2 class="endpoints-title">{tr('Endpoint')}</h2>
<nav class="panel index" aria-label={tr('Daftar endpoint')}>
	<ul>
		{#each ref.endpoints as endpoint (endpoint.id)}
			<li>
				<a href="#ep-{endpoint.id}" onclick={() => reveal(endpoint.id)}>
					<span class="method">{endpoint.method}</span>
					<code>{endpoint.path}</code>
				</a>
			</li>
		{/each}
	</ul>
</nav>
{#each ref.endpoints as endpoint (endpoint.id)}
	<details class="panel endpoint">
		<summary>
			<h3 id="ep-{endpoint.id}" class="signature">
				<span class="method">{endpoint.method}</span>
				<code>{endpoint.path}</code>
			</h3>
		</summary>
		<p>{endpoint.summary}</p>
		<p class="meta">
			<Badge>{scopeLabel(endpoint.scope)}</Badge>
		</p>
		{#if endpoint.fields.length > 0}
			<h4>{tr('Parameter')}</h4>
			<ul class="fields">
				{#each endpoint.fields as field (field.where + field.name)}
					<li>
						<span class="field-head">
							<code>{field.name}</code>
							<span class="meta">{field.where} · {field.type}</span>
							{#if field.required}<span class="required">{tr('wajib')}</span>{/if}
						</span>
						{#if field.description}<span class="meta">{field.description}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<h4>{tr('Respons')}</h4>
		<ul class="statuses">
			{#each endpoint.statuses as status (status.code)}
				<li><code>{status.code}</code> <span class="meta">{status.description}</span></li>
			{/each}
		</ul>
	</details>
{/each}

<style>
	.panel {
		display: grid;
		gap: 8px;
		margin-bottom: 16px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.endpoints-title {
		margin: 24px 0 12px;
	}
	.index ul {
		display: grid;
		gap: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.index a {
		display: flex;
		flex-wrap: nowrap;
		align-items: baseline;
		gap: 8px;
		min-height: 44px;
		padding: 10px 0;
		color: var(--ink);
	}
	/* Collapsed by default: a phone shows the signature rows, not 28,000 px of parameters. */
	.endpoint summary {
		cursor: pointer;
		list-style: none;
	}
	.endpoint summary::-webkit-details-marker {
		display: none;
	}
	/* A <details> stays a block box; its children are spaced by hand. */
	.endpoint {
		display: block;
	}
	.endpoint > :not(summary) {
		margin-top: 8px;
	}
	h3 {
		margin: 4px 0 0;
		font-size: 15px;
		font-weight: 600;
	}
	h4 {
		margin: 8px 0 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	pre {
		margin: 0;
		padding: 12px;
		border-radius: var(--r-s);
		background: var(--bg);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 13px;
	}
	code {
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
	}
	.signature {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}
	.method {
		font-size: 13px;
		font-weight: 800;
	}
	.fields,
	.statuses {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.statuses li {
		line-height: 1.4;
	}
	.fields li {
		display: grid;
		gap: 2px;
	}
	.field-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
	}
	.required {
		font-size: 12px;
		font-weight: 600;
	}
</style>
