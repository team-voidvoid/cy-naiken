import type { DiagnosisSummary, HistoryResponse } from './history-types.ts';
import { normalizeTarget } from './targets.ts';

export interface HistoryOptions {
  limit: number;
  url?: string;
  query?: string;
  cursor?: { createdAt: number; id: string };
}

export class InvalidHistoryRequest extends Error {}

export function parseHistoryOptions(params: URLSearchParams): HistoryOptions {
  const limitValue = params.get('limit');
  if (limitValue !== null && !/^[1-9]\d?$/.test(limitValue)) throw new InvalidHistoryRequest('表示件数を確認してください。');
  const limit = limitValue === null ? 12 : Number(limitValue);
  if (limit > 50) throw new InvalidHistoryRequest('表示件数は50件以内で指定してください。');
  const query = params.get('q')?.trim();
  if (query && query.length > 200) throw new InvalidHistoryRequest('検索語は200文字以内で入力してください。');
  const rawUrl = params.get('url');
  let url: string | undefined;
  if (rawUrl !== null) {
    if (rawUrl.length > 2048) throw new InvalidHistoryRequest('URLが長すぎます。');
    try { url = normalizeTarget(rawUrl).url; }
    catch (error) { throw new InvalidHistoryRequest(error instanceof Error ? error.message : 'URLを確認してください。'); }
  }
  const rawCursor = params.get('cursor');
  let cursor: HistoryOptions['cursor'];
  if (rawCursor !== null) {
    try {
      if (!rawCursor || rawCursor.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(rawCursor)) throw new Error();
      const parsed: unknown = JSON.parse(atob(rawCursor.replace(/-/g, '+').replace(/_/g, '/')));
      if (!parsed || typeof parsed !== 'object' || !('createdAt' in parsed) || !('id' in parsed)
        || typeof parsed.createdAt !== 'number' || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0
        || typeof parsed.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(parsed.id)) throw new Error();
      cursor = { createdAt: parsed.createdAt, id: parsed.id };
    } catch { throw new InvalidHistoryRequest('履歴の続きの指定が無効です。再度一覧を開いてください。'); }
  }
  return { limit, ...(url ? { url } : {}), ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) };
}

// Kept identical to the partial index predicates in db/schema.ts.
const eligible = (alias: string) => `json_extract(${alias}.payload, '$.mode') = 'live'
  AND json_extract(${alias}.payload, '$.status') IN ('complete', 'preliminary')`;

export function historyQuery(options: HistoryOptions): { sql: string; bindings: Array<string | number> } {
  const bindings: Array<string | number> = [];
  const conditions = [eligible('d')];
  if (options.url) {
    conditions.push("json_extract(d.payload, '$.url') = ?");
    bindings.push(options.url);
  } else {
    // Select the newest eligible result for each exact normalized URL before pagination.
    conditions.push(`NOT EXISTS (SELECT 1 FROM diagnoses newer
      WHERE ${eligible('newer')}
      AND json_extract(newer.payload, '$.url') = json_extract(d.payload, '$.url')
      AND (newer.created_at > d.created_at OR (newer.created_at = d.created_at AND newer.id > d.id)))`);
  }
  if (options.query) {
    const pattern = `%${options.query.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(json_extract(d.payload, '$.url') LIKE ? ESCAPE '\\' OR json_extract(d.payload, '$.siteName') LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern);
  }
  if (options.cursor) {
    conditions.push('(d.created_at < ? OR (d.created_at = ? AND d.id < ?))');
    bindings.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
  }
  bindings.push(options.limit + 1);
  return {
    sql: `SELECT d.id, d.created_at AS sortCreatedAt,
      json_extract(d.payload, '$.url') AS url,
      json_extract(d.payload, '$.siteName') AS siteName,
      json_extract(d.payload, '$.status') AS status,
      json_extract(d.payload, '$.createdAt') AS createdAt,
      json_extract(d.payload, '$.updatedAt') AS updatedAt,
      json_extract(d.payload, '$.headline') AS headline,
      json_extract(d.payload, '$.summary') AS summary,
      json_extract(d.payload, '$.checkedCount') AS checkedCount,
      json_extract(d.payload, '$.score') AS score,
      json_extract(d.payload, '$.observation.outcome') AS outcome,
      json_extract(d.payload, '$.observation.preview.imageUrl') AS previewImage,
      json_extract(r.payload, '$.status') AS researchStatus
      FROM diagnoses d LEFT JOIN research_jobs r ON r.diagnosis_id = d.id
      WHERE ${conditions.join('\nAND ')}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
    bindings,
  };
}

export interface HistoryRow {
  id: string; sortCreatedAt: number; url: string; siteName: string;
  status: DiagnosisSummary['status']; createdAt: string; updatedAt: string;
  headline: string; summary: string; checkedCount: number; score: number;
  outcome?: string | null; previewImage?: string | null; researchStatus?: string | null;
}

export function historyResponse(rows: HistoryRow[], limit: number): HistoryResponse {
  const visible = rows.slice(0, limit);
  const diagnoses: DiagnosisSummary[] = visible.map((row) => ({
    id: row.id, url: row.url, siteName: row.siteName, status: row.status,
    createdAt: row.createdAt, updatedAt: row.updatedAt, headline: row.headline,
    summary: row.summary, checkedCount: row.checkedCount, score: row.score,
    ...(['ok', 'blocked', 'timeout', 'error'].includes(row.outcome ?? '') ? { outcome: row.outcome as DiagnosisSummary['outcome'] } : {}),
    ...(typeof row.previewImage === 'string' && row.previewImage ? { imageUrl: `/api/diagnoses/${encodeURIComponent(row.id)}/image` } : {}),
    ...(['starting', 'running', 'completed', 'failed'].includes(row.researchStatus ?? '') ? { researchStatus: row.researchStatus as DiagnosisSummary['researchStatus'] } : {}),
  }));
  const last = visible.at(-1);
  const nextCursor = rows.length > limit && last
    ? btoa(JSON.stringify({ createdAt: last.sortCreatedAt, id: last.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : null;
  return { diagnoses, nextCursor };
}
