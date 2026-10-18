import { Miniflare } from 'miniflare';

// Local Miniflare normally allows private networks. Use a separate public-only
// network service so the actual socket destination, after DNS resolution, is
// filtered too. This prevents a DNS preflight/fetch race in local previews.
export async function createPublicEgress() {
  const runtime = new Miniflare({
    host: '127.0.0.1', port: 0, cf: false, inspectorPort: undefined,
    modules: true, compatibilityDate: '2026-05-15',
    outboundService: { network: { allow: ['public'], deny: ['private', '240.0.0.0/4'], tlsOptions:{trustBrowserCas:true} } },
    script: `export default {
      async fetch(request) {
        if (request.method !== 'GET') return new Response('Method not allowed', {status:405});
        const target = request.headers.get('x-naiken-target');
        let url;
        try { url = new URL(target); } catch { return new Response('Invalid URL', {status:400}); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
          return new Response('Invalid destination', {status:400});
        try {
          return await fetch(url, {redirect:'manual', signal:AbortSignal.timeout(10000),
            headers:{'User-Agent':'NAIKEN-Prototype/0.1 (public-page-inspection; no-authentication)',
              Accept:request.headers.get('accept') || '*/*'}});
        } catch { return new Response('Public destination unavailable', {status:502}); }
      }
    }`,
  });
  return { url:(await runtime.ready).origin, dispose:()=>runtime.dispose() };
}
