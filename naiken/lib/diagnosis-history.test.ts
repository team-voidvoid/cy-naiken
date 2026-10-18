import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { historyQuery, historyResponse, parseHistoryOptions, InvalidHistoryRequest, type HistoryOptions, type HistoryRow } from './diagnosis-history.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  return db;
}
function insert(db: DatabaseSync, id: string, url: string, at: number, extra: Record<string, unknown> = {}) {
  const payload = { id, url, siteName: new URL(url).hostname, mode: 'live', status: 'complete', createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), headline: '確認完了', summary: '公開情報の確認結果', score: 12, checkedCount: 3, ...extra };
  db.prepare('INSERT INTO diagnoses VALUES (?, ?, ?, ?)').run(id, `archive:${id}`, JSON.stringify(payload), at);
}
function list(db: DatabaseSync, options: HistoryOptions) {
  const { sql, bindings } = historyQuery(options);
  return historyResponse(db.prepare(sql).all(...bindings) as unknown as HistoryRow[], options.limit);
}

test('public list includes latest eligible live result per exact URL and retains preliminary scans', () => {
  const db = setup();
  insert(db, 'older', 'https://site.org/', 100);
  insert(db, 'newer', 'https://site.org/', 200);
  insert(db, 'failed', 'https://site.org/', 300, { status: 'failed' });
  insert(db, 'observing', 'https://another.org/', 500, { status: 'observing' });
  insert(db, 'demo', 'https://demo.org/', 600, { mode: 'demo' });
  insert(db, 'preliminary', 'https://site.org/path', 400, { status: 'preliminary' });
  insert(db, 'query', 'https://site.org/?q=x', 350);
  assert.deepEqual(list(db, { limit: 12 }).diagnoses.map((row) => row.id), ['preliminary', 'query', 'newer']);
  assert.deepEqual(list(db, { limit: 12, url: 'https://site.org/' }).diagnoses.map((row) => row.id), ['newer', 'older']);
  assert.equal(list(db, { limit: 12, url: 'https://missing.org/' }).nextCursor, null);
  db.close();
});

test('newest-first pagination is stable when creation times tie and never repeats older URL results', () => {
  const db = setup();
  for (const id of ['a', 'b', 'c', 'd', 'e']) insert(db, id, `https://${id}.org/`, 100);
  insert(db, 'old-a', 'https://a.org/', 50);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const options = parseHistoryOptions(new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) }));
    const response = list(db, options);
    ids.push(...response.diagnoses.map((row) => row.id));
    cursor = response.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ['e', 'd', 'c', 'b', 'a']);
  db.close();
});

test('search escapes LIKE wildcards and parameterizes quotes, and applies to latest results', () => {
  const db = setup();
  insert(db, 'literal', 'https://literal.org/', 100, { siteName: "100%_\\'service" });
  insert(db, 'other', 'https://other.org/', 200, { siteName: '100abcservice' });
  assert.deepEqual(list(db, { limit: 12, query: "%_\\'" }).diagnoses.map((row) => row.id), ['literal']);
  assert.equal(list(db, { limit: 12, query: "' OR 1=1 --" }).diagnoses.length, 0);
  assert.deepEqual(list(db, { limit: 12, query: 'other.org' }).diagnoses.map((row) => row.id), ['other']);
  insert(db, 'literal-new', 'https://literal.org/', 300, { siteName: 'Changed title' });
  assert.equal(list(db, { limit: 12, query: '%_' }).diagnoses.length, 0);
  db.close();
});

test('projection exposes only public summary, same-origin image proxy and whitelisted job status', () => {
  const db = setup();
  insert(db, 'safe-id', 'https://site.org/', 100, { observation: { outcome: 'ok', preview: { imageUrl: 'https://site.org/og.png' }, internal: 'secret' }, unknowns: ['hidden'] });
  db.prepare('INSERT INTO research_jobs (diagnosis_id, payload) VALUES (?, ?)').run('safe-id', JSON.stringify({ status: 'running', sessionId: 'secret', credentials: 'secret' }));
  const result = list(db, { limit: 12 });
  assert.deepEqual(Object.keys(result.diagnoses[0]).sort(), ['checkedCount', 'createdAt', 'headline', 'id', 'imageUrl', 'outcome', 'researchStatus', 'score', 'siteName', 'status', 'summary', 'updatedAt', 'url'].sort());
  assert.equal(result.diagnoses[0].imageUrl, '/api/diagnoses/safe-id/image');
  assert.equal(result.diagnoses[0].researchStatus, 'running');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  db.prepare('UPDATE research_jobs SET payload = ?').run(JSON.stringify({ status: 'internal-state' }));
  assert.equal(list(db, { limit: 12 }).diagnoses[0].researchStatus, undefined);
  db.close();
});

test('malformed bounds and cursors return input errors; URLs use scanner normalization', () => {
  for (const limit of ['', '0', '-1', '51', '1.5', '1e1', 'NaN', '001', '10000']) {
    assert.throws(() => parseHistoryOptions(new URLSearchParams({ limit })), InvalidHistoryRequest);
  }
  for (const cursor of ['', '!!', btoa('{}'), btoa('{"createdAt":-1,"id":"a"}'), btoa('{"createdAt":1,"id":""}')]) {
    assert.throws(() => parseHistoryOptions(new URLSearchParams({ cursor })), InvalidHistoryRequest);
  }
  for (const url of ['', 'http://localhost/', 'https://127.0.0.1/', 'https://user:pass@site.org/']) {
    assert.throws(() => parseHistoryOptions(new URLSearchParams({ url })), InvalidHistoryRequest);
  }
  assert.deepEqual(parseHistoryOptions(new URLSearchParams({ url: 'SITE.ORG:443/a?x=1#fragment', q: '  hello  ' })), { limit: 12, url: 'https://site.org/a?x=1', query: 'hello' });
});

test('legacy successful results request OGP backfill while blocked results keep the fallback', () => {
  const db = setup();
  insert(db, 'legacy', 'https://legacy.org/', 100, { observation: { outcome: 'ok' } });
  insert(db, 'blocked', 'https://blocked.org/', 200, { observation: { outcome: 'blocked' } });
  const items = list(db, { limit: 12 }).diagnoses;
  assert.equal(items.find(item => item.id === 'legacy')?.imageUrl, '/api/diagnoses/legacy/image');
  assert.equal(items.find(item => item.id === 'blocked')?.imageUrl, undefined);
  db.close();
});

test('SQLite uses partial indexes for ordering and per-URL newest lookup', () => {
  const db = setup();
  const query = historyQuery({ limit: 12 });
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings);
  const detail = JSON.stringify(plan);
  assert.match(detail, /diagnoses_public_history_order/);
  assert.match(detail, /diagnoses_public_history_url/);
  const exact = historyQuery({ limit: 12, url: 'https://site.org/' });
  assert.match(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${exact.sql}`).all(...exact.bindings)), /diagnoses_public_history_url/);
  db.close();
});
