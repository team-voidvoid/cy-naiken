import type { ComponentInfo, TechnologyCoverage } from '../diagnosis-types.ts';
import type { TechnologySignal } from './types.ts';
import { cleanEvidenceUrl, detectPageTechnologies } from './engine.mjs';
import { LIMITS, readTags, resolveHtmlBase } from './html-detector.mjs';

const SCRIPT_CHARACTERS = 200_000;
const SCRIPT_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);
const HEADER_NAMES = ['server', 'x-powered-by', 'cf-ray', 'x-vercel-id', 'x-nf-request-id'];
export interface ScriptSource { url: string; body: string }

/** Active executable references only; first base[href], including CDN bases. */
export function referencedScripts(body: string, pageUrl: string): string[] {
  const { tags } = readTags(body.slice(0, LIMITS.htmlCharacters));
  const base = resolveHtmlBase(tags, pageUrl);
  return tags.flatMap((tag) => {
    if (tag.name !== 'script' || !SCRIPT_TYPES.has((tag.attrs.get('type') ?? '').trim().toLowerCase())) return [];
    const source = tag.attrs.get('src');
    if (!source) return [];
    try { return [new URL(source, base.url).href]; } catch { return []; }
  });
}

/** Workers-compatible collection: inspect supplied strings, never execute JS. */
export function inspectTechnologies(page: { url: string; body: string; headers: Headers }, scripts: ScriptSource[] = []): { components: ComponentInfo[]; coverage: TechnologyCoverage } {
  const body = page.body.slice(0, LIMITS.htmlCharacters);
  let inputTruncated = page.body.length > body.length;
  const { tags } = readTags(body);
  const observations: TechnologySignal[] = [];
  const add = (type: string, key: string, value: string, url: string, location: TechnologySignal['location']) => {
    if (value.length > SCRIPT_CHARACTERS) inputTruncated = true;
    observations.push({ type, key, value: value.slice(0, SCRIPT_CHARACTERS), sourceUrl: cleanEvidenceUrl(url) ?? page.url, location });
  };
  for (const tag of tags) {
    const location = { source: 'html', tag: tag.name, offset: tag.offset };
    if (tag.attrs.has('ng-version')) add('dom', '[ng-version]', tag.attrs.get('ng-version')!, page.url, { ...location, attribute: 'ng-version' });
    if (tag.attrs.has('data-styled-version')) add('dom', '[data-styled-version]', tag.attrs.get('data-styled-version')!, page.url, { ...location, attribute: 'data-styled-version' });
    if (tag.attrs.has('data-react-helmet')) add('dom', '[data-react-helmet]', 'true', page.url, { ...location, attribute: 'data-react-helmet' });
    if (tag.attrs.has('data-reactroot')) add('dom', 'react-root', 'true', page.url, { ...location, attribute: 'data-reactroot' });
    if (/(?:^|\s)svelte-[a-z0-9]+(?:\s|$)/i.test(tag.attrs.get('class') ?? '')) add('dom', 'svelte-class', 'true', page.url, { ...location, attribute: 'class' });
    const executable = tag.name === 'script' && !tag.attrs.has('src') && SCRIPT_TYPES.has((tag.attrs.get('type') ?? '').trim().toLowerCase());
    if (executable || tag.name === 'style') {
      const tail = body.slice(tag.endOffset);
      const end = tail.search(new RegExp(`</${tag.name}\\s*>`, 'i'));
      add(executable ? 'scripts' : 'css', '', end < 0 ? tail : tail.slice(0, end), page.url, { ...location, inline: true });
    }
  }
  for (const script of scripts) {
    const source = cleanEvidenceUrl(script.url);
    if (!source) continue;
    add('scriptSrc', '', source, source, { source: 'fetched-script', attribute: 'src' });
    add('scripts', '', script.body, source, { source: 'fetched-script' });
  }
  const headers: Record<string, string | string[]> = {};
  for (const name of HEADER_NAMES) {
    const value = page.headers.get(name);
    if (value) { headers[name] = value.slice(0, 8192); inputTruncated ||= value.length > 8192; }
  }
  // The detector needs cookie names only. Values never enter saved evidence.
  const cookies = typeof page.headers.getSetCookie === 'function' ? page.headers.getSetCookie() : (page.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
  headers['set-cookie'] = cookies.slice(0, 50).flatMap((cookie) => {
    const name = cookie.split('=')[0].trim();
    return /^[\w!#$%&'*+.^`|~-]{1,256}$/.test(name) ? [`${name}=true`] : [];
  });
  inputTruncated ||= cookies.length > 50 || observations.length > 400;
  const detected = detectPageTechnologies({ url: page.url, body, headers }, { status: 'disabled', observations });
  const components = detected.detections.map((detection): ComponentInfo => ({
    technologyId: detection.id, name: detection.name, version: detection.version ?? undefined,
    package: detection.package ?? undefined, versionStatus: detection.versionStatus,
    versions: detection.versions.map(({ version }) => version), detectionBasis: detection.detectionBasis,
    detectionConfidence: detection.confidence, confidenceScore: detection.confidenceScore,
    evidence: detection.evidence.map((evidence) => ({
      label: detection.detectionBasis === 'inferred' ? '関連技術からの推定' : evidence.versionBasis === 'referenced' ? '公開ファイルの参照' : '公開された記載・特徴',
      value: evidence.value, url: evidence.sourceUrl ?? undefined, ruleId: evidence.ruleId,
    })),
  }));
  return { components, coverage: {
    engine: 'wappalyzer-style', mode: 'static', browserExecuted: false,
    supportedTechnologies: detected.supportedTechnologies.length,
    observedSignals: detected.coverage.observedSignalTypes,
    htmlParsedCompletely: detected.coverage.htmlParsedCompletely && page.body.length === body.length,
    evidenceTruncated: detected.coverage.evidenceTruncated, inputTruncated,
  } };
}
