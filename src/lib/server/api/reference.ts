import {
	API_REQUESTS_PER_WINDOW,
	API_TOKEN_LIFETIME_DAYS,
	API_TOKEN_MAX_PER_USER
} from '#lib/shared/api-tokens';
import type { Translator } from '#lib/shared/i18n';
import { API_AUTH_FAILURES_PER_WINDOW } from './http';
import { API_INTRO, AUTH_TEXT, ERROR_TEXT, LIMITS_TEXT, openApiDocument } from './openapi';

/**
 * FN-38: the OpenAPI document reduced to what the docs page renders (endpoints, parameters, body fields,
 * statuses), so the page shows exactly what `/api/v1/openapi.json` says, in the reader's language.
 */
export interface ReferenceField {
	name: string;
	where: 'path' | 'query' | 'body';
	type: string;
	required: boolean;
	description: string;
}

export interface ReferenceEndpoint {
	id: string;
	method: string;
	path: string;
	summary: string;
	scope: string;
	fields: ReferenceField[];
	statuses: { code: string; description: string }[];
}

type Schema = {
	type?: string | string[];
	enum?: unknown[];
	format?: string;
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
};

function typeOf(s: Schema): string {
	if (s.enum) return s.enum.map(String).join(' | ');
	const t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'any');
	return s.format ? `${t} (${s.format})` : t;
}

export function apiReference(t: Translator) {
	const doc = openApiDocument(t);
	const endpoints: ReferenceEndpoint[] = [];
	for (const [path, methods] of Object.entries(doc.paths)) {
		for (const [method, raw] of Object.entries(methods)) {
			const op = raw as {
				operationId: string;
				summary: string;
				'x-montra-scope': string;
				parameters: {
					name: string;
					in: 'path' | 'query';
					required: boolean;
					description?: string;
					schema: Schema;
				}[];
				requestBody?: { content: { 'application/json': { schema: Schema } } };
				responses: Record<string, { description: string }>;
			};
			const body = op.requestBody?.content['application/json'].schema;
			endpoints.push({
				id: op.operationId,
				method: method.toUpperCase(),
				path,
				summary: op.summary,
				scope: op['x-montra-scope'],
				fields: [
					...op.parameters.map((p) => ({
						name: p.name,
						where: p.in,
						type: typeOf(p.schema),
						required: p.required,
						description: p.description ?? ''
					})),
					...Object.entries(body?.properties ?? {}).map(([name, s]) => ({
						name,
						where: 'body' as const,
						type: typeOf(s),
						required: body?.required?.includes(name) ?? false,
						description: s.description ?? ''
					}))
				],
				statuses: Object.entries(op.responses).map(([code, r]) => ({
					code,
					description: r.description
				}))
			});
		}
	}
	return {
		intro: t.tr(API_INTRO),
		auth: t.tr(AUTH_TEXT),
		errors: t.tr(ERROR_TEXT),
		limits: t.trf(LIMITS_TEXT, {
			n: API_REQUESTS_PER_WINDOW,
			gagal: API_AUTH_FAILURES_PER_WINDOW,
			max: API_TOKEN_MAX_PER_USER,
			days: API_TOKEN_LIFETIME_DAYS.join('/')
		}),
		endpoints
	};
}
