import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { reserveDiagnosisIn } from './diagnosis-reservation.ts';
import { DIAGNOSIS_CACHE_MS } from './diagnosis-cache.ts';
import type { Diagnosis, Observation } from './diagnosis-types.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  // D1 adapter delegates every statement and constraint to actual SQLite.
  const adapter = { prepare(sql: string) {
    const statement = db.prepare(sql);
    return { bind(...bindings: SQLInputValue[]) { return {
      async run() { return statement.run(...bindings); },
      async first() { return statement.get(...bindings) ?? null; },
    }; } };
  } } as unknown as Pick<D1Database, 'prepare'>;
  return { db, adapter };
}
function value(id: string, at: number, status: Diagnosis['status'] = 'complete'): Diagnosis {
  return { id, url: 'https://site.org/', siteName: 'site.org', mode: 'live', status, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), headline: '完了', summary: '結果', score: 1, checkedCount: 1, unknowns: [], findings: [], components: [], explanationSource: 'template', observation: { outcome: 'ok', status: 200 } as Observation };
}

test('completed and preliminary cache entries are shared for seven days; expired IDs retain old results', async () => {
  assert.equal(DIAGNOSIS_CACHE_MS, 7 * 24 * 60 * 60 * 1000);
  const now = 2_000_000_000_000;
  for (const status of ['complete', 'preliminary'] as const) {
    const { db, adapter } = setup();
    const initial = value('old-id', now, status);
    assert.equal((await reserveDiagnosisIn(adapter, initial, initial.url, now)).owned, true);
    assert.deepEqual(await reserveDiagnosisIn(adapter, value('six-day-id', now), initial.url, now + 6 * 24 * 60 * 60 * 1000), { value: initial, owned: false });
    assert.equal((await reserveDiagnosisIn(adapter, value('seven-day-id', now), initial.url, now + DIAGNOSIS_CACHE_MS)).owned, false);
    const fresh = value('new-id', now + DIAGNOSIS_CACHE_MS + 1);
    assert.deepEqual(await reserveDiagnosisIn(adapter, fresh, initial.url, now + DIAGNOSIS_CACHE_MS + 1), { value: fresh, owned: true });
    const old = db.prepare('SELECT cache_key, payload FROM diagnoses WHERE id = ?').get('old-id');
    assert.equal(old?.cache_key, 'archive:old-id');
    assert.deepEqual(JSON.parse(String(old?.payload)), initial);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM diagnoses').get()?.count, 2);
    db.close();
  }
});

test('failed and abandoned in-flight reservations keep their short retry timeouts', async () => {
  const now = 2_000_000_000_000;
  for (const [status, timeout] of [['failed', 30_000], ['observing', 60_000]] as const) {
    const { db, adapter } = setup();
    const initial = value('old-id', now, status);
    await reserveDiagnosisIn(adapter, initial, initial.url, now);
    assert.equal((await reserveDiagnosisIn(adapter, value('before-id', now), initial.url, now + timeout)).owned, false);
    assert.equal((await reserveDiagnosisIn(adapter, value('after-id', now), initial.url, now + timeout + 1)).owned, true);
    db.close();
  }
});


test('transient observation failures can retry after thirty seconds instead of one week', async () => {
  const now = 2_000_000_000_000;
  for (const [outcome, status] of [['timeout', 0], ['error', 0], ['blocked', 429]] as const) {
    const { db, adapter } = setup();
    const initial = value('old-id', now);
    initial.observation = { outcome, status } as Observation;
    await reserveDiagnosisIn(adapter, initial, initial.url, now);
    assert.equal((await reserveDiagnosisIn(adapter, value('before-id', now), initial.url, now + 30_000)).owned, false);
    assert.equal((await reserveDiagnosisIn(adapter, value('after-id', now), initial.url, now + 30_001)).owned, true);
    assert.equal(db.prepare('SELECT cache_key FROM diagnoses WHERE id = ?').get('old-id')?.cache_key, 'archive:old-id');
    db.close();
  }
});

test('blocked observations other than rate limits remain reusable for one week', async () => {
  const now = 2_000_000_000_000;
  const { db, adapter } = setup();
  const initial = value('blocked-id', now);
  initial.observation = { outcome: 'blocked', status: 403 } as Observation;
  await reserveDiagnosisIn(adapter, initial, initial.url, now);
  assert.equal((await reserveDiagnosisIn(adapter, value('fresh-id', now), initial.url, now + DIAGNOSIS_CACHE_MS)).owned, false);
  assert.equal((await reserveDiagnosisIn(adapter, value('fresh-id', now), initial.url, now + DIAGNOSIS_CACHE_MS + 1)).owned, true);
  db.close();
});
