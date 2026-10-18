import { normalizeTarget } from './targets.ts';
import { inspectTechnologies, referencedScripts } from './technology/scanner.ts';
import { publicFetch } from './public-fetch.ts';
import type { ComponentInfo } from './diagnosis-types.ts';

export interface ArchiveSnapshot {
  timestamp: string; sourceUrl: string; status: 'observed' | 'unavailable';
  components: ComponentInfo[]; scriptsRead: number; scriptsSkipped: number;
  truncated?: boolean;
  failure?: ArchiveFailure;
}
export interface ArchiveFailure {
  code: 'no_captures' | 'invalid_response' | 'network' | 'timeout' | 'rate_limited' | 'access_denied' | 'http_error' | 'redirected' | 'capture_mismatch' | 'budget';
  message: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
}
export interface ArchiveHistory {
  checkedAt: string; fromYear: number; toYear: number;
  status: 'available' | 'unavailable'; snapshots: ArchiveSnapshot[];
  changes: { name: string; fromVersion: string; toVersion: string; from: string; to: string }[];
  note: string;
  failure?: ArchiveFailure;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const ORIGIN = 'https://web.archive.org';
const NOTE = '年ごと最大1件、直近4暦年の保存記録を比較します。保存日時は更新日時ではありません。記録の欠落や版不明の期間があり、更新回数・頻度や安全性は確定できません。JSはHTMLと同じ保存日時の応答だけを採用します。';

/** Reject queries rather than silently sending tokens or changing the target. */
export function archiveTarget(input: string): string {
  const url = new URL(normalizeTarget(input).url);
  if (url.search || /%(?:00|0a|0d|2f|5c)/i.test(url.pathname)) throw new Error('履歴調査はクエリや特殊なエスケープを含まない公開URLのみ対応しています。');
  return url.href;
}
function replay(timestamp: string, original: string) { return `${ORIGIN}/web/${timestamp}id_/${original}`; }
function stamp(date: Date) { return date.toISOString().replace(/[-:T]/g, '').slice(0, 14); }
function validStamp(value: string) {
  if (!/^\d{14}$/.test(value)) return false;
  const date = new Date(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}Z`);
  return Number.isFinite(date.getTime()) && stamp(date) === value;
}

class ArchiveFetchError extends Error {
  readonly failure: ArchiveFailure;
  constructor(failure: ArchiveFailure) { super(failure.message); this.failure = failure; }
}
function failure(error: unknown): ArchiveFailure {
  return error instanceof ArchiveFetchError ? error.failure : { code: 'network', message: 'Internet Archive との通信に失敗しました。時間をおいて再取得してください。' };
}
function retryDelay(response: Response): number {
  const header = response.headers.get('retry-after');
  const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? (Date.parse(header) - Date.now()) / 1000 : 60;
  return Number.isFinite(seconds) ? Math.max(30, Math.ceil(seconds)) : 60;
}
function matchingOriginal(original: string, target: string): string | undefined {
  try {
    // CDX exact matching canonicalizes HTTP(S) and www. Replay the returned
    // original, while still rejecting different paths, subdomains and queries.
    const archived = new URL(archiveTarget(original)), requested = new URL(target);
    if (new URL(original).hash || archived.hostname.replace(/^www\d*\./, '') !== requested.hostname.replace(/^www\d*\./, '') || archived.pathname !== requested.pathname) return;
    return archived.href;
  } catch { return; }
}
export function observedChanges(snapshots: ArchiveSnapshot[]): ArchiveHistory['changes'] {
  const names = new Set(snapshots.flatMap(s => s.components.map(c => c.name)));
  return [...names].flatMap(name => {
    // Compare only adjacent sampled snapshots. Missing/ambiguous versions break the chain.
    const changes: ArchiveHistory['changes'] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const before = snapshots[i - 1], after = snapshots[i];
      const a = before.components.find(c => c.name === name), b = after.components.find(c => c.name === name);
      if (before.status === 'observed' && after.status === 'observed' && a?.version && b?.version && a.version !== b.version)
        changes.push({ name, fromVersion: a.version, toVersion: b.version, from: before.timestamp, to: after.timestamp });
    }
    return changes;
  });
}

export async function collectArchiveHistory(input: string, fetcher: Fetcher = publicFetch, now = new Date()): Promise<ArchiveHistory> {
  const target = archiveTarget(input);
  const toYear = now.getUTCFullYear(), fromYear = toYear - 3;
  const result: ArchiveHistory = { checkedAt: now.toISOString(), fromYear, toYear, status: 'unavailable', snapshots: [], changes: [], note: NOTE };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ArchiveFetchError({ code: 'timeout', message: 'Internet Archive の応答が制限時間に間に合いませんでした。時間をおいて再取得してください。' })), 25_000);
  let requests = 0, bytes = 0;
  const read = async (url: string, mime: RegExp, timestamp?: string) => {
    const parsed = new URL(url);
    controller.signal.throwIfAborted();
    if (parsed.origin !== ORIGIN || parsed.username || parsed.password || ++requests > 13) throw new ArchiveFetchError({ code: 'budget', message: '履歴の取得件数が上限に達しました。' });
    let response: Response;
    try { response = await fetcher(url, { redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { Accept: 'text/html,application/javascript,application/json,text/plain;q=0.8' } }); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    if ([403, 429].includes(response.status)) {
      const denied: ArchiveFailure = response.status === 429
        ? { code: 'rate_limited', message: 'Internet Archive のリクエスト制限に達しました。時間をおいて再取得してください。', httpStatus: 429, retryAfterSeconds: retryDelay(response) }
        : { code: 'access_denied', message: 'Internet Archive がアクセスを拒否しました（HTTP 403）。保存記録の有無は確認できていません。', httpStatus: 403, retryAfterSeconds: 60 };
      controller.abort(new ArchiveFetchError(denied));
      await response.body?.cancel();
      throw controller.signal.reason;
    }
    // Never follow replay redirects, including nearest-capture or live-site redirects.
    if (response.status !== 200 || !mime.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) throw new ArchiveFetchError({ code: 'redirected', message: '別の保存日時やページへの転送が返されたため、この保存本文は比較していません。', httpStatus: response.status });
      if (response.status !== 200) throw new ArchiveFetchError({ code: 'http_error', message: `Internet Archive から HTTP ${response.status} が返され、取得できませんでした。`, httpStatus: response.status });
      throw new ArchiveFetchError({ code: 'invalid_response', message: 'Internet Archive の応答が期待した形式ではありませんでした。' });
    }
    if (timestamp) {
      const datetime = new Date(response.headers.get('memento-datetime') ?? '');
      if (!Number.isFinite(datetime.getTime()) || stamp(datetime) !== timestamp) { await response.body?.cancel(); throw new ArchiveFetchError({ code: 'capture_mismatch', message: '指定した保存日時と本文の保存日時が一致しないため、比較していません。' }); }
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ArchiveFetchError({ code: 'invalid_response', message: 'Internet Archive から本文が返されませんでした。' });
    const decoder = new TextDecoder(); let text = '', size = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; bytes += chunk.value.byteLength;
        if (size > 1_000_000 || bytes > 6_000_000) { await reader.cancel(); throw new ArchiveFetchError({ code: 'budget', message: '保存本文が解析サイズの上限を超えたため、確認できませんでした。' }); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    finally { reader.releaseLock(); }
  };
  try {
    const cdx = new URL(`${ORIGIN}/cdx/search/cdx`);
    cdx.search = new URLSearchParams({ url: target, matchType: 'exact', output: 'json', fl: 'timestamp,original,mimetype,statuscode', from: String(fromYear), to: stamp(now), collapse: 'timestamp:4', limit: '4' }).toString();
    cdx.searchParams.append('filter', 'statuscode:200'); cdx.searchParams.append('filter', 'mimetype:text/html');
    const index = await read(cdx.href, /json/i);
    let rows: unknown;
    try { rows = JSON.parse(index); }
    catch { throw new ArchiveFetchError({ code: 'invalid_response', message: 'Internet Archive の保存一覧を読み取れませんでした。' }); }
    if (!Array.isArray(rows)) throw new ArchiveFetchError({ code: 'invalid_response', message: 'Internet Archive の保存一覧が期待した形式ではありませんでした。' });
    if (rows.length === 0) { result.failure = { code: 'no_captures', message: '指定したURLと期間の保存記録は見つかりませんでした。' }; return result; }
    if (JSON.stringify(rows[0]) !== JSON.stringify(['timestamp','original','mimetype','statuscode'])) throw new ArchiveFetchError({ code: 'invalid_response', message: 'Internet Archive の保存一覧が期待した形式ではありませんでした。' });
    const seen = new Set<string>();
    for (const row of rows.slice(1, 5)) {
      if (!Array.isArray(row) || row.length !== 4) continue;
      const [timestamp, original, mime, status] = row;
      const archivedUrl = typeof original === 'string' ? matchingOriginal(original, target) : undefined;
      if (typeof timestamp !== 'string' || !validStamp(timestamp) || timestamp < `${fromYear}0101000000` || timestamp > stamp(now) || seen.has(timestamp.slice(0,4)) || !archivedUrl || mime !== 'text/html' || status !== '200') continue;
      seen.add(timestamp.slice(0,4));
      const sourceUrl = replay(timestamp, archivedUrl);
      const snapshot: ArchiveSnapshot = { timestamp, sourceUrl, status: 'unavailable', components: [], scriptsRead: 0, scriptsSkipped: 0 };
      result.snapshots.push(snapshot);
      try {
        const body = await read(sourceUrl, /text\/html|application\/xhtml\+xml/i, timestamp);
        const candidates = [...new Set(referencedScripts(body, archivedUrl))];
        const scripts: {url:string;body:string}[] = [];
        snapshot.scriptsSkipped = Math.max(0, candidates.length - 2);
        for (const candidate of candidates.slice(0, 2)) {
          try {
            const scriptUrl = archiveTarget(candidate);
            const archived = replay(timestamp, scriptUrl);
            scripts.push({ url: scriptUrl, body: await read(archived, /(?:java|ecma)script|text\/plain/i, timestamp) });
          } catch { snapshot.scriptsSkipped++; }
        }
        // Replay response headers belong to Archive, not the historical origin.
        const detected = inspectTechnologies({ url: archivedUrl, body, headers: new Headers() }, scripts);
        snapshot.components = detected.components.map(c => ({ ...c, evidence: c.evidence.map(e => {
          let url = sourceUrl;
          try { if (e.url) url = replay(timestamp, archiveTarget(e.url)); } catch { /* Keep HTML provenance when a script reference contains an excluded query. */ }
          return { ...e, url };
        }) }));
        snapshot.truncated = detected.coverage.inputTruncated || detected.coverage.evidenceTruncated || !detected.coverage.htmlParsedCompletely;
        snapshot.scriptsRead = scripts.length; snapshot.status = 'observed';
      } catch (error) { snapshot.failure = failure(error); }
    }
    result.snapshots.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
    result.changes = observedChanges(result.snapshots);
    if (result.snapshots.some(s => s.status === 'observed')) result.status = 'available';
    else result.failure = (controller.signal.aborted ? failure(controller.signal.reason) : result.snapshots.find(s => s.failure)?.failure) ?? {
      code: rows.length === 1 ? 'no_captures' : 'invalid_response',
      message: rows.length === 1 ? '指定したURLと期間の保存記録は見つかりませんでした。' : '保存一覧から、対象URLと一致する有効な記録を確認できませんでした。',
    };
    return result;
  } catch (error) { result.failure = failure(error); return result; }
  finally { clearTimeout(timer); }
}

// Bounded per-isolate cache and in-flight coalescing; global DB rate limits live in the route.
export function createArchiveHistoryCache(collect: (target: string) => Promise<ArchiveHistory> = collectArchiveHistory, clock = Date.now) {
  const cache = new Map<string, { expires: number; value: Promise<ArchiveHistory> }>();
  return async (input: string): Promise<ArchiveHistory> => {
    const target = archiveTarget(input), now = clock();
    let entry = cache.get(target);
    if (!entry || entry.expires <= now) {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      const pending = { expires: Infinity, value: Promise.resolve().then(() => collect(target)) };
      pending.value = pending.value.then(value => {
        const ttl = value.status === 'available' ? 3_600_000 : Math.max(30, value.failure?.retryAfterSeconds ?? 30) * 1000;
        pending.expires = clock() + ttl;
        return value;
      }, error => { if (cache.get(target) === pending) cache.delete(target); throw error; });
      cache.set(target, pending);
      entry = pending;
    }
    const value = await entry.value;
    return value.status === 'available' ? value : { ...value, failure: {
      ...value.failure ?? { code: 'network', message: '履歴を取得できませんでした。' },
      retryAfterSeconds: Math.max(0, Math.ceil((entry.expires - clock()) / 1000)),
    } };
  };
}
export const cachedArchiveHistory = createArchiveHistoryCache();
