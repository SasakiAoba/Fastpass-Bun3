# 文化祭カジノ企画 ファストパス管理システム

Cloudflare Pages FunctionsとD1を使い、木製ファストパスの販売、連続発番、入場、使用済み取消、払い戻し、会計、記録をMac・iPad間で同期する管理画面です。

## 業務設定

現在の主な設定は次のとおりです。各運用回の開始時にD1の`config_snapshot_json`へ固定保存され、途中でコード側の値が変わっても過去記録の単価や上限は変わりません。

- 単価：100円
- 番号：`HC-001`～`HC-200`
- 日別上限：各日200枚の仮値
- 開催日：3日とも未設定
- 仮確保：180秒
- 時刻基準：サーバー時刻（Asia/Tokyo）

開催日未設定中、LIVEの販売は停止します。画面・業務試験は管理画面から開発者モードを開始して行います。

## 認証

個別アカウントや2FAは設けず、1つの共有パスワードをサーバーで検証します。

- 平文パスワードはコード、Git、D1へ保存しません。
- D1にはArgon2idの検証値だけを保存します。
- ログイン成功後はSecure・HttpOnly・SameSite=StrictのセッションCookieを使用します。
- 状態変更は同一OriginとCSRFトークンを検証します。
- ログイン失敗はIP・ブラウザー単位の匿名化キーで回数制限します。
- 通常操作、払い戻し、管理操作でパスワードを再入力しません。
- 共有端末を離れるときは明示的にログアウトします。

初期認証SQLは、パスワードを標準入力で渡して生成します。生成結果は一時ファイルだけに保存し、適用後に削除してください。

```bash
npm run auth:sql > auth-initial.sql
```

`auth-*.sql`、`.dev.vars`、`wrangler.jsonc`はGit対象外です。

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
| Preview D1 | `bun2fastpass-preview` |
| Runtime Secret | `AUTH_RATE_LIMIT_PEPPER` |
| Pages Functions failure mode | Fail closed |

ProductionとPreviewは必ず別のD1へBindingします。GitにCloudflare APIトークン、Secret、データベースIDを固定保存しません。

## D1マイグレーション

- `migrations/0001_initial.sql`: Productionに適用済みの基準スキーマと空のLIVE運用回1
- `migrations/0002_atomic_operations.sql`: 条件付き更新件数を同一batch内で検証し、競合時に全体をロールバックする仕組み

`0001`は新規データベースだけに適用します。既存Productionには`0002`だけを適用します。認証行はマイグレーションに含めません。

Remote適用前には次を必ず行います。

1. 対象環境、D1名、Binding名を読み返す。
2. ProductionではTime Travelブックマークを取得する。
3. `schema_migrations`を確認し、未適用の版だけを適用する。
4. `PRAGMA foreign_key_check`と`PRAGMA quick_check`を実行する。
5. Previewで全業務試験とDEV削除を完了する。
6. ProductionではDEV領域だけで限定試験し、終了時にDEVを削除する。
7. 最終状態がLIVE・営業停止・DEVなしであることを確認する。

## 業務上の保証

- 発番、販売日、単価、残数、対象領域、サーバー時刻はブラウザー入力を信用せずD1から決定します。
- 複数SQLはD1のtransactional batchでまとめ、途中の条件不一致は全体を取り消します。
- 操作IDはUUIDと内容ハッシュで冪等化し、通信断時は同じ処理を新しいIDで自動再実行しません。
- DEVはLIVEと別workspaceに保存し、終了時にDEV workspaceをCASCADE削除します。
- DEV終了後はLIVE・営業停止へ戻します。
- 払い戻しても販売済み枚数と発行番号は戻しません。
- 会計の最終金額は「預り金合計 − お釣り合計 − 払い戻し合計」です。
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
