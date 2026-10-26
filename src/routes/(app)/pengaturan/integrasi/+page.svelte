<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { AI_KEY_TEST_LABELS, type AiKeyProvider } from '#lib/shared/ai-keys';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	const PROVIDER_NAMES: Record<AiKeyProvider, string> = { anthropic: 'Anthropic' };

	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);
	let deleteOpen = $state(false);
	let deleteSummary = $state<HTMLElement>();

	/** Nothing is shown as saved before the server answers; the page data is reloaded from the server either way. */
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else await update({ reset: result.type === 'success' });
				busy = '';
				if (name === 'delete' && result.type === 'success') {
					// The row is gone: focus moves to the form that adds a key again.
					await tick();
					document.getElementById('ai-key')?.focus();
				}
			};
		};

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	/** "Batal" closes the confirm step and returns focus to "Hapus kunci". */
	function cancelDelete() {
		deleteOpen = false;
		deleteSummary?.focus();
	}

	const done = $derived(form && 'done' in form ? form.done : undefined);
	const tested = $derived(form && 'tested' in form ? form.tested : undefined);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const when = (ms: number) => formatDateTimeWib(ms, locale);
	const stored = $derived(data.keys[0]);
</script>

<svelte:head><title>{tr('Integrasi AI')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Integrasi AI')}
	subtitle={tr('Kunci Anthropic milikmu sendiri')}
/>

<p class="intro">
	{tr(
		'Fitur AI (baca struk, mutasi, asisten Tanya) memakai kunci Anthropic milikmu. Biayanya ditagih Anthropic ke akunmu, bukan lewat aplikasi ini.'
	)}
</p>
<p class="intro">
	{tr(
		'Kunci disimpan terenkripsi dan tidak pernah ditampilkan lagi, hanya 4 karakter terakhirnya.'
	)}
</p>
<p class="links">
	<a href="https://console.anthropic.com/settings/keys" rel="noopener noreferrer"
		>{tr('Buat kunci di console.anthropic.com')}</a
	>
</p>

{#if done === 'created'}<p class="ok" role="status">{tr('Kunci disimpan.')}</p>{/if}
{#if done === 'replaced'}<p class="ok" role="status">
		{tr('Kunci diganti. Tes koneksi untuk memastikan kunci baru bekerja.')}
	</p>{/if}
{#if done === 'removed'}<p class="ok" role="status">{tr('Kunci dihapus.')}</p>{/if}
{#if tested === 'ok'}<p class="ok" role="status">{tr(AI_KEY_TEST_LABELS.ok)}</p>{/if}
<FormBanner message={tested && tested !== 'ok' ? tr(AI_KEY_TEST_LABELS[tested]) : banner} />

{#if !data.configured}
	<section class="notice" aria-labelledby="not-configured-title">
		<h2 id="not-configured-title">{tr('Belum dikonfigurasi')}</h2>
		<p>
			{tr(
				'Penyimpanan kunci belum disiapkan di server ini, jadi kunci belum bisa ditambahkan atau diganti.'
			)}
		</p>
	</section>
{/if}

<section class="group" aria-labelledby="keys-title">
	<h2 id="keys-title">{tr('Kunci API')}</h2>
	{#if refreshing}
		<Skeleton rows={2} />
	{:else if data.loadError}
		<ErrorState text={tr(data.loadError)} onretry={retry} />
	{:else if !stored}
		<EmptyState
			text={tr(
				'Belum ada kunci API. Tambahkan kunci Anthropic agar fitur AI nanti bisa membaca struk, mutasi dan menjawab pertanyaanmu.'
			)}
		/>
	{:else}
		<GroupList>
			{#each data.keys as key (key.provider)}
				<GroupRow>
					<div class="key">
						<div class="line">
							<span class="name">{PROVIDER_NAMES[key.provider]}</span>
							<span class="num masked">•••• {key.lastFour}</span>
						</div>
						<span class="meta">
							{trf('Ditambahkan {waktu}', {
								waktu: when(key.createdAt)
							})}{#if key.updatedAt !== key.createdAt}
								· {trf('Diganti {waktu}', { waktu: when(key.updatedAt) })}{/if}
						</span>
						<span class="meta">
							{#if key.lastTestResult && key.lastTestedAt}
								<span
									class:good={key.lastTestResult === 'ok'}
									class:bad={key.lastTestResult !== 'ok'}
									>{tr(AI_KEY_TEST_LABELS[key.lastTestResult])}</span
								>
								· {trf('Terakhir dicoba {waktu}', { waktu: when(key.lastTestedAt) })}
							{:else}
								{tr('Belum pernah dicoba')}
							{/if}
						</span>
					</div>
				</GroupRow>
			{/each}
		</GroupList>
		<div class="actions">
			{#if data.testConfigured}
				<form method="POST" action="?/test" use:enhance={track('test')}>
					<Button type="submit" variant="secondary" full disabled={busy !== ''}>
						{busy === 'test' ? tr('Menguji koneksi…') : tr('Tes koneksi')}
					</Button>
				</form>
			{:else}
				<Button variant="secondary" full disabled describedby="test-unavailable">
					{tr('Belum dikonfigurasi')}
				</Button>
				<p class="meta" id="test-unavailable">
					{tr(
						'Tes koneksi belum dikonfigurasi di server ini. Kunci tetap bisa disimpan dan diganti.'
					)}
				</p>
			{/if}
			<details class="confirm" bind:open={deleteOpen}>
				<summary bind:this={deleteSummary}>{tr('Hapus kunci')}</summary>
				<form method="POST" action="?/delete" use:enhance={track('delete')}>
					<p>
						{tr(
							'Kunci dihapus dari aplikasi ini. Kunci itu sendiri tetap aktif di akun Anthropic-mu sampai kamu mencabutnya di sana.'
						)}
					</p>
					<div class="row">
						<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
							{busy === 'delete' ? tr('Menghapus…') : tr('Ya, hapus kunci')}
						</Button>
						<Button variant="ghost" size="sm" onclick={cancelDelete}>{tr('Batal')}</Button>
					</div>
				</form>
			</details>
		</div>
	{/if}
</section>

<section class="group" aria-labelledby="save-title">
	<h2 id="save-title">{stored ? tr('Ganti kunci') : tr('Tambahkan kunci Anthropic')}</h2>
	<form method="POST" action="?/save" class="save" use:enhance={track('save')}>
		<Field
			id="ai-key"
			name="key"
			type="password"
			label={tr('Kunci API Anthropic')}
			placeholder="sk-ant-…"
			hint={tr('Diawali “sk-ant-”. Tempel kuncinya di sini; kunci tidak akan ditampilkan lagi.')}
			minlength={data.minLength}
			maxlength={data.maxLength}
			autocomplete="off"
			spellcheck="false"
			required
			disabled={!data.configured}
		/>
		<Button type="submit" variant="primary" full disabled={busy !== '' || !data.configured}>
			{busy === 'save' ? tr('Menyimpan…') : stored ? tr('Ganti kunci') : tr('Simpan kunci')}
		</Button>
	</form>
</section>

<style>
	.intro {
		margin: 4px 0 8px;
		color: var(--muted);
		font-size: 15px;
	}
	.links {
		margin: 0 0 16px;
	}
	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		/* The app's one standalone text link (app.css .text-link): ink, underlined, never blue or bold. */
		color: var(--ink-2);
		font-size: 15px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
		overflow-wrap: anywhere;
	}
	.group {
		display: grid;
		gap: 8px;
		margin-top: 24px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.notice {
		display: grid;
		gap: 4px;
		margin-top: 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.notice h2 {
		font-size: 15px;
	}
	.notice p {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.key {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.masked {
		font-family: var(--font-mono);
		font-size: 14px;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.good {
		color: var(--money-in);
		font-weight: 600;
	}
	.bad {
		color: var(--money-up);
		font-weight: 600;
	}
	.actions {
		display: grid;
		gap: 8px;
		margin-top: 8px;
	}
	.actions .meta {
		margin: 0;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 0 0 8px;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.ok {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.save {
		display: grid;
		gap: 16px;
	}
</style>
