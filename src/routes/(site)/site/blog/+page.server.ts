import { listPosts } from '#lib/server/content/blog';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ posts: listPosts(locals.locale) });
