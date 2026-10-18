import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveTarget, collectArchiveHistory, createArchiveHistoryCache, observedChanges } from '../lib/archive-history.ts';
const target = 'https://public-site.org/';
const now = new Date('2026-10-18T00:00:00Z');
const header = ['timestamp','original','mimetype','statuscode'];
const row = year => [`${year}0101000000`,target,'text/html','200'];
const json = rows => new Response(JSON.stringify([header,...rows]), {headers:{'content-type':'application/json'}});
const html = (year, body) => new Response(body, {headers:{'content-type':'text/html','memento-datetime':`Wed, 01 Jan ${year} 00:00:00 GMT`}});

test('four-year exact CDX scope; archived versions and change windows retain replay sources', async () => {
  const calls=[];
  const result=await collectArchiveHistory(target,async (url, init) => {
    calls.push(url); assert.equal(init.redirect,'manual'); assert.equal(init.credentials,'omit');
    if(url.includes('/cdx/')) {
      const u=new URL(url); assert.equal(u.searchParams.get('matchType'),'exact'); assert.equal(u.searchParams.get('from'),'2023'); assert.equal(u.searchParams.get('limit'),'4');
      return json([row(2023),row(2024)]);
    }
    return html(url.includes('2023') ? 2023 : 2024, `<div data-styled-version="${url.includes('2023') ? '5.1.0' : '6.0.0'}"></div>`);
  },now);
  assert.equal(result.status,'available'); assert.equal(calls.length,3);
  assert.equal(result.changes.length,1); assert.equal(result.changes[0].fromVersion,'5.1.0');
  assert.match(result.snapshots[0].components[0].evidence[0].url,/web\/20230101000000id_/);
});

test('query credentials, private targets and encoded separators are rejected before fetching', async () => {
  for(const url of ['http://localhost/','http://127.0.0.1/','https://public-site.org/?token=secret','https://user:secret@public-site.org/','https://public-site.org/a%2fb']) {
    assert.throws(()=>archiveTarget(url));
    await assert.rejects(()=>collectArchiveHistory(url,()=>{throw new Error('must not fetch');},now));
  }
});

test('replay redirects, absent/mismatching capture dates never become observations',async()=>{
  for(const response of [new Response('',{status:302,headers:{location:target}}),new Response('<div data-styled-version="5.0.0"></div>',{headers:{'content-type':'text/html'}}),html(2025,'<div data-styled-version="5.0.0"></div>')]) {
    let n=0;
    const result=await collectArchiveHistory(target,async()=>++n===1?json([row(2024)]):response,now);
    assert.equal(n,2); assert.equal(result.status,'unavailable'); assert.equal(result.snapshots[0].components.length,0);
  }
});

test('archived JS uses exact HTML timestamp; query/private references never fetched',async()=>{
  const calls=[];
  const result=await collectArchiveHistory(target,async url=>{
    calls.push(url);
    if(url.includes('/cdx/')) return json([row(2024)]);
    if(url.endsWith(target)) return html(2024,'<script src="/library.js"></script><script src="http://127.0.0.1/secret.js"></script><script src="/skip.js"></script>');
    return new Response('/*! jQuery v3.7.1 */',{headers:{'content-type':'application/javascript','memento-datetime':'Mon, 01 Jan 2024 00:00:00 GMT'}});
  },now);
  assert.equal(calls.length,3); assert.ok(calls.every(u=>u.startsWith('https://web.archive.org/')));
  assert.equal(result.snapshots[0].scriptsRead,1); assert.equal(result.snapshots[0].scriptsSkipped,2);
  assert.equal(result.snapshots[0].components.find(c=>c.name==='jQuery').version,'3.7.1');
});

test('429/403 abort remaining captures; no retry or fallback',async()=>{
  for(const status of [429,403]) {
    let calls=0;
    const result=await collectArchiveHistory(target,async()=>++calls===1?json([row(2023),row(2024)]):new Response('',{status}),now);
    assert.equal(calls,2); assert.equal(result.status,'unavailable');
  }
});

test('malformed/wrong-target CDX, oversized and missing responses degrade without false changes',async()=>{
  const invalid=json([['20240101000000','https://other-site.org/','text/html','200']]);
  assert.equal((await collectArchiveHistory(target,async()=>invalid,now)).snapshots.length,0);
  let calls=0;
  const result=await collectArchiveHistory(target,async()=>++calls===1?json([row(2024)]):html(2024,'x'.repeat(1_000_001)),now);
  assert.equal(result.status,'unavailable');
  for(const status of [404,500]) assert.equal((await collectArchiveHistory(target,async()=>new Response('',{status}),now)).status,'unavailable');
});

