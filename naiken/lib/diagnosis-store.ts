import { env } from 'cloudflare:workers';
import type { Diagnosis } from './diagnosis-types';
import { historyQuery, historyResponse, type HistoryOptions, type HistoryRow } from './diagnosis-history';
import { reserveDiagnosisIn } from './diagnosis-reservation';

function database() {
  if (!env.DB) throw new Error('診断結果の保存先が利用できません。');
  return env.DB;
}

export async function listDiagnosisHistory(options: HistoryOptions) {
  const { sql, bindings } = historyQuery(options);
  const result = await database().prepare(sql).bind(...bindings).all<HistoryRow>();
  return historyResponse(result.results, options.limit);
}

export async function findDiagnosis(id: string): Promise<Diagnosis | null> {
  const row = await database().prepare('SELECT payload FROM diagnoses WHERE id = ?').bind(id).first<{payload:string}>();
  return row ? JSON.parse(row.payload) as Diagnosis : null;
}

export async function reserveDiagnosis(value: Diagnosis, cacheKey: string): Promise<{value:Diagnosis; owned:boolean}> {
  return reserveDiagnosisIn(database(), value, cacheKey);
}

export async function saveDiagnosis(value: Diagnosis, expectedStatus?: Diagnosis['status']) {
  const query = expectedStatus
    ? database().prepare("UPDATE diagnoses SET payload = ? WHERE id = ? AND json_extract(payload, '$.status') = ?").bind(JSON.stringify(value), value.id, expectedStatus)
    : database().prepare('UPDATE diagnoses SET payload = ? WHERE id = ?').bind(JSON.stringify(value), value.id);
  await query.run();
}

export async function allowRequest(key: string, maximum: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await database().prepare('INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET hits = CASE WHEN expires_at <= ? THEN 1 ELSE hits + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING hits')
    .bind(key, now + windowMs, now, now).first<{hits:number}>();
  return !!row && row.hits <= maximum;
}

export async function fingerprint(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b=>b.toString(16).padStart(2,'0')).join('');
}
