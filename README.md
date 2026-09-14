# 文化祭カジノ企画 ファストパス管理システム

Cloudflare Pages FunctionsとD1を使い、木製ファストパスの販売、連続発番、入場、使用済み取消、払い戻し、会計、記録をMac・iPad間で同期する管理画面です。

画面表示中のD1同期は30秒間隔で行い、非表示タブでは同期を停止します。変更がない場合はETagによる304応答で全件の再読み取りを省き、サーバー時刻だけ更新します。販売・入場などの確定操作後は、その応答に含まれる最新状態を即時反映します。運用SQLで直接データを変更するときは、同じトランザクションで`system_state.updated_at_ms`または`mode_epoch`も進めてください。

## 業務設定

現在の主な設定は次のとおりです。各運用回の開始時にD1の`config_snapshot_json`へ固定保存され、途中でコード側の値が変わっても過去記録の単価や上限は変わりません。

- 単価：100円
- 番号：`HC-001`～`HC-200`
- 日別上限：各日200枚の仮値
- 開催日：2026年9月18日・19日・20日
- 時刻基準：サーバー時刻（Asia/Tokyo）

LIVEの販売は設定した開催日だけ受け付けます。画面・業務試験は管理画面から開発者モードを開始して行います。

## 認証

個別アカウントや2FAは設けず、1つの共有パスワードをサーバーで検証します。

- 7文字の英大文字・数字による共有パスワードはCloudflareの`AUTH_SHARED_PASSWORD` Secretだけへ保存し、コード、Git、D1へ保存しません。
- D1の既存認証行はセッションを一括失効できる認証世代番号だけに利用します。
- ログイン成功後はSecure・HttpOnly・SameSite=StrictのセッションCookieを使用します。
- 状態変更は同一OriginとCSRFトークンを検証します。
- ログイン試行の15分制限は設けず、誤入力後もすぐ再試行できます。
- 通常操作、払い戻し、管理操作でパスワードを再入力しません。
- 共有端末を離れるときは明示的にログアウトします。

`.dev.vars`と`wrangler.jsonc`はGit対象外です。

## 開発と検査

Node.js 20以上を使用します。

```bash
npm install
npm run typecheck
npm test
npm run build
```

ローカル仮想D1試験は、リポジトリ直下にローカル専用`wrangler.jsonc`を置き、`0001`～`0005`を適用して実行します。試験用パスワードとSecretだけを使い、Remote D1へは接続しません。

```bash
npm run test:d1
```

この試験はCookie認証、CSRF拒否、DEV販売、連続発番、入場、使用取消、払い戻し、販売直後の入場使用、冪等再送、同時更新競合、DEV削除、ログアウトを検証します。

## Cloudflare Pages

| 設定 | 値 |
|---|---|
| Project | `b2fp` |
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | リポジトリルート |
| D1 Binding | `DB` |
| Production D1 | `bun2fastpass` |
| Preview D1 | `bun2fastpass`（Productionと同じD1、内部の環境別領域を使用） |
| Environment binding | Production: `FASTPASS_ENVIRONMENT=production` / Preview: `FASTPASS_ENVIRONMENT=preview` |
| Runtime Secret | `AUTH_SHARED_PASSWORD`（英大文字・数字7文字） |
| Pages Functions failure mode | Fail closed |

自動DEV開始はViteのビルド時に環境別で確定します。Cloudflare Pagesの`main`は初期無効、`CF_PAGES=1`かつ`CF_PAGES_BRANCH`が`main`以外のPreviewは初期有効です。変数がない通常のローカルビルドは初期無効です。手動の開発者モードは引き続き利用できます。

CLIから直接デプロイする場合、成果物を環境別にビルドしてください。Productionは`npm run build`、Previewは`npm run build -- --mode preview`です。`wrangler pages deploy --branch`だけでは、すでにビルドされた初期モードは変わりません。ProductionとPreviewで同じ`dist`を流用しません。

開催日は日本時間で、1日目`2026-09-18`、2日目`2026-09-19`、3日目`2026-09-20`です。LIVE販売はこの3日だけを受け付け、営業停止中は開催日でも業務更新を拒否します。

ProductionとPreviewは同じD1に接続します。`system_state`の1行目をProduction、2行目をPreviewとして、モード・営業状態・券・会計・削除対象を独立させます。認証設定と端末情報は共有します。実行環境はPagesの`FASTPASS_ENVIRONMENT`変数のみから決め、未設定は503で停止します。画面のビルド環境とAPI環境が一致しない場合も自動DEV開始を行いません。