test('missing or ambiguous sample breaks comparison chain; same versions do not imply no updates',()=>{
  const make=(timestamp,version,status='observed')=>({timestamp,status,components:version?[{name:'jQuery',version}]:[]});
  assert.equal(observedChanges([make('2023','1.0.0'),make('2024',null,'unavailable'),make('2025','3.0.0')]).length,0);
  assert.equal(observedChanges([make('2023','1.0.0'),make('2024','1.0.0')]).length,0);
});

test('untrusted CDX over-response stays bounded to four yearly captures and 13 requests',async()=>{
  let count=0;
  const result=await collectArchiveHistory(target,async url=>{
    count++;
    if(url.includes('/cdx/')) return json([row(2023),row(2024),row(2025),row(2026),row(2026)]);
    const year=url.match(/web\/(\d{4})/)[1];
    if(url.endsWith(target)) return html(year,'<script src="/a.js"></script><script src="/b.js"></script>');
    return new Response('/*! jQuery v3.7.1 */',{headers:{'content-type':'application/javascript','memento-datetime':`01 Jan ${year} 00:00:00 GMT`}});
  },now);
  assert.equal(count,13); assert.equal(result.snapshots.length,4);
});

test('HTML version references remain explicitly referenced when JS capture does not match',async()=>{
  const result=await collectArchiveHistory(target,async url=>{
    if(url.includes('/cdx/'))return json([row(2024)]);
    if(url.endsWith(target))return html(2024,'<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>');
    return new Response('/*! jQuery v9.9.9 */',{headers:{'content-type':'application/javascript','memento-datetime':'01 Jan 2025 00:00:00 GMT'}});
  },now);
  const snap=result.snapshots[0], jq=snap.components.find(c=>c.name==='jQuery');
  assert.equal(snap.scriptsRead,0); assert.equal(snap.scriptsSkipped,1); assert.equal(jq.version,'3.7.1'); assert.equal(jq.versionStatus,'referenced');
});

test('CDX exact URL canonicalization retains HTTP/www captures and their script provenance', async () => {
  const requested = 'https://openai.com/ja-JP/';
  const calls = [];
  const result = await collectArchiveHistory(requested, async url => {
    calls.push(url);
    if (url.includes('/cdx/')) return json([['20240101000000', 'http://www.openai.com:80/ja-JP/', 'text/html', '200']]);
    if (url.endsWith('/ja-JP/')) return html(2024, '<script src="../library.js"></script>');
    return new Response('/*! jQuery v3.7.1 */', { headers: { 'content-type': 'application/javascript', 'memento-datetime': '01 Jan 2024 00:00:00 GMT' } });
  }, now);
  assert.equal(result.status, 'available');
  assert.equal(result.snapshots[0].scriptsRead, 1);
  assert.equal(calls[1], 'https://web.archive.org/web/20240101000000id_/http://www.openai.com/ja-JP/');
  assert.equal(calls[2], 'https://web.archive.org/web/20240101000000id_/http://www.openai.com/library.js');
  const jquery = result.snapshots[0].components.find(c => c.name === 'jQuery');
  assert.equal(jquery.version, '3.7.1');
  assert.ok(jquery.evidence.every(e => e.url.startsWith('https://web.archive.org/web/20240101000000id_/http://www.openai.com/')));
});

test('CDX canonical matching still rejects unrelated paths, hosts, credentials and queries', async () => {
  for (const original of ['https://openai.com.evil.org/ja-JP/', 'https://blog.openai.com/ja-JP/', 'https://openai.com/other/', 'https://openai.com/ja-jp/', 'https://openai.com/ja-JP/?token=secret', 'https://user:secret@openai.com/ja-JP/', 'https://openai.com:8443/ja-JP/', 'http://127.0.0.1/ja-JP/', 'https://openai.com/ja-JP/#other']) {
    let calls = 0;
    const result = await collectArchiveHistory('https://openai.com/ja-JP/', async () => {
      calls++;
      return json([['20240101000000', original, 'text/html', '200']]);
    }, now);
    assert.equal(calls, 1, original);
    assert.equal(result.snapshots.length, 0, original);
    assert.equal(result.failure.code, 'invalid_response', original);
  }
});

test('missing captures, index HTTP errors and malformed replies have distinct explanations', async () => {
  for (const empty of [[], [header]]) {
    const result = await collectArchiveHistory(target, async () => new Response(JSON.stringify(empty), { headers: { 'content-type': 'application/json' } }), now);
    assert.equal(result.failure.code, 'no_captures');
  }
  for (const [status, code] of [[403, 'access_denied'], [429, 'rate_limited'], [502, 'http_error']]) {
    const result = await collectArchiveHistory(target, async () => new Response('', { status, headers: { 'retry-after': '120' } }), now);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.failure.code, code);
    assert.equal(result.failure.httpStatus, status);
    if (status === 429) assert.equal(result.failure.retryAfterSeconds, 120);
  }
  for (const body of ['not JSON', '{"unexpected":true}', '[["wrong","fields"]]']) {
    const result = await collectArchiveHistory(target, async () => new Response(body, { headers: { 'content-type': 'application/json' } }), now);
    assert.equal(result.failure.code, 'invalid_response');
  }
  const network = await collectArchiveHistory(target, async () => { throw new TypeError('fetch failed'); }, now);
  assert.equal(network.failure.code, 'network');
});

