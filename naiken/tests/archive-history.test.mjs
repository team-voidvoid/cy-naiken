import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveTarget, collectArchiveHistory, observedChanges } from '../lib/archive-history.ts';
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
