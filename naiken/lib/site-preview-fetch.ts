import { assertPublicDns } from './public-dns.ts';
import { publicFetch } from './public-fetch.ts';
import { extractSitePreview } from './site-preview.ts';
import { normalizeTarget } from './targets.ts';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_HTML_BYTES = 1024 * 1024;

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fetch metadata only: no scripts, inspection, scoring or AI requests. */
export async function fetchSitePreview(input: string, fetcher: Fetcher = publicFetch, dnsCheck: typeof assertPublicDns = assertPublicDns) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('OGPの取得が時間上限に達しました。', 'TimeoutError')), 7_000);
  try {
    let url = normalizeTarget(input).url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      url = normalizeTarget(url).url;
      await abortable(dnsCheck(new URL(url), controller.signal), controller.signal);
      const response = await abortable(fetcher(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'NAIKEN-Prototype/0.1 (site-preview)' },
      }), controller.signal);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('OGPの転送先を確認できませんでした。');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || response.headers.get('cf-mitigated') === 'challenge' || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new Error('OGPを取得できる公開HTMLではありません。');
      }
      const reader = response.body?.getReader();
      if (!reader) return undefined;
      const decoder = new TextDecoder();
      let html = '';
      let bytes = 0;
      try {
        while (true) {
          const next = await abortable(reader.read(), controller.signal);
          if (next.done) break;
          const chunk = next.value.subarray(0, MAX_HTML_BYTES - bytes);
          bytes += chunk.byteLength;
          html += decoder.decode(chunk, { stream: true });
          // Metadata is normally in the head; avoid downloading the rest of a large page.
          if (bytes >= MAX_HTML_BYTES || /<\/head\s*>/i.test(html)) { await reader.cancel(); break; }
        }
        html += decoder.decode();
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      if (/<title\b[^>]*>\s*(?:just a moment|access denied|attention required|robot check|security check)/i.test(html) || /id\s*=\s*["']challenge-(?:running|form)["']/i.test(html)) {
        throw new Error('OGPの取得が拒否されました。');
      }
      return extractSitePreview(html, url);
    }
    return undefined;
  } finally { clearTimeout(timer); }
}
