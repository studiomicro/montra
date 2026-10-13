import { describe, expect, it, vi } from 'vitest';
import {
	failureOf,
	listen,
	shouldAutoStart,
	speechRecognitionCtor,
	transcriptOf,
	type RecognitionLike
} from './recognition';

class FakeRecognition implements RecognitionLike {
	static last: FakeRecognition | null = null;
	lang = '';
	interimResults = false;
	continuous = true;
	maxAlternatives = 5;
	onresult: RecognitionLike['onresult'] = null;
	onerror: RecognitionLike['onerror'] = null;
	onend: RecognitionLike['onend'] = null;
	started = false;
	constructor() {
		FakeRecognition.last = this;
	}
	start() {
		this.started = true;
	}
	stop() {
		this.onend?.();
	}
	abort() {
		this.onerror?.({ error: 'aborted' });
		this.onend?.();
	}
	emit(parts: [string, boolean][]) {
		const results = Object.assign(
			parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })),
			{ length: parts.length }
		);
		this.onresult?.({ results });
	}
}

const handlers = () => ({
	onText: vi.fn(),
	onFinal: vi.fn(),
	onFailure: vi.fn(),
	onEnd: vi.fn()
});

describe('speechRecognitionCtor', () => {
	it('detects the standard and the webkit constructor, else null', () => {
		expect(speechRecognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
		expect(speechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(
			FakeRecognition
		);
		expect(speechRecognitionCtor({})).toBeNull();
		expect(speechRecognitionCtor({ SpeechRecognition: 'nope' })).toBeNull();
	});
});

describe('failureOf', () => {
	it('maps a refused microphone to denied', () => {
		expect(failureOf('not-allowed')).toBe('denied');
		expect(failureOf('service-not-allowed')).toBe('denied');
		expect(failureOf('no-speech')).toBe('no-speech');
		expect(failureOf('network')).toBe('failed');
		expect(failureOf('audio-capture')).toBe('failed');
	});
});

describe('transcriptOf', () => {
	it('splits final and interim text', () => {
		const results = Object.assign(
			[
				{ isFinal: true, 0: { transcript: 'kopi 25rb ' } },
				{ isFinal: false, 0: { transcript: 'dan parkir' } }
			],
			{ length: 2 }
		);
		expect(transcriptOf(results)).toEqual({ final: 'kopi 25rb', interim: 'dan parkir' });
		expect(transcriptOf(Object.assign([], { length: 0 }))).toEqual({ final: '', interim: '' });
	});
});

describe('listen', () => {
	it('starts at once in the chosen language with interim results', () => {
		const h = handlers();
		listen(FakeRecognition, 'id-ID', h);
		const rec = FakeRecognition.last!;
		expect(rec.started).toBe(true);
		expect(rec.lang).toBe('id-ID');
		expect(rec.interimResults).toBe(true);
		expect(rec.continuous).toBe(false);
		expect(rec.maxAlternatives).toBe(1);
	});

	it('reports live text, then the final sentence on end', () => {
		const h = handlers();
		listen(FakeRecognition, 'en-US', h);
		const rec = FakeRecognition.last!;
		rec.emit([['kopi', false]]);
		expect(h.onText).toHaveBeenLastCalledWith('kopi');
		rec.emit([['kopi 25rb dan parkir goceng', true]]);
		rec.stop();
		expect(h.onFinal).toHaveBeenCalledWith('kopi 25rb dan parkir goceng');
		expect(h.onEnd).toHaveBeenCalledOnce();
		expect(h.onFailure).not.toHaveBeenCalled();
	});

	it('a refused microphone reports denied and no sentence', () => {
		const h = handlers();
		listen(FakeRecognition, 'id-ID', h);
		const rec = FakeRecognition.last!;
		rec.onerror?.({ error: 'not-allowed' });
		rec.onend?.();
		expect(h.onFailure).toHaveBeenCalledWith('denied');
		expect(h.onFinal).not.toHaveBeenCalled();
		expect(h.onEnd).toHaveBeenCalledOnce();
	});

	it('our own abort drops the text silently', () => {
		const h = handlers();
		const session = listen(FakeRecognition, 'id-ID', h);
		FakeRecognition.last!.emit([['kopi 25rb', true]]);
		session.abort();
		expect(h.onFailure).not.toHaveBeenCalled();
		expect(h.onFinal).not.toHaveBeenCalled();
	});
});

describe('shouldAutoStart (red team L2)', () => {
	const here = new URL('https://app.example/riwayat/suara?mulai=1');
	it('starts at once only after an in-app navigation that asked for it', () => {
		expect(shouldAutoStart(new URL('https://app.example/'), here)).toBe(true);
	});
	it('never on a full page load (a link from another site, a reload, a bookmark)', () => {
		expect(shouldAutoStart(null, here)).toBe(false);
	});
	it('never from another origin or without the flag', () => {
		expect(shouldAutoStart(new URL('https://evil.example/'), here)).toBe(false);
		expect(
			shouldAutoStart(new URL('https://app.example/'), new URL('https://app.example/riwayat/suara'))
		).toBe(false);
	});
});
