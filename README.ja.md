# s3-compat-check

[English](README.md) | 日本語

`s3-compat-check` は、S3 API 互換をうたうオブジェクトストレージが基本的な S3 API
を正しく実装しているかを短時間で確認する、小さな CLI（兼ライブラリ）です。
`npx` で実行でき、インストールは不要、設定もほぼ必要ありません。

```text
S3 Compatibility Check

Endpoint: http://localhost:9000
Bucket:   test-bucket
Region:   us-east-1

✓ PutObject                   11 ms
✓ GetObject                   14 ms
✓ HeadObject                  14 ms
✓ DeleteObject                18 ms
✓ Range GET                   19 ms
✓ ListObjectsV2               25 ms
✓ Multipart Upload            67 ms
✓ ETag                        21 ms
- Checksum                unsupported
✗ Presigned URL           403 SignatureDoesNotMatch
✓ Nonexistent Object           6 ms

Failures:
  ✗ Presigned URL (presigned)
      GET presigned URL: The request signature we calculated does not match ... (HTTP 403 SignatureDoesNotMatch)

9 passed, 1 failed, 1 unsupported
Duration: 0.2 s
```

Amazon S3、MinIO、Ceph RGW、Cloudflare R2、SeaweedFS、Garage など、S3 互換の実装
であれば何にでも使えます。特定ベンダーに依存する処理は含みません。

### 適合性テストスイートとの違い

