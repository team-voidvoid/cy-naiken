# ナイケン（NAIKEN）

**預ける前に、内見を。** 公開ページに見える部品・設定を読み取り、個人情報を預ける判断材料を出すプロトタイプです。

画面は[SUUMO](https://suumo.jp/)の不動産ポータルを参考に、URL検索・みんなの調査一覧・設備表風の点検結果で構成しています。案内役は[OpenAI dotsの公式紹介ページ](https://learn.chatgpt.com/docs/dots)に掲載されているAlfredです（[画像出典](https://learn.chatgpt.com/images/codex/dots/portrait-alfred.webp)）。キャラクターの表示とAI調査機能は別で、調査にはAgents APIを使います。

## 起動

Node.js 22.13.0 以上を使用します。

```sh
npm install
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_charming_network.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_tricky_namorita.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0004_left_hiroim.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0005_stormy_bruce_banner.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0006_version_extractions.sql
npm run dev
```

表示されたローカル URL を開きます。テーブル作成は初回だけ実行します。実際の点検には外部 HTTP / HTTPS 通信が必要です。

```sh
npm run build
npm run typecheck
npm test
```

`npm test`は履歴検索・キャッシュ期限・OGP抽出と画像取得の制限を、外部通信なしで検証します。既存のローカル環境にも、`0004_left_hiroim.sql` と `0005_stormy_bruce_banner.sql` を上記の方法で一度適用してください。

## 試せること

- 任意の公開ドメインの URL 入力と、対象ページの確認。
- 取得中・速報・照合完了の表示、結果 URL からの再表示。
- 全利用者が保存した実際の調査を、サイト名・URLで検索。URLごとの最新結果と過去の調査履歴を閲覧。
- 調査時のOGP画像付きカード表示。画像がない・取得できないサイトは代替表示。
- 最大3件の気になる点、検出した部品の公開年、確定／推測／見えないの分類と根拠。
- Wappalyzer方式の独自辞書による42技術の検出、対応するnpmパッケージ名・版・照合ルールの表示。
- 取得拒否や材料不足の表示。取得できない項目は採点しません。
- 通常の点検後、AI Agentが追加の公開ページ・JS・公式資料を調べる「AIで詳しく調べる」（APIキー設定時）。
- 「AIの内見カウンター」でAI内見が完了してから、Decisions APIで公開情報に基づく安全スコアを表示（APIキー設定時、明示操作で実行）。

## 構成

Sites の React / Vinext スターターを使用しています。

| 場所 | 役割 |
|---|---|
| `app/` | 画面と診断API |
| `lib/targets.ts` / `lib/public-dns.ts` | 入力例と、公開URL・DNS解決先の検証 |
| `lib/scanner.ts` | 公開ページ・直接参照JSの取得と観測 |
| `lib/technology/` | 独自の技術辞書、HTMLトークナイザー、根拠・複数版・関連推定の集約、Workers用アダプター |
| `lib/rules.ts` | 部品の固定資料との照合、分類・採点・定型文 |
| `lib/diagnosis-store.ts` | 診断結果の保存、重複受付・回数の制限 |
| `lib/diagnosis-types.ts` | 画面とAPIの共通データ型 |
| `lib/agents-client.ts` | Agents APIのセッション・ターン・ツール結果通信 |
| `lib/research-engine.ts` / `lib/research-store.ts` | AI調査の進行・保存・重複実行防止 |
| `lib/research-fetch.ts` / `lib/research-report.ts` | 公開ページ取得・引用照合・AIレポート検証 |
| `lib/decisions-client.ts` / `lib/safety-score*.ts` | Decisions APIの応答検証・安全性評価・保存・重複実行防止 |

## API

| エンドポイント | 用途 |
|---|---|
| `GET /api/targets` | 入力例の一覧（診断対象を限定する一覧ではありません） |
| `GET /api/history` | 実際の調査の最新一覧。`q`でサイト名・URL検索、`url`で同じURLの履歴、`limit`・`cursor`でページ送り |
| `GET /api/diagnoses/{id}/image` | OGP画像の取得。未保存の既存結果はOGPを補完し、画像なし・取得失敗時は代替表示 |
| `POST /api/diagnoses` | `{"url":"https://www.kfc.co.jp/"}` で実際の点検を開始 |
| `GET /api/diagnoses/{id}` | 進捗・結果を取得。速報から固定資料との照合を完了 |
| `POST /api/diagnoses/{id}/research` | AI調査を明示的に開始（ログイン不要） |
| `GET /api/diagnoses/{id}/research` | 保存済みAI調査を進め、進捗・結果を取得 |
| `POST /api/diagnoses/{id}/safety-score` | AI内見とレポートの保存完了後、公開情報をDecisions APIで評価（同じ診断は1回のみ） |
| `GET /api/diagnoses/{id}/safety-score` | 設定状態・保存済み評価を取得。AI内見完了前は評価を返さない（API呼び出しは行わない） |

POST は `Content-Type: application/json` を指定します。HTTP / HTTPS の一般公開ドメインを指定できます。スキームを省略した場合は HTTPS を補い、パスとクエリを保持し、フラグメント（`#` 以降）は取り除きます。たとえば `/coco-to/` はルートURLへ置き換えません。画面の「入力例」は候補であり、それ以外の公開サイトも入力できます。

## プロトタイプの範囲

通常の点検には、Wappalyzerのように公開情報と辞書の規則を照合する技術検出を組み込んでいます。独自の35技術の規則に、従来のjQuery Mobile・jQuery Cookie・Swiper・picturefill・Magnific Popup・jquery-match-height・styled-componentsの7技術を加えています。Wappalyzerのコード・指紋データ・APIは使用していません。基本の検出にAIやAPIキーは不要です。キー設定時には、下記の低コストな版抽出で補完します。

HTML・応答ヘッダー・meta・属性・Cookie名・インラインCSS/JS・取得できた直接参照JSを照合し、製品ごとに根拠と版を集約します。Google Hosted LibrariesのjQuery、jsDelivr・unpkgの完全な版指定、JS中の版の表記も扱います。`latest`、版範囲、キャッシュ用クエリから版を推測しません。HTMLの最初の有効な`base href`を解決し、コメントやtemplate内の見本のJSは取得しません。

対応パッケージ名は版不明でも表示します。対応表はサイト内部の`package.json`や全依存を取得した結果ではありません。Next.jsからReact、WordPressからPHPなどの関連推定は直接観測と区別します。複数の版がある部品は一つに決めず、公開年・古さの採点を保留します。

Cloudflare Workers向けに文字列の解析部分を導入しています。ローカル版のChrome起動・DOM実行時の収集・OSV API照合は含みません。ブラウザでのJavaScript実行後にだけ見える情報は未確認です。HTMLの解析入力は先頭512,000文字、各JS/CSSは先頭200,000文字、根拠は製品ごとに8件までで、省略・上限を結果に記録します。取得全体の10MB・19秒・28リクエスト・直接参照JS5件の上限と公開ネットワーク検証を使います。

通常の点検では、公開日・保守状況は仕様書に記録された公式資料（2026年10月17日確認）の固定表を使い、文章も定型文で生成します。表にない版は未照合のまま残します。jQuery Mobile の非推奨化を EOL と同一視せず、styled-components 5.3.11 の EOL は未確認と表示します。AI調査とDecisions APIの安全性スコアは「AIの内見カウンター」にまとめて表示し、既存の「観測された指摘の合計」には加算しません。dotsによる調査は未接続です。

診断結果は D1 に保存します。同じURLの進行中処理を共有し、正常に取得した結果とアクセス拒否の記録は1週間（7日間）再利用します。一時的な通信失敗・タイムアウト・HTTP 429は30秒後から再試行できます。観測は受付リクエスト内で行い、保存済み速報からの照合は結果取得時に実行します。ブラウザを閉じる前に受付が完了していれば、診断URLから再開できます。

調査URLと結果は全利用者に公開されます。入力画面にも公開範囲を表示し、個人用URLを入力しないよう案内します。公開一覧は取得中・受付失敗を除き、URLごとの最新結果を表示します。取得拒否やタイムアウトも、確認できなかった結果として表示します。パス・クエリを含む同じ正規化URLごとに履歴を保持し、1週間を過ぎて再調査しても古い結果URLとAIレポートは残ります。一覧や履歴の閲覧だけで新しい点検やAI調査を開始しません。

OGP情報は点検で取得したHTMLから保存します。OGP画像が未保存の既存結果は、一覧の画像を表示する際に対象URLのHTMLからOGPだけを補完します。補完情報はURL別の専用キャッシュに保存し、診断結果・取得日時・1週間の診断キャッシュ・AIレポートは更新しません。画像情報は7日間、画像がない結果は24時間再利用し、取得失敗時は1時間後から再試行します。同じURLの同時取得を抑止し、公開HTMLの先頭1MiBまで・7秒・転送3回に制限します。アクセス拒否された診断結果は補完の対象にしません。画像は保存済みURLだけをサーバ側で取得し、公開ネットワーク・転送先・画像形式・取得時間・サイズを制限します。取得時の画像URLを保存するため、配信元で画像が変更・削除された場合は表示内容が変わることがあります。Webページ全体や画像ファイルそのもののアーカイブではありません。

## 低コストなバージョン抽出

`window.next={version:"16.3.3",...}` のように部品との対応が明確な表記は、取得済みJSからローカルで抽出します。根拠の保存件数が上限でも、この版表記を追加できます。複数の版があれば単一の版には決めません。

版が未確認の部品について、取得済みJSの先頭200,000文字に版表記と部品の特徴がある場合だけ、`OPENAI_API_KEY` で Responses API の `gpt-6-luna` を最大1回呼び出します。全文や追加のWeb検索を使わず、版表記の前後の短い断片を最大6件・入力JSON 8,000文字まで送ります。推論は `none`、出力は600トークン、通信は8秒までです。API料金が発生します。`NAIKEN_VERSION_EXTRACTION_ENABLED=false` で有料の補完を無効にし、ローカル抽出だけを利用できます。ローカルの `.env` と `.dev.vars` のいずれも設定に利用できます。

AIの返答はJSON Schemaで制限し、版・部品ID・断片ID・根拠の引用を元の入力と照合します。原文にない版や引用は採用せず、部品との対応にAIの判断を使ったものは画面で明示します。版の表記は実稼働版の証明ではなく、AI補完の版は公開年・古さの採点に加えません。根拠が乏しい場合、未取得のJSや実行後だけにある版は未確認のままです。

同じ断片・対象部品・モデルの結果はD1で7日間共有し、同時実行も原子的に予約して重複課金を防ぎます。新規呼び出しはアプリ全体で3回／分・UTC日付ごとに50回までです。空の抽出結果もキャッシュし、失敗・結果不明の予約は1時間保持します。自動再試行は行わず、失敗時も通常の点検結果を残します。既存環境には `0006_version_extractions.sql` の適用が必要です。検出方式の更新前の結果URLは保持し、新しい点検ではキャッシュを分けて取得します。

仕様・料金：[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)（2026-10-18確認）。

## Decisions APIによる安全性スコア

実サイトの通常点検とAI内見が完了すると、「AIの内見カウンター」のレポートの後に安全スコア欄が現れます。「安全スコアを確認する」を押すと、サーバ側の `OPENAI_API_KEY` で固定の `POST https://api.openai.com/v1/decisions` を1回呼び出します。モデルは `gpt-6-luna` で、AI調査の `NAIKEN_AGENT_MODEL` とは独立しています。キーにDecisions APIの利用権限が必要で、API利用料金が発生します。`NAIKEN_DECISIONS_ENABLED=false` で新規評価を無効にできます。キーがなくても、AI内見の完了を確認できれば保存済みの評価は表示します。

画面だけでなくAPIと採点予約のSQLでも、同じ診断のAI内見が `completed` でレポートを保存済みであることを確認します。未開始・進行中・失敗時には、過去に保存したスコアも返しません。AI内見の完了や結果URLの閲覧だけではDecisions APIを呼び出さず、明示操作で評価を開始します。

入力は対象・最終URLのオリジン、観測項目の分類、検出した部品の版・照合済みの保守情報、取得範囲です。URLのパス・クエリ・フラグメント、ページ本文、Cookie値、ページ由来の自由文は送りません。AI調査のレポートはこの評価に混ぜません。

5段階（0〜4）の `score` 質問を使い、返された段階指数の加重平均を `round(score / 4 * 100)` で100点に換算します。**高いほど確認範囲で観測された懸念が少ない**ことを表し、安全である確率ではありません。画面で評価基準、段階別の分布、AIの評価確信度、確認範囲を確認できます。安全性保証・詐欺判定・マルウェア検出は行わず、サーバ内部や個人情報の保管方法は未確認です。実データでの評価基準の校正は未実施です。

取得拒否・取得失敗・未完了・確認項目が3未満（またはヘッダ未確認）の場合は採点しません。未確認部分を安全／危険として扱わず、失敗や拒否を0点に置き換えません。応答のモデル、質問名、型、スコア範囲、確信度、分布の合計とスコアの整合性を検証します。

評価はD1の既存診断JSON内に保存するため、DBマイグレーションの追加は不要です。同じ診断への同時POSTは原子的に1回だけ予約し、完成結果は再利用します。GET・再読み込みではAPIを呼びません。新規受付は接続元IPのハッシュごとに3回／分、アプリ全体で10回／分です。通信全体は15秒、入出力は各32KiBまでで、転送・自動再試行は行いません。開始失敗・結果不明・保存中断も同じ診断では再送せず、60秒を過ぎた予約は状態確認時に失敗として表示します。通常の点検結果は保持します。

仕様参照：[Decisions API](https://developers.openai.com/api/docs/guides/decisions)（2026-10-18確認）。実APIへの課金を伴う検証は行わず、合成応答・ローカルSQLiteで契約・制限・並行受付・再表示を検証しています。

## AI調査の設定と流れ

APIキー未設定でも通常の点検は利用できます。AI調査はログイン不要で利用できます。2026-10-18にローカル画面からMozillaの公開サイトを指定し、実APIで調査・根拠表示・再読み込み後の結果保持まで確認しました。

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

## 技術検出のテスト

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

テストは公開取得とDecisions APIを注入した合成データで実行し、外部通信やAI呼び出しを行いません。CDN・版の衝突・連結JS・HTMLの除外領域とbase・解析上限・Cookie値の非保存・DNS拒否・JS取得数上限に加え、スコア換算・応答検証・タイムアウト・同時受付・保存済み評価の再利用を確認します。保存テストにはNode.jsの組み込みSQLiteを使います。
