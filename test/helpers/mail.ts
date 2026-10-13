import { readFileSync } from 'node:fs';

/**
 * FN-19 forwarding test doubles. The fixtures (`src/lib/shared/inbound/fixtures/<institution>/*.eml.txt`) are
 * FICTIONAL mails: every name, `*.example` domain, number and reference is invented, none is a redacted real
 * sample (those are an owner item). `TO_ADDRESS` in a fixture is replaced with the address under test.
 */
export function fixtureText(
	name: string,
	to = 'm-00000000000000000000000000@in.contoh.example'
): string {
	return readFileSync(
		new URL(`../../src/lib/shared/inbound/fixtures/${name}.eml.txt`, import.meta.url),
		'utf8'
	)
		.replaceAll('TO_ADDRESS', to)
		.replace(/\r?\n/g, '\r\n');
}

export const bytes = (text: string) => new TextEncoder().encode(text);

/** A stream of `data` in chunks of `chunk` bytes. */
export function streamOf(data: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= data.length) return controller.close();
			controller.enqueue(data.subarray(at, at + chunk));
			at += chunk;
		}
	});
}

/** An Email Routing message double: records `setReject`. `rawSize` defaults to the real size. */
export function emailMessage(raw: Uint8Array, to: string, rawSize = raw.length) {
	const m = {
		to,
		raw: streamOf(raw),
		rawSize,
		rejected: null as string | null,
		setReject(reason: string) {
			m.rejected = reason;
		}
	};
	return m;
}
