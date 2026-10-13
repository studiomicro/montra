import { describe, expect, it } from 'vitest';
import { isStatScreen, STAT_SCREENS, statScreenForPath } from './privacy';

describe('usage statistics vocabulary (FN-31)', () => {
	it('counts each tab page and Anggaran as its own named screen', () => {
		expect(statScreenForPath('/')).toBe('beranda');
		expect(statScreenForPath('/riwayat')).toBe('riwayat');
		expect(statScreenForPath('/laporan')).toBe('laporan');
		expect(statScreenForPath('/dompet')).toBe('dompet');
		expect(statScreenForPath('/anggaran')).toBe('anggaran');
		expect(statScreenForPath('/kekayaan')).toBe('kekayaan');
		expect(statScreenForPath('/pengaturan/privasi')).toBe('privasi');
	});

	it('every mapped screen is in the closed list; anything else counts as nothing', () => {
		for (const path of ['/', '/riwayat', '/laporan', '/dompet', '/anggaran', '/kekayaan'])
			expect(isStatScreen(statScreenForPath(path))).toBe(true);
		for (const path of ['/dompet/x', '/anggaran?ubah=bulanan', '/impor', '/riwayat/123'])
			expect(statScreenForPath(path)).toBeNull();
		expect(isStatScreen('dompet ')).toBe(false);
		expect(new Set(STAT_SCREENS).size).toBe(STAT_SCREENS.length);
	});
});
