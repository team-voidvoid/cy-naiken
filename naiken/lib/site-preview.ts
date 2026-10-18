import type { Observation } from './diagnosis-types.ts';
import { normalizeTarget, validateFetchUrl } from './targets.ts';
import { assertPublicDns } from './public-dns.ts';
import { publicFetch } from './public-fetch.ts';

type Preview = NonNullable<Observation['preview']>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 7_000;

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', copy: '©', reg: '®', trade: '™', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', yen: '¥', euro: '€' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return Object.hasOwn(named, name.toLowerCase()) ? named[name.toLowerCase()] : entity;
    const point = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const name = match[1].toLowerCase();
    if (!(name in result)) result[name] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function plain(value: string | undefined, limit: number): string | undefined {
  return value?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || undefined;
}

/** Use only metadata from the HTML already fetched by the scanner. */
export function extractSitePreview(html: string, pageUrl: string): Preview | undefined {
  // Raw-text elements and comments are not metadata, including apparent tags in JS.
  const source = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|template|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const metadata = new Map<string, string[]>();
  let baseUrl = pageUrl;
  let hasBase = false;
  let hasTitle = false;
  let title: string | undefined;
  for (const match of source.matchAll(/<(meta|base|title)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tagName = match[1].toLowerCase();
    const attrs = attributes(match[0]);
    if (tagName === 'base' && !hasBase && attrs.href) {
      hasBase = true;
      try { baseUrl = normalizeTarget(new URL(attrs.href, pageUrl).href).url; } catch { /* Ignore unsafe document bases. */ }
    } else if (tagName === 'title' && !hasTitle) {
      hasTitle = true;
      const rest = source.slice((match.index ?? 0) + match[0].length);
      const end = rest.search(/<\/title\s*>/i);
      if (end >= 0) title = plain(decodeEntities(rest.slice(0, end)), 200);
    } else if (tagName === 'meta') {
      const key = (attrs.property ?? attrs.name ?? '').trim().toLowerCase();
      if (attrs.content && ['og:title', 'og:site_name', 'og:description', 'description', 'og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'].includes(key)) {
        const values = metadata.get(key) ?? [];
        if (values.length < 20) values.push(attrs.content);
        metadata.set(key, values);
      }
    }
  }
  const first = (...keys: string[]) => keys.flatMap((key) => metadata.get(key) ?? []).find((value) => value.trim());
  const preview: Preview = {};
  preview.title = plain(first('og:title', 'og:site_name'), 200) ?? title;
  preview.description = plain(first('og:description', 'description'), 500);
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    for (const candidate of metadata.get(key) ?? []) {
      try {
        if (candidate.length > 4096) continue;
        preview.imageUrl = normalizeTarget(new URL(candidate.trim(), baseUrl).href).url;
        break;
      } catch { /* Try the next declared image when this URL is unsafe or malformed. */ }
    }
    if (preview.imageUrl) break;
  }
  return preview.title || preview.description || preview.imageUrl ? preview : undefined;
}

function matchesImageType(bytes: Uint8Array, mime: string): boolean {
  const prefix = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.slice(start, start + count));
  switch (mime) {
    case 'image/jpeg': return prefix(0xff, 0xd8, 0xff);
    case 'image/png': return prefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    case 'image/webp': return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
    case 'image/avif': {
      if (bytes.length < 16 || ascii(4, 4) !== 'ftyp') return false;
      const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      if (boxSize < 16 || boxSize > bytes.length || boxSize > 256) return false;
      if (['avif', 'avis'].includes(ascii(8, 4))) return true;
      for (let index = 16; index + 4 <= boxSize; index += 4) if (['avif', 'avis'].includes(ascii(index, 4))) return true;
      return false;
    }
    default: return false;
  }
}

export function unavailablePreviewImage(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** The route supplies only an image URL read from a persisted observation. */
export async function fetchSitePreviewImage(imageUrl: string, fetcher: Fetcher = publicFetch, dnsCheck: typeof assertPublicDns = assertPublicDns): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    let url = imageUrl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const valid = validateFetchUrl(url, imageUrl, 'html');
      await dnsCheck(valid, controller.signal);
      controller.signal.throwIfAborted();
      const response = await fetcher(valid.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': 'NAIKEN-Prototype/0.1 (site-preview)' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) return unavailablePreviewImage();
        url = new URL(location, valid).href;
        continue;
      }
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const size = Number(response.headers.get('content-length') ?? '0');
      if (!response.ok || !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(mime) || !Number.isFinite(size) || size < 0 || size > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        return unavailablePreviewImage();
      }
      const reader = response.body?.getReader();
      if (!reader) return unavailablePreviewImage();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const next = await reader.read();
          controller.signal.throwIfAborted();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_IMAGE_BYTES) { await reader.cancel(); return unavailablePreviewImage(); }
          chunks.push(next.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      if (!matchesImageType(body, mime)) return unavailablePreviewImage();
      return new Response(body.buffer, { headers: {
        'Content-Type': mime, 'Content-Length': String(bytes),
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Referrer-Policy': 'no-referrer',
      } });
    }
  } catch { /* Invalid, inaccessible and unsupported images all use the same fallback. */ }
  finally { clearTimeout(timer); }
  return unavailablePreviewImage();
}
