import { describe, expect, it } from 'vitest';
import { enumMentions } from './check-enums';

describe('enumMentions', () => {
	it('reads qualified, renamed-table, backtick and bare column lists', () => {
		expect(
			enumMentions(`CREATE TABLE "t" (
				CONSTRAINT "a" CHECK("t"."kind" in ('x', 'y')),
				CONSTRAINT "b" CHECK("__new_t"."source" in ('m','n' , 'o')),
				CONSTRAINT "c" CHECK(\`flag\` is null or \`flag\` IN ('dup')),
				CONSTRAINT "d" CHECK(state not in ('gone')))`)
		).toEqual([
			{ column: 'kind', values: ['x', 'y'], op: 'in' },
			{ column: 'source', values: ['m', 'n', 'o'], op: 'in' },
			{ column: 'flag', values: ['dup'], op: 'in' },
			{ column: 'state', values: ['gone'], op: 'in' }
		]);
	});

	it('reads = / <> comparisons and an escaped quote', () => {
		expect(
			enumMentions(
				`CHECK(("t"."type" = 'transfer') = ("t"."x" is not null) and "t"."src" <> 'it''s')`
			)
		).toEqual([
			{ column: 'type', values: ['transfer'], op: 'eq' },
			{ column: 'src', values: ["it's"], op: 'eq' }
		]);
	});

	it('ignores glob/like patterns, functions of a column and comments', () => {
		expect(
			enumMentions(`CHECK("t"."last_four" not glob '*[^0-9]*' and length("t"."d") = 10
				and typeof("t"."delta") = 'integer' and "t"."n" like 'a%') -- "t"."kind" in ('z')`)
		).toEqual([]);
	});
});
