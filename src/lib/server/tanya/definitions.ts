import type { ToolDefinition } from './anthropic.ts';

/**
 * The JSON definitions of Tanya's read-only tools (FN-22), as the Messages API takes them: data only, so the
 * owner-run `compat:tanya` (plain Node) offers the model exactly the tools the app does. Their inputs are checked
 * again by strict zod schemas in tools.ts; no tool takes a space id, a user id or SQL.
 */

/** Longest category, wallet or subscription name in a tool input or result. */
export const NAME_MAX = 60;
/** Most merchants `top_merchants` returns (aggregate.ts MAX_MERCHANTS). */
export const MERCHANTS_MAX = 10;
export const PERIOD_PATTERN =
	'^(this_month|last_month|last_3_months|this_year|month:[0-9]{4}-(0[1-9]|1[0-2]))$';

const PERIOD_DOC = {
	type: 'string',
	pattern: PERIOD_PATTERN,
	description:
		'this_month, last_month, last_3_months, this_year, or month:YYYY-MM. Resolved by the server to WIB dates.'
};
const CATEGORY_DOC = {
	type: 'string',
	maxLength: NAME_MAX,
	description: "The category name in the user's words (matched by the server)."
};
const NO_INPUT_DOC = { type: 'object', properties: {}, additionalProperties: false };

export const DEFINITIONS = {
	spending_summary: {
		name: 'spending_summary',
		description:
			'Income, expense and net (income minus expense) of a period, per currency, optionally for one category. Transfers and balance adjustments are not counted.',
		input_schema: {
			type: 'object',
			properties: { period: PERIOD_DOC, category: CATEGORY_DOC },
			required: ['period'],
			additionalProperties: false
		}
	},
	spending_by_category: {
		name: 'spending_by_category',
		description:
			'Expense of a period split by category, largest first, per currency (top N, the rest as "other").',
		input_schema: {
			type: 'object',
			properties: {
				period: PERIOD_DOC,
				top: { type: 'integer', minimum: 1, maximum: 8, description: 'How many categories (1-8).' }
			},
			required: ['period'],
			additionalProperties: false
		}
	},
	top_merchants: {
		name: 'top_merchants',
		description:
			'The places money was spent most in a period (grouped by transaction title), largest first, per currency.',
		input_schema: {
			type: 'object',
			properties: {
				period: PERIOD_DOC,
				limit: { type: 'integer', minimum: 1, maximum: MERCHANTS_MAX }
			},
			required: ['period'],
			additionalProperties: false
		}
	},
	compare_periods: {
		name: 'compare_periods',
		description:
			'Expense of one period against another (optionally one category): both totals, the difference and the percent change, per currency.',
		input_schema: {
			type: 'object',
			properties: { period: PERIOD_DOC, compare_to: PERIOD_DOC, category: CATEGORY_DOC },
			required: ['period', 'compare_to'],
			additionalProperties: false
		}
	},
	monthly_trend: {
		name: 'monthly_trend',
		description: 'Income and expense per WIB month for the last N months (this month included).',
		input_schema: {
			type: 'object',
			properties: { months: { type: 'integer', minimum: 1, maximum: 6 } },
			additionalProperties: false
		}
	},
	list_subscriptions: {
		name: 'list_subscriptions',
		description:
			'The subscriptions of the space, most expensive per month first, with the monthly estimate per currency, and the recurring expenses due in the next 30 days.',
		input_schema: NO_INPUT_DOC
	},
	wallet_balances: {
		name: 'wallet_balances',
		description:
			'The balance of every wallet of the space now, and the total per currency (never summed across currencies).',
		input_schema: NO_INPUT_DOC
	},
	budget_status: {
		name: 'budget_status',
		description:
			"This month's budget: the total budget and each category budget with what is spent, what is left and the percent used.",
		input_schema: NO_INPUT_DOC
	}
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof DEFINITIONS;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.values(DEFINITIONS);
