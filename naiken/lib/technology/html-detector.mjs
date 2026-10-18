// Original, deliberately small rules. No third-party fingerprint database.
// This module only inspects strings supplied by its caller; it performs no I/O.

export const LIMITS = Object.freeze({
  htmlCharacters: 512_000,
  headerEntries: 128,
  headerValueCharacters: 8_192,
  totalHeaderCharacters: 65_536,
  tagCharacters: 16_384,
  evidencePerProduct: 8,
});

const PRODUCTS = Object.freeze({
  bootstrap: "Bootstrap",
  jquery: "jQuery",
  nextjs: "Next.js",
  nginx: "nginx",
  php: "PHP",
  wordpress: "WordPress",
});
export const SUPPORTED_TECHNOLOGIES = Object.freeze(Object.entries(PRODUCTS).map(([id, name]) => Object.freeze({ id, name })));
const RELEASE = String.raw`[0-9]{1,4}\.[0-9]{1,4}(?:\.[0-9]{1,4})?(?:-(?:alpha|beta|rc)(?:[.-]?[0-9]{1,4})?)?`;
const SEMVER = String.raw`[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-(?:alpha|beta|rc)(?:[.-]?[0-9]{1,4})?)?`;
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const INERT = new Set(["template", "svg", "math"]);
const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

function decodeEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()];
    const hex = entity[1].toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : whole;
  });
}

// Quote-aware tokenizer for a restricted static-HTML view, not a browser DOM.
// Comments, raw-text contents and inert template/foreign contents are excluded.
export function readTags(html) {
  const tags = [];
  const inert = new Map();
  let cursor = 0;
  let complete = true;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end === -1) { complete = false; break; }
      cursor = end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", start)) {
      const end = html.indexOf("]]>", start + 9);
      if (end === -1) { complete = false; break; }
      cursor = end + 3;
      continue;
    }
    if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
      let quote = null; let end = start + 2;
      for (; end < html.length; end++) {
        if (quote) { if (html[end] === quote) quote = null; }
        else if (html[end] === '"' || html[end] === "'") quote = html[end];
        else if (html[end] === ">") break;
      }
      if (end === html.length) { complete = false; break; }
      cursor = end + 1;
      continue;
    }
    const prefix = /^<\/?([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(start, start + 160));
    if (!prefix) { cursor = start + 1; continue; }
    let quote = null;
    let end = start + prefix[0].length;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === html.length) { complete = false; break; }
    // Scan to the real end so quoted markup cannot become evidence. Skip large
    // attribute lists while retaining later tags and raw-text/inert boundaries.
    const oversized = end - start > LIMITS.tagCharacters;
    if (oversized) complete = false;
    cursor = end + 1;
    const name = prefix[1].toLowerCase();
    const closing = html[start + 1] === "/";
    if (closing) {
      if (INERT.has(name)) inert.set(name, Math.max(0, (inert.get(name) ?? 0) - 1));
      continue;
    }
    if (name === "plaintext") { complete = false; break; }
    if (INERT.has(name)) {
      // A slash does not self-close an HTML template, but does close SVG/MathML.
      if (name === "template" || html[end - 1] !== "/") inert.set(name, (inert.get(name) ?? 0) + 1);
    }
    const attrs = new Map();
    const body = oversized ? "" : html.slice(start + prefix[0].length, end);
    const attrPattern = /([^\s/=>"'<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const attr of body.matchAll(attrPattern)) {
      const key = attr[1].toLowerCase();
      // HTML retains the first occurrence of a duplicate attribute.
      if (!attrs.has(key)) attrs.set(key, decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ""));
    }
    if (!oversized && ![...inert.values()].some(Boolean)) tags.push({ name, attrs, offset: start, endOffset: end + 1 });
    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "gi");
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) { complete = false; break; }
      cursor = close.lastIndex;
    }
  }
  return { tags, complete };
}

