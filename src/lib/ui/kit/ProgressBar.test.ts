import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProgressBar from './ProgressBar.svelte';

const rect = (body: string) => body.match(/<rect[^>]*>/)?.[0] ?? '';
const svg = (body: string) => body.match(/<svg[^>]*>/)?.[0] ?? '';

describe('ProgressBar (server render)', () => {
	it('fills the percent of the track and exposes it to assistive technology', () => {
		const { body } = render(ProgressBar, { props: { percent: 42, label: 'Liburan' } });
		expect(rect(body)).toContain('width="42"');
		expect(svg(body)).toContain('role="progressbar"');
		expect(svg(body)).toContain('aria-valuenow="42"');
		expect(svg(body)).toContain('aria-valuemax="100"');
		expect(svg(body)).toContain('aria-label="Liburan"');
	});

	it('caps the fill at 100 but keeps the real percent in the value text', () => {
		const { body } = render(ProgressBar, { props: { percent: 108, label: 'Dana darurat' } });
		expect(rect(body)).toContain('width="100"');
		expect(svg(body)).toContain('aria-valuenow="100"');
		expect(svg(body)).toContain('aria-valuetext="108%"');
	});

	it('shows an empty track at 0 %', () => {
		const { body } = render(ProgressBar, { props: { percent: 0, label: 'Baru' } });
		expect(rect(body)).toContain('width="0"');
	});

	it('uses no inline style (CSP)', () => {
		const { body } = render(ProgressBar, { props: { percent: 50, label: 'x' } });
		expect(body).not.toContain('style=');
	});
});

describe('ProgressBar pace marker and tones', () => {
	it('draws the pace marker at its percent, kept inside the track', () => {
		const { body } = render(ProgressBar, { props: { percent: 30, label: 'x', marker: 25 } });
		expect(body).toMatch(/<rect class="marker[^"]*" x="25"/);
		const end = render(ProgressBar, { props: { percent: 30, label: 'x', marker: 100 } }).body;
		expect(end).toMatch(/<rect class="marker[^"]*" x="99"/);
	});

	it('has no marker unless asked, and colours the fill by tone', () => {
		const { body } = render(ProgressBar, { props: { percent: 30, label: 'x' } });
		expect(body).not.toContain('marker');
		const warn = render(ProgressBar, { props: { percent: 30, label: 'x', tone: 'warn' } }).body;
		expect(rect(warn)).toMatch(/class="fill warn/);
	});
});
