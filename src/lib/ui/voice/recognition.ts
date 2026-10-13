/**
 * The browser's own speech recogniser (Web Speech API), feature-detected — never user-agent sniffed. Audio
 * never leaves the browser through MONTRA: only the text it produces is parsed, on the device (FN-14).
 * Minimal local types: `SpeechRecognition` is not in every TypeScript DOM lib, and `webkit…` never is.
 */

interface ResultList {
	readonly length: number;
	[index: number]: { readonly isFinal: boolean; readonly 0?: { readonly transcript: string } };
}

export interface RecognitionLike {
	lang: string;
	interimResults: boolean;
	continuous: boolean;
	maxAlternatives: number;
	onresult: ((event: { results: ResultList }) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

/** The recogniser constructor this browser offers, or null (the typed sentence field is the fallback). */
export function speechRecognitionCtor(win: object): RecognitionCtor | null {
	const w = win as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
	const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
	return typeof ctor === 'function' ? (ctor as RecognitionCtor) : null;
}

/**
 * Whether opening the page should start recording at once: only after an in-app (client-side) navigation from
 * our own origin that asked for it (`?mulai=1` on the Tambah sheet and Beranda links). A full page load — a link
 * from another site, a reload, a bookmark — has no `from` and waits for a tap, so no other site can switch the
 * microphone on by linking here.
 */
export function shouldAutoStart(from: URL | null, url: URL): boolean {
	return from !== null && from.origin === url.origin && url.searchParams.has('mulai');
}

/** Why recognition stopped without text: the microphone was refused, nothing was heard, or anything else. */
export type RecognitionFailure = 'denied' | 'no-speech' | 'failed';

export function failureOf(error: string): RecognitionFailure {
	if (error === 'not-allowed' || error === 'service-not-allowed') return 'denied';
	if (error === 'no-speech') return 'no-speech';
	return 'failed';
}

/** The final and the still-changing (interim) text of a result list. */
export function transcriptOf(results: ResultList): { final: string; interim: string } {
	let final = '';
	let interim = '';
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const text = result?.[0]?.transcript ?? '';
		if (result?.isFinal) final += text;
		else interim += text;
	}
	return { final: final.trim(), interim: interim.trim() };
}

export interface ListenHandlers {
	/** Everything heard so far (final + interim), for the live view. */
	onText: (text: string) => void;
	/** The final sentence once recognition ends with one. */
	onFinal: (text: string) => void;
	onFailure: (failure: RecognitionFailure) => void;
	/** Recognition ended (after onFinal / onFailure, or when nothing was said). */
	onEnd: () => void;
}

/**
 * Starts one recognition session in `lang` (`id-ID` or `en-US`): interim results on, one sentence, one
 * alternative. Returns the session so the page can stop (keep what was heard) or abort (drop it) it.
 */
export function listen(Ctor: RecognitionCtor, lang: string, handlers: ListenHandlers) {
	const rec = new Ctor();
	rec.lang = lang;
	rec.interimResults = true;
	rec.continuous = false;
	rec.maxAlternatives = 1;
	let final = '';
	let failed = false;
	rec.onresult = (event) => {
		const t = transcriptOf(event.results);
		final = t.final;
		handlers.onText([t.final, t.interim].filter(Boolean).join(' '));
	};
	rec.onerror = (event) => {
		const failure = failureOf(event.error);
		// "aborted" is our own abort (language switch, leaving the page): nothing to report.
		if (event.error === 'aborted') return;
		failed = true;
		handlers.onFailure(failure);
	};
	rec.onend = () => {
		if (!failed && final) handlers.onFinal(final);
		handlers.onEnd();
	};
	rec.start();
	return {
		stop: () => rec.stop(),
		abort: () => {
			final = '';
			rec.abort();
		}
	};
}