[Ceph s3-tests](https://github.com/ceph/s3-tests) や s3t のようなプロジェクトは、
網羅的な適合性テストを行います。`s3-compat-check` は別のニーズを満たします。

- インストール不要で `npx` からすぐ実行できる
- 数秒で終わり、多くのアプリケーションが依存する API をカバーする
- 必要なのは endpoint とバケットだけ
- 読みやすい結果に加え、CI 向けの JSON も出力する
- どの API が失敗し、何を期待して何が返ってきたかを正確に報告する
- 新しいチェックを簡単に追加できる

> **S3 への完全な適合を保証するものではありません。** すべて成功しても、下記の
> 基本操作が期待どおりに動くことを示すだけで、それ以外の S3 API については何も
> 示しません。詳しくは [制約事項](#制約事項) を参照してください。

## Quick Start

使い捨てのローカル MinIO サーバーを起動し（コミュニティがメンテナンスしている
イメージを使用）、バケットを作成します。

```bash
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=ACCESS_KEY_EXAMPLE \
  -e MINIO_ROOT_PASSWORD=SECRET_KEY_EXAMPLE \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data

export AWS_ACCESS_KEY_ID=ACCESS_KEY_EXAMPLE
export AWS_SECRET_ACCESS_KEY=SECRET_KEY_EXAMPLE
aws --endpoint-url http://localhost:9000 s3 mb s3://test-bucket
```

チェックを実行します。

```bash
npx s3-compat-check --endpoint http://localhost:9000 --bucket test-bucket
```

## インストール

インストールは不要です。`npx s3-compat-check` は常に最新版を実行します。
**Node.js 22.12 以降**が必要です。

プロジェクトや CI でバージョンを固定する場合:

```bash
npm install --save-dev s3-compat-check
npx s3-compat-check --help
```

## 使用例

### MinIO

```bash
AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin \
npx s3-compat-check \
  --endpoint http://localhost:9000 \
  --bucket test \
  --allow-insecure
```

（`--allow-insecure` が必要なのは、`localhost`、`127.0.0.1`、`::1` 以外の
平文 HTTP endpoint の場合だけです。）

### AWS S3

```bash
AWS_PROFILE=default \
npx s3-compat-check \
  --bucket my-test-bucket \
  --region ap-northeast-1
```

### Cloudflare R2

```bash
npx s3-compat-check \
  --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --bucket test-bucket \
  --region auto
```

### JSON

```bash
npx s3-compat-check \
  --endpoint http://localhost:9000 \
  --bucket test \
  --format json
```

### 特定のチェックだけを実行

```bash
npx s3-compat-check \
  --endpoint http://localhost:9000 \
  --bucket test-bucket \
  --checks put,get,head,range
```

## CLI オプション

| オプション               | デフォルト                      | 説明                                                                                                         |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--endpoint <url>`       | AWS S3                          | S3 endpoint の URL。未指定時は `AWS_ENDPOINT_URL_S3`、次に `AWS_ENDPOINT_URL` を使用。                       |
| `--bucket <name>`        | （必須）                        | チェックを実行する**既存の**バケット。バケットの作成・削除は一切行いません。                                 |
| `--region <region>`      | `AWS_REGION` または `us-east-1` | 署名に使うリージョン（`AWS_DEFAULT_REGION` も参照します）。                                                  |
| `--prefix <prefix>`      | `s3-compat-check/`              | キーの基本 prefix。実行ごとに、この下へ一意な名前空間を作ります（[安全性](#セキュリティ上の考慮事項)参照）。 |
| `--timeout <ms>`         | `10000`                         | S3 操作 1 回ごとのタイムアウト。レスポンス本文の読み取りも含みます。                                         |
| `--cleanup-timeout <ms>` | `30000`                         | 最後の cleanup（確認を含む）にかけられる時間。最大 3 分の 1 を確認用に確保します。                           |
| `--concurrency <n>`      | `4`                             | 並列に実行するチェック数（1〜32）。結果は常に同じ順序で表示されます。                                        |
| `--format <text\|json>`  | `text`                          | レポートの形式。                                                                                             |
| `--output <file>`        |                                 | レポートを（`--format` の形式で）ファイルにも書き出します。標準出力にはテキストのレポートを表示します。      |
| `--checks <names>`       | すべて                          | 実行するチェックのカンマ区切りリスト。複数回指定できます。                                                   |
| `--skip <names>`         |                                 | スキップするチェックのカンマ区切りリスト（`all` は指定不可）。チェック ID の大文字小文字は区別しません。     |
| `--list-checks`          |                                 | 利用できるチェックを表示して終了します。                                                                     |
| `--verbose`              |                                 | 操作ごとの診断情報を stderr に表示し、レポートにも詳細を加えます。                                           |
| `--no-color`             |                                 | 色を無効にします。stdout が TTY でない場合や `NO_COLOR` が設定されている場合も無効になります。               |
| `--path-style`           | カスタム endpoint の場合        | path-style のリクエスト（`https://host/bucket/key`）を強制します。                                           |
| `--virtual-hosted-style` | AWS S3 の場合                   | virtual-hosted-style のリクエスト（`https://bucket.host/key`）を強制します。                                 |
| `--allow-insecure`       |                                 | `localhost` / `127.0.0.1` / `::1` 以外の平文 HTTP endpoint を許可します。TLS 証明書の検証は常に有効です。    |
| `--version`, `--help`    |                                 |                                                                                                              |

## 認証

認証情報は、標準の
[AWS SDK for JavaScript v3 の credential provider chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
で解決します。環境変数、共有の config / credentials ファイル（`AWS_PROFILE`）、SSO、
Web Identity、ECS・EC2 のインスタンスロールに対応しています。

| 変数                                         | 用途                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | 静的な認証情報                                         |
| `AWS_SESSION_TOKEN`                          | 一時的な認証情報                                       |
| `AWS_PROFILE`                                | `~/.aws/config` / `credentials` の名前付きプロファイル |
| `AWS_REGION`                                 | デフォルトの署名リージョン                             |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`    | `--endpoint` 未指定時のデフォルト endpoint             |

秘密情報を渡す**コマンドラインオプションは意図的に用意していません**。コマンド
ラインで渡した値は、シェルの履歴やプロセス一覧に残ってしまうためです。

プライベート CA を使う場合は、Node.js 標準の `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`
を使ってください。

## チェック一覧

各チェックは独立しています。それぞれ自分専用の prefix の下に自分のオブジェクトを
書き込むため、あるチェックが失敗しても他のチェックは影響を受けません。

| ID            | 名前               | 確認内容                                                                                                                                                        |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `put`         | PutObject          | 1 KiB の PUT が HTTP 200 を返し、正しいサイズで保存される。                                                                                                     |
| `get`         | GetObject          | GET が HTTP 200、正しい `Content-Length`、バイト単位で一致するデータを返す。                                                                                    |
| `head`        | HeadObject         | HEAD が `Content-Length`、`Content-Type`、ユーザーメタデータ（`x-amz-meta-*`）、`ETag`、`Last-Modified` を返す。                                                |
| `delete`      | DeleteObject       | DELETE が 204（200 も可）を返し、その後 GET が `404 NoSuchKey`、HEAD が 404 を返す。存在しないキーの削除も成功する。                                            |
| `range`       | Range GET          | `bytes=0-99`、`bytes=100-199`、`bytes=-100` が 206、正しい `Content-Range`・`Content-Length`・データを返す。                                                    |
| `list`        | ListObjectsV2      | `Prefix` による絞り込み、continuation token を使った `MaxKeys` のページング（`MaxKeys` は上限として扱う）、`KeyCount`、サイズ、`Delimiter` / `CommonPrefixes`。 |
| `multipart`   | Multipart Upload   | 作成、2 パート（5 MiB + 約 1 MiB）のアップロード、完了の後、ダウンロードしたオブジェクトのサイズと SHA-256 を確認する。失敗時は abort する。                    |
| `etag`        | ETag               | PUT が返した ETag を HEAD と GET も返す。`If-Match` は 200、`If-None-Match` は 304、誤った `If-Match` は 412 を返す。**ETag が MD5 であるとは仮定しない。**     |
| `checksum`    | Checksum           | _任意機能。_ `x-amz-checksum-sha256` 付きの PUT が成功し、HEAD で読み戻した checksum が一致し、一致しない checksum は拒否される。                               |
| `presigned`   | Presigned URL      | 署名付き GET URL（60 秒）を、SDK も認証ヘッダーも使わない素の `fetch` で取得し、アップロードしたデータが返る。                                                  |
| `nonexistent` | Nonexistent Object | 存在しないキーへの GET が `404 NoSuchKey`、HEAD が 404 を返す。ステータスとエラーコードは分けて報告する。                                                       |

### 結果のステータス

| ステータス    | 意味                                                                                                                        | 実行を失敗にするか |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `passed`      | 動作が S3 と一致した。                                                                                                      | しない             |
| `failed`      | リクエストが失敗したか、応答が S3 と異なった。レポートには操作、HTTP ステータス、エラーコード、期待値と実際の値が含まれる。 | **する**           |
| `unsupported` | **任意**機能（現在は `checksum` のみ）が実装されていない。必須チェックはこれを返さず、代わりに失敗になる。                  | しない             |
| `skipped`     | チェックが実行されなかった（実行の中断など）。                                                                              | しない             |

`checksum` が `unsupported` になるのは、サーバーが checksum ヘッダーを拒否した場合
（501、または 400 の `NotImplemented` / `InvalidArgument` / `InvalidRequest`）か、
黙って無視した場合です。黙って無視した場合とは、一致しない checksum を受け入れ、
checksum を一度も返さない（PUT でも HEAD でも）ことを指します。
次の場合、このチェックは **失敗** します。

- サーバーが _誤った_ checksum を返した
- checksum を返したのに、一致しない checksum を受け入れた
- 一致しない checksum を、checksum 固有の HTTP 400（`BadDigest`、`InvalidDigest`、
  `XAmzContentChecksumMismatch`、`XAmzContentSHA256Mismatch`）以外で拒否した

## JSON 出力

`--format json` は標準出力に 1 つの JSON ドキュメントを出力します。スキーマの
バージョン 1.0 は安定版です。マイナーリリースでフィールドが追加されることは
ありますが、`schemaVersion` を上げずに削除や名前の変更をすることはありません。

```json
{
  "schemaVersion": "1.0",
  "tool": "s3-compat-check",
  "toolVersion": "0.1.0",
  "ok": false,
  "aborted": false,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "finishedAt": "2026-01-01T00:00:01.200Z",
  "durationMs": 1200,
  "endpoint": "http://localhost:9000",
  "bucket": "test-bucket",
  "region": "us-east-1",
  "addressingStyle": "path",
  "runPrefix": "s3-compat-check/20260101T000000Z-0123abcd/",
  "environment": { "node": "v22.12.0", "platform": "linux", "arch": "x64", "awsSdkVersion": "3.x" },
  "summary": { "total": 11, "passed": 9, "failed": 1, "skipped": 0, "unsupported": 1 },
  "checks": [
    { "id": "put", "name": "PutObject", "status": "passed", "required": true, "durationMs": 42 },
    {
      "id": "presigned",
      "name": "Presigned URL",
      "status": "failed",
      "required": true,
      "durationMs": 18,
      "error": {
        "kind": "http",
        "message": "The request signature we calculated does not match the signature you provided.",
        "operation": "GET presigned URL",
        "httpStatus": 403,
        "code": "SignatureDoesNotMatch"
      }
    }
  ],
  "cleanup": {
    "status": "completed",
    "deletedObjects": 16,
    "abortedUploads": 0,
    "remaining": [],
    "errors": [],
    "warnings": [],
    "durationMs": 12
  }
}
```

- `endpoint` は、AWS のデフォルト endpoint を使う場合 `null` になります。
- `checks[].error.kind` は `assertion`、`http`、`network`、`timeout`、`aborted`、
  `credentials`、`skipped`、`unknown` のいずれかです。
  - `assertion` エラーでは、`expected` と `actual` が差分を表します。
  - `unsupported` と `skipped` の結果では、`error` にその理由が入ります。
- `checks[].details`（任意）には、観測した内容が入ります。例えば返ってきたエラー
  コードや、ETag がたまたま MD5 だったかどうかです。
- `cleanup.status` は `completed` か `failed` です。`remaining` には削除できなかった
  キーが入ります。

実行を開始できない場合（設定の誤り、endpoint に接続できない、認証情報が不正）の
JSON 出力は次のとおりです。

```json
{
  "schemaVersion": "1.0",
  "tool": "s3-compat-check",
  "toolVersion": "0.1.0",
  "ok": false,
  "error": { "type": "environment", "message": "Bucket \"test-bucket\" does not exist" }
}
```

`error.type` は `config`（終了コード 2）、`environment`（終了コード 3）、
`interrupted`（終了コード 130 / 143）のいずれかです。

## 終了コード

| コード | 意味                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| `0`    | すべてのチェックが成功した。任意機能の `unsupported` と `skipped` は実行を失敗にしない。                  |
| `1`    | 少なくとも 1 つのチェックが失敗したか、cleanup に失敗した（テスト用オブジェクトが残っている可能性あり）。 |
| `2`    | コマンドライン引数または設定が不正。                                                                      |
| `3`    | 実行環境の致命的エラー：接続できない、認証情報がない、アクセス拒否、バケットが存在しない。                |
| `130`  | SIGINT で中断された（SIGTERM の場合は `143`）。cleanup は試行済み。                                       |

`--format json` のときは、引数エラーでも fatal JSON を出力します。

## CI への組み込み

```yaml
# GitHub Actions
- name: S3 compatibility smoke test
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.STORAGE_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.STORAGE_SECRET_ACCESS_KEY }}
  run: |
    npx s3-compat-check@0 \
      --endpoint https://storage.example.com \
      --bucket test-bucket \
      --format json --output s3-compat-check.json
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: s3-compat-check
    path: s3-compat-check.json
```

`--output` を指定すると、JSON レポートはファイルに書き出され、ジョブログには
読みやすい要約が表示されます。JSON レポートに認証情報や署名付き URL が含まれる
ことはないため、artifact として保存しても安全です。

## ライブラリ API

```ts
import { runChecks } from "s3-compat-check";

const result = await runChecks({
  endpoint: "http://localhost:9000",
  bucket: "test-bucket",
  region: "us-east-1",
  checks: ["put", "get", "head", "range"],
});

console.log(result.summary); // { total: 4, passed: 4, failed: 0, skipped: 0, unsupported: 0 }
```

- `runChecks(options)` は型付きの `RunReport`（JSON 出力と同じ構造）を返します。
  - stdout にも stderr にも何も書き込みません（AWS SDK の診断出力は破棄します）。
  - マスク済みの診断情報を受け取りたい場合は `logger` を渡してください。
  - `logger` と `onCheckComplete` の完了は待ちません。これらが投げた例外や reject
    された Promise は無視され、cleanup を妨げることはありません。
- 次の場合は例外を投げます。
  - `ConfigError`：オプションが不正
  - `EnvironmentError`：endpoint やバケットを使えない
  - `RunAbortedError`：チェックが始まる前に `signal` が発火した
- オプションは CLI に対応しています。
  - CLI と同じもの：`endpoint`、`bucket`、`region`、`prefix`、`timeoutMs`、
    `cleanupTimeoutMs`、`concurrency`、`checks`、`skip`、`addressingStyle`
    （`"path"` / `"virtual-hosted"`）、`allowInsecure`
  - ライブラリ専用：`credentials`（AWS SDK の認証情報オブジェクトまたは provider）、
    `signal`（`AbortSignal`）、`onCheckComplete`
- ほかに `listChecks()`、`formatText(report)`、`formatJson(report)` もエクスポート
  しています。

## セキュリティ上の考慮事項

このツールは、指定したバケットへの**書き込みと削除を行います**。そのうえで安全に
使えるよう設計しています。

- **隔離された名前空間。** すべてのオブジェクトは、実行ごとに一意な
  `<prefix><UTC タイムスタンプ>-<ランダム ID>/` の下に作成します（例：
  `s3-compat-check/20261116T000000Z-a1b2c3d4/`）。書き込む前にこの prefix が空で
  あることを確認するため、既存のオブジェクトを上書きすることはありません。
- **自分が作ったものだけを削除。** cleanup が削除するのは、追跡していたキーと、
  一意な実行 prefix の下にあるそれ以外のもの（例えば、サーバーには保存された
  ものの応答がタイムアウトした書き込み）だけです。削除のたびに実行 prefix の内側か
  どうかを先に確認するため、その外側のものを削除することはありません。
- **必ず cleanup する。**
  - 各チェックのオブジェクトは、そのチェックが終わった時点（実行中のリクエストが
    すべて完了した後）で削除します。
  - 最後に全体を掃除し、未完了の multipart upload を abort します。また、実行
    prefix の下にあるオブジェクトのバージョンと削除マーカーも削除します。これには
    バージョニング一時停止中のバケットの `null` バージョンも含みます。
  - cleanup には専用の時間予算（`--cleanup-timeout`）があります。
  - cleanup に失敗した場合や一覧の取得が不完全だった場合は、残ったキーを
    レポートに示し、終了コード 1 で終了します。
- **シグナル。** SIGINT / SIGTERM を受けると、実行中のリクエストを中止したうえで
  cleanup を実行します。2 回目のシグナルで即座に終了し、45 秒経っても終わらない
  場合は待つのをやめて終了します。
- **バケットを管理しない。** バケットの作成・削除・設定変更は一切行いません。
- **出力に秘密情報を含めない。**
  - 対象：アクセスキー、シークレットキー、セッショントークン、`Authorization`
    ヘッダー、`X-Amz-Signature` / `X-Amz-Credential`、署名付き URL。
  - これらは、テキスト、JSON、verbose ログ、エラーメッセージのすべての出力で
    マスクされます。
  - SDK のエラーオブジェクトやクライアント設定をシリアライズすることもありません。
- **通信。** 平文 HTTP は、ループバックアドレスか `--allow-insecure` 指定時を除いて
  拒否します。TLS の検証を無効にすることはありません。
- **リトライしない。** SDK はリクエストごとに 1 回だけ試行するよう設定しています。
  そのため、失敗はリトライで隠されず、起きたとおりに報告されます。

### 必要な権限

専用のテストバケット、少なくとも専用の prefix を使ってください。デフォルトの
prefix に絞った、最小限の AWS IAM ポリシーは次のとおりです。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::test-bucket"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::test-bucket/s3-compat-check/*"
    }
  ]
}
```

最後の掃除では、常に `ListObjectVersions` を試します。

- バージョニングしていないバケットでは、ここで `403` や `501` が返っても問題として
  扱いません。
- 書き込みがタイムアウトした場合は、バージョンが作られたかどうかが分かりません。
  そのため `GetBucketVersioning`（`s3:GetBucketVersioning`、任意）で確認し、
  バケットが一度もバージョニングされていない場合を除いて、cleanup を失敗として
  報告します。
- バージョニングが有効または一時停止中のバケットでは、バージョンと削除マーカーを
  削除できるよう、`s3:ListBucketVersions`（バケット）と `s3:DeleteObjectVersion`
  （オブジェクト）も付与してください。

バケットを削除する権限は**不要**です。

`s3:ListBucket` がないと、S3 は存在しないキーに対して `404` ではなく `403` を返す
ため、`delete` と `nonexistent` のチェックが失敗します。

## 制約事項

- これは**スモークテストであり、適合性テストスイートではありません**。対象は
  一部の主要な操作の、一般的なケースだけです。
- 対象外のもの：バケット操作、ACL とポリシー、Object Lock、タグ付け、ライフ
  サイクル、暗号化（SSE-\*）、CopyObject、UploadPartCopy、DeleteObjects、
  ListObjects（v1）、POST ポリシー、CORS、Web サイトホスティング、通知、
  レプリケーション、Object Lambda、S3 Express など。
- ETag は一貫性だけを比較します。MD5 ハッシュであるとは決して仮定しません。
- checksum は SHA-256 のみをテストします。
- 署名付き URL のチェックでは、ツールを実行するマシンから endpoint のホスト名を
  名前解決できる必要があります。
- 一覧の取得は強い整合性を前提としています。結果整合性の一覧を持つ実装では、
  `list` が時々失敗することがあります。
- multipart upload は 5 MiB のパートを使います。回線が遅い場合は `--timeout` を
  増やしてください。

## 開発

```bash
npm ci
npm run lint        # ESLint + Prettier
npm run typecheck
npm test            # ユニットテスト（Vitest）
npm run build       # tsup -> dist/

# 使い捨ての MinIO に対する E2E テスト（テスト自身がバケットを作成・削除します）:
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=ACCESS_KEY_EXAMPLE -e MINIO_ROOT_PASSWORD=SECRET_KEY_EXAMPLE \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
AWS_ACCESS_KEY_ID=ACCESS_KEY_EXAMPLE AWS_SECRET_ACCESS_KEY=SECRET_KEY_EXAMPLE \
  S3CC_E2E_ENDPOINT=http://localhost:9000 npm run test:e2e
```

チェックの追加方法とリリース手順は [CONTRIBUTING.md](CONTRIBUTING.md)（英語）を
参照してください。

## ライセンス

[Apache-2.0](LICENSE)
