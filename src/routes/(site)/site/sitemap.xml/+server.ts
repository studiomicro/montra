import { listPosts } from '#lib/server/content/blog';
import { sitemapXml } from '#lib/server/content/sitemap';
import type { RequestHandler } from './$types';

export const prerender = true;

export const GET: RequestHandler = () =>
	new Response(sitemapXml(listPosts('id')), {
		headers: { 'content-type': 'application/xml; charset=utf-8' }
	});
