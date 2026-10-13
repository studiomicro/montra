import { describe, expect, it } from 'vitest';
import { decideWhatsNew, isReleaseNotesPath } from './whats-new';

const decide = (stored: string | null, current = '0.6.0', hasNote = true) =>
	decideWhatsNew({ stored, current, hasNote });

describe('decideWhatsNew (FN-42b AC15)', () => {
	it('first install, cleared or corrupt storage: remember the running version, never show', () => {
		expect(decide(null)).toEqual({ show: false, store: '0.6.0' });
		for (const stored of ['abc', '', '1.2', '0.6.0 ', '01.6.0'])
			expect(decide(stored), stored).toEqual({ show: false, store: '0.6.0' });
	});

	it('the same version: nothing shown, nothing written', () => {
		expect(decide('0.6.0')).toEqual({ show: false, store: null });
	});

	it('a newer version shows its note once; without a note it is only remembered', () => {
		expect(decide('0.5.0')).toEqual({ show: true, store: '0.6.0' });
		expect(decide('0.5.0', '0.6.0', false)).toEqual({ show: false, store: '0.6.0' });
		// Several versions skipped: still one notice (for the running version).
		expect(decide('0.1.0')).toEqual({ show: true, store: '0.6.0' });
	});

	it('a rollback to an older version: nothing shown, the running version remembered', () => {
		expect(decide('0.7.0')).toEqual({ show: false, store: '0.6.0' });
	});

	it('compares by number: 0.10.0 is newer than 0.9.0', () => {
		expect(decide('0.9.0', '0.10.0')).toEqual({ show: true, store: '0.10.0' });
		expect(decide('0.10.0', '0.9.0')).toEqual({ show: false, store: '0.9.0' });
	});

	it('an unreadable running version changes nothing', () => {
		expect(decide('0.5.0', 'dev')).toEqual({ show: false, store: null });
	});
});

describe('isReleaseNotesPath', () => {
	it('matches the two Tentang pages only', () => {
		expect(isReleaseNotesPath('/pengaturan/tentang')).toBe(true);
		expect(isReleaseNotesPath('/pengaturan/tentang/')).toBe(true);
		expect(isReleaseNotesPath('/pengaturan/tentang/catatan-rilis')).toBe(true);
		expect(isReleaseNotesPath('/pengaturan')).toBe(false);
		expect(isReleaseNotesPath('/')).toBe(false);
		expect(isReleaseNotesPath('/pengaturan/tentangx')).toBe(false);
	});
});
