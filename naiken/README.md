# ナイケン（NAIKEN）

**預ける前に、内見を。** 公開ページに見える部品・設定を読み取り、個人情報を預ける判断材料を出すプロトタイプです。

画面は[SUUMO](https://suumo.jp/)の不動産ポータルを参考に、URL検索・サンプル一覧・設備表風の点検結果で構成しています。案内役は[OpenAI dotsの公式紹介ページ](https://learn.chatgpt.com/docs/dots)に掲載されているAlfredです（[画像出典](https://learn.chatgpt.com/images/codex/dots/portrait-alfred.webp)）。キャラクターの表示とAI調査機能は別で、調査にはAgents APIを使います。

## 起動

Node.js 22.13.0 以上を使用します。

```sh
npm install
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_charming_network.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_tricky_namorita.sql
npm run dev
```

表示されたローカル URL を開きます。テーブル作成は初回だけ実行します。画面内のサンプルは外部通信なしで試せます。実際の点検には外部 HTTP / HTTPS 通信が必要です。

```sh
npm run build
npm run typecheck
```

## 試せること

- 任意の公開ドメインの URL 入力と、対象ページの確認。
- 取得中・速報・照合完了の表示、結果 URL からの再表示。
- 最大3件の気になる点、検出した部品の公開年、確定／推測／見えないの分類と根拠。
- 取得拒否や材料不足の表示。取得できない項目は採点しません。
- 通常の点検後、AI Agentが追加の公開ページ・JS・公式資料を調べる「AIで詳しく調べる」（APIキー設定時）。
- 資料の保存記録を再現した3サンプル（古い部品、一部の版不明、取得拒否）。

サンプルは仕様書13章の **2026年10月17日の部分的な観測記録**です。現在のサイトの実測結果ではありません。CoCo壱番屋とKFCのサンプルでは部品の記録だけを再現し、ヘッダ・Cookie属性など記録のない項目は未確認とします。マツキヨココカラの403はその取得条件で拒否された記録で、安全性の判定には使いません。

## 構成

Sites の React / Vinext スターターを使用しています。

| 場所 | 役割 |
|---|---|
| `app/` | 画面と診断API |
| `lib/targets.ts` / `lib/public-dns.ts` | 入力例と、公開URL・DNS解決先の検証 |
| `lib/scanner.ts` | 公開ページ・直接参照JSの取得と観測 |
| `lib/rules.ts` | 部品の固定資料との照合、分類・採点・定型文 |
| `lib/demo.ts` | 事前調査記録のサンプル |
| `lib/diagnosis-store.ts` | 診断結果の保存、重複受付・回数の制限 |
| `lib/diagnosis-types.ts` | 画面とAPIの共通データ型 |
| `lib/agents-client.ts` | Agents APIのセッション・ターン・ツール結果通信 |
| `lib/research-engine.ts` / `lib/research-store.ts` | AI調査の進行・保存・重複実行防止 |
| `lib/research-fetch.ts` / `lib/research-report.ts` | 公開ページ取得・引用照合・AIレポート検証 |

## API

| エンドポイント | 用途 |
|---|---|
| `GET /api/targets` | 入力例の一覧（診断対象を限定する一覧ではありません） |
| `GET /api/diagnoses` | 3件のサンプル結果 |
| `POST /api/diagnoses` | `{"url":"https://www.kfc.co.jp/"}` で実際の点検を開始 |
| `POST /api/diagnoses` | `{"demo":"old"}` でサンプルの速報（`unknown` / `blocked` も利用可能） |
| `GET /api/diagnoses/{id}` | 進捗・結果を取得。速報から固定資料との照合を完了 |
| `POST /api/diagnoses/{id}/research` | AI調査を明示的に開始（サインインが必要） |
| `GET /api/diagnoses/{id}/research` | 保存済みAI調査を進め、進捗・結果を取得 |

POST は `Content-Type: application/json` を指定します。HTTP / HTTPS の一般公開ドメインを指定できます。スキームを省略した場合は HTTPS を補い、パスとクエリを保持し、フラグメント（`#` 以降）は取り除きます。たとえば `/coco-to/` はルートURLへ置き換えません。画面の「入力例」は候補であり、それ以外の公開サイトも入力できます。

## プロトタイプの範囲

通常の点検では、公開日・保守状況は仕様書に記録された公式資料（2026年10月17日確認）の固定表を使い、文章も定型文で生成します。表にない版は未照合のまま残します。jQuery Mobile の非推奨化を EOL と同一視せず、styled-components 5.3.11 の EOL は未確認と表示します。AI調査は別枠に表示し、既存の点数には加算しません。Decisions API・dotsは未接続です。

診断結果は D1 に保存します。同じURLの進行中処理を共有し、完成した観測は10分間再利用します。観測は受付リクエスト内で行い、保存済み速報からの照合は結果取得時に実行します。ブラウザを閉じる前に受付が完了していれば、診断URLから再開できます。

## AI調査の設定と流れ

APIキー未設定でも通常の点検・サンプルは利用できます。AI調査はログイン不要で利用できます。2026-10-18にローカル画面からMozillaの公開サイトを指定し、実APIで調査・根拠表示・再読み込み後の結果保持まで確認しました。

Sitesの公開範囲はPublicに設定します。AI調査の新規開始・再実行は、接続元IPのハッシュ単位で3回／分、アプリ全体で10回／分に制限します。IPを取得できない場合は共通枠を使います。APIキーはサーバ側でのみ使用し、利用者への開示やChatGPTへのサインイン要求は行いません。

ローカルでは `.env.example` を参考に、Git管理外の `.dev.vars` に `OPENAI_API_KEY` を設定して開発サーバを再起動します。公開版ではSitesのサーバ環境変数へ設定します。キーを画面やソースに埋め込まないでください。既定モデルは `gpt-6.1-sol`、変更する場合は `NAIKEN_AGENT_MODEL` を指定します。Agents APIへのアクセスと `api.agents.read` / `api.agents.write` / `api.responses.write` の権限が必要です。ChatGPTの利用枠ではなくAPIキー側の利用料金が発生します。

1. 通常の点検後、利用者がAI調査を開始します。
2. Agents APIに対象URLと観測結果を渡して非同期セッションを作成します。
3. AgentがWeb検索と `inspect_public_page` を選び、対象ページ・JS・公式資料を追加取得します。取得は公開ネットワークへのGETに限定します。
4. ツール要求を約5秒ごとに確認し、取得結果を保存してAgentへ返します。
5. 完了したターンの最終レポートを取得し、引用が実際の取得内容に含まれるか照合します。解釈は「推測」「見えない」として表示します。

公開ページ取得は最大12回、1回7秒・1MiBまでです。10分を過ぎた調査は次の状態確認時に中断を依頼します。画面を閉じたり自動更新を止めたりしても、Agent側の処理が即時停止するわけではありません。ツール実行と結果保存は、画面を再表示して状態確認が再開すると進みます。Webhookや常駐ワーカーによる無人継続、厳密なトークン・費用上限は未実装です。

同じ診断のAI調査は共有し、開始結果が不明な場合は重複課金を避けるため自動再送しません。APIが開始を拒否したことが確認できた場合は、設定確認後にボタンから再実行できます。開始結果が不明な失敗は管理者確認が必要です。取得・AI処理に失敗しても通常の点検結果は残ります。

仕様参照：[Agents API](https://developers.openai.com/api/docs/guides/agents-api/quickstart)、[関数ツール](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)。

点数は観測された指摘を並べるための仮ルールで、安全性の認証や危険度の確率ではありません。確認できた項目数とあわせて読みます。古さは検出した部品の公開年であり、サイト全体の年齢や運営の保守実態を示しません。

取得は指定された公開ページと直接参照するJSを対象にします。IPアドレス直接指定、localhost・内部ホスト名、非標準ポート、認証情報付きURLは受け付けません。初回・リダイレクト先・JS配信先について、URLとDNS解決先が公開ネットワーク向けであることを通信前に検証します。公開環境では Cloudflare の公開ネットワーク向け取得を使い、ローカルでも公開ネットワークに限定した中継を通します。DNS検証後に接続先が変わっても、内部ネットワークへの接続を遮断します。具体的な通信先の制約は `lib/targets.ts`、`lib/public-dns.ts`、`build/public-egress.mjs` を参照してください。

ビルド済みのローカル確認には `npm start` を使ってください。公開ネットワーク限定の中継も一緒に起動します。取得は全体19秒・最大10MB・最大28リクエスト・直接参照JS最大5件に制限し、新規受付は全体20回／分、利用者12回／分、対象ホスト6回／分までです。

任意の公開URLを入力できても、すべてのページを取得できるわけではありません。認証が必要なページ、Bot対策などで取得が拒否されるページ、時間内に応答しないページは確認できなかった理由を表示し、拒否や失敗を危険度として採点しません。

フォーム送信・ログイン・ブラウザでのJS実行・脆弱性の実証は行いません。利用者のCookieや認証情報を対象サイトに転送しません。サーバ内部やログイン後の情報管理の安全性は、この点検では分かりません。
