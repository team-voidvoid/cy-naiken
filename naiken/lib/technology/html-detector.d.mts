export const LIMITS: Readonly<{ htmlCharacters: number; tagCharacters: number; evidencePerProduct: number }>;
export interface HtmlTag { name: string; attrs: Map<string, string>; offset: number; endOffset: number }
export function readTags(html: string): { tags: HtmlTag[]; complete: boolean };
export function resolveHtmlBase(tags: HtmlTag[], sourceUrl?: string | null): { url: URL; absolute: boolean };
