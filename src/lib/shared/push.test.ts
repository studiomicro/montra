import { describe, expect, it } from 'vitest';
import { normalizePushEndpoint, parsePushPayload } from './push';

describe('parsePushPayload', () => {
	it('reads title, body and a same-origin path', () => {
		expect(parsePushPayload('{"title":"Uji","body":"Halo","url":"/riwayat"}')).toEqual({
			title: 'Uji',
			body: 'Halo',
			url: '/riwayat'
		});
	});
	it('opens / for a missing, foreign or scheme-relative url', () => {
		for (const url of [
			undefined,
			'https://evil.example',
			'//evil.example',
			'/\\evil',
			'javascript:x'
		])
			expect(parsePushPayload(JSON.stringify({ title: 'T', body: 'B', url }))?.url).toBe('/');
	});
	it('strips invisible characters and caps lengths', () => {
		const p = parsePushPayload(JSON.stringify({ title: 'A​B', body: 'x'.repeat(500) }));
		expect(p?.title).toBe('AB');
		expect(p?.body.length).toBe(240);
	});
	it('refuses anything that is not a payload', () => {
		for (const text of [
			'',
			'not json',
			'null',
			'[]',
			'{"title":1,"body":"b"}',
			'{"title":" ","body":"b"}'
		])
			expect(parsePushPayload(text)).toBeNull();
	});
});

describe('normalizePushEndpoint', () => {
	it('lower-cases scheme and host, drops :443 and a trailing dot, keeps path and query exact', () => {
		const want = 'https://fcm.googleapis.com/fcm/send/AbC:x?Key=Val';
		for (const raw of [
			want,
			'HTTPS://FCM.GoogleAPIs.com/fcm/send/AbC:x?Key=Val',
			'https://fcm.googleapis.com:443/fcm/send/AbC:x?Key=Val',
			'https://fcm.googleapis.com./fcm/send/AbC:x?Key=Val'
		])
			expect(normalizePushEndpoint(raw)).toBe(want);
		expect(normalizePushEndpoint('https://fcm.googleapis.com')).toBe('https://fcm.googleapis.com/');
		// Path bytes are not rewritten (no dot-segment or percent re-encoding).
		expect(normalizePushEndpoint('https://a.example/x/../%7e')).toBe('https://a.example/x/../%7e');
	});
	it('refuses non-https, other ports, credentials, fragments and junk', () => {
		for (const raw of [
			'http://fcm.googleapis.com/x',
			'https://fcm.googleapis.com:8443/x',
			'https://u:p@fcm.googleapis.com/x',
			'https://fcm.googleapis.com/x#frag',
			'https:///x',
			'not a url',
			''
		])
			expect(normalizePushEndpoint(raw)).toBeNull();
	});
});
