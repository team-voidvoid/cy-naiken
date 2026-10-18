import { normalizeTarget } from './targets.ts';
import { inspectTechnologies, referencedScripts } from './technology/scanner.ts';
import { publicFetch } from './public-fetch.ts';
import type { ComponentInfo } from './diagnosis-types.ts';

export interface ArchiveSnapshot {
  timestamp: string; sourceUrl: string; status: 'observed' | 'unavailable';
  components: ComponentInfo[]; scriptsRead: number; scriptsSkipped: number;
  truncated?: boolean;
}
export interface ArchiveHistory {
  checkedAt: string; fromYear: number; toYear: number;
  status: 'available' | 'unavailable'; snapshots: ArchiveSnapshot[];
  changes: { name: string; fromVersion: string; toVersion: string; from: string; to: string }[];
  note: string;
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
  const timer = setTimeout(() => controller.abort(), 25_000);
  let requests = 0, bytes = 0;
  const read = async (url: string, mime: RegExp, timestamp?: string) => {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN || parsed.username || parsed.password || ++requests > 13 || controller.signal.aborted) throw new Error('budget');
    const response = await fetcher(url, { redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { Accept: 'text/html,application/javascript,application/json,text/plain;q=0.8' } });
    if ([403, 429].includes(response.status)) controller.abort();
    // Never follow replay redirects, including nearest-capture or live-site redirects.
    if (response.status !== 200 || !mime.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('unavailable'); }
    if (timestamp) {
      const datetime = new Date(response.headers.get('memento-datetime') ?? '');
      if (!Number.isFinite(datetime.getTime()) || stamp(datetime) !== timestamp) { await response.body?.cancel(); throw new Error('capture mismatch'); }
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty');
    const decoder = new TextDecoder(); let text = '', size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; bytes += chunk.value.byteLength;
        if (size > 1_000_000 || bytes > 6_000_000) { await reader.cancel(); throw new Error('size budget'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { reader.releaseLock(); }
  };
  try {
    const cdx = new URL(`${ORIGIN}/cdx/search/cdx`);
    cdx.search = new URLSearchParams({ url: target, matchType: 'exact', output: 'json', fl: 'timestamp,original,mimetype,statuscode', from: String(fromYear), to: stamp(now), collapse: 'timestamp:4', limit: '4' }).toString();
    cdx.searchParams.append('filter', 'statuscode:200'); cdx.searchParams.append('filter', 'mimetype:text/html');
    const rows: unknown = JSON.parse(await read(cdx.href, /json/i));
    if (!Array.isArray(rows) || JSON.stringify(rows[0]) !== JSON.stringify(['timestamp','original','mimetype','statuscode'])) return result;
    const seen = new Set<string>();
    for (const row of rows.slice(1, 5)) {
      if (!Array.isArray(row) || row.length !== 4) continue;
      const [timestamp, original, mime, status] = row;
      if (typeof timestamp !== 'string' || !validStamp(timestamp) || timestamp < `${fromYear}0101000000` || timestamp > stamp(now) || seen.has(timestamp.slice(0,4)) || original !== target || mime !== 'text/html' || status !== '200') continue;
      seen.add(timestamp.slice(0,4));
      const sourceUrl = replay(timestamp, target);
      const snapshot: ArchiveSnapshot = { timestamp, sourceUrl, status: 'unavailable', components: [], scriptsRead: 0, scriptsSkipped: 0 };
      result.snapshots.push(snapshot);
      try {
        const body = await read(sourceUrl, /text\/html|application\/xhtml\+xml/i, timestamp);
        const candidates = [...new Set(referencedScripts(body, target))];
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
        const detected = inspectTechnologies({ url: target, body, headers: new Headers() }, scripts);
        snapshot.components = detected.components.map(c => ({ ...c, evidence: c.evidence.map(e => ({ ...e, url: e.url ? replay(timestamp, archiveTarget(e.url)) : sourceUrl })) }));
        snapshot.truncated = detected.coverage.inputTruncated || detected.coverage.evidenceTruncated || !detected.coverage.htmlParsedCompletely;
        snapshot.scriptsRead = scripts.length; snapshot.status = 'observed';
      } catch { /* Missing/excluded/blocked captures remain explicitly unavailable. */ }
    }
    result.snapshots.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
    result.changes = observedChanges(result.snapshots);
    if (result.snapshots.some(s => s.status === 'observed')) result.status = 'available';
    return result;
  } catch { return result; }
  finally { clearTimeout(timer); }
}

// Bounded per-isolate cache and in-flight coalescing; global DB rate limits live in the route.
const cache = new Map<string, { expires: number; value: Promise<ArchiveHistory> }>();
export function cachedArchiveHistory(input: string): Promise<ArchiveHistory> {
  const target = archiveTarget(input), now = Date.now();
  const entry = cache.get(target);
  if (entry && entry.expires > now) return entry.value;
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  const value = collectArchiveHistory(target);
  cache.set(target, { expires: now + 3_600_000, value });
  return value;
}
