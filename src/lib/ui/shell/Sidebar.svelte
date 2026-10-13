<script lang="ts">
	import { page } from '$app/state';
	import type { Module } from '#lib/shared/feature-flags';
	import { hasProLook } from '#lib/shared/pro-look';
	import { appName } from '#lib/shared/sanity';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import IconButton from '#lib/ui/kit/IconButton.svelte';
	import InitialsTile from '#lib/ui/kit/InitialsTile.svelte';
	import ProBadge from '#lib/ui/kit/ProBadge.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import { openFiturSheet } from './fitur.svelte';
	import { activeHref, isActive, visibleSections } from './nav';
	import type { ShellData } from './shell-data';

	let {
		onadd,
		hidden = [],
		shell
	}: { onadd: () => void; hidden?: readonly Module[]; shell: ShellData } = $props();
	const { tr, trf } = useI18n();
	const sections = $derived(visibleSections(hidden));
	const current = $derived(
		activeHref(
			sections.flatMap((s) => s.items),
			page.url.pathname
		)
	);
	const spaceName = $derived(
		shell.space ? (shell.space.kind === 'personal' ? tr('Pribadi') : shell.space.name) : ''
	);
	const spaceLine = $derived(
		!shell.space
			? ''
			: shell.space.kind === 'personal'
				? tr('Ruang pribadi')
				: trf('Ruang bersama · {peran}', {
						peran: shell.space.role === 'owner' ? tr('Pemilik') : tr('Anggota')
					})
	);
</script>

