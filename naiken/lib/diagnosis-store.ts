import { env } from 'cloudflare:workers';
import type { Diagnosis } from './diagnosis-types';

function database() {
  if (!env.DB) throw new Error('診断結果の保存先が利用できません。');
  return env.DB;
}

export async function findDiagnosis(id: string): Promise<Diagnosis | null> {
  const row = await database().prepare('SELECT payload FROM diagnoses WHERE id = ?').bind(id).first<{payload:string}>();
  return row ? JSON.parse(row.payload) as Diagnosis : null;
}

export async function reserveDiagnosis(value: Diagnosis, cacheKey: string): Promise<{value:Diagnosis; owned:boolean}> {
  const now = Date.now();
  // Preserve old result links while releasing expired reservations atomically.
  // In-flight work is keyed by URL, independent of wall-clock bucket boundaries.
  await database().prepare(`UPDATE diagnoses SET cache_key = 'archive:' || id
    WHERE cache_key = ? AND (
      (json_extract(payload, '$.status') IN ('complete','preliminary') AND created_at < ?)
      OR (json_extract(payload, '$.status') = 'failed' AND created_at < ?)
      OR (json_extract(payload, '$.status') = 'observing' AND created_at < ?)
    )`).bind(cacheKey, now - 600_000, now - 30_000, now - 60_000).run();
  const row = await database().prepare('INSERT INTO diagnoses (id, cache_key, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO NOTHING RETURNING id')
    .bind(value.id, cacheKey, JSON.stringify(value), now).first<{id:string}>();
  if (row) return {value, owned:true};
  const existing = await database().prepare('SELECT payload FROM diagnoses WHERE cache_key = ?').bind(cacheKey).first<{payload:string}>();
  if (!existing) throw new Error('受付が混み合っています。もう一度お試しください。');
  return {value:JSON.parse(existing.payload), owned:false};
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
