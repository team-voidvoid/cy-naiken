# ナイケン（NAIKEN）

**預ける前に、内見を。**

Webサービスに個人情報を預ける前に、公開情報からその中身を「内見」するプロトタイプです。OpenAI DevDayハッカソン向けに開発しています。

## できること

- URLを入力し、公開ページのヘッダ・HTTPS・利用部品などを点検する。
- 気になる点を「確定」「推測」「見えない」に分け、根拠とともに確認する。
- AI Agentが対象ページ・JavaScript・公式資料を追加調査し、出典付きのレポートを作成する。
- 点検結果とAI調査の進捗を保存し、結果URLから再表示する。
- 全利用者の調査結果を、OGP画像付きの一覧から検索・閲覧する。
- 同じURLの結果を1週間再利用し、過去の調査履歴も確認する。
- 保存済みの観測記録を使ったサンプルを試す。

点検は公開情報に限ります。安全性の保証や脆弱性の実証を行うものではなく、外から分からない項目は未確認として扱います。

## デザイン

画面デザインは、実際の不動産ポータル **[SUUMO](https://suumo.jp/)** をモチーフにしています。物件を探して内見する感覚をWebサービスの点検に置き換え、URL検索、物件一覧風のサンプルカード、設備表風の点検結果で構成しています。

案内役には[OpenAI dots](https://learn.chatgpt.com/docs/dots)のキャラクター「Alfred」を使用しています。キャラクターの表示とAI調査の実行は別で、調査にはOpenAI Agents APIを使用します。

## リポジトリ構成

| ディレクトリ | 内容 |
|---|---|
| [`naiken/`](naiken/) | アプリ本体。画面、API、点検・AI調査処理、DB定義 |
| [`docs/`](docs/) | ハッカソン概要、プロダクト仕様、DevDay参考資料 |

リポジトリルートはこの`devday`ディレクトリです。アプリの開発コマンドは`naiken/`内で実行します。

## 開発

Node.js 22.13.0以上を使用します。初回は[`naiken/README.md`の起動手順](naiken/README.md#起動)に従い、依存パッケージの導入とローカルDBの初期化を行ってください。

セットアップ後の起動：

```sh
cd naiken
npm run dev
```

AI調査を使う場合は、`naiken/.dev.vars`に`OPENAI_API_KEY`を設定します。設定例は[`naiken/.env.example`](naiken/.env.example)を参照してください。APIキー未設定でも通常の点検とサンプルは利用できます。

公開環境はSitesを利用し、サーバ処理はCloudflare Workers、データ保存はD1で行います。公開版のAPIキーはSitesのサーバ環境変数に別途設定し、フロントエンドのコードには含めません。

## 関連資料

- [アプリの詳細・API・制約](naiken/README.md)
- [ハッカソン概要](docs/dev-day-hackathon.md)
- [プロダクト仕様書](docs/concept-v2-reference-added.md)
- [OpenAI DevDay 2026参考資料](docs/openai-devday-2026.md)
