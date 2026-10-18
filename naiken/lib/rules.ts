import type { ComponentInfo, Finding, Observation } from './diagnosis-types.ts';

// Snapshot supplied by the specification, section 13.6 (verified 2026-10-17).
// This prototype does not present these records as a live API lookup.
const REFERENCES: Record<string, { date: string; support: string; url: string; supportUrl: string; points: number }> = {
  'jQuery@1.11.1': { date: '2014-05-01', support: '1.x は公式サポート対象外。終了日は未確認。', url: 'https://blog.jquery.com/2014/05/01/jquery-1-11-1-and-2-1-1-released/', supportUrl: 'https://jquery.com/support/', points: 22 },
  'jQuery@3.2.1': { date: '2017-03-20', support: '旧版。3.x 系は重大な修正に限る保守方針。系統全体の EOL ではありません。', url: 'https://blog.jquery.com/2017/03/20/jquery-3-2-1-now-available/', supportUrl: 'https://jquery.com/support/', points: 14 },
  'jQuery@3.1.1': { date: '2016-09-22', support: '旧版。3.x 系は重大な修正に限る保守方針。個別版の終了日は未確認。', url: 'https://blog.jquery.com/2016/09/22/jquery-3-1-1-released/', supportUrl: 'https://jquery.com/support/', points: 14 },
  'jQuery Mobile@1.4.5': { date: '2014-10-31', support: '2021-10-07 にプロジェクトの非推奨化を告知。EOL 日とは区別します。', url: 'https://blog.jquerymobile.com/2014/10/31/jquery-mobile-1-4-5-released/', supportUrl: 'https://blog.jquerymobile.com/2021/10/07/jquery-maintainers-continue-modernization-initiative-with-deprecation-of-jquery-mobile/', points: 20 },
  'styled-components@5.3.11': { date: '2023-05-26', support: 'この版の EOL は未確認。2026年4月の公式記事ではプロジェクトの開発継続を明記。', url: 'https://github.com/styled-components/styled-components/releases/tag/v5.3.11', supportUrl: 'https://styled-components.com/blog/celebrating-a-decade-of-styled-components', points: 5 },
};

export function finalizeObservation(observation: Observation) {
  const unknowns = [
    'SQL インジェクション、保存データの暗号化、サーバ内部や認証後の安全性は、この点検では分かりません。',
    '公開 HTML と JS の表記を確認しています。実際の画面表示や、検出した部品の稼働・悪用可能性は検証していません。',
    '公開日・保守状況は仕様書に記録された公式資料（2026-10-17 確認）の固定表との照合です。未登録の版は採点を保留します。',
  ];
  if (observation.outcome !== 'ok') return {
    findings: [] as Finding[], components: [] as ComponentInfo[], headline: observation.outcome === 'blocked' ? '見えなかった。それも、点検の結果です。' : '今回は、中を確認できませんでした。',
    summary: observation.message ?? 'この取得条件では公開ページを確認できませんでした。取得できないことは危険性を意味しません。', score: 0, checkedCount: 0, oldestYear: undefined,
    unknowns: [...unknowns, '通常ページを取得できなかったため、5 項目すべて未確認です。拒否ページの設定は採点していません。'],
  };
  const findings = observation.findings.map((item) => ({ ...item, evidence: [...item.evidence] }));
  const components = observation.components.map((component): ComponentInfo => {
    if (component.detectionBasis === 'inferred') return { ...component, verified: false, releaseDate: undefined, support: '関連技術からの推定です。この部品自体の版・公開年は未確認です。古さの点数には含めません。' };
    const reference = REFERENCES[`${component.name}@${component.version}`];
    if (!reference) return { ...component, verified: false, support: '公開日・保守状況は未照合です。古さの点数には含めません。' };
    const enriched = { ...component, releaseDate: reference.date, support: reference.support, sourceUrl: reference.url, verified: true };
    findings.push({ id: `age-${component.name}-${component.version}`, category: 'components', confidence: 'confirmed', points: reference.points,
      title: `${reference.date.slice(0, 4)}年公開の ${component.name} を検出`,
      explanation: `${component.name} ${component.version} の表記が公開情報にあります。${reference.support} サイト全体の古さや危険性を示すものではありません。`,
      evidence: [...component.evidence, { label: '公式公開日', value: reference.date, url: reference.url }, { label: '保守方針（2026-10-17 確認）', value: reference.support, url: reference.supportUrl }],
    });
    return enriched;
  });
  findings.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id, 'en'));
  const years = components.flatMap((component) => component.releaseDate ? [Number(component.releaseDate.slice(0, 4))] : []);
  const oldestYear = years.length ? Math.min(...years) : undefined;
  if (observation.scriptsSkipped) unknowns.push(`直接参照された JS のうち ${observation.scriptsSkipped} 本は、許可範囲・上限・取得状態により未確認です。`);
  if (components.some((item) => !item.version)) unknowns.push('部品名の手掛かりがあっても、正確な版が分からない部品があります。');
  if (components.some((item) => item.versionStatus === 'multiple')) unknowns.push('複数の版の記載がある部品は、単一の稼働版に決めず公開年・古さの採点を保留しています。');
  if (observation.technologyCoverage) {
    unknowns.push('技術の検出は公開HTML・ヘッダー・取得したJSの規則照合です。ブラウザでJavaScriptを実行していないため、実行後だけに見える技術・版は未確認です。');
    if (observation.technologyCoverage.inputTruncated || !observation.technologyCoverage.htmlParsedCompletely || observation.technologyCoverage.evidenceTruncated) unknowns.push('技術の解析入力または根拠数が上限に達しました。省略部分に別の部品・版があるかは未確認です。');
  }
  return {
    findings, components, oldestYear, unknowns,
    headline: oldestYear ? `${oldestYear}年製の部品が、今も顔を出す。` : findings.length ? '預ける前に、もう一歩だけ確かめたい。' : '見える範囲から、判断の材料を。',
    summary: oldestYear ? `公開情報で検出した部品のうち、確認できた最古の公開年は ${oldestYear} 年です。サイト全体の年齢ではありません。` : '今回取得できた公開情報に限った結果です。指摘がないことは、安全性の保証ではありません。',
    score: Math.min(100, findings.reduce((total, finding) => total + (finding.confidence === 'unknown' ? 0 : finding.points), 0)),
    checkedCount: new Set(observation.checkedCategories).size,
  };
}
