import { detectTechnologies, readTags, resolveHtmlBase, LIMITS } from "./html-detector.mjs";
import { TECHNOLOGY_RULES, SUPPORTED_TECHNOLOGIES } from "./rules.mjs";
import { packageForTechnology } from "./packages.mjs";

const RULES = TECHNOLOGY_RULES.map((rule) => ({ ...rule, patterns: rule.patterns.map((pattern, index) => ({ ...pattern, ruleId: `${rule.id}.${pattern.type}.${index + 1}`, regex: new RegExp(pattern.pattern, "i") })) }));
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}(?:\.[0-9]{1,4})?(?:-[a-z0-9.-]{1,32})?$/i;

export function cleanEvidenceUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.search = ""; url.hash = "";
    return url.href;
  } catch { return null; }
}

export function pageObservations(page) {
  const { tags } = readTags(page.body);
  const base = resolveHtmlBase(tags, page.url);
  const observations = [];
  const add = (type, key, value, location) => observations.push({ type, key, value: String(value), location, sourceUrl: page.url });
  for (const [key, values] of Object.entries(page.headers)) {
    if (key.toLowerCase() === "set-cookie") {
      for (const value of Array.isArray(values) ? values : [values]) { const name = String(value).split("=")[0].trim().toLowerCase(); if (name) add("cookies", name, "true", { source: "header", name: "set-cookie", cookieName: name }); }
      continue;
    }
    for (const value of Array.isArray(values) ? values : [values]) add("headers", key.toLowerCase(), value, { source: "header", name: key.toLowerCase() });
  }
  for (const tag of tags) {
    const location = { source: "html", tag: tag.name, offset: tag.offset };
    if (tag.name === "meta") {
      const name = tag.attrs.get("name") ?? tag.attrs.get("property");
      if (name && tag.attrs.has("content")) add("meta", name.toLowerCase(), tag.attrs.get("content"), { ...location, attribute: "content" });
    }
    if (tag.name === "script" && tag.attrs.get("src")) {
      const value = cleanEvidenceUrl(tag.attrs.get("src"), base.url);
      if (value) add("scriptSrc", "", value, { ...location, attribute: "src" });
    }
    if (tag.name === "link" && (tag.attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet") && tag.attrs.get("href")) {
      const value = cleanEvidenceUrl(tag.attrs.get("href"), base.url);
      if (value) add("stylesheetSrc", "", value, { ...location, attribute: "href" });
    }
    if (tag.name === "html" && tag.attrs.has("data-wf-site")) add("dom", "html[data-wf-site]", "true", { ...location, attribute: "data-wf-site" });
    if (tag.attrs.get("id") === "___gatsby") add("dom", "#___gatsby", "true", { ...location, attribute: "id" });
    if (tag.name === "astro-island") add("dom", "astro-island", "true", location);
  }
  return observations;
}

function aggregate(id, name, evidence, incomplete) {
  const versions = [];
  evidence.forEach((item, index) => {
    if (!item.claimedVersion) return;
    let candidate = versions.find(({ version }) => version === item.claimedVersion);
    if (!candidate) { candidate = { version: item.claimedVersion, basis: item.versionBasis, confidence: item.confidence, evidenceIndexes: [] }; versions.push(candidate); }
    if (item.versionBasis === "runtime") { candidate.basis = "runtime"; candidate.confidence = item.confidence; }
    candidate.evidenceIndexes.push(index);
  });
  const single = versions.length === 1 && !incomplete ? versions[0] : null;
  return { id, name, package: packageForTechnology(id), confidence: evidence.some(({ confidence }) => confidence === "high") ? "high" : "medium", confidenceScore: Math.min(100, evidence.reduce((sum, item) => sum + (item.score ?? (item.confidence === "high" ? 100 : 65)), 0)), detectionBasis: "observed", version: single?.version ?? null, versionStatus: incomplete ? "incomplete" : single?.basis ?? (versions.length ? "multiple" : "unknown"), versionConfidence: single?.confidence ?? null, versions, evidence };
}

// Deterministic pattern matching and relation resolution; no AI or network I/O.
export function detectPageTechnologies(page, runtime = { observations: [], status: "disabled" }) {
  const original = detectTechnologies({ html: page.body, headers: page.headers, sourceUrl: page.url });
  const found = new Map(original.detections.map((detection) => [detection.id, { name: detection.name, evidence: [...detection.evidence], incomplete: detection.versionStatus === "incomplete" }]));
  const observations = [...pageObservations(page), ...(runtime.observations ?? []).slice(0, 400)];
  const matched = new Set();
  for (let pass = 0; pass < RULES.length; pass++) {
    let changed = false;
    for (const rule of RULES) {
      if (rule.requires?.some((id) => !found.has(id))) continue;
      for (const pattern of rule.patterns) {
        for (const [observationIndex, observation] of observations.entries()) {
          if (observation.type !== pattern.type || observation.key !== pattern.key) continue;
          const value = String(observation.value).slice(0, 200_000);
          const matches = pattern.scanAll ? value.matchAll(new RegExp(pattern.pattern, "gi")) : [pattern.regex.exec(value)].filter(Boolean);
          let occurrence = 0;
          for (const match of matches) {
            if (++occurrence > LIMITS.evidencePerProduct + 1) { if (found.has(rule.id)) found.get(rule.id).incomplete = true; break; }
            const key = `${pattern.ruleId}|${observationIndex}|${match.index}`;
            if (matched.has(key)) continue;
            matched.add(key);
            if (!found.has(rule.id)) { found.set(rule.id, { name: rule.name, evidence: [], incomplete: false }); changed = true; }
            const result = found.get(rule.id);
            const candidate = match[pattern.versionGroup];
            const version = candidate && VERSION.test(candidate) ? candidate : null;
            if (result.evidence.length >= LIMITS.evidencePerProduct) {
              result.incomplete = true;
              const replace = version && !result.evidence.some((item) => item.claimedVersion === version) ? result.evidence.findLastIndex((item) => !item.claimedVersion) : -1;
              if (replace < 0) continue;
              result.evidence.splice(replace, 1);
            }
            const excerpt = value.slice(Math.max(0, match.index - 24), Math.min(value.length, match.index + match[0].length + 100)).slice(0, 400);
            result.evidence.push({ ruleId: pattern.ruleId, score: pattern.score, confidence: pattern.score >= 90 ? "high" : "medium", location: observation.location ?? { source: observation.type, key: observation.key }, value: `${observation.key ? observation.key + ": " : ""}${excerpt}`, sourceUrl: cleanEvidenceUrl(observation.sourceUrl ?? page.url), claimedVersion: version, versionBasis: version ? pattern.basis : null });
          }
        }
      }
    }
    if (!changed) break;
  }
  for (const rule of RULES) if (found.has(rule.id)) for (const id of rule.excludes ?? []) found.delete(id);
  const detections = [...found].map(([id, result]) => aggregate(id, result.name, result.evidence, result.incomplete));
  for (let pass = 0; pass < RULES.length; pass++) {
    let changed = false;
    for (const rule of RULES) {
      const source = detections.find(({ id }) => id === rule.id);
      if (!source) continue;
      for (const id of rule.implies ?? []) {
        if (detections.some((item) => item.id === id)) continue;
        const implied = TECHNOLOGY_RULES.find((item) => item.id === id);
        if (!implied) continue;
        detections.push({ ...aggregate(id, implied.name, [{ ruleId: `${rule.id}.implies.${id}`, confidence: "medium", score: Math.min(50, source.confidenceScore), location: { source: "inference", technology: rule.id }, sourceUrl: page.url, value: `${source.name}の観測から推定。${implied.name}自体の直接観測ではありません。`, claimedVersion: null, versionBasis: null }], false), detectionBasis: "inferred", inferredFrom: [rule.id] });
        changed = true;
      }
    }
    if (!changed) break;
  }
  detections.sort((left, right) => left.id.localeCompare(right.id));
  return { ...original, supportedTechnologies: SUPPORTED_TECHNOLOGIES, detections, coverage: { ...original.coverage, mode: "rule-based-browser-and-static", evidenceTruncated: original.coverage.evidenceTruncated || [...found.values()].some(({ incomplete }) => incomplete), browserStatus: runtime.status, observedSignalTypes: [...new Set(observations.map(({ type }) => type))] } };
}
