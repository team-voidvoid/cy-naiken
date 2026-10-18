import type { VersionCache, VersionCacheEntry, VersionMatch } from './version-extraction.ts';

export function createVersionCache(database: D1Database): VersionCache {
  return {
    async read(key) {
      const row = await database.prepare('SELECT status, payload FROM version_extractions WHERE cache_key = ? AND expires_at > ?')
        .bind(key, Date.now()).first<{ status: VersionCacheEntry['status']; payload: string | null }>();
      return row ? { status: row.status, matches: row.payload ? JSON.parse(row.payload) : [] } : null;
    },
    async reserve(key) {
      const now = Date.now();
      await database.prepare('DELETE FROM version_extractions WHERE expires_at <= ?').bind(now).run();
      // In-flight and failed attempts are held for an hour, including unknown outcomes.
      return !!await database.prepare("INSERT INTO version_extractions (cache_key, status, payload, expires_at) VALUES (?, 'pending', NULL, ?) ON CONFLICT(cache_key) DO NOTHING RETURNING cache_key")
        .bind(key, now + 3_600_000).first();
    },
    async finish(key, matches: VersionMatch[] | null) {
      await database.prepare("UPDATE version_extractions SET status = ?, payload = ?, expires_at = ? WHERE cache_key = ? AND status = 'pending'")
        .bind(matches ? 'completed' : 'failed', matches ? JSON.stringify(matches) : null,
          Date.now() + (matches ? 7 * 86_400_000 : 3_600_000), key).run();
    },
  };
}
