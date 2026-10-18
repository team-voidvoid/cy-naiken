import { normalizeTarget } from './targets.ts';
import { assertPublicDns } from './public-dns.ts';
import { publicFetch } from './public-fetch.ts';

export interface ResearchPage {
  url: string; title: string; text: string; links: string[]; scripts: string[];
  headers: Record<string, string>; status: number; ok: boolean; error?: string; truncated: boolean;
}
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Dependencies = { fetcher?: Fetcher; dnsCheck?: typeof assertPublicDns };
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 16_000;
const HEADER_NAMES = ['content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'content-type', 'x-frame-options', 'x-content-type-options', 'server'];
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, name: string) => {
    if (!name.startsWith('#')) return ENTITIES[name] ?? whole;
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  });
}
function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}
function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const name = match[1].toLowerCase();
    if (!(name in output)) output[name] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return output;
}
function publicLink(value: string | undefined, base: string): string | undefined {
  if (!value?.trim()) return;
  try { return normalizeTarget(new URL(value, base).href).url; } catch { return; }
}

/** Abort also bounds mock/custom transports that do not implement signal handling. */
async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

function htmlContent(html: string, url: string) {
  const withoutComments = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const structure = withoutComments.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, (block, name: string) => name.toLowerCase() === 'script' ? block.slice(0, block.indexOf('>') + 1) : ' ');
  const title = plainText(structure.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '').slice(0, 300);
  // This is a source-text extraction, not browser rendering or JS execution.
  const tags = structure.match(/<(?:a|script|base)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) ?? [];
  const baseTag = tags.find((tag) => /^<base\b/i.test(tag));
  const base = baseTag ? publicLink(attributes(baseTag).href, url) ?? url : url;
  const links = new Set<string>();
  const scripts = new Set<string>();
  for (const tag of tags) {
    const isScript = /^<script\b/i.test(tag);
    if (!isScript && !/^<a\b/i.test(tag)) continue;
    const attrs = attributes(tag);
    const link = publicLink(isScript ? attrs.src : attrs.href, base);
    if (!link) continue;
    const collection = isScript ? scripts : links;
    if (collection.size < (isScript ? 15 : 30)) collection.add(link);
  }
  const visible = withoutComments
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, ' ');
  return { title, text: plainText(visible), links: [...links], scripts: [...scripts] };
}

export async function inspectPublicPage(input: string, dependencies: Dependencies = {}): Promise<ResearchPage> {
  const result: ResearchPage = { url: '', title: '', text: '', links: [], scripts: [], headers: {}, status: 0, ok: false, truncated: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('取得時間の上限に達しました。', 'TimeoutError')), 7_000);
  const fetcher = dependencies.fetcher ?? publicFetch;
  const dnsCheck = dependencies.dnsCheck ?? assertPublicDns;
  try {
    let url = normalizeTarget(input).url;
    result.url = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      controller.signal.throwIfAborted();
      url = normalizeTarget(url).url;
      result.url = url;
      // Recheck even on same-host redirects; transport enforces the actual socket destination.
      await withSignal(dnsCheck(new URL(url), controller.signal), controller.signal);
      const response = await withSignal(fetcher(url, {
        method: 'GET', credentials: 'omit', redirect: 'manual', signal: controller.signal, cache: 'no-store',
        headers: { 'User-Agent': 'NAIKEN-Prototype/0.1 (public-page-inspection; no-authentication)', Accept: 'text/html,application/xhtml+xml,application/javascript,text/javascript,text/plain;q=0.8' },
      }), controller.signal);
      result.status = response.status;
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('リダイレクトの上限、または転送先不明のため取得を中止しました。');
        url = normalizeTarget(new URL(location, url).href).url;
        continue;
      }
      if ([401, 403, 407, 429].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
        await response.body?.cancel();
        throw new Error('アクセス拒否または確認画面です。通常ページの根拠としては使用できません。');
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} のため通常ページを確認できませんでした。`); }
      const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      const isHtml = ['text/html', 'application/xhtml+xml'].includes(mime);
      if (!isHtml && !['text/plain', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'application/x-javascript'].includes(mime)) {
        await response.body?.cancel();
        throw new Error('HTML・JavaScript・プレーンテキスト以外は取得対象外です。');
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      if (!Number.isFinite(length) || length < 0 || length > MAX_BYTES) {
        await response.body?.cancel(); result.truncated = true;
        throw new Error('本文サイズが1MiBの上限を超えたため、根拠として使用しません。');
      }
      const reader = response.body?.getReader();
      let body = '';
      let bytes = 0;
      const decoder = new TextDecoder('utf-8');
      if (reader) {
        try {
          while (true) {
            const next = await withSignal(reader.read(), controller.signal);
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_BYTES) { result.truncated = true; throw new Error('本文サイズが1MiBの上限を超えたため、根拠として使用しません。'); }
            body += decoder.decode(next.value, { stream: true });
          }
          body += decoder.decode();
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
      }
      if (isHtml && (/<title\b[^>]*>\s*(?:just a moment|access denied|attention required|robot check|security check)/i.test(body) || /id\s*=\s*["']challenge-(?:running|form)["']/i.test(body))) {
        throw new Error('確認画面が返ったため、通常ページの根拠として使用できません。');
      }
      const extracted = isHtml ? htmlContent(body, url) : { title: '', text: body, links: [], scripts: [] };
      result.title = extracted.title;
      result.text = extracted.text.slice(0, MAX_TEXT);
      result.links = extracted.links;
      result.scripts = extracted.scripts;
      result.truncated = extracted.text.length > MAX_TEXT;
      for (const name of HEADER_NAMES) {
        const value = response.headers.get(name);
        if (value !== null) result.headers[name] = value.slice(0, 4_000);
      }
      result.ok = true;
      return result;
    }
    throw new Error('転送を完了できませんでした。');
  } catch (error) {
    // Error responses and partial body data are never returned as usable evidence.
    return { ...result, title: '', text: '', links: [], scripts: [], headers: {}, ok: false,
      error: controller.signal.aborted ? '取得が7秒以内に完了しませんでした。' : error instanceof Error ? error.message : '公開ページを取得できませんでした。' };
  } finally { clearTimeout(timer); }
}
