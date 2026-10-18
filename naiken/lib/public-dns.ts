/**
 * Public DNS preflight. This alone does not prevent DNS rebinding: callers must
 * also enforce public destinations in the actual outbound transport.
 * No Node APIs are used so this can run in the Sites / Workers runtime.
 */
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_DNS_BYTES = 32 * 1024;

function ipv4Bytes(input: string): number[] | undefined {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(input)) return;
  const bytes = input.split('.').map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
}

function ipv6Words(input: string): number[] | undefined {
  if (!input || input.includes('%') || !/^[\da-f:.]+$/i.test(input)) return;
  let normalized = input.toLowerCase();
  if (normalized.includes('.')) {
    const split = normalized.lastIndexOf(':');
    const v4 = ipv4Bytes(normalized.slice(split + 1));
    if (!v4) return;
    normalized = `${normalized.slice(0, split + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  if (normalized.split('::').length > 2) return;
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return;
  const parts = halves.length === 2 ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  if (parts.length !== 8 || !parts.every((part) => /^[\da-f]{1,4}$/.test(part))) return;
  return parts.map((part) => Number.parseInt(part, 16));
}

/** Conservative public-unicast classification; transitional mechanisms are denied. */
export function isPublicAddress(input: string): boolean {
  const v4 = ipv4Bytes(input);
  if (v4) {
    const [a, b, c] = v4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  const v6 = ipv6Words(input);
  if (!v6) return false;
  const [a, b] = v6;
  // Allow only global-unicast 2000::/3. This rejects unspecified, loopback,
  // mapped IPv4, NAT64, ULA, link-local, site-local and multicast space.
  if (a < 0x2000 || a > 0x3fff) return false;
  // IETF special assignments / Teredo / ORCHID, documentation, 6to4 and
  // newly allocated documentation space are not accepted as public targets.
  if ((a === 0x2001 && (b < 0x0200 || b === 0x0db8)) || a === 0x2002 || (a === 0x3fff && b <= 0x0fff)) return false;
  return true;
}

async function readDnsJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error('公開 DNS の確認に失敗しました。'); }
  const length = Number(response.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length < 0 || length > MAX_DNS_BYTES) { await response.body?.cancel(); throw new Error('DNS 応答サイズが上限を超えました。'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DNS 応答が空でした。');
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_DNS_BYTES) { await reader.cancel(); throw new Error('DNS 応答サイズが上限を超えました。'); }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new Error('DNS 応答の形式を確認できませんでした。'); }
}

export async function assertPublicDns(url: URL, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<void> {
  signal.throwIfAborted();
  const replies = await Promise.all(['A', 'AAAA'].map(async (type) => {
    const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`;
    const response = await fetcher(endpoint, { method: 'GET', headers: { Accept: 'application/dns-json' }, credentials: 'omit', redirect: 'manual', signal, cache: 'no-store' });
    return readDnsJson(response, signal);
  }));
  let addressCount = 0;
  for (const reply of replies) {
    if (!reply || typeof reply !== 'object' || !('Status' in reply) || ![0, 3].includes(reply.Status as number)) throw new Error('公開 DNS の解決結果を確認できませんでした。');
    const answers = 'Answer' in reply ? reply.Answer : [];
    if (!Array.isArray(answers)) throw new Error('DNS 応答の形式を確認できませんでした。');
    for (const answer of answers) {
      if (!answer || typeof answer !== 'object' || typeof answer.type !== 'number' || typeof answer.data !== 'string') throw new Error('DNS 応答の形式を確認できませんでした。');
      if (answer.type !== 1 && answer.type !== 28) continue;
      if (reply.Status !== 0 || (answer.type === 1 ? !ipv4Bytes(answer.data) : !ipv6Words(answer.data)) || !isPublicAddress(answer.data)) throw new Error('公開用ではない IP アドレスへの通信を中止しました。');
      addressCount++;
    }
  }
  if (addressCount === 0) throw new Error('公開 IP アドレスを確認できませんでした。');
}
