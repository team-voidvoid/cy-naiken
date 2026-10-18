import type { Diagnosis } from './diagnosis-types.ts';
import type { SafetyScore } from './safety-score-types.ts';

export function createSafetyScoreStore(database: D1Database) {
  return {
    async read(id: string): Promise<Diagnosis | null> {
      const row = await database.prepare('SELECT payload FROM diagnoses WHERE id = ?').bind(id).first<{ payload: string }>();
      return row ? JSON.parse(row.payload) : null;
    },
    async reserve(id: string, assessment: SafetyScore): Promise<boolean> {
      // One paid request per saved diagnosis, even across Workers or tabs.
      const row = await database.prepare(`UPDATE diagnoses SET payload = json_set(payload, '$.safetyScore', json(?))
        WHERE id = ? AND json_extract(payload, '$.status') = 'complete'
        AND json_extract(payload, '$.mode') = 'live' AND json_type(payload, '$.safetyScore') IS NULL RETURNING id`)
        .bind(JSON.stringify(assessment), id).first();
      return !!row;
    },
    async finish(id: string, assessment: SafetyScore): Promise<void> {
      // Update only this field; never overwrite the diagnosis or a terminal result.
      await database.prepare(`UPDATE diagnoses SET payload = json_set(payload, '$.safetyScore', json(?))
        WHERE id = ? AND json_extract(payload, '$.safetyScore.status') = 'scoring'`)
        .bind(JSON.stringify(assessment), id).run();
    },
  };
}
export type SafetyScoreStore = ReturnType<typeof createSafetyScoreStore>;
