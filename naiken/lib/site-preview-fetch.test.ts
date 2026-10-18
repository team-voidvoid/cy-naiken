import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSitePreview } from './site-preview-fetch.ts';

const url = 'https://public-site.org/page';
const publicDns = async () => {};

test('metadata fetch follows public redirects and stops after the head without fetching scripts or image bytes', async () => {
  const requests: string[] = [];
  const checked: string[] = [];
  let cancelled = false;
  const preview = await fetchSitePreview(url, async (input, init) => {
    requests.push(input);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'manual');
    if (requests.length === 1) return new Response(null, { status: 302, headers: { Location: '/redirected' } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('<head><meta property="og:image" content="/og.png"></head><script src="/app.js"></script>')); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '10000000' } });
  }, async (target) => { checked.push(target.href); });
  assert.equal(preview?.imageUrl, 'https://public-site.org/og.png');
  assert.deepEqual(requests, [url, 'https://public-site.org/redirected']);
  assert.deepEqual(checked, requests);
  assert.equal(cancelled, true);
});

test('metadata fetch rejects private redirects, private DNS, blocked pages, challenge HTML and non-HTML', async () => {
  let calls = 0;
  await assert.rejects(fetchSitePreview(url, async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }); }, publicDns));
  assert.equal(calls, 1);
  await assert.rejects(fetchSitePreview(url, async () => { throw new Error('must not fetch'); }, async () => { throw new Error('private DNS'); }));
  for (const response of [
    new Response('<head></head>', { status: 403, headers: { 'Content-Type': 'text/html' } }),
    new Response('<head><title>Just a moment</title></head>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('image', { headers: { 'Content-Type': 'image/png' } }),
  ]) await assert.rejects(fetchSitePreview(url, async () => response, publicDns));
});

test('metadata fetch bounds retained HTML to the first MiB and cancels the remaining response', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024) + '<meta property="og:image" content="/too-late.png">')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/html' } });
  assert.equal(await fetchSitePreview(url, async () => response, publicDns), undefined);
  assert.equal(cancelled, true);
});

test('metadata fetch aborts a stalled HTML body after seven seconds', { timeout: 10_000 }, async () => {
  let cancelled = false;
  await assert.rejects(fetchSitePreview(url, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<head>')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/html' } }), publicDns));
  assert.equal(cancelled, true);
});
