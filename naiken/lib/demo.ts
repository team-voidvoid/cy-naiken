import type { ComponentInfo, DemoKind, Diagnosis, Observation } from './diagnosis-types.ts';
import { finalizeObservation } from './rules.ts';

// 仕様書13章の2026-10-17の記録を部分再現する。現在の実測結果ではない。
const observedDate = '2026-10-17';
const commonUnknowns = [
  'SQLインジェクションなど、サーバ内部の安全性はこの点検では分かりません。',
  'ログイン後の画面、個人情報の保存方法、運営の保守実態は確認していません。',
];
const partialUnknowns = [
  'この保存記録には、通常ページのヘッダ・Cookie属性・HTTPからの転送・CSRF対策の検証結果がありません。',
  '記録した部品が現在も使われているか、実行されるか、脆弱性を悪用できるかは確認していません。',
];

const jquery: ComponentInfo = {
  name: 'jQuery', version: '1.11.1', releaseDate: '2014-05-01', verified: true,
  support: '1.xは公式サポート対象外。終了日は未確認です。',
  sourceUrl: 'https://blog.jquery.com/2014/05/01/jquery-1-11-1-and-2-1-1-released/',
  evidence: [
    { label: 'JS本文の版表記', value: 'jQuery 1.11.1', url: 'https://code.jquery.com/jquery-1.11.1.min.js' },
    { label: '公式サポート方針（2026-10-17確認）', value: 'jQuery 1.xはサポート対象外。終了日は特定していません。', url: 'https://jquery.com/support/' },
  ],
};
const mobile: ComponentInfo = {
  name: 'jQuery Mobile', version: '1.4.5', releaseDate: '2014-10-31', verified: true,
  support: '2021-10-07にプロジェクトを非推奨化。EOL日の宣言とは区別します。',
  sourceUrl: 'https://blog.jquerymobile.com/2014/10/31/jquery-mobile-1-4-5-released/',
  evidence: [
    { label: 'JS本文の版表記', value: 'jQuery Mobile 1.4.5', url: 'https://code.jquery.com/mobile/1.4.5/jquery.mobile-1.4.5.min.js' },
    { label: '公式の非推奨化告知', value: '2021-10-07 fully deprecated。重大なセキュリティ問題の報告窓口は残るとしています。', url: 'https://blog.jquerymobile.com/2021/10/07/jquery-maintainers-continue-modernization-initiative-with-deprecation-of-jquery-mobile/' },
  ],
};
const cookie: ComponentInfo = {
  name: 'jQuery Cookie', version: '1.4.1', verified: false,
  support: '公開日・保守状況は未照合です。',
  evidence: [{ label: 'JS本文の版表記', value: 'jQuery Cookie 1.4.1', url: 'https://ichibanya.linkto-cloud.jp/coco-to/js/jquery.cookie.js' }],
};
const styled: ComponentInfo = {
  name: 'styled-components', version: '5.3.11', releaseDate: '2023-05-26', verified: true,
  support: 'この版のEOLは未確認。2026年の公式記事はプロジェクトの開発継続を明記しています。',
  sourceUrl: 'https://github.com/styled-components/styled-components/releases/tag/v5.3.11',
  evidence: [
    { label: 'HTML属性', value: 'data-styled-version="5.3.11"', url: 'https://www.kfc.co.jp/' },
    { label: '公式記事（2026-10-17確認）', value: '2026-04-10の記事は開発継続を明記。この版のEOLを示すものではありません。', url: 'https://styled-components.com/blog/celebrating-a-decade-of-styled-components' },
  ],
};
const react: ComponentInfo = {
  name: 'React系の手掛かり', verified: false, support: '技術名の手掛かりのみ。React本体の版・保守状況は判定できません。',
  evidence: [{ label: 'HTML属性', value: 'data-react-helmet="true"（Reactの版は示しません）', url: 'https://www.kfc.co.jp/' }],
};

export function createDemo(kind: DemoKind, id: string): Diagnosis {
  const createdAt = new Date().toISOString();
  const base = {
    id, mode: 'demo' as const, demoKind: kind, status: 'complete' as const,
    createdAt, updatedAt: createdAt, explanationSource: 'template' as const,
  };
  if (kind === 'blocked') {
    const url = 'https://www.matsukiyococokara-online.com/store/';
    return {
      ...base, url, siteName: 'マツキヨココカラ', headline: '扉の先は、確認できませんでした。',
      summary: '事前調査ではHTTP 403で取得を拒否されました。拒否は危険性の証拠ではありません。現在の取得状態を示す結果でもありません。',
      score: 0, checkedCount: 0, findings: [], components: [],
      observation: {
        url, finalUrl: url, status: 403, fetchedAt: observedDate, bytes: 0,
        userAgent: '事前調査：クラウド・利用者PCのcurl等（詳細なUser-Agentは記録なし）',
        outcome: 'blocked',
        message: '2026-10-17の保存記録の再現。本文サイズ・最終URLの詳細・正確な取得時刻は未記録です（bytesの0は記録なしを示します）。別の本文抽出では読めた観測もあり、拒否の原因は未確定です。',
        findings: [], components: [], checkedCategories: [], scriptsFetched: 0, scriptsSkipped: 0,
      },
      unknowns: [
        '通常ページを取得できていないため、5項目すべて未確認です。拒否ページのヘッダは採点していません。',
        '今回の取得条件で拒否された原因と、現在の取得可否は不明です。',
        ...commonUnknowns,
      ],
    };
  }

  const isOld = kind === 'old';
  const url = isOld ? 'https://ichibanya.linkto-cloud.jp/coco-to/' : 'https://www.kfc.co.jp/';
  const components = structuredClone(isOld ? [jquery, mobile, cookie] : [styled, react]);
  const observation: Observation = {
    url, finalUrl: url, status: 200, fetchedAt: observedDate,
    bytes: isOld ? 132841 : 48204,
    userAgent: '事前調査（詳細なUser-Agentは記録なし）', outcome: 'ok',
    message: '2026-10-17 22:03〜22:04 JSTの資料由来の部分再現です。公開日・保守情報の照合も2026-10-17の記録です。正確な時刻・本文ハッシュ・最終URLの詳細は未記録です。',
    findings: [], components, checkedCategories: ['components'],
    scriptsFetched: isOld ? 3 : 0, scriptsSkipped: 0,
  };
  const finalized = finalizeObservation(observation);
  return {
    ...base, ...finalized, url, siteName: isOld ? 'CoCo壱番屋 注文ページ' : 'ケンタッキーフライドチキン',
    headline: isOld ? '2014年の部品が、顔を出しています。' : '見えた版と、見えない版があります。',
    summary: isOld
      ? '事前調査の公開JSから、jQuery 1.11.1とjQuery Mobile 1.4.5を確認。中身年齢は、確認できた部品の公開年です。'
      : 'styled-components 5.3.11は2023年公開。React本体の版と、この部品のEOLは未確認です。見えない部分を推測で補いません。',
    observation,
    unknowns: [
      ...(isOld ? ['jQuery 1.xの公式サポート終了日、jQuery Cookie 1.4.1の公開日・保守状況は未確認です。']
        : ['React本体の版、styled-components 5.3.11のEOLは未確認です。', 'HTMLに外部JS参照がなくても、ブラウザでのJavaScript実行が不要とは判断できません。']),
      ...partialUnknowns, ...commonUnknowns,
    ],
  };
}

export function demoList(): Diagnosis[] {
  return (['old', 'unknown', 'blocked'] as const).map((kind) => createDemo(kind, `demo-${kind}`));
}
