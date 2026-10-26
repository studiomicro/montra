<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { Module } from '#lib/shared/feature-flags';
	import { useI18n } from '#lib/ui/i18n-context';
	import FeatureChip from '#lib/ui/kit/FeatureChip.svelte';
	import ToggleRow from '#lib/ui/kit/ToggleRow.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { fiturSheet } from './fitur.svelte';
	import { featureItem, MODULE_NAV } from './nav';
	import Sheet from './Sheet.svelte';

	/**
	 * The Fitur sheet (APP_PARITY § 3, "Jelajahi fitur"): one switch per feature module with a page (FN-12). Each
	 * switch posts the same per-user `setFlag` action as /pengaturan/fitur; the switch shows the stored state
	 * again once the server confirmed the write and the layout (sidebar) reloaded. `hidden` is the layout's list.
	 * Under the switches, the enabled features' pages (the phone's way to them; the sidebar lists them too).
	 */
	let { hidden }: { hidden: readonly Module[] } = $props();
	const { tr } = useI18n();

	/** The switchable modules with a page, in the sheet's order; glyph, hue, label and hint from nav.ts (FN-54). */
	const ROWS = (['kekayaan', 'barang', 'langganan', 'koleksi', 'patungan'] as const).flatMap(
		(module) => {
			const item = featureItem(MODULE_NAV[module] ?? '');
			return item ? [{ module, item }] : [];
		}
	);
	const ALUR_UANG = featureItem('/alur-uang');

	/** The module being saved (null when none): every switch is disabled meanwhile. */
	let busy = $state<Module | null>(null);
	let message = $state<{ ok: boolean; text: string } | null>(null);
	/** What a switch shows: the stored flag, except for the one being saved (the user's new choice). */
	let pending = $state<{ module: Module; enabled: boolean } | null>(null);
	const enabled = (module: Module) =>
		pending?.module === module ? pending.enabled : !hidden.includes(module);

	const save =
		(module: Module): SubmitFunction =>
		({ formData }) => {
			busy = module;
			message = null;
			pending = { module, enabled: formData.get('enabled') === 'on' };
			return async ({ result }) => {
				if (result.type === 'success') {
					await invalidateAll();
					message = { ok: true, text: tr('Perubahan disimpan.') };
				} else if (result.type === 'failure' && typeof result.data?.error === 'string') {
					message = { ok: false, text: tr(result.data.error) };
				} else {
					message = {
						ok: false,
						text: tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.')
					};
				}
				pending = null;
				busy = null;
			};
		};

	function onclose() {
		message = null;
	}
</script>

<Sheet bind:open={fiturSheet.open} title={tr('Fitur')} {onclose}>
	{#if fiturSheet.open}
		<p class="intro">
			{tr(
				'Nyalakan fitur yang kamu pakai agar muncul di menu. Mematikannya hanya menyembunyikan menu: data dan angkanya tetap dihitung.'
			)}
		</p>
		{#if message}
			<p class="message" class:ok={message.ok} role={message.ok ? 'status' : 'alert'}>
				{message.text}
			</p>
		{/if}
		<ul class="rows">
			{#each ROWS as row (row.module)}
				<li>
					<form method="POST" action="/pengaturan/fitur?/setFlag" use:enhance={save(row.module)}>
						<input type="hidden" name="module" value={row.module} />
						<ToggleRow
							icon={row.item.icon}
							tone={row.item.tone}
							name="enabled"
							label={tr(row.item.label)}
							hint={busy === row.module ? tr('Menyimpan…') : tr(row.item.hint ?? '')}
							checked={enabled(row.module)}
							disabled={busy !== null}
							onchange={(event) => event.currentTarget.form?.requestSubmit()}
						/>
					</form>
				</li>
			{/each}
		</ul>
		<h3 class="sub">{tr('Buka fitur')}</h3>
		<ul class="rows">
			<!-- FN-35: Alur uang is a page for everyone, not a module with a switch (owner decision B). -->
			{#if ALUR_UANG}
				<li>
					<a class="link" href={ALUR_UANG.href} onclick={() => (fiturSheet.open = false)}>
						<FeatureChip icon={ALUR_UANG.icon} tone={ALUR_UANG.tone} size={40} />
						<span class="link-label"
							>{tr(ALUR_UANG.label)}<span class="link-hint">{tr(ALUR_UANG.hint ?? '')}</span></span
						>
						<Icon name="chevron-right" size={18} />
					</a>
				</li>
			{/if}
			{#each ROWS.filter((row) => !hidden.includes(row.module)) as row (row.module)}
				<li>
					<a class="link" href={row.item.href} onclick={() => (fiturSheet.open = false)}>
						<FeatureChip icon={row.item.icon} tone={row.item.tone} size={40} />
						<span class="link-label">{tr(row.item.label)}</span>
						<Icon name="chevron-right" size={18} />
					</a>
				</li>
			{/each}
		</ul>
		<a class="more" href="/pengaturan/fitur" onclick={() => (fiturSheet.open = false)}>
			{tr('Semua pengaturan fitur')}
		</a>
	{/if}
</Sheet>

<style>
	.intro {
		margin: 0 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	li + li {
		border-top: 1px solid var(--line);
	}
	.message {
		margin: 0 0 12px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
	}
	.message.ok {
		color: var(--money-in);
	}
	.sub {
		margin: 20px 0 8px;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.link {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		padding: 8px 16px;
		color: var(--ink);
		text-decoration: none;
	}
	.link:hover {
		background: var(--panel-2);
	}
	.link-label {
		display: grid;
		flex: 1;
		font-size: 15px;
		font-weight: 600;
	}
	.link-hint {
		color: var(--muted);
		font-size: 13px;
		font-weight: 400;
	}
	.more {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 8px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
