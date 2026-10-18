// Independently authored observations. No Wappalyzer code or fingerprint data.
// Rules describe public names/paths/APIs; observations are never proof of use.
import { packageForTechnology } from "./packages.mjs";

const RELEASE = String.raw`([0-9]{1,4}\.[0-9]{1,4}(?:\.[0-9]{1,4})?(?:-[a-z0-9.-]{1,32})?)`;
const EXACT_RELEASE = String.raw`([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[a-z0-9.-]{1,32})?)`;
const marker = (type, key, pattern = ".", score = 70) => ({ type, key, pattern, score });
const runtimeVersion = (key) => ({ type: "js", key, pattern: `^${RELEASE}$`, versionGroup: 1, basis: "runtime", score: 95 });
const generator = (name) => ({ type: "meta", key: "generator", pattern: `^${name}(?:[ /]${RELEASE})?(?:$|\\s)`, versionGroup: 1, basis: "declared", score: 100 });
const header = (key, name) => ({ type: "headers", key, pattern: `^${name}(?:/${RELEASE})?(?:$|[ (])`, versionGroup: 1, basis: "declared", score: 100 });
const script = (pattern) => marker("scriptSrc", "", pattern, 65);
const banner = (name) => ({ type: "scripts", key: "", pattern: `\\b${name}\\s*(?:[-:]\\s*)?(?:v(?:ersion)?\\s*)?${RELEASE}(?=$|[^a-z0-9.+-])`, versionGroup: 1, basis: "declared", score: 70, scanAll: true });

