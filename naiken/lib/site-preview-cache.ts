import type { Observation } from './diagnosis-types.ts';
import { fetchSitePreview } from './site-preview-fetch.ts';

type Preview = NonNullable<Observation['preview']>;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Separate URL cache keeps historical observations and their expiry unchanged. */
export async function cachedSitePreview(db: Pick<D1Database, 'prepare'>, url: string, dependencies: {
  fetchPreview?: (url: string) => Promise<Preview | undefined>;
  now?: () => number;
} = {}): Promise<Preview | undefined> {
  const now = dependencies.now ?? Date.now;
  const time = now();
  const previous = await db.prepare('SELECT payload, next_fetch_at FROM site_previews WHERE url = ?').bind(url).first<{ payload: string; next_fetch_at: number }>();
  const cached: Preview | undefined = previous ? JSON.parse(previous.payload) : undefined;
  if (previous && previous.next_fetch_at > time) return cached;
  const token = crypto.randomUUID();
  const claimed = await db.prepare(`INSERT INTO site_previews (url, payload, next_fetch_at, lease_token, lease_until)
    VALUES (?, '{}', 0, ?, ?)
    ON CONFLICT(url) DO UPDATE SET lease_token = excluded.lease_token, lease_until = excluded.lease_until
    WHERE site_previews.next_fetch_at <= ? AND site_previews.lease_until <= ? RETURNING url`)
    .bind(url, token, time + 30_000, time, time).first();
  if (!claimed) return cached;
  let preview = cached;
  let delay = HOUR;
  try {
    preview = await (dependencies.fetchPreview ?? fetchSitePreview)(url);
    delay = preview?.imageUrl ? WEEK : DAY;
  } catch { /* A failed refresh retains previously cached metadata and retries later. */ }
  await db.prepare(`UPDATE site_previews SET payload = ?, next_fetch_at = ?, lease_token = NULL, lease_until = 0
    WHERE url = ? AND lease_token = ?`).bind(JSON.stringify(preview ?? {}), now() + delay, url, token).run();
  return preview;
}