test('a timeout identifies the failure and aborts the index request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = collectArchiveHistory(target, async (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, now);
  t.mock.timers.tick(25_000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.failure.code, 'timeout');
  assert.equal(result.snapshots.length, 0);
});

test('a stalled response body preserves the timeout reason when the transport throws AbortError', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted;
  const ready = new Promise(resolve => { bodyStarted = resolve; });
  const pending = collectArchiveHistory(target, async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      bodyStarted();
    },
  }), { headers: { 'content-type': 'application/json' } }), now);
  await ready;
  await Promise.resolve();
  t.mock.timers.tick(25_000);
  assert.equal((await pending).failure.code, 'timeout');
});

test('failed replay retains its HTTP reason while other HTML observations remain usable', async () => {
  const result = await collectArchiveHistory(target, async url => {
    if (url.includes('/cdx/')) return json([row(2023), row(2024)]);
    return url.includes('/web/2023') ? new Response('', { status: 503 }) : html(2024, '<div data-styled-version="6.0.0"></div>');
  }, now);
  assert.equal(result.status, 'available');
  assert.equal(result.snapshots[0].failure.httpStatus, 503);
  assert.equal(result.snapshots[1].status, 'observed');
  assert.equal(result.failure, undefined);
});

test('an excluded query in evidence does not discard an otherwise observed HTML capture', async () => {
  const result = await collectArchiveHistory(target, async url => {
    if (url.includes('/cdx/')) return json([row(2024)]);
    return html(2024, '<script src="https://code.jquery.com/jquery-3.7.1.min.js?cache=abc"></script>');
  }, now);
  assert.equal(result.status, 'available');
  assert.equal(result.snapshots[0].scriptsRead, 0);
  const jquery = result.snapshots[0].components.find(c => c.name === 'jQuery');
  assert.equal(jquery.version, '3.7.1');
  assert.ok(jquery.evidence.every(e => e.url === result.snapshots[0].sourceUrl));
});

test('cache coalesces in-flight checks but expires unavailable results after 30 seconds', async () => {
  let time = 0, calls = 0, release;
  const cached = createArchiveHistoryCache(() => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  }, () => time);
  const first = cached(target), second = cached(target);
  await Promise.resolve();
  assert.equal(calls, 1);
  time = 5_000;
  release({ status: 'unavailable', failure: { code: 'network', message: 'communication failed' } });
  assert.equal((await first).failure.retryAfterSeconds, 30);
  await second;
  time = 15_000;
  assert.equal((await cached(target)).failure.retryAfterSeconds, 20);
  assert.equal(calls, 1);
  time = 35_000;
  const retry = cached(target);
  await Promise.resolve();
  assert.equal(calls, 2);
  release({ status: 'available' });
  await retry;
  time = 3_634_999;
  assert.equal((await cached(target)).status, 'available');
  assert.equal(calls, 2);
  time = 3_635_000;
  const expired = cached(target);
  await Promise.resolve();
  assert.equal(calls, 3);
  release({ status: 'available' });
  await expired;
});

test('cache honors upstream retry delay and evicts rejected checks', async () => {
  let time = 0, calls = 0;
  const limited = createArchiveHistoryCache(async () => {
    calls++;
    return { status: 'unavailable', failure: { code: 'rate_limited', message: 'rate limited', retryAfterSeconds: 120 } };
  }, () => time);
  await limited(target);
  time = 60_000;
  assert.equal((await limited(target)).failure.retryAfterSeconds, 60);
  assert.equal(calls, 1);
  time = 120_000;
  await limited(target);
  assert.equal(calls, 2);
  const failed = createArchiveHistoryCache(async () => { throw new Error('unexpected failure'); });
  await assert.rejects(failed(target), /unexpected failure/);
  await assert.rejects(failed(target), /unexpected failure/);
});

test('a later global rate limit takes precedence over an earlier failed capture', async () => {
  let calls = 0;
  const cached = createArchiveHistoryCache(input => collectArchiveHistory(input, async url => {
    calls++;
    if (url.includes('/cdx/')) return json([row(2023), row(2024), row(2025)]);
    return url.includes('/web/2023') ? new Response('', { status: 503 }) : new Response('', { status: 429, headers: { 'retry-after': '120' } });
  }, now), () => 0);
  const result = await cached(target);
  assert.equal(calls, 3);
  assert.equal(result.failure.code, 'rate_limited');
  assert.equal(result.failure.retryAfterSeconds, 120);
  assert.equal(result.snapshots[0].failure.httpStatus, 503);
  assert.equal(result.snapshots[1].failure.httpStatus, 429);
});
