import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTechnologies, referencedScripts } from '../lib/technology/scanner.ts';
import { finalizeObservation } from '../lib/rules.ts';
import { observe } from '../lib/scanner.ts';

const url = 'https://public.example.com/shop/';
const page = (body = '', headers = {}) => ({ url, body, headers: new Headers(headers) });
const component = (result, name) => result.components.find((item) => item.name === name);
const observation = (components, extras = {}) => ({ url, finalUrl: url, status: 200, fetchedAt: new Date().toISOString(), bytes: 100,
  userAgent: 'fixture', outcome: 'ok', findings: [], components, checkedCategories: ['components'], scriptsFetched: 0, scriptsSkipped: 0, ...extras });

test('Google Hosted Libraries and scoped npm CDN references identify packages without executing JavaScript', () => {
  const result = inspectTechnologies(page(`<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
    <script src="https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@angular/core@18.2.0/fesm2022/core.mjs"></script>`));
  assert.deepEqual(component(result, 'jQuery').package, { name: 'jquery', ecosystem: 'npm' });
  assert.equal(component(result, 'jQuery').version, '3.7.1');
  assert.equal(component(result, 'Vue.js').versionStatus, 'referenced');
  assert.equal(component(result, 'Angular').package.name, '@angular/core');
  assert.equal(result.coverage.supportedTechnologies, 42); assert.equal(result.coverage.browserExecuted, false);
});

test('HTML attributes, generators and response headers share the same evidence resolver', () => {
  const result = inspectTechnologies(page('<meta name="generator" content="WordPress 6.6.2"><div ng-version="18.2.0"></div><style data-styled-version="5.3.11"></style>', { server: 'nginx/1.26.2' }));
  assert.equal(component(result, 'nginx').version, '1.26.2');
  assert.equal(component(result, 'Angular').version, '18.2.0');
  assert.equal(component(result, 'Angular').versionStatus, 'declared');
  assert.equal(component(result, 'styled-components').package.name, 'styled-components');
  assert.equal(component(result, 'PHP').detectionBasis, 'inferred');
  assert.equal(component(result, 'PHP').version, undefined);
});

test('related products retain package names but never acquire inferred versions or age points', () => {
  const result = inspectTechnologies(page('<script src="/_next/static/app.js"></script>'));
  const react = component(result, 'React');
  assert.equal(react.detectionBasis, 'inferred'); assert.equal(react.version, undefined); assert.equal(react.package.name, 'react');
  assert.equal(component(result, 'Next.js').package.name, 'next');
  const finalized = finalizeObservation(observation([{ name: 'jQuery', version: '1.11.1', detectionBasis: 'inferred', evidence: [] }]));
  assert.equal(finalized.score, 0); assert.equal(finalized.oldestYear, undefined);
});

test('conflicting file and bundle declarations become one component with no definitive version or old-age score', () => {
  const result = inspectTechnologies(page('<script src="/jquery-3.7.1.min.js"></script>'), [{ url: 'https://public.example.com/jquery-3.7.1.min.js', body: '/*! jQuery v1.11.1 */' }]);
  const jquery = component(result, 'jQuery');
  assert.equal(result.components.length, 1); assert.equal(jquery.version, undefined); assert.equal(jquery.versionStatus, 'multiple');
  assert.deepEqual(jquery.versions.sort(), ['1.11.1', '3.7.1']);
  const finalized = finalizeObservation(observation(result.components));
  assert.equal(finalized.score, 0); assert.equal(finalized.oldestYear, undefined); assert.match(finalized.unknowns.join(' '), /複数の版/);
});

test('multiple versions inside the same concatenated bundle are all retained', () => {
  const result = inspectTechnologies(page(), [{ url: 'https://cdn.example.com/bundle.js', body: '/*! jQuery v1.11.1 */\n/*! jQuery v3.7.1 */' }]);
  assert.equal(component(result, 'jQuery').versionStatus, 'multiple');
  assert.deepEqual(component(result, 'jQuery').versions, ['1.11.1', '3.7.1']);
});

test('the existing seven library signatures remain supported in the dictionary', () => {
  const result = inspectTechnologies(page('<style data-styled-version="5.3.11"></style>'), [{ url: 'https://cdn.example.com/libraries.js', body:
    'jQuery Mobile version 1.4.5\njQuery Cookie Plugin v1.4.1\nSwiper v8.4.7\npicturefill - v3.0.3\nMagnific Popup v1.1.0\nmatchHeight: v0.7.2' }]);
  for (const name of ['jQuery Mobile', 'jQuery Cookie', 'Swiper', 'picturefill', 'Magnific Popup', 'jquery-match-height', 'styled-components']) assert.ok(component(result, name), name);
  assert.equal(component(result, 'jQuery'), undefined, 'Plugin banners must not imply a jQuery core version');
});

test('comments, examples, raw-text markup and inert templates do not identify technologies or get fetched', () => {
  const body = `<!-- <script src="/jquery-1.11.1.js"></script> -->
    <template><meta name="generator" content="WordPress 6.6.2"><script src="/hidden.js"></script></template>
    <script type="application/ld+json">{"example":"<style data-styled-version='5.3.11'>"}</script>
    <p>jQuery v1.11.1</p><img alt="<script src='/fake.js'>">`;
  assert.deepEqual(inspectTechnologies(page(body)).components, []);
  assert.deepEqual(referencedScripts(body, url), []);
});

