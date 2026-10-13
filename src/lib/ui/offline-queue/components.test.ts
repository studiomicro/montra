import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Locale } from '#lib/shared/i18n';
import { QUEUE_STALE_MS, type QueueItem } from '#lib/shared/offline-queue';
import Harness from '../../../../test/helpers/I18nHarness.svelte';
import OfflineBadge from './OfflineBadge.svelte';
import PendingSheet from './PendingSheet.svelte';
import { reopenHref } from './view';

const NOW = 1_800_000_000_000;
const SPACE = '6a1f0c2e-8b3d-4e5f-9a0b-1c2d3e4f5a6b';

function html(component: unknown, props: Record<string, unknown>, locale: Locale = 'id') {
	return render(Harness, {
		props: { component: component as Component<Record<string, unknown>>, locale, props }
	})
		.body.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\s+/g, ' ');
}

const badge = (o: Record<string, unknown>, locale: Locale = 'id') =>
	html(
		OfflineBadge,
		{ pending: 0, failed: 0, online: false, sessionEnded: false, onopen: () => {}, ...o },
		locale
	);

function item(o: Partial<QueueItem> = {}): QueueItem {
	return {
		clientId: crypto.randomUUID(),
		spaceId: SPACE,
		kind: 'transaction.create',
		payload: [],
		accountId: 'user-a',
		spaceName: 'Pribadi',
		createdAt: NOW,
		keptAt: NOW,
		attempts: 0,
		nextAttemptAt: 0,
		status: 'pending',
		summary: { title: 'Kopi', amountMinor: 2_500_000, currency: 'IDR', count: 1 },
		...o
	};
}

const sheet = (items: QueueItem[], o: Record<string, unknown> = {}, locale: Locale = 'id') =>
	html(
		PendingSheet,
		{
			open: true,
			items,
			currentSpaceId: SPACE,
			sessionEnded: false,
			now: NOW,
			onretry: () => {},
			ondiscard: () => {},
			...o
		},
		locale
	);

describe('OfflineBadge (task 9)', () => {
	it('renders nothing for an empty queue', () => {
		expect(badge({})).not.toContain('<button');
	});
	it('offline with 1 and with N pending: "Menunggu koneksi", never "Tersimpan"', () => {
		expect(badge({ pending: 1 })).toContain('Menunggu koneksi · 1 menunggu');
		const n = badge({ pending: 3 });
		expect(n).toContain('Menunggu koneksi · 3 menunggu');
		expect(n).not.toMatch(/tersimpan/i);
	});
	it('online: sending; failed items win; a paused session says so', () => {
		expect(badge({ pending: 2, online: true })).toContain('Mengirim 2 perubahan…');
		expect(badge({ pending: 2, failed: 1 })).toContain('1 perubahan gagal dikirim');
		expect(badge({ pending: 2, sessionEnded: true })).toContain(
			'Sesi berakhir. Silakan masuk kembali.'
		);
	});
	it('says saved only for confirmed items, with an empty queue', () => {
		expect(badge({ confirmed: 2 })).toContain('2 perubahan tersimpan.');
	});
	it('English', () => {
		expect(badge({ pending: 1 }, 'en')).toContain('Waiting for a connection · 1 waiting');
		expect(badge({ failed: 2 }, 'en')).toContain('2 changes could not be sent');
	});
});

describe('PendingSheet (task 9)', () => {
	it('an empty queue: "Semua tersinkron"', () => {
		expect(sheet([])).toContain('Semua tersinkron');
	});
	it('a pending item in plain language with the shared money format', () => {
		const body = sheet([item()]);
		expect(body).toContain('Transaksi baru');
		expect(body).toContain('Kopi · Rp 25.000');
		expect(body).toContain('Menunggu koneksi');
	});
	it('a failed item shows its specific reason and "Buka transaksi" for an edit', () => {
		const failed = item({
			kind: 'transaction.update',
			targetId: 'tx-1',
			expectedUpdatedAt: 5,
			status: 'failed',
			lastError: 'Data ini sudah berubah. Muat ulang lalu coba lagi.'
		});
		const body = sheet([failed]);
		expect(body).toContain('Data ini sudah berubah. Muat ulang lalu coba lagi.');
		expect(body).toContain('href="/riwayat/tx-1/edit"');
		expect(body).not.toContain('Kirim lagi');
		expect(reopenHref(failed)).toBe('/riwayat/tx-1/edit');
	});
	it('a failed create can be sent again; a stale one says so', () => {
		const body = sheet([
			item({ status: 'failed', lastError: 'Ruang ini sudah tidak bisa diakses.' }),
			item({ keptAt: NOW - QUEUE_STALE_MS - 1 })
		]);
		expect(body).toContain('Ruang ini sudah tidak bisa diakses.');
		expect(body).toContain('Ketinggalan sinkron. Kirim lagi atau buang.');
		expect(body.match(/Kirim lagi<\/button>/g)).toHaveLength(2);
	});
	it('a paused session shows the sign-in-again reason on every pending item', () => {
		const body = sheet([item(), item()], { sessionEnded: true });
		expect(body.match(/Sesi berakhir\. Silakan masuk kembali\./g)).toHaveLength(2);
	});
	it("names an item's space when it is not the current one (space switch)", () => {
		const body = sheet([item({ spaceName: 'Keluarga', spaceId: 'other' })]);
		expect(body).toContain('Keluarga');
	});
	it('a voice save with several rows', () => {
		const body = sheet([
			item({
				kind: 'voice.save',
				summary: { title: 'kopi', amountMinor: 3_000_000, currency: 'IDR', count: 2 }
			})
		]);
		expect(body).toContain('2 transaksi · Rp 30.000');
	});
	it('English', () => {
		const body = sheet([item()], {}, 'en');
		expect(body).toContain('Pending changes');
		expect(body).toContain('Waiting for a connection');
		expect(body).toContain('Discard');
	});
});