function normalizeHeaders(headers) {
  if (headers === null || typeof headers !== "object") throw new TypeError("headers must be an object or pairs");
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const normalized = [];
  let size = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new TypeError("Invalid header entry");
    const name = entry[0].trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new TypeError("Invalid header name");
    for (const value of Array.isArray(entry[1]) ? entry[1] : [entry[1]]) {
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new TypeError("Invalid header value");
      size += name.length + value.length;
      if (value.length > LIMITS.headerValueCharacters || size > LIMITS.totalHeaderCharacters || normalized.length >= LIMITS.headerEntries) {
        throw new RangeError("Headers exceed the prototype limit");
      }
      normalized.push({ name, value: value.trim() });
    }
  }
  return normalized;
}

function pageContext(sourceUrl) {
  if (sourceUrl === null) return null;
  if (typeof sourceUrl !== "string") throw new TypeError("sourceUrl must be a string or null");
  const url = new URL(sourceUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new TypeError("Invalid sourceUrl");
  url.search = "";
  url.hash = "";
  return url;
}

// The first active base[href] wins even when its URL falls back to the page.
// Track whether the origin is known so source-less fixtures keep relative paths.
export function resolveHtmlBase(tags, sourceUrl = null) {
  const fallback = { url: new URL(sourceUrl ?? "https://fixture.invalid/"), absolute: sourceUrl !== null };
  const base = tags.find((tag) => tag.name === "base" && tag.attrs.has("href"));
  if (!base) return fallback;
  const raw = base.attrs.get("href").trim();
  try {
    const url = new URL(raw, fallback.url);
    if (["data:", "javascript:"].includes(url.protocol)) return fallback;
    return { url, absolute: fallback.absolute || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw) };
  } catch { return fallback; }
}