test('the first active HTML base resolves both evidence and executable script references', () => {
  const body = '<template><base href="https://ignored.example.com/"></template><base href="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/"><base href="https://ignored.example.com/"><script src="jquery.min.js?v=cache"></script>';
  assert.deepEqual(referencedScripts(body, url), ['https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js?v=cache']);
  const jquery = component(inspectTechnologies(page(body)), 'jQuery');
  assert.equal(jquery.version, '3.7.1'); assert.ok(!JSON.stringify(jquery).includes('cache'));
});

test('large tags preserve later library observations and report partial parsing', () => {
  const body = `<img src="data:image/png;base64,${'a'.repeat(17_000)}"><script src="/jquery-3.7.1.min.js"></script>`;
  const result = inspectTechnologies(page(body));
  assert.equal(component(result, 'jQuery').version, '3.7.1'); assert.equal(result.coverage.htmlParsedCompletely, false);
});

test('input and evidence limits stay visible without selecting a single version', () => {
  const result = inspectTechnologies(page('<meta name="generator" content="Astro 5.1.0">' + ' '.repeat(520_000)));
  assert.equal(result.coverage.inputTruncated, true); assert.equal(result.coverage.htmlParsedCompletely, false);
  const bounded = inspectTechnologies(page(), [{ url: 'https://cdn.example.com/bundle.js', body: 'jQuery v1.11.1\n'.repeat(20) }]);
  assert.equal(component(bounded, 'jQuery').versionStatus, 'incomplete'); assert.equal(component(bounded, 'jQuery').version, undefined);
  assert.equal(bounded.coverage.evidenceTruncated, true); assert.equal(finalizeObservation(observation(bounded.components)).score, 0);
});

test('cookie values and URL query secrets never enter component evidence', () => {
  const result = inspectTechnologies(page('<script src="https://unpkg.com/vue@3.5.13/dist/vue.global.js?token=private-token#private-fragment"></script>', { 'set-cookie': 'PHPSESSID=private-cookie; Secure; HttpOnly' }));
  assert.ok(component(result, 'PHP')); assert.ok(component(result, 'Vue.js'));
  assert.doesNotMatch(JSON.stringify(result), /private-cookie|private-token|private-fragment/);
});

test('version ranges, lookalike CDN hosts and unexecuted globals cannot produce exact package versions', () => {
  const result = inspectTechnologies(page('<script src="https://unpkg.com/vue@latest/dist/vue.global.js"></script><script src="https://unpkg.com.evil.example.net/react@19.2.0/dist/react.js"></script>'), [
    { url: 'https://public.example.com/app.js', body: 'window.Vue={version:"3.5.13"};window.React={version:"19.2.0"};' },
  ]);
  assert.deepEqual(result.components, []);
});

const htmlResponse = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
test('the real scanner routes active CDN sources through existing validation and records package metadata', async () => {
  const requests = []; const dnsHosts = [];
  const result = await observe(url, async (target, init) => {
    requests.push(target); assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('authorization'), null); assert.equal(new Headers(init.headers).get('cookie'), null);
    if (target.startsWith('http:')) return new Response('blocked', { status: 403 });
    if (target === url) return htmlResponse('<base href="https://cdn.example.com/libraries/"><template><script src="/hidden.js"></script></template><script src="jquery.min.js"></script>', { server: 'Caddy' });
    assert.equal(target, 'https://cdn.example.com/libraries/jquery.min.js');
    return new Response('/*! jQuery v3.7.1 */', { headers: { 'content-type': 'application/javascript' } });
  }, {}, async (target) => { dnsHosts.push(target.hostname); });
  assert.equal(result.outcome, 'ok'); assert.equal(result.scriptsFetched, 1); assert.equal(requests.length, 3);
  assert.ok(dnsHosts.includes('cdn.example.com')); assert.equal(component(result, 'jQuery').package.name, 'jquery');
  assert.equal(component(result, 'jQuery').version, '3.7.1'); assert.equal(result.technologyCoverage.browserExecuted, false);
});

test('blocked pages stay unscored and do not expose components from challenge markup', async () => {
  const result = await observe(url, async () => new Response('<script src="/jquery-1.11.1.js"></script>', { status: 403 }), {}, async () => {});
  assert.equal(result.outcome, 'blocked'); assert.deepEqual(result.components, []); assert.equal(finalizeObservation(result).score, 0);
});

test('script DNS failures stay unobserved and cannot bypass the transport', async () => {
  const requests = [];
  const result = await observe(url, async (target) => {
    requests.push(target);
    return target.startsWith('http:') ? new Response('blocked', { status: 403 }) : htmlResponse('<script src="https://private.example.net/app.js"></script>');
  }, {}, async (target) => { if (target.hostname === 'private.example.net') throw Error('Private DNS destination'); });
  assert.equal(result.outcome, 'ok'); assert.equal(result.scriptsFetched, 0); assert.equal(result.scriptsSkipped, 1);
  assert.ok(requests.every((target) => !target.includes('private.example.net')));
});

test('the existing five-script retrieval cap remains in force', async () => {
  let scripts = 0;
  const result = await observe(url, async (target) => {
    if (target.startsWith('http:')) return new Response('blocked', { status: 403 });
    if (target === url) return htmlResponse(Array.from({ length: 8 }, (_, i) => `<script src="/js/file-${i}.js"></script>`).join(''));
    scripts++; return new Response('/*! Bootstrap v5.3.3 */', { headers: { 'content-type': 'application/javascript' } });
  }, {}, async () => {});
  assert.equal(scripts, 5); assert.equal(result.scriptsFetched, 5); assert.equal(result.scriptsSkipped, 3);
  assert.equal(component(result, 'Bootstrap').package.name, 'bootstrap');
});