export const TECHNOLOGY_RULES = Object.freeze([
  { id: "wordpress", name: "WordPress", implies: ["php"], patterns: [marker("js", "wp.receiveEmbedMessage", "^true$"), script("/wp-(?:content|includes)/")] },
  { id: "nextjs", name: "Next.js", implies: ["react"], patterns: [runtimeVersion("next.version"), marker("js", "__NEXT_DATA__", "^true$"), { type: "headers", key: "x-powered-by", pattern: `^Next\\.js(?:[ /]${RELEASE})?$`, versionGroup: 1, basis: "declared", score: 100 }] },
  { id: "jquery", name: "jQuery", patterns: [runtimeVersion("jQuery.fn.jquery"), runtimeVersion("$.fn.jquery"), banner("jQuery"), { type: "scriptSrc", key: "", pattern: `^https?://ajax\\.googleapis\\.com/ajax/libs/jquery/${EXACT_RELEASE}/jquery(?:\\.slim)?(?:\\.min)?\\.js$`, versionGroup: 1, basis: "referenced", score: 65 }] },
  { id: "bootstrap", name: "Bootstrap", patterns: [runtimeVersion("bootstrap.Tooltip.VERSION"), banner("Bootstrap"), marker("css", "", "--bs-(?:body|primary|font)", 60)] },
  { id: "nginx", name: "nginx", patterns: [] },
  { id: "php", name: "PHP", patterns: [marker("cookies", "phpsessid", "^true$", 55)] },
  { id: "react", name: "React", patterns: [runtimeVersion("React.version"), banner("React"), marker("dom", "react-root", "^true$", 80), marker("dom", "[data-react-helmet]", "^true$", 60), marker("scripts", "", "https://react\\.dev/errors/", 65)] },
  { id: "vue", name: "Vue.js", patterns: [runtimeVersion("Vue.version"), banner("Vue(?:\\.js)?"), { ...runtimeVersion("vue-app.version"), type: "dom" }, marker("dom", "vue-root", "^true$", 80)] },
  { id: "nuxt", name: "Nuxt", implies: ["vue"], patterns: [marker("js", "__NUXT__", "^true$", 85), script("/_nuxt/")] },
  { id: "angular", name: "Angular", patterns: [{ type: "dom", key: "[ng-version]", pattern: `^${RELEASE}$`, versionGroup: 1, basis: "declared", score: 95 }] },
  { id: "angularjs", name: "AngularJS", patterns: [runtimeVersion("angular.version.full")] },
  { id: "alpinejs", name: "Alpine.js", patterns: [runtimeVersion("Alpine.version")] },
  { id: "htmx", name: "htmx", patterns: [runtimeVersion("htmx.version")] },
  { id: "astro", name: "Astro", patterns: [generator("Astro"), marker("dom", "astro-island", "^true$", 85)] },
  { id: "svelte", name: "Svelte", patterns: [marker("dom", "svelte-class", "^true$", 60)] },
  { id: "gatsby", name: "Gatsby", implies: ["react"], patterns: [generator("Gatsby"), marker("dom", "#___gatsby", "^true$", 85)] },
  { id: "drupal", name: "Drupal", implies: ["php"], patterns: [generator("Drupal"), marker("js", "Drupal.behaviors", "^true$", 85)] },
  { id: "joomla", name: "Joomla", implies: ["php"], patterns: [generator("Joomla!?"), marker("js", "Joomla", "^true$", 65)] },
  { id: "ghost", name: "Ghost", patterns: [generator("Ghost")] },
  { id: "shopify", name: "Shopify", patterns: [marker("js", "Shopify.shop", "\\.myshopify\\.com$", 95), script("cdn\\.shopify\\.com/"), marker("cookies", "_shopify_y", "^true$", 60)] },
  { id: "wix", name: "Wix", patterns: [generator("Wix(?:\\.com)?"), script("static\\.wixstatic\\.com/")] },
  { id: "webflow", name: "Webflow", patterns: [marker("dom", "html[data-wf-site]", "^true$", 90), generator("Webflow")] },
  { id: "squarespace", name: "Squarespace", patterns: [generator("Squarespace"), marker("js", "Static.SQUARESPACE_CONTEXT", "^true$", 90)] },
  { id: "express", name: "Express", patterns: [marker("headers", "x-powered-by", "^Express$", 100)] },
  { id: "apache", name: "Apache HTTP Server", patterns: [header("server", "Apache")] },
  { id: "caddy", name: "Caddy", patterns: [header("server", "Caddy")] },
  { id: "iis", name: "Microsoft IIS", patterns: [header("server", "Microsoft-IIS")] },
  { id: "cloudflare", name: "Cloudflare", patterns: [marker("headers", "server", "^cloudflare$", 100), marker("headers", "cf-ray", "^[a-f0-9]+-", 90)] },
  { id: "vercel", name: "Vercel", patterns: [marker("headers", "x-vercel-id", ".", 90), marker("headers", "server", "^Vercel$", 100)] },
  { id: "netlify", name: "Netlify", patterns: [marker("headers", "server", "^Netlify$", 100), marker("headers", "x-nf-request-id", ".", 85)] },
  { id: "hugo", name: "Hugo", patterns: [generator("Hugo")] },
  { id: "jekyll", name: "Jekyll", patterns: [generator("Jekyll")] },
  { id: "docusaurus", name: "Docusaurus", implies: ["react"], patterns: [generator("Docusaurus")] },
  { id: "google-analytics", name: "Google Analytics", patterns: [marker("cookies", "_ga", "^true$", 60), marker("xhr", "", "(?:^|\\.)google-analytics\\.com$", 85)] },
  { id: "google-tag-manager", name: "Google Tag Manager", patterns: [script("^https://www\\.googletagmanager\\.com/gtm\\.js")] },
  // Keep the existing NAIKEN library observations in the same version resolver.
  { id: "jquery-mobile", name: "jQuery Mobile", patterns: [banner("jQuery Mobile"), { type: "scriptSrc", key: "", pattern: `(?:^|/)jquery\\.mobile[-.]${RELEASE}(?:\\.min)?\\.js$`, versionGroup: 1, basis: "referenced", score: 65 }] },
  { id: "jquery-cookie", name: "jQuery Cookie", patterns: [banner("jQuery Cookie(?: Plugin)?")] },
  { id: "swiper", name: "Swiper", patterns: [banner("Swiper"), { type: "scriptSrc", key: "", pattern: `/swiper/${EXACT_RELEASE}/[^?#]+\\.js$`, versionGroup: 1, basis: "referenced", score: 65 }] },
  { id: "picturefill", name: "picturefill", patterns: [banner("picturefill")] },
  { id: "magnific-popup", name: "Magnific Popup", patterns: [banner("Magnific Popup")] },
  { id: "jquery-match-height", name: "jquery-match-height", patterns: [banner("(?:jquery[.-]match[.-]height|matchHeight)")] },
  { id: "styled-components", name: "styled-components", patterns: [{ type: "dom", key: "[data-styled-version]", pattern: `^${RELEASE}$`, versionGroup: 1, basis: "declared", score: 95 }] },
].map((rule) => {
  const identity = packageForTechnology(rule.id);
  if (!identity) return rule;
  const name = identity.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `^https?://(?:cdn\\.jsdelivr\\.net/npm/|unpkg\\.com/)${name}@${EXACT_RELEASE}/[^?#]+\\.(?:m?js|css)$`;
  return { ...rule, patterns: [...rule.patterns, ...["scriptSrc", "stylesheetSrc"].map((type) => ({ type, key: "", pattern, versionGroup: 1, basis: "referenced", score: 65 }))] };
}));

export const SUPPORTED_TECHNOLOGIES = Object.freeze(TECHNOLOGY_RULES.map(({ id, name }) => Object.freeze({ id, name })));
export const RUNTIME_CHAINS = Object.freeze([...new Set(TECHNOLOGY_RULES.flatMap(({ patterns }) => patterns.filter(({ type }) => type === "js").map(({ key }) => key)))]);
