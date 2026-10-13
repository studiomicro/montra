import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '#lib/shared/i18n';
import { en } from '#lib/shared/i18n-en';
import { ENDPOINTS, type ApiEndpoint } from './endpoints';
import { openApiDocument } from './openapi';

const doc = openApiDocument(createTranslator('en')) as unknown as {
	openapi: string;
	paths: Record<string, Record<string, Record<string, unknown>>>;
	components: Record<string, Record<string, unknown>>;
};
const endpoints = Object.values(ENDPOINTS) as ApiEndpoint[];
/** The /api/v1 routes that are not part of the public API (session, webhook, dev gate; unchanged by FN-38). */
const INTERNAL = new Set([
	'health',
	'track',
	'sync/push',
	'billing/webhook',
	'dev/ping',
	'openapi.json'
]);

function routeFiles(dir = 'src/routes/api/v1', prefix = ''): string[] {
	const out: string[] = [];
	for (const d of readdirSync(dir, { withFileTypes: true })) {
		if (d.isDirectory())
			out.push(...routeFiles(join(dir, d.name), prefix ? `${prefix}/${d.name}` : d.name));
		else if (d.name === '+server.ts') out.push(prefix);
	}
	return out;
}

function walk(value: unknown, visit: (key: string, v: unknown) => void) {
	if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
	else if (value && typeof value === 'object')
		for (const [k, v] of Object.entries(value)) {
			visit(k, v);
			walk(v, visit);
		}
}

describe('the OpenAPI document (FN-38 criterion 23)', () => {
	it('is OpenAPI 3.1 with every public route, and every public route file is documented', () => {
		expect(doc.openapi).toBe('3.1.0');
		for (const e of endpoints)
			expect(doc.paths[e.path]?.[e.method.toLowerCase()], e.operationId).toBeDefined();
		const documented = new Set(
			endpoints.map((e) => e.path.replace('/api/v1/', '').replace('{id}', '[id]'))
		);
		for (const route of routeFiles()) {
			if (INTERNAL.has(route)) continue;
			expect(documented.has(route), `${route} is not in ENDPOINTS`).toBe(true);
		}
		for (const e of endpoints) {
			const file = join('src/routes', e.path.replace('{id}', '[id]'), '+server.ts');
			expect(existsSync(file), file).toBe(true);
			const source = readFileSync(file, 'utf8');
			expect(source).toMatch(
				new RegExp(`export const ${e.method} = apiRoute\\(\\s*ENDPOINTS\\.${e.operationId},`)
			);
		}
	});

	it('passes an OpenAPI 3.1 schema validator (@seriousme/openapi-schema-validator, dev only)', async () => {
		const validator = new Validator();
		const result = await validator.validate(JSON.parse(JSON.stringify(doc)));
		expect(result.errors ?? []).toEqual([]);
		expect(result.valid).toBe(true);
		expect(validator.version).toBe('3.1');
		// The validator does reject a broken document (here: one without `info`).
		const broken = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
		delete broken.info;
		expect((await new Validator().validate(broken)).valid).toBe(false);
	});

	it('names every response, parameter and security requirement; every $ref resolves', () => {
		for (const [path, methods] of Object.entries(doc.paths))
			for (const op of Object.values(methods)) {
				const responses = op.responses as Record<string, { description?: string }>;
				for (const status of ['401', '429', '500']) expect(responses[status], path).toBeDefined();
				for (const r of Object.values(responses)) expect(r.description).toBeTruthy();
				expect(op.security).toEqual([{ bearerToken: [] }]);
				for (const p of op.parameters as {
					name: string;
					in: string;
					required: boolean;
					schema: unknown;
				}[]) {
					expect(['path', 'query']).toContain(p.in);
					expect(p.schema).toBeTruthy();
					if (p.in === 'path') expect(p.required).toBe(true);
				}
			}
		walk(doc, (key, v) => {
			if (key !== '$ref') return;
			const name = String(v).replace('#/components/schemas/', '');
			expect(doc.components.schemas?.[name], String(v)).toBeDefined();
		});
		walk(doc, (key) => expect(key).not.toBe('$schema'));
		// Red team L3: internal D1 budgets stay out of the public document.
		expect(JSON.stringify(doc)).not.toMatch(/d1|quer(y|ies)-budget|max-d1/i);
	});

	it('requires space_id everywhere but the space list, and documents money as integers', () => {
		for (const e of endpoints) {
			const params = doc.paths[e.path]![e.method.toLowerCase()]!.parameters as {
				name: string;
				required: boolean;
			}[];
			const space = params.find((p) => p.name === 'space_id');
			if (e.operationId === 'listSpaces') expect(space).toBeUndefined();
			else expect(space?.required).toBe(true);
		}
		walk(doc, (key, v) => {
			if (key.endsWith('_minor') && v && typeof v === 'object' && 'type' in v)
				expect(['integer', JSON.stringify(['integer', 'null'])]).toContain(
					typeof v.type === 'string' ? v.type : JSON.stringify(v.type)
				);
		});
	});

	it('is fully English: no description or summary is left as an Indonesian phrase', () => {
		walk(doc, (key, v) => {
			if ((key === 'description' || key === 'summary') && typeof v === 'string')
				expect(Object.hasOwn(en, v) && en[v] !== v, v).toBe(false);
		});
	});
});
