import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../test/helpers/html';
import TwoSheets from '../../../../test/fixtures/TwoSheets.svelte';

describe('Sheet', () => {
	it('gives every sheet on a page its own title id, each dialog labelled by its own heading', () => {
		const { body } = render(TwoSheets);
		const labels = [...body.matchAll(/<dialog[^>]*aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
		const headings = [...body.matchAll(/<h2[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)].map(
			(m) => [m[1], m[2] === undefined ? undefined : stripComments(m[2])]
		);
		expect(labels).toHaveLength(2);
		expect(new Set(labels).size).toBe(2);
		expect(headings).toEqual([
			[labels[0], 'Satu'],
			[labels[1], 'Dua']
		]);
	});

	it('caps its height and scrolls its own content (a tall form never runs off-screen)', () => {
		const source = readFileSync('src/lib/ui/shell/Sheet.svelte', 'utf8');
		const sheet = source.match(/\.sheet \{([^}]*)\}/)?.[1];
		const body = source.match(/\.sheet-body \{([^}]*)\}/)?.[1];
		expect(sheet).toMatch(/max-height:\s*calc\(100dvh/);
		expect(body).toMatch(/overflow-y:\s*auto/);
		expect(body).toMatch(/min-height:\s*0/);
	});

	it('the title row is part of the glass surface: no fill of its own, outside the padded body', () => {
		const source = readFileSync('src/lib/ui/shell/Sheet.svelte', 'utf8');
		const head = source.match(/\.sheet-head \{([^}]*)\}/)?.[1];
		expect(head).not.toMatch(/background/);
		expect(source).toMatch(/<\/header>\s*<div class="sheet-body">/);
	});
});
