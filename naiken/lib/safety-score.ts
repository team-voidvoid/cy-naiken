import type { Diagnosis } from './diagnosis-types.ts';
import { SAFETY_MODEL, SAFETY_RUBRIC_VERSION, type SafetyScore } from './safety-score-types.ts';
import { DecisionsError, scoreWithDecisions, type DecisionsConfig } from './decisions-client.ts';

const CATEGORIES = ['headers', 'cookies', 'https', 'components', 'csrf'];
const SIGNALS: Record<string, string> = {
  csp: 'CSPのスクリプト実行制限を確認できなかった', framing: 'ヘッダで埋め込み制限を確認できなかった',
  hsts: 'HTTPS応答にHSTSがなかった（preload等は未確認）', nosniff: 'nosniff指定を確認できなかった', charset: '文字コード指定を確認できなかった',
  'https-downgrade': '最終応答が平文HTTPだった', 'http-page': 'HTTPでもHTTPSへ転送されず応答した',
  'http-reference': 'HTTP形式の参照がHTMLにあった（実通信は未確認）', csrf: 'POSTフォームにトークンの表記を確認できなかった（別の対策は未確認）',
  'disclosure-server': 'Serverヘッダに製品・版らしき表記があった', 'disclosure-x-powered-by': 'X-Powered-Byヘッダに製品・版らしき表記があった',
};
export function safetyUnavailableReason(diagnosis: Diagnosis): string | undefined {
  if (diagnosis.mode !== 'live') return '実際の点検結果がないため、安全性を採点しません。';
  if (diagnosis.status !== 'complete') return '通常の点検が完了してから安全性を評価できます。';
  if (!diagnosis.observation || diagnosis.observation.outcome !== 'ok') return '公開ページを取得できなかったため、安全性を採点しません。';
  const checked = new Set(diagnosis.observation.checkedCategories.filter(item => CATEGORIES.includes(item)));
  if (checked.size < 3 || !checked.has('headers')) return '確認できた項目が少ないため、安全性を採点しません。';
}

/** Send structured observations, never raw HTML, cookie values or URL paths/queries. */
export function safetyInput(diagnosis: Diagnosis): string {
  const observation = diagnosis.observation!;
  return JSON.stringify({
    targetOrigin: new URL(diagnosis.url).origin, finalOrigin: new URL(observation.finalUrl).origin,
    observedAt: observation.fetchedAt, checkedCategories: CATEGORIES.filter(item => observation.checkedCategories.includes(item)),
    signals: [...new Map(observation.findings.flatMap(finding => {
      const signal = SIGNALS[finding.id] ?? (/^cookie-\d+$/.test(finding.id) ? '用途未確認のCookieにSecure属性がなかった' : undefined);
      return signal && finding.confidence !== 'unknown' ? [[`${signal}:${finding.confidence}`, { signal, confidence: finding.confidence }] as const] : [];
    })).values()],
    components: diagnosis.components.slice(0, 42).map(component => ({
      technology: /^[a-z0-9-]{1,64}$/.test(component.technologyId ?? '') ? component.technologyId : 'unidentified',
      version: /^[0-9][0-9a-z.+-]{0,60}$/i.test(component.version ?? '') ? component.version : null,
      basis: component.detectionBasis === 'inferred' ? 'inferred' : 'observed',
      releaseDate: component.verified && /^\d{4}-\d{2}-\d{2}$/.test(component.releaseDate ?? '') ? component.releaseDate : null,
      maintenance: !component.verified ? 'unverified' : component.support?.includes('公式サポート対象外') ? 'out_of_support' : component.support?.includes('非推奨化') ? 'deprecated' : 'not_established',
    })),
    coverage: { scriptsFetched: observation.scriptsFetched, scriptsSkipped: observation.scriptsSkipped,
      inputTruncated: observation.technologyCoverage?.inputTruncated ?? null,
      htmlParsedCompletely: observation.technologyCoverage?.htmlParsedCompletely ?? null,
      evidenceTruncated: observation.technologyCoverage?.evidenceTruncated ?? null, browserExecuted: false },
    exclusions: ['サーバ内部', '認証後の処理', '個人情報の保管', '詐欺・マルウェアの有無', '未取得部分'],
  });
}

export function safetyState(status: 'scoring'): SafetyScore;
export function safetyState(status: 'unavailable' | 'failed', message: string): SafetyScore;
export function safetyState(status: 'scoring' | 'unavailable' | 'failed', message?: string): SafetyScore {
  const base = { model: SAFETY_MODEL, rubricVersion: SAFETY_RUBRIC_VERSION, updatedAt: new Date().toISOString() };
  return status === 'scoring' ? { ...base, status } : { ...base, status, message: message! };
}
export async function evaluateSafety(diagnosis: Diagnosis, config: DecisionsConfig): Promise<SafetyScore> {
  const reason = safetyUnavailableReason(diagnosis);
  if (reason) return safetyState('unavailable', reason);
  try {
    const result = await scoreWithDecisions(safetyInput(diagnosis), config);
    return { ...safetyState('scoring'), ...result, status: 'completed' };
  } catch (error) {
    return safetyState(error instanceof DecisionsError && error.code === 'refusal' ? 'unavailable' : 'failed',
      error instanceof DecisionsError ? error.message : '安全性評価を完了できませんでした。');
  }
}
