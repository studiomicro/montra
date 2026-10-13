const PAGES = new Set(['privasi', 'ketentuan']);

export const match = (param: string): boolean => PAGES.has(param);
