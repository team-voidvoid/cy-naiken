import type { AllowedTarget } from './diagnosis-types.ts';

export const TARGETS: AllowedTarget[] = [
  { url: 'https://ichibanya.linkto-cloud.jp/coco-to/', name: 'CoCo壱番屋', description: '注文ページの公開情報を点検' },
  { url: 'https://car.orix.co.jp/', name: 'オリックスレンタカー', description: '公式トップページを点検' },
  { url: 'https://www.furusato-tax.jp/', name: 'ふるさとチョイス', description: '公式トップページを点検' },
  { url: 'https://www.kfc.co.jp/', name: 'ケンタッキーフライドチキン', description: '公式トップページを点検' },
  { url: 'https://www.matsukiyococokara-online.com/store/', name: 'マツキヨココカラ', description: 'オンラインストアを点検' },
];
export const JS_HOSTS = ['code.jquery.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

const RESERVED_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'test', 'invalid', 'example', 'onion', 'home', 'lan', 'arpa', 'corp', 'intranet', 'private', 'alt'];

function parsePublicUrl(input: string): URL {
  const raw = input.trim();
  if (!raw || raw.length > 4096 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) throw new Error('URL の形式を確認してください。');
  const full = raw.includes('://') ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(full); } catch { throw new Error('HTTP / HTTPS の公開 URL を入力してください。'); }
  // URL removes explicit :80 for HTTP and :443 for HTTPS, preserving other ports.
  if (!['https:', 'http:'].includes(url.protocol) || url.port) throw new Error('HTTP / HTTPS の標準ポートのみ利用できます。');
  if (url.username || url.password || full.match(/^https?:\/\/([^/?#]*)/i)?.[1].includes('@')) throw new Error('認証情報付きの URL は利用できません。');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  // The URL parser canonicalizes IPv4 spellings (decimal, octal and hexadecimal).
  if (hostname.length > 253 || labels.length < 2 || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(':') || hostname.includes('[') || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/[a-z]/.test(labels[labels.length - 1])) throw new Error('IP アドレスや内部ホストではなく、公開ドメインを入力してください。');
  if (RESERVED_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) throw new Error('内部用・予約済みのドメインは取得できません。');
  url.hostname = hostname;
  url.hash = '';
  return url;
}

export function normalizeTarget(input: string): AllowedTarget {
  const url = parsePublicUrl(input);
  const known = TARGETS.find((item) => new URL(item.url).hostname === url.hostname);
  return { url: url.href, name: known?.name ?? url.hostname, description: known?.description ?? '入力した公開ページの情報を点検' };
}

/** Syntax is checked here; the scanner must also check DNS and its outbound transport. */
export function validateFetchUrl(input: string, _targetUrl: string, _kind: 'html' | 'script'): URL {
  return parsePublicUrl(input);
}
