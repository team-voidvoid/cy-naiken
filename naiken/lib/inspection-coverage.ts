import type { Diagnosis } from './diagnosis-types';

const CATEGORIES = [
  ['headers', '公開ヘッダ'],
  ['cookies', 'Cookie 属性'],
  ['https', 'HTTPS'],
  ['components', '部品・版表記'],
  ['csrf', 'フォームの手掛かり'],
] as const;

/** These are performed checks, not proof that information or protection exists. */
export function inspectionCoverage(diagnosis: Diagnosis) {
  const observation = diagnosis.observation;
  const checked = new Set(observation?.outcome === 'ok' ? observation.checkedCategories : []);
  const components = diagnosis.components.length ? diagnosis.components : observation?.components ?? [];
  const versions = components.filter(component => !!component.version).length;
  const details = {
    headers: '取得した応答の設定を点検しました。設定の有無は指摘と根拠をご覧ください。',
    cookies: '公開ページの応答にある属性が対象です。Cookieの用途やログイン後の属性は未確認です。',
    https: '取得した応答と転送先を点検しました。ブラウザでの実際の通信は未確認です。',
    components: components.length
      ? `部品候補 ${components.length} 件・版表記 ${versions} 件。${versions ? '実際の稼働版は未確認です。' : '版は特定できませんでした。'}`
      : '部品・版を特定できませんでした。検出できなくても、未使用とは限りません。',
    csrf: '公開HTML内のフォームの手掛かりが対象です。フォームの動作や対策の有効性は未確認です。',
  };
  const items = CATEGORIES.map(([id, label]) => ({
    id, label, inspected: checked.has(id),
    detail: checked.has(id) ? details[id] : 'この分野の点検を完了できていません。安全・危険の判定はしていません。',
  }));
  return { items, inspectedCount: items.filter(item => item.inspected).length, total: items.length };
}
