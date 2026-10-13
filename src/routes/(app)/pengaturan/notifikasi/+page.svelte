<script lang="ts">
	import { onMount } from 'svelte';
	import { deserialize, enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { base64urlDecode } from '#lib/shared/base64url';
	import { msg } from '#lib/shared/i18n';
	import {
		CLOSE_REMINDER_HOURS,
		NOTIFICATION_KIND_LABELS,
		NOTIFICATION_KINDS,
		type NotificationKind
	} from '#lib/shared/notifications';
	import { detectIosBrowser, detectMobileOs } from '#lib/shared/user-agent';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import Toggle from '#lib/ui/kit/Toggle.svelte';
	import { isStandalone } from '#lib/ui/pwa/install.svelte';
	import { endpointHash, hasPushApi, pushSupport, type PushSupport } from '#lib/ui/pwa/push';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();

	/** Resolved in the browser on mount; the server cannot know this device's permission or subscription. */
	let phase = $state<'loading' | 'ready'>('loading');
	let support = $state<PushSupport>('unsupported');
	let permission = $state<NotificationPermission>('default');
	/** SHA-256 of this browser's own push endpoint, null when it holds no subscription. */
	let browserHash = $state<string | null>(null);
	let busy = $state(false);
	let actionError = $state('');
	/** What a failed attempt was, so "Coba lagi" repeats it. */
	let lastAttempt = $state<'on' | 'off' | null>(null);
	let testing = $state(false);

	/** On only when this browser holds a subscription AND the server has it stored for this user. */
	const on = $derived(browserHash !== null && data.endpointHashes.includes(browserHash));

	async function registration() {
		return navigator.serviceWorker.getRegistration();
	}

	async function readDeviceState() {
		const hasApi = hasPushApi();
		support = pushSupport({
			os: detectMobileOs(navigator.userAgent, navigator.maxTouchPoints),
			iosBrowser: detectIosBrowser(navigator.userAgent, navigator.maxTouchPoints),
			standalone: isStandalone(),
			hasPushApi: hasApi
		});
		if (support !== 'supported') return;
		permission = Notification.permission;
		const sub = await (await registration())?.pushManager.getSubscription();
		browserHash = sub ? await endpointHash(sub.endpoint) : null;
	}

	onMount(() => {
		readDeviceState()
			.catch((e) => console.warn('notifikasi: device state', e))
			.finally(() => (phase = 'ready'));
	});

	/** Posts one action of this page with `fields`; the parsed ActionResult. */
	async function post(action: 'subscribe' | 'unsubscribe', fields: Record<string, string>) {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		const response = await fetch(`?/${action}`, {
			method: 'POST',
			body,
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
		return deserialize(await response.text());
	}

	const failureText = (result: Awaited<ReturnType<typeof post>>) =>
		result.type === 'failure' && typeof result.data?.error === 'string'
			? tr(result.data.error)
			: tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');

	async function turnOn() {
		// Never prompts unless the server has VAPID keys (the switch is disabled then anyway).
		if (!data.configured || !data.publicKey) return;
		const key = base64urlDecode(data.publicKey);
		if (!key) return;
		permission = await Notification.requestPermission();
		if (permission !== 'granted') {
			actionError =
				permission === 'denied'
					? tr('Notifikasi diblokir di pengaturan browser. Izinkan dulu, lalu coba lagi.')
					: tr('Izin notifikasi belum diberikan.');
			return;
		}
		const reg = await registration();
		if (!reg) {
			actionError = tr('Aplikasi belum siap di browser ini. Muat ulang halaman, lalu coba lagi.');
			return;
		}
		let sub = await reg.pushManager.getSubscription();
		if (!sub)
			sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		const json = sub.toJSON();
		const result = await post('subscribe', {
			endpoint: sub.endpoint,
			p256dh: json.keys?.p256dh ?? '',
			auth: json.keys?.auth ?? ''
		});
		if (result.type !== 'success') {
			// The server did not store it: the browser must not keep a subscription nobody will use.
			await sub.unsubscribe().catch(() => {});
			browserHash = null;
			actionError = failureText(result);
			return;
		}
		browserHash = await endpointHash(sub.endpoint);
		await invalidateAll();
	}

	async function turnOff() {
		const sub = await (await registration())?.pushManager.getSubscription();
		if (sub) {
			const result = await post('unsubscribe', { endpoint: sub.endpoint });
			if (result.type !== 'success') {
				actionError = failureText(result);
				return;
			}
			await sub.unsubscribe();
		}
		browserHash = null;
		await invalidateAll();
	}

	async function attempt(want: 'on' | 'off') {
		busy = true;
		actionError = '';
		lastAttempt = want;
		try {
			await (want === 'on' ? turnOn() : turnOff());
		} catch (e) {
			console.warn('notifikasi: toggle failed', e);
			actionError = tr('Notifikasi tidak bisa diubah di browser ini. Coba lagi.');
		} finally {
			busy = false;
		}
	}

	function onchange(event: Event & { currentTarget: HTMLInputElement }) {
		const want = event.currentTarget.checked ? 'on' : 'off';
		// The switch shows the confirmed state only: it flips once the browser and the server both agree.
		event.currentTarget.checked = on;
		void attempt(want);
	}

	const PERMISSION_LABELS: Record<NotificationPermission, string> = {
		default: msg('Belum ditanya'),
		granted: msg('Diizinkan'),
		denied: msg('Diblokir')
	};
	const hint = $derived(
		busy
			? tr('Menyimpan…')
			: permission === 'denied'
				? tr('Diblokir di pengaturan browser')
				: on
					? tr('Aktif di perangkat ini')
					: tr('Mati di perangkat ini')
	);
	// FN-24 kinds: what the switches show is the server's state; a flipped switch submits at once and shows
	// the stored value once the write is confirmed and reloaded (the /pengaturan/fitur pattern).
	let shownPrefs = $derived({ ...data.prefs });
	let savingKind = $state<NotificationKind | null>(null);
	let prefError = $state('');
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const savePref =
		(kind: NotificationKind): SubmitFunction =>
		() => {
			shownPrefs = { ...data.prefs };
			savingKind = kind;
			prefError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					prefError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				} else {
					await update({ reset: false });
				}
				savingKind = null;
			};
		};
	// FN-34b: the evening reminder's hour. Like the switches, the select shows the server's stored hour and
	// submits at once; the stored value is shown again once the write is confirmed.
	let savingHour = $state(false);
	const prefSaved = $derived(
		(!savingKind && form && 'savedPref' in form && form.savedPref) ||
			(!savingHour && form && 'savedHour' in form && form.savedHour !== undefined)
	);
	let hourError = $state('');
	const hourLabel = (h: number) => `${String(h).padStart(2, '0')}.00 WIB`;
	const saveHour: SubmitFunction = () => {
		savingHour = true;
		hourError = '';
		return async ({ result, update }) => {
			if (result.type === 'error')
				hourError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			else await update({ reset: false });
			savingHour = false;
		};
	};
	const hourFailure = $derived(
		hourError || (form && 'hourError' in form && form.hourError ? tr(form.hourError) : '')
	);

	const RESULT_LABELS = {
		sent: msg('Terkirim'),
		expired: msg('Kedaluwarsa, dihapus'),
		failed: msg('Gagal terkirim')
	} as const;
</script>

<svelte:head><title>{tr('Notifikasi')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Notifikasi')}
/>

<p class="intro">
	{tr(
		'Notifikasi di perangkat diatur per perangkat. Semua notifikasi juga tampil di Kotak masuk, termasuk tanpa notifikasi perangkat.'
	)}
</p>

{#if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={() => invalidateAll()} />
{:else if !data.configured}
	<GroupList>
		<GroupRow>
			<Toggle
				label={tr('Beri tahu di perangkat ini')}
				hint={tr('Belum dikonfigurasi')}
				checked={false}
				disabled
			/>
		</GroupRow>
	</GroupList>
{:else if phase === 'loading'}
	<Skeleton rows={2} />
{:else if support === 'ios-needs-install'}
	<p class="message" role="status">
		{tr('Pasang dulu ke layar utama untuk mengaktifkan notifikasi di iPhone')}
		{tr('Butuh iOS 16.4 atau lebih baru.')}
	</p>
	<a class="link" href="/pengaturan/instal">{tr('Cara memasang aplikasi')}</a>
{:else if support === 'ios-open-in-safari'}
	<p class="message" role="status">
		{tr('Notifikasi di iPhone hanya untuk aplikasi yang dipasang dari Safari ke layar utama.')}
	</p>
	<a class="link" href="/pengaturan/instal">{tr('Cara memasang aplikasi')}</a>
{:else if support === 'ios-too-old'}
	<p class="message" role="status">
		{tr(
			'Notifikasi di iPhone butuh iOS 16.4 atau lebih baru. Perbarui iOS, lalu buka lagi dari layar utama.'
		)}
	</p>
{:else if support === 'unsupported'}
	<p class="message" role="status">{tr('Browser ini tidak mendukung notifikasi.')}</p>
{:else}
	{#if actionError}
		<ErrorState text={actionError} onretry={() => lastAttempt && attempt(lastAttempt)} />
	{/if}
	<GroupList>
		<GroupRow>
			<Toggle
				label={tr('Beri tahu di perangkat ini')}
				{hint}
				bind:checked={() => on, () => {}}
				disabled={busy || permission === 'denied'}
				{onchange}
			/>
		</GroupRow>
	</GroupList>
	<p class="note">{tr('Izin browser')}: {tr(PERMISSION_LABELS[permission])}</p>
{/if}

<section class="kinds" aria-labelledby="kinds-title">
	<h2 id="kinds-title">{tr('Jenis notifikasi')}</h2>
	{#if prefSaved}<p class="ok" role="status">{tr('Perubahan disimpan.')}</p>{/if}
	{#if data.prefsError}
		<ErrorState text={tr(data.prefsError)} onretry={() => invalidateAll()} />
	{:else}
		{#if hourFailure}
			<FormBanner message={hourFailure} />
		{/if}
		{#if prefError}
			<FormBanner message={prefError} />
		{:else if form && 'prefError' in form && form.prefError}
			<FormBanner message={tr(form.prefError)} />
		{/if}
		<GroupList>
			{#each NOTIFICATION_KINDS as kind (kind)}
				<GroupRow>
					<form method="POST" action="?/setPref" class="row-form" use:enhance={savePref(kind)}>
						<input type="hidden" name="kind" value={kind} />
						<Toggle
							name="enabled"
							label={tr(NOTIFICATION_KIND_LABELS[kind].label)}
							hint={savingKind === kind
								? tr('Menyimpan…')
								: tr(NOTIFICATION_KIND_LABELS[kind].hint)}
							bind:checked={
								() => shownPrefs[kind], (v) => (shownPrefs = { ...shownPrefs, [kind]: v })
							}
							disabled={savingKind !== null}
							onchange={(event) => event.currentTarget.form?.requestSubmit()}
						/>
						{#if !hydrated}
							<Button type="submit" variant="secondary" size="sm">{tr('Simpan')}</Button>
						{/if}
					</form>
				</GroupRow>
				{#if kind === 'close_reminder'}
					<GroupRow>
						<form
							method="POST"
							action="?/setReminderHour"
							class="row-form hour-form"
							use:enhance={saveHour}
						>
							<label class="hour-label" for="close-reminder-hour">
								<span>{tr('Jam pengingat tutup hari')}</span>
								<span class="hour-hint">
									{savingHour ? tr('Menyimpan…') : tr('Hanya jam bulat, 06.00–23.00 WIB')}
								</span>
							</label>
							{#key data.closeReminderHour}
								<select
									id="close-reminder-hour"
									name="hour"
									class="hour-select"
									disabled={savingHour || savingKind !== null}
									onchange={(event) => event.currentTarget.form?.requestSubmit()}
								>
									{#each CLOSE_REMINDER_HOURS as h (h)}
										<option value={String(h)} selected={h === data.closeReminderHour}>
											{hourLabel(h)}
										</option>
									{/each}
								</select>
							{/key}
							{#if !hydrated}
								<Button type="submit" variant="secondary" size="sm">{tr('Simpan')}</Button>
							{/if}
						</form>
					</GroupRow>
				{/if}
			{/each}
		</GroupList>
	{/if}
</section>

{#if data.devTools && data.configured}
	<section class="dev" aria-labelledby="dev-title">
		<h2 id="dev-title">{tr('Uji notifikasi (khusus pengembangan)')}</h2>
		<form
			method="POST"
			action="?/sendTestPush"
			use:enhance={() => {
				testing = true;
				return async ({ update }) => {
					await update({ reset: false });
					testing = false;
				};
			}}
		>
			<Button type="submit" variant="secondary" disabled={testing}>
				{testing ? tr('Mengirim…') : tr('Kirim notifikasi uji')}
			</Button>
		</form>
		<FormBanner message={form && 'error' in form && form.error ? tr(form.error) : undefined} />
		{#if form && 'testResults' in form && form.testResults}
			<ol class="results" role="status">
				{#each form.testResults as result, i (i)}
					<li>{tr('Perangkat')} {i + 1}: {tr(RESULT_LABELS[result])}</li>
				{/each}
			</ol>
		{/if}
	</section>
{/if}

<style>
	.intro {
		margin: 4px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.message {
		margin: 0;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
		color: var(--ink);
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 8px;
		color: var(--ink);
		font-weight: 700;
	}
	.note {
		margin: 8px 4px 0;
		font-size: 13px;
		color: var(--muted);
	}
	.kinds {
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	.row-form {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.hour-label {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		color: var(--ink);
		font-size: 15px;
		font-weight: 600;
	}
	.hour-hint {
		color: var(--muted);
		font-size: 13px;
		font-weight: 400;
	}
	.hour-select {
		min-height: 44px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-variant-numeric: tabular-nums;
	}
	.hour-select:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.ok {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.dev {
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.results {
		margin: 0;
		padding-left: 20px;
	}
</style>
