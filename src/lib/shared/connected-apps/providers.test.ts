import { describe, expect, it } from 'vitest';
import { en } from '../i18n-en.ts';
import {
	appRows,
	CONNECTED_APP_INFO,
	CONNECTED_APP_PROVIDERS,
	isConnectedAppProvider,
	type ConnectionView
} from './providers.ts';

const conn = (provider: ConnectionView['provider']): ConnectionView => ({
	id: `id-${provider}`,
	provider,
	externalLabel: 'contoh.id',
	isDemo: true,
	updatedAt: 1,
	canDisconnect: true
});

describe('appRows', () => {
	it('lists the five providers in order, all "Belum dikonfigurasi" with no connection', () => {
		for (const configured of [true, false]) {
			const rows = appRows([], configured);
			expect(rows.map((r) => r.provider)).toEqual([...CONNECTED_APP_PROVIDERS]);
			expect(rows.every((r) => r.state === 'not_configured' && r.connection === null)).toBe(true);
		}
	});

	it('shows a live row as connected only while the key is configured', () => {
		const rows = appRows([conn('notion')], true);
		expect(rows.find((r) => r.provider === 'notion')).toMatchObject({ state: 'connected' });
		expect(rows.filter((r) => r.state === 'connected')).toHaveLength(1);
	});

	it('treats even a seeded connected row as "Belum dikonfigurasi" without the key, but keeps it disconnectable', () => {
		const row = appRows([conn('slack')], false).find((r) => r.provider === 'slack')!;
		expect(row.state).toBe('not_configured');
		expect(row.connection?.id).toBe('id-slack');
	});
});

describe('provider info', () => {
	it('uses provider names only and never claims a live connection in the descriptions', () => {
		expect(Object.values(CONNECTED_APP_INFO).map((i) => i.name)).toEqual([
			'Gmail',
			'Google Sheets',
			'Google Calendar',
			'Notion',
			'Slack'
		]);
		for (const { description } of Object.values(CONNECTED_APP_INFO)) {
			expect(description).toMatch(/^Nantinya /);
			expect(description.toLowerCase()).not.toContain('terhubung');
			expect(en[description]).toMatch(/^Will later /);
		}
	});

	it('isConnectedAppProvider is exact', () => {
		expect(isConnectedAppProvider('slack')).toBe(true);
		expect(isConnectedAppProvider('toString')).toBe(false);
	});
});