Previewはテスト専用です。開発者モードを終了するとPreview内のテストデータを削除し、空の設定領域で停止します。その状態では本番業務操作・本番リセット・正式出力をサーバー側で拒否します。Productionの本番領域をPreviewへ接続しません。Previewの設定領域は0005適用時に本番の設定・開催日だけをコピーします。後日設定・開催日を変更するときは両環境の設定領域を更新してください。

運用回番号は既存の一意制約を保つため、同じD1内の環境を通じて採番します。Previewの設定領域・テスト作成に使用された番号の分だけ、Productionの運用回番号は飛ぶ場合があります。券番号・グループ番号・会計は各領域で独立します。

GitにCloudflare APIトークン、Secret、データベースIDを固定保存しません。

## D1マイグレーション

- `migrations/0001_initial.sql`: Productionに適用済みの基準スキーマと空のLIVE運用回1
- `migrations/0002_atomic_operations.sql`: 条件付き更新件数を同一batch内で検証し、競合時に全体をロールバックする仕組み
- `migrations/0003_event_dates.sql`: LIVE運用回1の開催日を2026年9月18日～20日に設定
- `migrations/0004_purged_operation_receipts.sql`: DEV削除後の結果照合用に操作ID・種別・処理日時だけを保持し、操作ID検索へ索引を追加。チケット・販売・返金の内容は保持しません。

- `migrations/0005_shared_d1_environment_scopes.sql`: 1つのD1内に環境別の状態・領域・履歴を設け、DBのトリガーでも環境をまたぐ参照を拒否します。

新しいFunctionsを公開する前に0005まで適用し、`/api/health`の`schemaVersion: 5`と環境名を確認します。既存Productionへの0001再適用やLIVEリセットは行いません。

`0001`は新規データベースだけに適用します。既存Productionには未適用の`0002`以降だけを順番に適用します。認証行はマイグレーションに含めません。

Remote適用前には次を必ず行います。

1. 対象環境、D1名、Binding名を読み返す。
2. ProductionではTime Travelブックマークを取得する。
3. `schema_migrations`を確認し、未適用の版だけを適用する。
4. `PRAGMA foreign_key_check`と`PRAGMA quick_check`を実行する。
5. 両環境が同じDB Bindingを使い、FASTPASS_ENVIRONMENTの値が正しいことを確認する。
6. Previewで更新試験を完了し、Productionの券・会計・モード・ETagが変わらないことを確認して試験データを削除する。
7. Productionは初期DEV無効でデプロイし、既存DEVの削除が承認されている場合だけ終了する。
8. ProductionのLIVE状態・開催日・営業状態、Previewの初期DEV・本番との分離を再確認する。

## 業務上の保証

- 発番、販売日、単価、残数、対象領域、サーバー時刻はブラウザー入力を信用せずD1から決定します。
- 複数SQLはD1のtransactional batchでまとめ、途中の条件不一致は全体を取り消します。
- 操作IDはUUIDと内容ハッシュで冪等化します。通信断や送信後の5xxでは元の操作IDを読み取りで照合し、結果不明なら端末内に操作IDごとの保留記録を残して新規確定を止めます。再読込しても保留は解除されません。複数タブでも別の操作IDを上書きしません。
- 結果照合ではPOSTを再送しません。処理済みなら最新状態を取得して復帰します。DEV削除済みなら削除済み操作IDから判断します。記録が見つからないだけでは未実行と判断せず、停止を維持します。
- DEVはLIVEと別workspaceに保存し、終了時にDEV workspaceをCASCADE削除します。
- DEV終了後はLIVE・営業停止へ戻します。
- 払い戻しても販売済み枚数と発行番号は戻しません。
- 販売は人数確定と同時に発番し、預り金・お釣りの入力は行いません。
- 会計の最終金額は「販売金額 − 払い戻し合計」です。
- 正式なJSON/CSV出力はLIVEだけを対象にし、認証情報やセッションを含めません。

## 秘密情報とGit

次をGitへ追加しません。

- パスワード平文と認証SQL
- APIトークン、Cookie、Secret
- `.env`、`.env.*`、`.dev.vars`
- `wrangler.jsonc`とローカルD1状態
- localStorage確認版のデータやバックアップ
- `node_modules/`、`dist/`、`.idea/`、`.DS_Store`

コミット前に`git diff --cached`を確認し、秘密情報と想定外のファイルがないことを検査します。

旧PreviewのFunctionsは環境分けを認識しないため、旧版へのロールバックは行いません。旧Previewデプロイは切替時に停止・撤去し、再公開する場合も環境対応版のFunctionsを使います。D1は共有のため、読み取り枠や負荷も共有します。営業中にPreviewで負荷試験を行わないでください。
