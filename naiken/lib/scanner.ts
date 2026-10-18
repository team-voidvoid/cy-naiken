import type { Finding, Observation } from './diagnosis-types.ts';
import { normalizeTarget, validateFetchUrl } from './targets.ts';
import { assertPublicDns } from './public-dns.ts';
import { publicFetch } from './public-fetch.ts';
import { inspectTechnologies, referencedScripts, type ScriptSource } from './technology/scanner.ts';
import { extractSitePreview } from './site-preview.ts';
import type { VersionEnricher } from './version-extraction.ts';

const LIMITS = { bytes: 10 * 1024 * 1024, requests: 28, scripts: 5, timeout: 19_000 };
const REQUEST_TIMEOUTS = { html: 7_000, http: 2_000, script: 3_000 };
const USER_AGENT = 'NAIKEN-Prototype/0.1 (public-page-inspection; no-authentication)';
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type FetchResult = { response: Response; text: string; url: string; hash?: string };
class LimitError extends Error {}
function attrs(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4]).replace(/&amp;/g, '&');
  return result;
}
function clean(value: string) { return value.replace(/[\u0000-\u001f]/g, ' ').slice(0, 600); }
function challenge(response: Response, text: string): boolean {
  return [401, 403, 407, 429].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge' || /<title[^>]*>\s*(?:just a moment|access denied|attention required|robot check|security check)/i.test(text) || /id=["']challenge-(?:running|form)["']/i.test(text);
}
export async function observe(input: string, fetcher: Fetcher = publicFetch, timeouts: Partial<typeof REQUEST_TIMEOUTS> = {}, dnsCheck: typeof assertPublicDns = assertPublicDns, enrichVersions?: VersionEnricher): Promise<Observation> {
  const target = normalizeTarget(input);
  const observation: Observation = { url: target.url, finalUrl: target.url, status: 0, fetchedAt: new Date().toISOString(), bytes: 0, userAgent: USER_AGENT, outcome: 'error', findings: [], components: [], checkedCategories: [], scriptsFetched: 0, scriptsSkipped: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeout);
  let requests = 0;
  const checkedHosts = new Set<string>();
  const request = async (inputUrl: string, kind: 'html' | 'script'): Promise<FetchResult> => {
    const phase = kind === 'script' ? 'script' : inputUrl.startsWith('http:') ? 'http' : 'html';
    const timeout = Math.max(1, Math.min(timeouts[phase] ?? REQUEST_TIMEOUTS[phase], REQUEST_TIMEOUTS[phase]));
    const requestController = new AbortController();
    const abortWithOverallDeadline = () => requestController.abort(controller.signal.reason);
    controller.signal.addEventListener('abort', abortWithOverallDeadline, { once: true });
    if (controller.signal.aborted) abortWithOverallDeadline();
    const requestTimer = setTimeout(() => requestController.abort(new DOMException('この取得の時間上限に達しました。', 'TimeoutError')), timeout);
    // A per-resource deadline covers its full redirect chain and response body.
    // Cancelling one resource must not abort the shared overall controller.
    try {
      let url = inputUrl;
      for (let redirects = 0; redirects <= 3; redirects++) {
        const valid = validateFetchUrl(url, target.url, kind);
        if (requestController.signal.aborted) throw requestController.signal.reason;
        if (!checkedHosts.has(valid.hostname)) {
          await dnsCheck(valid, requestController.signal);
          checkedHosts.add(valid.hostname);
        }
        if (++requests > LIMITS.requests) throw new LimitError('通信回数の上限に達しました。');
        const response = await fetcher(valid.href, { method: 'GET', redirect: 'manual', signal: requestController.signal, credentials: 'omit', cache: 'no-store', headers: { 'User-Agent': USER_AGENT, Accept: kind === 'html' ? 'text/html' : 'application/javascript,text/javascript,text/plain;q=0.8' } });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 3) throw new Error('リダイレクトの上限、または転送先不明のため中止しました。');
          url = new URL(location, valid).href;
          continue;
        }
        const size = Number(response.headers.get('content-length') ?? '0');
        if (size > LIMITS.bytes - observation.bytes) { await response.body?.cancel(); throw new LimitError('取得サイズの上限に達しました。'); }
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let text = '';
        const chunks: Uint8Array[] = [];
        let bodyBytes = 0;
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              observation.bytes += chunk.value.byteLength;
              if (observation.bytes > LIMITS.bytes) { await reader.cancel(); throw new LimitError('取得サイズの上限に達しました。'); }
              if (kind === 'html') { chunks.push(chunk.value); bodyBytes += chunk.value.byteLength; }
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally { reader.releaseLock(); }
        }
        let hash: string | undefined;
        if (kind === 'html') {
          const body = new Uint8Array(bodyBytes);
          let offset = 0;
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
          hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body))).map((part) => part.toString(16).padStart(2, '0')).join('');
        }
        return { response, text, url: valid.href, hash };
      }
      throw new Error('転送を中止しました。');
    } finally {
      clearTimeout(requestTimer);
      controller.signal.removeEventListener('abort', abortWithOverallDeadline);
    }
  };
  try {
    const page = await request(target.url, 'html');
    observation.finalUrl = page.url;
    observation.status = page.response.status;
    if (challenge(page.response, page.text)) {
      observation.outcome = 'blocked';
      observation.message = 'この取得条件ではアクセス拒否または確認画面が返りました。理由や危険性は断定せず、通常ページとして採点しません。';
      return observation;
    }
    if (!page.response.ok || !/text\/html|application\/xhtml\+xml/i.test(page.response.headers.get('content-type') ?? '')) throw new Error('通常の HTML ページを取得できませんでした。');
    observation.outcome = 'ok';
    observation.hash = page.hash;
    observation.preview = extractSitePreview(page.text, page.url);
    observation.checkedCategories = ['headers', 'cookies', 'components', 'csrf'];
    const headers = page.response.headers;
    const html = page.text.replace(/<!--[\s\S]*?-->/g, '');
    const finding = (id: string, category: Finding['category'], title: string, explanation: string, value: string, points: number, confidence: Finding['confidence'] = 'confirmed', label = '今回取得した応答') => {
      observation.findings.push({ id, category, title, explanation, points, confidence, evidence: [{ label, value: clean(value), url: page.url }] });
    };
    const metaPolicies = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => attrs(match[0])).filter((tag) => tag['http-equiv']?.toLowerCase() === 'content-security-policy').map((tag) => tag.content ?? '');
    const cspHeader = headers.get('content-security-policy') ?? '';
    const csp = [cspHeader, ...metaPolicies].join(';');
    if (!/(?:^|;)\s*(?:script-src(?:-elem)?|default-src)\s+[^;]+/i.test(csp)) finding('csp', 'headers', 'スクリプトの追加制限は、確認できません。', 'CSP の実行制限が見当たりません。XSS があるという意味ではありません。Report-Only は報告専用です。', `CSP: ${csp || 'ヘッダ・meta とも未検出'}; Report-Only: ${headers.get('content-security-policy-report-only') ?? '未検出'}`, 9);
    if (!/^(?:DENY|SAMEORIGIN)$/i.test(headers.get('x-frame-options')?.trim() ?? '') && !/(?:^|;)\s*frame-ancestors\s+[^;]+/i.test(cspHeader)) finding('framing', 'headers', '別サイトへの埋め込み制限が見えません。', '今回のヘッダで X-Frame-Options または CSP の frame-ancestors を確認できません。meta の frame-ancestors は強制されません。', `X-Frame-Options: ${headers.get('x-frame-options') ?? '未検出'}; ヘッダ CSP: ${cspHeader || '未検出'}`, 5);
    if (page.url.startsWith('https:') && !headers.get('strict-transport-security')) finding('hsts', 'https', 'HTTPS を覚える指定は、今回見えません。', '今回の HTTPS 応答に HSTS がありません。保存済みの設定、親ドメインの指定、preload の有無は未確認です。', 'Strict-Transport-Security: 未検出', 5);
    if (headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') finding('nosniff', 'headers', 'ファイルの種類を守る指定が見えません。', '今回の応答に X-Content-Type-Options: nosniff を確認できません。これだけで攻撃の成立を判断しません。', `X-Content-Type-Options: ${headers.get('x-content-type-options') ?? '未検出'}`, 3);
    if (!/charset\s*=/i.test(headers.get('content-type') ?? '') && !/<meta\b[^>]*charset\s*=/i.test(html)) finding('charset', 'headers', '文字コードの指定が見当たりません。', '応答ヘッダと HTML の meta に文字コードの指定を確認できません。ブラウザでの解釈結果は未確認です。', `Content-Type: ${headers.get('content-type') ?? '未検出'}; meta charset: 未検出`, 2);
    if (page.url.startsWith('http:')) {
      observation.checkedCategories.push('https');
      finding('https-downgrade', 'https', 'HTTP のページとして応答しました。', '今回の取得では、ページの最終応答が HTTP でした。フォーム送信やブラウザの HSTS 動作は試していません。', `最終 URL: ${page.url}`, 12);
    }
    for (const name of ['server', 'x-powered-by']) {
      const value = headers.get(name);
      if (value && /\d+\.\d+/.test(value)) finding(`disclosure-${name}`, 'components', '製品名と版を、外に名乗っています。', '応答ヘッダに製品と版らしき表記があります。この値だけで実際の稼働版や脆弱性は確定しません。', `${name}: ${value}`, 4, 'inferred');
    }
    const cookieHeaders = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
    for (const line of cookieHeaders.filter(Boolean)) {
      const [nameValue, ...attributes] = line.split(';');
      const name = nameValue.slice(0, nameValue.indexOf('=')).trim();
      // Never retain cookie values, including non-standard attributes.
      const safeAttributes = attributes.map((part) => part.trim()).filter((part) => /^(?:secure|httponly|samesite=(?:strict|lax|none)|max-age=-?\d+|expires=[\w\s,:-]+)$/i.test(part));
      if (!safeAttributes.some((part) => /^secure$/i.test(part))) finding(`cookie-${observation.findings.length}`, 'cookies', '用途が分からない Cookie に Secure がありません。', 'Cookie の用途は未確認です。認証情報の漏えいは確認していません。保存期限がないことだけでログイン用 Cookie とは判断しません。', `${name}; ${safeAttributes.join('; ') || '対象属性なし'}`, 0, 'inferred', 'Cookie の名前と属性（値は保存しません）');
    }
    const insecure = [...html.matchAll(/<(?:script|img|iframe|link|form)\b[^>]*>/gi)].map((match) => ({ tag: match[0], attributes: attrs(match[0]) })).find(({ attributes }) => /^http:/i.test(attributes.src ?? attributes.href ?? attributes.action ?? ''));
    if (insecure) finding('http-reference', 'https', 'HTTP 形式の参照が書かれています。', '公開 HTML に HTTP 形式の参照があります。ブラウザや CSP による HTTPS 化・遮断を確認していないため、実際の平文通信とは断定しません。', `タグ: ${insecure.tag.match(/^<\w+/)?.[0]}; HTTP 形式の参照あり`, 3, 'inferred');
    const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)];
    const post = forms.find((match) => attrs(match[0].slice(0, match[0].indexOf('>') + 1)).method?.toLowerCase() === 'post' && !/(?:csrf|xsrf|authenticity|requestverification)token|name=["'][^"']*(?:csrf|xsrf|token)/i.test(match[0]));
    if (post) finding('csrf', 'csrf', '送信フォームのトークンは見当たりません。', 'POST フォームに CSRF 対策トークンらしき表記を確認できません。別の仕組みで対策している可能性があり、対策なしとは断定できません。', 'method=POST; HTML 内のトークンらしき表記なし', 2, 'inferred');
    const technologyPage = { url: page.url, body: page.text, headers };
    const initialTechnologies = inspectTechnologies(technologyPage);
    observation.components = initialTechnologies.components;
    observation.technologyCoverage = initialTechnologies.coverage;
    const fetchedScripts: ScriptSource[] = [];
    try {
      const httpPage = target.url.startsWith('http:') ? page : await request(target.url.replace(/^https:/, 'http:'), 'html');
      if (httpPage.response.ok && !challenge(httpPage.response, httpPage.text)) {
        observation.checkedCategories.push('https');
        if (httpPage.url.startsWith('http:')) finding('http-page', 'https', 'HTTP でもページが応答しています。', 'HTTP での取得が HTTPS に転送されず完了しました。ブラウザの HSTS 動作や入力情報の送信は試していません。', `HTTP ${httpPage.response.status}; 転送先: ${httpPage.url}`, 12);
      }
    } catch { /* HTTPS-only observations remain useful; HTTP is unconfirmed. */ }
    const scriptSources = referencedScripts(page.text, page.url);
    const candidates = [...new Set(scriptSources)].flatMap((source) => {
      try { return [validateFetchUrl(new URL(source, page.url).href, target.url, 'script').href]; } catch { observation.scriptsSkipped++; return []; }
    });
    const priority = (url: string) => /jquery|swiper|picturefill|magnific|match[.-]?height|(?:^|\/)lib(?:\.min)?\.js/i.test(url) ? 0 : new URL(url).hostname === new URL(target.url).hostname && /\/js\//.test(url) ? 1 : 2;
    candidates.sort((a, b) => priority(a) - priority(b));
    observation.scriptsSkipped += Math.max(0, candidates.length - LIMITS.scripts);
    for (const url of candidates.slice(0, LIMITS.scripts)) {
      try {
        const script = await request(url, 'script');
        if (!script.response.ok || challenge(script.response, script.text) || /text\/html/i.test(script.response.headers.get('content-type') ?? '')) { observation.scriptsSkipped++; continue; }
        observation.scriptsFetched++;
        fetchedScripts.push({ url: script.url, body: script.text });
      } catch { observation.scriptsSkipped++; }
    }
    const technologies = inspectTechnologies(technologyPage, fetchedScripts);
    observation.components = technologies.components;
    observation.technologyCoverage = technologies.coverage;
    if (controller.signal.aborted) observation.message = '取得時間の上限に達したため、確認できた範囲のみ表示しています。';
    clearTimeout(timer);
    if (enrichVersions) {
      try {
        const enriched = await enrichVersions(observation.components, fetchedScripts);
        observation.components = enriched.components;
        observation.versionExtraction = enriched.versionExtraction;
      } catch { observation.versionExtraction = { status: 'failed', requests: 0 }; }
    }
    return observation;
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
    observation.outcome = timedOut ? 'timeout' : 'error';
    observation.message = timedOut ? '取得が時間内に終わりませんでした。危険性を意味するものではありません。' : error instanceof LimitError ? error.message : 'この取得条件では対象ページを確認できませんでした。公開先を確認できない、転送先が対象外、または通信エラーの可能性があります。';
    observation.findings = []; observation.components = []; observation.checkedCategories = [];
    return observation;
  } finally { clearTimeout(timer); }
}
