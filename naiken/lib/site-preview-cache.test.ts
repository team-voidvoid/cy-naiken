import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { cachedSitePreview } from './site-preview-cache.ts';

const url = 'https://public-site.org/page';
const preview = { title: 'Site', imageUrl: 'https://public-site.org/og.png' };
const HOUR = 60 * 60 * 1000;
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  const adapter = { prepare(sql: string) {
    const statement = db.prepare(sql);
    return { bind(...values: SQLInputValue[]) { return {
      async run() { return statement.run(...values); },
      async first() { return statement.get(...values) ?? null; },
    }; } };
  } } as unknown as Pick<D1Database, 'prepare'>;
  return { db, adapter };
}

test('backfilled metadata persists by URL for a week without changing diagnosis payload, dates or cache key', async () => {
  const { db, adapter } = setup();
  const original = JSON.stringify({ mode: 'live', observation: { outcome: 'ok', fetchedAt: '2026-01-01' }, score: 12 });
  db.prepare('INSERT INTO diagnoses VALUES (?, ?, ?, ?)').run('old-result', url, original, 123);
  let time = 1_000_000;
  let calls = 0;
  const dependencies = { now: () => time, fetchPreview: async () => { calls++; return preview; } };
  assert.deepEqual(await cachedSitePreview(adapter, url, dependencies), preview);
  time += 6 * 24 * HOUR;
  assert.deepEqual(await cachedSitePreview(adapter, url, dependencies), preview);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT next_fetch_at FROM site_previews').get()?.next_fetch_at, 1_000_000 + 7 * 24 * HOUR);
  const result = db.prepare('SELECT * FROM diagnoses').get();
  assert.equal(result?.payload, original);
  assert.equal(result?.created_at, 123);
  assert.equal(result?.cache_key, url);
  db.close();
});

test('missing images are cached for one day; fetch failures retry after one hour', async () => {
  for (const fail of [false, true]) {
    const { db, adapter } = setup();
    let time = 1_000_000;
    let calls = 0;
    const dependencies = { now: () => time, fetchPreview: async () => { calls++; if (fail) throw new Error('unavailable'); return { title: 'No image' }; } };
    await cachedSitePreview(adapter, url, dependencies);
    const delay = fail ? HOUR : 24 * HOUR;
    time += delay - 1;
    await cachedSitePreview(adapter, url, dependencies);
    assert.equal(calls, 1);
    time += 1;
    await cachedSitePreview(adapter, url, dependencies);
    assert.equal(calls, 2);
    db.close();
  }
});

test('concurrent requests share one metadata fetch and stale metadata survives a failed refresh', async () => {
  const { db, adapter } = setup();
  let release!: (value: typeof preview) => void;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<typeof preview>(resolve => { release = resolve; });
  let calls = 0;
  const dependencies = { now: () => 1_000_000, fetchPreview: async () => { calls++; started(); return pending; } };
  const first = cachedSitePreview(adapter, url, dependencies);
  await beginning;
  await cachedSitePreview(adapter, url, dependencies);
  assert.equal(calls, 1);
  release(preview);
  assert.deepEqual(await first, preview);
  assert.deepEqual(await cachedSitePreview(adapter, url, { now: () => 1_000_000 + 8 * 24 * HOUR, fetchPreview: async () => { throw new Error('offline'); } }), preview);
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT payload FROM site_previews').get()?.payload)), preview);
  db.close();
});

test('a crashed fetch can be reclaimed and its old lease cannot overwrite the new result', async () => {
  const { db, adapter } = setup();
  db.prepare('INSERT INTO site_previews VALUES (?, ?, ?, ?, ?)').run(url, '{}', 0, 'crashed', 10);
  await cachedSitePreview(adapter, url, { now: () => 100, fetchPreview: async () => {
    db.prepare('UPDATE site_previews SET lease_token = ?, payload = ? WHERE url = ?').run('new-owner', JSON.stringify({ title: 'New owner' }), url);
    return preview;
  } });
  assert.equal(JSON.parse(String(db.prepare('SELECT payload FROM site_previews').get()?.payload)).title, 'New owner');
  db.close();
});
