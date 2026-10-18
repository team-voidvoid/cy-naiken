import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { extractComponentVersions, prepareVersionSnippets, VERSION_MODEL } from '../lib/version-extraction.ts';
import { createVersionCache } from '../lib/version-extraction-store.ts';
import { inspectTechnologies } from '../lib/technology/scanner.ts';
import { finalizeObservation } from '../lib/rules.ts';
import { observe } from '../lib/scanner.ts';

const VERSION = '19.3.0-canary-cbb046ab-20260731';
const TARGET_URL = 'https://public.example.com/';
const scripts = [{ url: `${TARGET_URL}_next/static/app.js?secret=private#fragment`,
  body: `window.next={version:"16.3.3",appDir:!0};r.useTransition=function(){return T.H.useTransition()},r.version="${VERSION}";` }];
function components() {
  return inspectTechnologies({ url: TARGET_URL, body: '<script src="/_next/static/app.js"></script>', headers: new Headers() }, scripts).components;
}
function harness(t, fetcher, allowCall = async () => true) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  sql.exec(readFileSync(new URL('../drizzle/0006_version_extractions.sql', import.meta.url), 'utf8'));
  const database = { prepare(query) { return { bind(...values) { return {
    async first() { return sql.prepare(query).get(...values) ?? null; },
    async run() { return sql.prepare(query).run(...values); },
  }; } }; } };
  return { sql, database, options: { apiKey: 'test-key', fetcher, cache: createVersionCache(database), allowCall } };
}
function answer(matches, overrides = {}) {
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ matches }) }] }],
    usage: { input_tokens: 1000, output_tokens: 100 }, ...overrides });
}
function match(body, overrides = {}) {
  const input = JSON.parse(body.input);
  const snippet = input.snippets.find(part => part.allowed.includes('react'));
  return { technologyId: 'react', snippetId: snippet.id, version: VERSION,
    quote: `r.useTransition=function(){return T.H.useTransition()},r.version="${VERSION}"`, ...overrides };
}
const react = result => result.components.find(part => part.technologyId === 'react');

test('Next.js literal declarations are resolved locally even with the AI fallback disabled', async () => {
  const many = inspectTechnologies({ url: TARGET_URL, body: Array.from({ length: 12 }, (_, i) => `<script src="/_next/static/${i}.js"></script>`).join(''), headers: new Headers() }).components;
  assert.equal(many.find(part => part.technologyId === 'nextjs').versionStatus, 'incomplete');
  const result = await extractComponentVersions(many, scripts);
  const next = result.components.find(part => part.technologyId === 'nextjs');
  assert.equal(next.version, '16.3.3'); assert.equal(next.versionStatus, 'declared');
  assert.equal(result.versionExtraction.requests, 0); assert.equal(react(result).version, undefined);
  const conflicting = await extractComponentVersions(many, [...scripts, { url: `${TARGET_URL}other.js`, body: 'window.next={version:"15.0.0"}' }]);
  assert.equal(conflicting.components[0].version, undefined);
  assert.equal(conflicting.components.find(part => part.technologyId === 'nextjs').versionStatus, 'multiple');
});

test('one bounded Responses request extracts a literal and the durable cache prevents repeat billing', async t => {
  let calls = 0;
  const h = harness(t, async (endpoint, init) => {
    calls++; assert.equal(endpoint, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); assert.equal(body.model, VERSION_MODEL);
    assert.equal(body.store, false); assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.max_output_tokens, 600); assert.equal(body.tools, undefined);
    assert.equal(body.text.format.strict, true); assert.ok(body.input.length < 8000);
    assert.doesNotMatch(body.input, /secret=private|fragment|test-key/);
    return answer([match(body)]);
  });
  const first = await extractComponentVersions(components(), scripts, h.options);
  assert.equal(react(first).version, VERSION); assert.equal(react(first).versionMethod, 'ai');
  assert.equal(first.versionExtraction.requests, 1); assert.equal(first.versionExtraction.inputTokens, 1000);
  assert.ok(react(first).evidence.some(item => item.ruleId === 'react.ai-version'));
  assert.doesNotMatch(JSON.stringify(first), /secret=private|fragment|test-key/);
  const second = await extractComponentVersions(components(), scripts, { ...h.options, cache: createVersionCache(h.database) });
  assert.equal(second.versionExtraction.status, 'cached'); assert.equal(react(second).version, VERSION); assert.equal(calls, 1);
  const differentOrigin = scripts.map(item => ({ ...item, url: item.url.replace('public.example.com', 'other.example.com') }));
  const third = await extractComponentVersions(components(), differentOrigin, h.options);
  assert.equal(calls, 1); assert.ok(react(third).evidence.some(item => item.url?.includes('other.example.com')));
});

