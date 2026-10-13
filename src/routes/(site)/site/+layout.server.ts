/**
 * The public site (FN-32) is static content: prerendered at build time (pages with per-request data opt out),
 * and served without JavaScript, so it works with scripts off and needs no inline boot script under the CSP.
 * Nothing here may read the request beyond its path: the prerendered copy answers every visitor.
 */
export const prerender = true;
export const csr = false;
