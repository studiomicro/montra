import { json } from '@sveltejs/kit';
import { openApiDocument } from '#lib/server/api/openapi';
import { createTranslator } from '#lib/shared/i18n';
import type { RequestHandler } from './$types';

// FN-38: the public API's OpenAPI 3.1 document, in English. Unauthenticated on purpose (owner decision 6): it
// holds no secret and no data, only the routes and shapes generated from the handlers' own schemas.
const document = openApiDocument(createTranslator('en'));

export const GET: RequestHandler = () =>
	json(document, { headers: { 'cache-control': 'public, max-age=300' } });
