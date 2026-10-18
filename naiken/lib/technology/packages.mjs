// Exact registry identities for supported products. A correspondence does not
// establish how the site installed the product, or expose its full dependencies.
export const TECHNOLOGY_PACKAGES = Object.freeze(Object.fromEntries(Object.entries({
  jquery: "jquery", bootstrap: "bootstrap", nextjs: "next", react: "react",
  vue: "vue", nuxt: "nuxt", angular: "@angular/core", angularjs: "angular",
  alpinejs: "alpinejs", htmx: "htmx.org", astro: "astro", svelte: "svelte",
  gatsby: "gatsby", express: "express", docusaurus: "@docusaurus/core",
  swiper: "swiper", picturefill: "picturefill", "magnific-popup": "magnific-popup",
  "styled-components": "styled-components", "jquery-match-height": "jquery-match-height",
}).map(([id, name]) => [id, Object.freeze({ name, ecosystem: "npm" })])));

export function packageForTechnology(id) {
  return Object.hasOwn(TECHNOLOGY_PACKAGES, id) ? TECHNOLOGY_PACKAGES[id] : null;
}

export const SUPPORTED_OSV_PACKAGES = Object.freeze(Object.values(TECHNOLOGY_PACKAGES).map(({ name, ecosystem }) => `${ecosystem}/${name}`));
