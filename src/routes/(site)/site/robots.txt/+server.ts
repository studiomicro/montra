import { robotsTxt } from '#lib/server/content/sitemap';
import type { RequestHandler } from './$types';

export const prerender = true;

export const GET: RequestHandler = () =>
	new Response(robotsTxt(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
