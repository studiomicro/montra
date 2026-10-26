/**
 * FN-22 Tanya test doubles: synthetic Messages API answers as the provider (through the gateway) would send them.
 * Mocked model answers prove the loop, the guard and the scoping only; they never count as a working AI path.
 */
const usage = { input_tokens: 120, output_tokens: 30 };

/** A final answer carrying `text`. */
export const textAnswer = (text: string, stopReason = 'end_turn') =>
	new Response(
		JSON.stringify({
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text }],
			stop_reason: stopReason,
			usage
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);

/** An answer asking for tools: `calls` are `[name, input]` pairs, ids `toolu_<round>_<i>`. */
export const toolAnswer = (calls: [string, unknown][], round = 1) =>
	new Response(
		JSON.stringify({
			id: `msg_tool_${round}`,
			type: 'message',
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Saya cek dulu.' },
				...calls.map(([name, input], i) => ({
					type: 'tool_use',
					id: `toolu_${round}_${i}`,
					name,
					input
				}))
			],
			stop_reason: 'tool_use',
			usage
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);

export const errorAnswer = (status: number, type: string) =>
	new Response(JSON.stringify({ type: 'error', error: { type, message: 'synthetic' } }), {
		status,
		headers: { 'content-type': 'application/json' }
	});

/** The JSON body of a recorded fetch call. */
export const bodyOf = (init: RequestInit | undefined) =>
	JSON.parse(String(init?.body)) as {
		model: string;
		max_tokens: number;
		system: string;
		tools: { name: string }[];
		messages: { role: string; content: unknown }[];
		thinking: unknown;
	};

/** The figure ids the tools returned so far in a recorded request, in order (ids are random per question). */
export const figureIdsOf = (init: RequestInit | undefined) =>
	[...String(init?.body).matchAll(/\\"figure_id\\":\\"([a-z0-9]+)\\"/g)].map((m) => m[1]!);
