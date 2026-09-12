# 文化祭カジノ企画 ファストパス管理システム

Cloudflare Pages FunctionsとD1を使い、木製ファストパスの販売、連続発番、入場、使用済み取消、払い戻し、会計、記録をMac・iPad間で同期する管理画面です。

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

ローカル仮想D1試験は、リポジトリ直下にローカル専用`wrangler.jsonc`を置き、`0001`と`0002`を適用してから実行します。試験用パスワードとSecretだけを使い、Remote D1へは接続しません。

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
| Preview D1 | `bun2fastpass`（本番業務開始前の暫定共有） |
| Runtime Secret | `AUTH_SHARED_PASSWORD`（英大文字・数字7文字） |
| Pages Functions failure mode | Fail closed |

`src/config/fastpass.config.ts`の`AUTO_START_DEVELOPER_MODE`は、ログイン後の自動DEV開始を制御します。導入試験中は`true`、本番移行時は`false`へ変更して先にデプロイし、その後で管理画面から既存DEV領域を終了します。`false`にしても手動の開発者モードは利用できます。

開催日は日本時間で、1日目`2026-09-18`、2日目`2026-09-19`、3日目`2026-09-20`です。LIVE販売はこの3日だけを受け付け、営業停止中は開催日でも業務更新を拒否します。

本番業務データを入れる前の導入試験に限り、ProductionとPreviewは同じD1を暫定共有します。PreviewとProductionの更新試験はDEV領域だけで行い、各試験後にDEV workspaceを削除して、LIVE・営業停止・DEVなしへ戻します。共有中は`system_state`、認証情報、セッション、監査記録を含む全状態が両環境に共通するため、Productionで本番業務を開始した後はPreviewで更新試験を行いません。継続してPreview更新試験が必要になった時点で、Preview専用D1へ分離します。

GitにCloudflare APIトークン、Secret、データベースIDを固定保存しません。

## D1マイグレーション

- `migrations/0001_initial.sql`: Productionに適用済みの基準スキーマと空のLIVE運用回1
- `migrations/0002_atomic_operations.sql`: 条件付き更新件数を同一batch内で検証し、競合時に全体をロールバックする仕組み
- `migrations/0003_event_dates.sql`: LIVE運用回1の開催日を2026年9月18日～20日に設定

`0001`は新規データベースだけに適用します。既存Productionには未適用の`0002`以降だけを順番に適用します。認証行はマイグレーションに含めません。

Remote適用前には次を必ず行います。

1. 対象環境、D1名、Binding名を読み返す。
2. ProductionではTime Travelブックマークを取得する。
3. `schema_migrations`を確認し、未適用の版だけを適用する。
4. `PRAGMA foreign_key_check`と`PRAGMA quick_check`を実行する。
5. Previewで全業務試験とDEV削除を完了する。共有中はこの間Productionを業務利用しない。
6. 最終状態がLIVE・営業停止・DEVなしであることを確認してからProductionをデプロイする。
7. ProductionではDEV領域だけで限定試験し、終了時にDEVを削除する。
8. Production確認後も、LIVE・営業停止・DEVなしであることを再確認する。

## 業務上の保証

- 発番、販売日、単価、残数、対象領域、サーバー時刻はブラウザー入力を信用せずD1から決定します。
- 複数SQLはD1のtransactional batchでまとめ、途中の条件不一致は全体を取り消します。
- 操作IDはUUIDと内容ハッシュで冪等化し、通信断時は同じ処理を新しいIDで自動再実行しません。
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
