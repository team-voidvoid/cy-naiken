import type { Diagnosis } from './diagnosis-types.ts';
import { DIAGNOSIS_CACHE_MS } from './diagnosis-cache.ts';

export async function reserveDiagnosisIn(db: Pick<D1Database, 'prepare'>, value: Diagnosis, cacheKey: string, now = Date.now()): Promise<{value:Diagnosis; owned:boolean}> {
  // Preserve old result links while releasing expired reservations atomically.
  // In-flight work is keyed by URL, independent of wall-clock bucket boundaries.
  await db.prepare(`UPDATE diagnoses SET cache_key = 'archive:' || id
    WHERE cache_key = ? AND (
      (json_extract(payload, '$.status') IN ('complete','preliminary') AND created_at < CASE
        WHEN json_extract(payload, '$.observation.outcome') = 'ok'
          OR (json_extract(payload, '$.observation.outcome') = 'blocked' AND COALESCE(json_extract(payload, '$.observation.status'), 0) != 429)
        THEN ? ELSE ? END)
      OR (json_extract(payload, '$.status') = 'failed' AND created_at < ?)
      OR (json_extract(payload, '$.status') = 'observing' AND created_at < ?)
    )`).bind(cacheKey, now - DIAGNOSIS_CACHE_MS, now - 30_000, now - 30_000, now - 60_000).run();
  const row = await db.prepare('INSERT INTO diagnoses (id, cache_key, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO NOTHING RETURNING id')
    .bind(value.id, cacheKey, JSON.stringify(value), now).first<{id:string}>();
  if (row) return {value, owned:true};
  const existing = await db.prepare('SELECT payload FROM diagnoses WHERE cache_key = ?').bind(cacheKey).first<{payload:string}>();
  if (!existing) throw new Error('受付が混み合っています。もう一度お試しください。');
  return {value:JSON.parse(existing.payload), owned:false};
}
