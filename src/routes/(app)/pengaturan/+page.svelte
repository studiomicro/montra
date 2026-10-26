<script lang="ts">
	import { hasProLook } from '#lib/shared/pro-look';
	import { useI18n } from '#lib/ui/i18n-context';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import InitialsTile from '#lib/ui/kit/InitialsTile.svelte';
	import ProBadge from '#lib/ui/kit/ProBadge.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	const { tr } = useI18n();
	const account = $derived(data.shell.account);
</script>

<svelte:head><title>{tr('Pengaturan')}</title></svelte:head>
<ScreenTitle title={tr('Pengaturan')} subtitle={account?.email} />

<!-- FN-46: who is signed in, like the sidebar's account row, with the Pro badge while a paid plan is in force. -->
{#if account}
	<div class="who" data-testid="settings-account">
		<InitialsTile name={account.name || account.email} size={44} round />
		<span class="who-name">{account.name || tr('Akun')}</span>
		{#if hasProLook(data.shell.plan)}<ProBadge />{/if}
	</div>
{/if}

<section class="group" aria-labelledby="settings-account">
	<h2 id="settings-account">{tr('Akun')}</h2>
	<GroupList>
		<IconRow
			icon="user"
			title={tr('Akun')}
			hint={tr('Nama, kata sandi dan kunci akun')}
			href="/pengaturan/akun"
		/>
		<IconRow
			icon="key"
			title={tr('Passkey')}
			hint={tr('Masuk dengan sidik jari, wajah atau PIN perangkat')}
			href="/pengaturan/akun/passkey"
		/>
		<IconRow
			icon="star"
			title={tr('Paket & kredit')}
			hint={tr('Paket, kredit dan voucher')}
			href="/pengaturan/paket"
		/>
		<IconRow
			icon="gauge"
			title={tr('Pemakaian')}
			hint={tr('Kredit terpakai dan batas pakai')}
			href="/pengaturan/pemakaian"
		/>
		<IconRow
			icon="people"
			title={tr('Ruang')}
			hint={tr('Ruang bersama dan undangan')}
			href="/ruang"
		/>
	</GroupList>
</section>

<section class="group" aria-labelledby="settings-app">
	<h2 id="settings-app">{tr('Aplikasi')}</h2>
	<GroupList>
		<IconRow
			icon="grid"
			title={tr('Kategori')}
			hint={tr('Pengeluaran dan pemasukan')}
			href="/pengaturan/kategori"
		/>
		<IconRow
			icon="receipt"
			title={tr('Pedagang & aturan')}
			hint={tr('Diingat dari koreksimu')}
			href="/pengaturan/pedagang"
		/>
		<IconRow
			icon="list"
			title={tr('Fitur')}
			hint={tr('Tampilkan atau sembunyikan menu')}
			href="/pengaturan/fitur"
		/>
		<IconRow
			icon="sun"
			title={tr('Tampilan')}
			hint={tr('Terang, gelap atau hitam-putih')}
			href="/pengaturan/tampilan"
		/>
		<IconRow
			icon="bell"
			title={tr('Notifikasi')}
			hint={tr('Pengingat dan notifikasi')}
			href="/pengaturan/notifikasi"
		/>
		<IconRow
			icon="link"
			title={tr('Aplikasi terhubung')}
			hint={tr('Sambungan ke aplikasi lain')}
			href="/pengaturan/aplikasi"
		/>
		<IconRow
			icon="bolt"
			title={tr('Integrasi AI')}
			hint={tr('Kunci Anthropic milikmu sendiri')}
			href="/pengaturan/integrasi"
		/>
		<IconRow
			icon="sparkle"
			title={tr('Ingatan asisten')}
			hint={tr('Percakapanmu dengan Tanya')}
			href="/pengaturan/ingatan"
		/>
		<IconRow
			icon="code"
			title={tr('API')}
			hint={tr('Token untuk skripmu')}
			href="/pengaturan/api"
		/>
		<IconRow
			icon="arrow-down"
			title={tr('Pasang aplikasi')}
			hint={tr('Buka dari layar utama')}
			href="/pengaturan/instal"
		/>
		<IconRow
			icon="info"
			title={tr('Tentang')}
			hint={tr('Versi, pembaruan dan yang baru')}
			href="/pengaturan/tentang"
		/>
	</GroupList>
</section>

<section class="group" aria-labelledby="settings-privacy">
	<h2 id="settings-privacy">{tr('Privasi')}</h2>
	<GroupList>
		<IconRow
			icon="lock"
			title={tr('Privasi')}
			hint={tr('Statistik, ekspor, persetujuan')}
			href="/pengaturan/privasi"
		/>
	</GroupList>
</section>

<style>
	.who {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		margin-top: 8px;
	}
	.who-name {
		overflow: hidden;
		min-width: 0;
		font-size: 17px;
		font-weight: 700;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.group {
		display: grid;
		gap: 8px;
		margin-top: 24px;
	}
	h2 {
		margin: 0 4px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
</style>