function assetReference(raw, base) {
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  try {
    const url = new URL(raw, base.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    const absolute = base.absolute || /^(?:https?:)?\/\//i.test(raw);
    return { url, value: absolute ? url.href : url.pathname };
  } catch { return null; }
}

function referencedVersion(product, asset, fileVersion) {
  if (fileVersion) return fileVersion;
  // Only explicitly versioned package references on these two CDN routes.
  // Cache-busting query parameters and arbitrary numeric path segments are ignored.
  const prefix = asset.url.hostname === "cdn.jsdelivr.net" ? "/npm/"
    : asset.url.hostname === "unpkg.com" ? "/" : null;
  if (prefix === null) return null;
  return new RegExp(`^${prefix}${product}@(${SEMVER})(?:/|$)`, "i").exec(asset.url.pathname)?.[1] ?? null;
}

/**
 * Passive observations only. All returned values are untrusted data.
 * A version is a public declaration/reference, never a verified installation.
 */
export function detectTechnologies({ html = "", headers = {}, sourceUrl = null } = {}) {
  if (typeof html !== "string") throw new TypeError("html must be a string");
  if (html.length > LIMITS.htmlCharacters) throw new RangeError("HTML exceeds the prototype limit");
  const page = pageContext(sourceUrl);
  const observedHeaders = normalizeHeaders(headers);
  const { tags, complete } = readTags(html);
  const base = resolveHtmlBase(tags, page?.href ?? null);
  const found = new Map();
  const truncated = new Set();
  function add(id, ruleId, confidence, location, value, version = null, versionBasis = null) {
    if (!found.has(id)) found.set(id, []);
    if (found.get(id).length >= LIMITS.evidencePerProduct) { truncated.add(id); return; }
    found.get(id).push({ ruleId, confidence, location, value, sourceUrl: page?.href ?? null, claimedVersion: version, versionBasis });
  }

  for (const [index, header] of observedHeaders.entries()) {
    for (const [id, name, headerName] of [["nginx", "nginx", "server"], ["php", "PHP", "x-powered-by"]]) {
      if (header.name !== headerName || !new RegExp(`^${name}(?=$|[/ \\t(])`, "i").test(header.value)) continue;
      const version = new RegExp(`^${name}/(${SEMVER})(?=$|[ \\t(])`, "i").exec(header.value)?.[1] ?? null;
      add(id, `${id}.header`, "high", { source: "header", name: header.name, index }, header.value, version, version ? "declared" : null);
    }
  }

  for (const tag of tags) {
    const location = (attribute) => ({ source: "html", tag: tag.name, attribute, offset: tag.offset });
    if (tag.name === "meta" && tag.attrs.get("name")?.trim().toLowerCase() === "generator") {
      const value = tag.attrs.get("content")?.trim() ?? "";
      if (/^WordPress(?=$|\s)/i.test(value)) {
        const version = new RegExp(`^WordPress\\s+(${RELEASE})(?=$|\\s)`, "i").exec(value)?.[1] ?? null;
        add("wordpress", "wordpress.generator", "high", location("content"), value, version, version ? "declared" : null);
      }
    }
    const type = (tag.attrs.get("type") ?? "").trim().toLowerCase();
    if (tag.name === "script" && tag.attrs.get("id") === "__NEXT_DATA__" && type === "application/json") {
      add("nextjs", "nextjs.data-script", "medium", location("id"), "__NEXT_DATA__");
    }
    const script = tag.name === "script" && JS_TYPES.has(type);
    const stylesheet = tag.name === "link" && (tag.attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet");
    if (!script && !stylesheet) continue;
    const attribute = script ? "src" : "href";
    const asset = assetReference(tag.attrs.get(attribute), base);
    if (!asset) continue;
    const basename = asset.url.pathname.split("/").at(-1);
    const jquery = script && new RegExp(`^jquery(?:[-.](${SEMVER}))?(?:\\.slim)?(?:\\.min)?\\.js$`, "i").exec(basename);
    if (jquery) {
      const version = referencedVersion("jquery", asset, jquery[1]);
      add("jquery", "jquery.asset-reference", "medium", location(attribute), asset.value, version, version ? "referenced" : null);
    }
    const bootstrap = new RegExp(`^bootstrap(?:[-.](${SEMVER}))?(?:\\.bundle)?(?:\\.min)?\\.${script ? "js" : "css"}$`, "i").exec(basename);
    if (bootstrap) {
      const version = referencedVersion("bootstrap", asset, bootstrap[1]);
      add("bootstrap", "bootstrap.asset-reference", "medium", location(attribute), asset.value, version, version ? "referenced" : null);
    }
    if (script && /(?:^|\/)_next\/static\//.test(asset.url.pathname)) {
      add("nextjs", "nextjs.static-reference", "medium", location(attribute), asset.value);
    }
  }

  const detections = [...found].sort(([left], [right]) => left.localeCompare(right)).map(([id, evidence]) => {
    const byVersion = new Map();
    evidence.forEach((item, index) => {
      if (!item.claimedVersion) return;
      if (!byVersion.has(item.claimedVersion)) byVersion.set(item.claimedVersion, { version: item.claimedVersion, basis: item.versionBasis, confidence: item.confidence, evidenceIndexes: [] });
      byVersion.get(item.claimedVersion).evidenceIndexes.push(index);
    });
    const versions = [...byVersion.values()];
    const single = versions.length === 1 && !truncated.has(id) ? versions[0] : null;
    return {
      id, name: PRODUCTS[id],
      confidence: evidence.some((item) => item.confidence === "high") ? "high" : "medium",
      version: single?.version ?? null,
      versionStatus: truncated.has(id) ? "incomplete" : single?.basis ?? (versions.length ? "multiple" : "unknown"),
      versionConfidence: single?.confidence ?? null,
      versions, evidence,
    };
  });
  return { schemaVersion: 1, sourceUrl: page?.href ?? null, supportedTechnologies: SUPPORTED_TECHNOLOGIES, coverage: { mode: "static-html-and-headers", htmlParsedCompletely: complete, evidenceTruncated: truncated.size > 0 }, detections };
}
