/** One column compared with string literals inside a CHECK: `col in ('a', 'b')` or `col = 'a'` / `col <> 'a'`. */
export interface EnumMention {
	column: string;
	values: string[];
	/** `in` for a value list, `eq` for a single `=` / `<>` / `!=` comparison. */
	op: 'in' | 'eq';
}

const IDENT = String.raw`[\`"]?\w+[\`"]?`;
/** An optionally table-qualified column; the column name is the capture. */
const COLUMN = String.raw`(?:${IDENT}\.)?[\`"]?(\w+)[\`"]?`;
const LITERAL = String.raw`'(?:[^']|'')*'`;
const IN_LIST = new RegExp(
	String.raw`${COLUMN}\s+(?:not\s+)?in\s*\(\s*(${LITERAL}(?:\s*,\s*${LITERAL})*)\s*\)`,
	'gi'
);
const COMPARISON = new RegExp(String.raw`${COLUMN}\s*(?:=|<>|!=)\s*(${LITERAL})`, 'gi');

const unquote = (literal: string) => literal.slice(1, -1).replaceAll("''", "'");
const literals = (list: string) => (list.match(new RegExp(LITERAL, 'g')) ?? []).map(unquote);

/**
 * The string-literal comparisons in a `CREATE TABLE` statement as SQLite stores it (`sqlite_master.sql`).
 * Only literals compared with a column count; `glob`/`like` patterns, `length(x) = 4` and
 * `typeof(x) = 'integer'` do not. Line comments are dropped first.
 */
export function enumMentions(createSql: string): EnumMention[] {
	const text = createSql.replace(/--[^\n]*/g, '');
	const out: EnumMention[] = [];
	for (const m of text.matchAll(IN_LIST))
		out.push({
			column: (m[1] as string).toLowerCase(),
			values: literals(m[2] as string),
			op: 'in'
		});
	for (const m of text.matchAll(COMPARISON))
		out.push({
			column: (m[1] as string).toLowerCase(),
			values: [unquote(m[2] as string)],
			op: 'eq'
		});
	return out;
}