test('no key, no literal, no contextual identity, and exhausted budgets never make a paid request', async t => {
  let calls = 0; const h = harness(t, async () => { calls++; throw Error('unexpected'); });
  await extractComponentVersions(components(), scripts, { ...h.options, apiKey: undefined });
  await extractComponentVersions(components(), scripts, { ...h.options, enabled: false });
  await extractComponentVersions(components(), [{ url: `${TARGET_URL}generic.js`, body: `x.version="${VERSION}"` }], h.options);
  await extractComponentVersions(components(), [{ url: `${TARGET_URL}generic.js`, body: 'React unknown' }], h.options);
  await extractComponentVersions(components(), scripts, { ...h.options, allowCall: async () => false });
  await extractComponentVersions(components(), scripts, h.options);
  assert.equal(calls, 0);
});

test('fabricated versions, modified quotations, and unrelated package attribution are rejected without retry', async t => {
  for (const override of [{ version: '999.0.0' }, { quote: `r.version="${VERSION}"; INVENTED` }, { technologyId: 'jquery' }]) {
    let calls = 0;
    const h = harness(t, async (_url, init) => { calls++; return answer([match(JSON.parse(init.body), override)]); });
    const result = await extractComponentVersions(components(), scripts, h.options);
    assert.equal(react(result).version, undefined); assert.equal(result.versionExtraction.status, 'failed');
    await extractComponentVersions(components(), scripts, h.options); assert.equal(calls, 1);
  }
});

test('concurrent scans reserve the same content atomically before an API call', async t => {
  let calls = 0; let finish; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  let body;
  const h = harness(t, async (_url, init) => { calls++; body = JSON.parse(init.body); started(); return pending; });
  const first = extractComponentVersions(components(), scripts, h.options); await ready;
  const second = await extractComponentVersions(components(), scripts, h.options);
  assert.equal(second.versionExtraction.requests, 0); assert.equal(calls, 1);
  finish(answer([match(body)])); assert.equal(react(await first).version, VERSION);
});

test('refusals, truncated responses, oversized bodies, and stalled transports preserve the normal scan', async t => {
  for (const transport of [async () => answer([], { status: 'incomplete' }),
    async () => answer([], { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No extraction' }] }] }),
    async () => new Response('x'.repeat(40_000)),
    async () => new Response('unauthorized test-key', { status: 401 }), () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} }))]) {
    let calls = 0;
    const h = harness(t, (...args) => { calls++; return transport(...args); });
    const result = await extractComponentVersions(components(), scripts, { ...h.options, timeoutMs: 20 });
    assert.equal(react(result).version, undefined); assert.equal(result.versionExtraction.status, 'failed');
    assert.equal(result.components.find(part => part.technologyId === 'nextjs').version, '16.3.3');
    assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(result), /test-key|unauthorized/);
  }
});

test('only small version contexts within the existing parser limit are sent', () => {
  const snippet = prepareVersionSnippets(components(), [{ url: TARGET_URL, body: 'a'.repeat(100_000) + scripts[0].body + 'b'.repeat(200_000) }]);
  assert.ok(snippet.length > 0); assert.ok(JSON.stringify(snippet).length < 8000);
  assert.equal(prepareVersionSnippets(components(), [{ url: TARGET_URL, body: ' '.repeat(200_001) + scripts[0].body }]).length, 0);
});

test('AI version associations retain candidate conflicts and never generate confirmed age points', async t => {
  const h = harness(t, async (_url, init) => answer([match(JSON.parse(init.body))]));
  const input = components().map(item => item.technologyId === 'react' ? { ...item, versions: ['18.0.0'] } : item);
  const result = await extractComponentVersions(input, scripts, h.options);
  assert.equal(react(result).versionStatus, 'multiple'); assert.equal(react(result).version, undefined);
  const observation = { outcome: 'ok', findings: [], components: [{ name: 'jQuery', version: '1.11.1', versionMethod: 'ai', evidence: [] }], checkedCategories: ['components'], scriptsSkipped: 0 };
  const finalized = finalizeObservation(observation);
  assert.equal(finalized.oldestYear, undefined); assert.equal(finalized.score, 0);
});

test('scanner enrichment runs after fetching and failures preserve existing components', async () => {
  const fetcher = async target => target.startsWith('http:') ? new Response('', { status: 403 }) : new Response('<script src="/jquery-3.7.1.min.js"></script>', { headers: { 'content-type': 'text/html' } });
  const result = await observe(TARGET_URL, fetcher, {}, async () => {}, async () => { throw Error('enrichment failed'); });
  assert.equal(result.outcome, 'ok'); assert.equal(result.components.find(item => item.name === 'jQuery').version, '3.7.1');
  assert.equal(result.versionExtraction.status, 'failed');
});
