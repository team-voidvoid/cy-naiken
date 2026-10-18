declare const __NAIKEN_LOCAL_EGRESS__: string | undefined;

// Production uses Workers' public Internet fetch. Vite dev uses a public-only
// workerd egress service rather than Miniflare's permissive default network.
export async function publicFetch(input: string, init?: RequestInit): Promise<Response> {
  let proxy = typeof __NAIKEN_LOCAL_EGRESS__ !== 'undefined' ? __NAIKEN_LOCAL_EGRESS__ : undefined;
  if (!proxy) {
    // The bundled local preview supplies its egress binding. Hosted Sites has
    // no such binding and uses Cloudflare's public Internet network instead.
    const { env } = await import('cloudflare:workers');
    proxy = env.NAIKEN_PUBLIC_EGRESS_URL;
  }
  if (!proxy) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-naiken-target', input);
  return fetch(proxy, {...init, headers, redirect:'manual'});
}
