import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSitePreview, fetchSitePreviewImage } from './site-preview.ts';
import { observe } from './scanner.ts';

const pageUrl = 'https://www.public-site.org/articles/page';
const publicDns = async () => {};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('extracts OGP regardless of attribute order/case, resolves base URLs and decodes entities', () => {
  const preview = extractSitePreview(`
    <BASE href="/assets/">
    <META CONTENT='Research &amp; &#x65E5;&#26412;' PROPERTY='OG:TITLE'>
    <meta content="A &quot;quoted&quot; description" name="description">
    <meta content="img/share.png?a=1&amp;b=2" property="og:image">
    <title>Fallback</title>`, pageUrl);
  assert.deepEqual(preview, {
    title: 'Research & 日本', description: 'A "quoted" description',
    imageUrl: 'https://www.public-site.org/assets/img/share.png?a=1&b=2',
  });
});

test('ignores comments and script metadata, falls back to title and Twitter image', () => {
  const preview = extractSitePreview(`
    <!-- <meta property="og:title" content="Comment"> -->
    <script>const text = '<meta property="og:title" content="Script">';</script>
    <style>.test { content: '<meta property="og:title" content="CSS">'; }</style>
    <title> Actual &amp; title </title>
    <meta property="og:image" content="data:image/png;base64,AA">
    <meta name="twitter:image" content="//cdn.public-site.org/image.jpg">`, pageUrl);
  assert.equal(preview?.title, 'Actual & title');
  assert.equal(preview?.imageUrl, 'https://cdn.public-site.org/image.jpg');
});

test('prefers secure OGP image and OGP description, bounds retained metadata', () => {
  const preview = extractSitePreview(`
    <meta name="description" content="fallback">
    <meta property="og:description" content="${'d'.repeat(800)}">
    <meta property="og:site_name" content="${'s'.repeat(300)}">
    <meta property="og:image" content="/first.png">
    <meta property="og:image:secure_url" content="https://cdn.public-site.org/secure.webp">`, pageUrl);
  assert.equal(preview?.title?.length, 200);
  assert.equal(preview?.description?.length, 500);
  assert.equal(preview?.imageUrl, 'https://cdn.public-site.org/secure.webp');
  assert.equal(extractSitePreview('<title>&copy; &constructor; &unknown;</title>', pageUrl)?.title, '© &constructor; &unknown;');
});

test('rejects non-public image destinations, credentials, ports and unsafe bases', () => {
  for (const image of ['http://localhost/image.png', 'http://127.1/image.png', 'https://10.0.0.1/a', 'https://private.internal/a', 'https://a:b@public-site.org/a', 'https://public-site.org:8443/a', 'javascript:alert(1)', 'file:///image.png']) {
    assert.equal(extractSitePreview(`<meta property="og:image" content="${image}">`, pageUrl), undefined, image);
  }
  assert.equal(extractSitePreview('<base href="http://localhost/"><meta property="og:image" content="/safe.png">', pageUrl)?.imageUrl, 'https://www.public-site.org/safe.png');
});

test('scanner saves metadata only for successful HTML and does not fetch additional preview resources', async () => {
  const requested: string[] = [];
  const observation = await observe(pageUrl, async (url) => {
    requested.push(url);
    return new Response('<meta property="og:title" content="Saved title"><meta property="og:image" content="/image.png">', { headers: { 'Content-Type': 'text/html' } });
  }, {}, publicDns);
  assert.equal(observation.preview?.title, 'Saved title');
  assert.equal(requested.length, 2); // Existing page + HTTP availability check only.
  assert.ok(requested.every((url) => !url.endsWith('image.png')));
  const blocked = await observe(pageUrl, async () => new Response('<meta property="og:title" content="Blocked">', { status: 403, headers: { 'Content-Type': 'text/html' } }), {}, publicDns);
  assert.equal(blocked.preview, undefined);
});

test('image proxy verifies each redirect and returns only bounded raster bytes', async () => {
  const checked: string[] = [];
  const requested: Array<{ url: string; init?: RequestInit }> = [];
  const response = await fetchSitePreviewImage('https://public-site.org/og.png', async (url, init) => {
    requested.push({ url, init });
    return requested.length === 1
      ? new Response(null, { status: 302, headers: { Location: 'https://cdn.public-site.org/og.png' } })
      : new Response(png, { headers: { 'Content-Type': 'image/png' } });
  }, async (url) => { checked.push(url.hostname); });
  assert.deepEqual(checked, ['public-site.org', 'cdn.public-site.org']);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(requested[0].init?.credentials, 'omit');
  assert.equal(requested[0].init?.redirect, 'manual');
});

test('image proxy denies private redirects before fetch and cancels redirect bodies', async () => {
  let calls = 0;
  let cancelled = false;
  const response = await fetchSitePreviewImage('https://public-site.org/og.png', async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
  }, publicDns);
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test('image proxy rejects private DNS and disallowed or spoofed content', async () => {
  let calls = 0;
  const denied = await fetchSitePreviewImage('https://public-site.org/a', async () => { calls++; return new Response(png); }, async () => { throw new Error('private DNS'); });
  assert.equal(denied.status, 404);
  assert.equal(calls, 0);
  for (const [type, body] of [['image/svg+xml', '<svg/>'], ['text/html', '<html/>'], ['image/png', '<html/>']]) {
    const response = await fetchSitePreviewImage('https://public-site.org/a', async () => new Response(body, { headers: { 'Content-Type': type } }), publicDns);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('image proxy cancels oversized announced and streamed bodies and limits redirects', async () => {
  for (const announced of [true, false]) {
    let cancelled = false;
    const response = await fetchSitePreviewImage('https://public-site.org/a', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'image/png', ...(announced ? { 'Content-Length': String(2 * 1024 * 1024 + 1) } : {}) } }), publicDns);
    assert.equal(response.status, 404);
    assert.equal(cancelled, true);
  }
  let calls = 0;
  const redirect = await fetchSitePreviewImage('https://public-site.org/a', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: '/again' } });
  }, publicDns);
  assert.equal(redirect.status, 404);
  assert.equal(calls, 4);
});

test('image proxy enforces its total deadline while an image body stalls', { timeout: 10_000 }, async () => {
  let cancelled = false;
  const response = await fetchSitePreviewImage('https://public-site.org/slow.png', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(png); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'image/png' } }), publicDns);
  assert.equal(response.status, 404);
  assert.equal(cancelled, true);
});