<nav class="sidebar" aria-label={tr('Navigasi utama')}>
	<div class="top">
		<a class="brand" href="/">{appName()}</a>
		<div class="tools">
			<IconButton icon="bell" label={tr('Notifikasi')} href="/kotak-masuk/notifikasi" />
			<ThemeToggle />
			<IconButton icon="gear" label={tr('Pengaturan')} href="/pengaturan" />
		</div>
	</div>

	<!-- The nav scrolls in its own region above the plan card, Tambah and the account, so no item hides under them. -->
	<div class="scroll">
		{#if shell.space}
			<a
				class="card space"
				href="/ruang"
				aria-label={trf('Ganti ruang: {ruang}', { ruang: spaceName })}
			>
				<InitialsTile name={spaceName} size={36} round />
				<span class="card-text">
					<span class="card-title">{spaceName}</span>
					<span class="card-line">{spaceLine}</span>
				</span>
				<Icon name="chevron-updown" size={18} />
			</a>
		{/if}

		<!-- FN-22: the assistant; /tanya itself says when it cannot answer on this server or without a key. -->
		<a
			href="/tanya"
			class="ask"
			aria-current={isActive('/tanya', page.url.pathname) ? 'page' : undefined}
		>
			<Icon name="sparkle" size={18} />
			<span>{trf('Tanya {app}…', { app: appName() })}</span>
		</a>

		{#each sections as section (section.title)}
			<p class="section" id="nav-{section.title}">{tr(section.title)}</p>
			<ul aria-labelledby="nav-{section.title}">
				{#each section.items as item (item.href)}
					<li>
						<a
							href={item.href}
							class="item"
							aria-current={current === item.href ? 'page' : undefined}
							aria-haspopup={item.sheet ? 'dialog' : undefined}
							onclick={item.sheet ? openFiturSheet : undefined}
						>
							<Icon name={item.icon} size={20} />
							<span>{tr(item.label)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/each}
	</div>

	<div class="bottom glass glass-soft">
		<!-- The Pro upsell is for Gratis only; a paid plan manages its plan and vouchers in Pengaturan › Paket. -->
		{#if !hasProLook(shell.plan)}
			<a class="card plan" href="/pengaturan/paket">
				<span class="plan-icon"><Icon name="sparkle" size={18} /></span>
				<span class="card-text">
					<span class="card-title">{appName()} {tr('Pro')}</span>
					<span class="card-line">{tr('Punya voucher?')}</span>
				</span>
				<Icon name="chevron-right" size={18} />
			</a>
		{/if}
		<button type="button" class="add" aria-haspopup="dialog" aria-keyshortcuts="n" onclick={onadd}>
			<Icon name="plus" size={18} />
			<span>{tr('Tambah transaksi')}</span>
			<kbd aria-hidden="true">N</kbd>
		</button>
		{#if shell.account}
			<a class="account" href="/pengaturan/akun">
				<InitialsTile name={shell.account.name || shell.account.email} size={36} round />
				<span class="card-text">
					<span class="name-line">
						<span class="card-title">{shell.account.name || tr('Akun')}</span>
						{#if hasProLook(shell.plan)}<ProBadge />{/if}
					</span>
					<span class="card-line">{shell.account.email}</span>
				</span>
			</a>
		{/if}
	</div>
</nav>

<style>
	.sidebar {
		display: none;
	}
	@media (min-width: 1024px) {
		.sidebar {
			position: sticky;
			top: var(--sai-top);
			display: flex;
			flex: none;
			flex-direction: column;
			gap: 4px;
			width: 248px;
			height: calc(100dvh - var(--sai-top));
			padding: 20px 12px calc(16px + var(--sai-bottom)) max(12px, var(--sai-left));
			overflow: hidden;
			background: var(--bg);
		}
	}
	/* min-height: 0 lets the flex child shrink below its content, so it scrolls instead of pushing the block below. */
	.scroll {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 4px;
		min-height: 0;
		padding-bottom: 24px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.scroll > :global(*) {
		flex: none;
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 0 4px 12px;
	}
	.brand {
		color: var(--ink);
		font-size: 19px;
		font-weight: 800;
		letter-spacing: -0.02em;
		text-decoration: none;
	}
	.tools {
		display: flex;
		gap: 4px;
	}
	.card,
	.account {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 56px;
		padding: 8px 12px 8px 10px;
		border-radius: var(--r-m);
		color: var(--ink);
		text-decoration: none;
	}
	.card {
		background: var(--panel);
	}
	.card:hover {
		background: var(--panel-2);
	}
	.card-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.card-title {
		overflow: hidden;
		font-size: 14px;
		font-weight: 700;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* FN-46: the name and the Pro badge on one line; a long name is cut, never the badge. */
	.name-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.card-line {
		overflow: hidden;
		font-size: 12px;
		color: var(--muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.ask {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		margin-top: 8px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--muted);
		font: inherit;
		font-size: 14px;
		text-decoration: none;
	}
	.ask[aria-current='page'] {
		color: var(--ink);
		font-weight: 600;
	}
	.section {
		margin: 12px 12px 2px;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 38px;
		padding: 0 12px;
		border-radius: var(--r-pill);
		color: var(--ink-2);
		font-size: 15px;
		font-weight: 500;
		text-decoration: none;
	}
	.item:hover {
		background: var(--panel);
	}
	.item[aria-current='page'] {
		background: var(--panel);
		color: var(--ink);
		font-weight: 700;
	}
	/* The plan card, Tambah and the account stay in view below the scrolling nav (soft glass). */
	.bottom {
		position: relative;
		flex: none;
		display: grid;
		/* minmax(0, …): a long e-mail is cut with an ellipsis, never widening the column. */
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		padding: 12px 0 0;
	}
	.plan-icon {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.add {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
	}
	.add:active {
		transform: scale(var(--press-scale));
	}
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 20px;
		height: 20px;
		padding: 0 5px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--bg) 20%, transparent);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
	}
	.account:hover {
		background: var(--panel);
	}
	/* The nav scrolls above the bottom block: fade its edge so the cut reads as "more below". */
	.bottom::before {
		content: '';
		position: absolute;
		right: 0;
		bottom: 100%;
		left: 0;
		height: 24px;
		background: linear-gradient(to bottom, transparent, var(--bg));
		pointer-events: none;
	}
	/*
	 * Short windows (≤ 940 px high): compact rows so the sections fit without scrolling at ~900 px; below that
	 * the nav region scrolls above the bottom block, whose cards keep their second line ("Punya voucher?").
	 * Touch targets stay ≥ 44 px on coarse pointers (the sidebar only shows from 1024 px wide, which is a mouse
	 * layout in practice).
	 */
	@media (min-width: 1024px) and (max-height: 940px) and (pointer: fine) {
		.sidebar {
			gap: 2px;
			padding-top: 14px;
		}
		.scroll {
			gap: 2px;
		}
		.top {
			margin-bottom: 6px;
		}
		.card,
		.account {
			min-height: 46px;
			padding-top: 4px;
			padding-bottom: 4px;
		}
		.ask {
			min-height: 38px;
			margin-top: 4px;
		}
		.section {
			margin: 8px 12px 0;
		}
		.item {
			min-height: 32px;
			font-size: 14px;
		}
		.bottom {
			gap: 6px;
			padding-top: 10px;
		}
		.add {
			min-height: 40px;
		}
	}
	@media (min-width: 1024px) and (max-height: 820px) and (pointer: fine) {
		.item {
			min-height: 30px;
		}
		.card,
		.account {
			min-height: 40px;
		}
	}
</style>
