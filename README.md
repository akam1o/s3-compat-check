# s3-compat-check

**S3 compatibility smoke tests in seconds.**

`s3-compat-check` is a small CLI (and library) that quickly verifies whether an
object storage service that claims S3 API compatibility actually implements the
basic S3 API correctly. Run it with `npx`: no installation and almost no
configuration needed.

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

It works with any S3-compatible implementation: Amazon S3, MinIO, Ceph RGW,
Cloudflare R2, SeaweedFS, Garage and others. Nothing in it is vendor-specific.

### How it differs from conformance suites

Projects such as [Ceph s3-tests](https://github.com/ceph/s3-tests) and s3t run
thorough conformance testing. `s3-compat-check` covers a different need:

- runs straight from `npx`, with nothing to install
- finishes in seconds and covers the APIs most applications depend on
- needs only an endpoint and a bucket
- prints readable results, and JSON for CI
- reports exactly which API failed, what was expected, and what came back
- is easy to extend with new checks

> **It does not guarantee full S3 conformance.** A passing run means the basic
> operations listed below behave as expected. It says nothing about the rest of
> the S3 API. See [Limitations](#limitations).

## Quick Start

Start a disposable local MinIO server (using the community-maintained image) and create a bucket:

```bash
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=ACCESS_KEY_EXAMPLE \
  -e MINIO_ROOT_PASSWORD=SECRET_KEY_EXAMPLE \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data

export AWS_ACCESS_KEY_ID=ACCESS_KEY_EXAMPLE
export AWS_SECRET_ACCESS_KEY=SECRET_KEY_EXAMPLE
aws --endpoint-url http://localhost:9000 s3 mb s3://test-bucket
```

Run the checks:

```bash
npx s3-compat-check --endpoint http://localhost:9000 --bucket test-bucket
```

## Installation

You do not need to install anything; `npx s3-compat-check` always runs the
latest version. Requires **Node.js 22.12 or later**.

To pin a version in a project or CI:

```bash
npm install --save-dev s3-compat-check
npx s3-compat-check --help
```

## Usage examples

### MinIO

```bash
AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin \
npx s3-compat-check \
  --endpoint http://localhost:9000 \
  --bucket test \
  --allow-insecure
```

(`--allow-insecure` is only required for plain-HTTP endpoints that are not
`localhost`, `127.0.0.1` or `::1`.)

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

### Run selected checks only

```bash
npx s3-compat-check \
  --endpoint http://localhost:9000 \
  --bucket test-bucket \
  --checks put,get,head,range
```

## CLI options

| Option                   | Default                     | Description                                                                                                              |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--endpoint <url>`       | AWS S3                      | S3 endpoint URL. Falls back to `AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`.                                           |
| `--bucket <name>`        | (required)                  | An **existing** bucket to run the checks in. Buckets are never created or deleted.                                       |
| `--region <region>`      | `AWS_REGION` or `us-east-1` | Signing region (`AWS_DEFAULT_REGION` is also honoured).                                                                  |
| `--prefix <prefix>`      | `s3-compat-check/`          | Base key prefix. Every run creates a unique namespace below it (see [Safety](#security-considerations)).                 |
| `--timeout <ms>`         | `10000`                     | Timeout for each individual S3 operation, including reading its response body.                                           |
| `--cleanup-timeout <ms>` | `30000`                     | Time budget for the final cleanup including verification (up to a third is reserved for verification).                   |
| `--concurrency <n>`      | `4`                         | Number of checks run in parallel (1–32). Results are always printed in the same order.                                   |
| `--format <text\|json>`  | `text`                      | Report format.                                                                                                           |
| `--output <file>`        |                             | Also write the report (in `--format`) to a file. The text report is still printed to stdout.                             |
| `--checks <names>`       | all                         | Comma-separated list of checks to run. May be repeated.                                                                  |
| `--skip <names>`         |                             | Comma-separated list of checks to skip (`all` is rejected). Check ids are case-insensitive.                              |
| `--list-checks`          |                             | Print the available checks and exit.                                                                                     |
| `--verbose`              |                             | Print per-operation diagnostics to stderr and extra details in the report.                                               |
| `--no-color`             |                             | Disable colors. Colors are also disabled when stdout is not a TTY or `NO_COLOR` is set.                                  |
| `--path-style`           | for custom endpoints        | Force path-style requests (`https://host/bucket/key`).                                                                   |
| `--virtual-hosted-style` | for AWS S3                  | Force virtual-hosted-style requests (`https://bucket.host/key`).                                                         |
| `--allow-insecure`       |                             | Allow plain-HTTP endpoints other than `localhost` / `127.0.0.1` / `::1`. TLS certificate verification is never disabled. |
| `--version`, `--help`    |                             |                                                                                                                          |

## Authentication

Credentials are resolved by the standard
[AWS SDK for JavaScript v3 credential provider chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html):
environment variables, shared config/credentials files (`AWS_PROFILE`), SSO, web identity, ECS and EC2 instance roles.

| Variable                                     | Purpose                                          |
| -------------------------------------------- | ------------------------------------------------ |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Static credentials                               |
| `AWS_SESSION_TOKEN`                          | Temporary credentials                            |
| `AWS_PROFILE`                                | Named profile from `~/.aws/config`/`credentials` |
| `AWS_REGION`                                 | Default signing region                           |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`    | Default endpoint when `--endpoint` is not given  |

There is intentionally **no command-line option for secrets**: values passed on
the command line end up in shell history and process listings.

For a private CA, use Node.js' standard `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

## Supported checks

Each check is independent: it writes its own objects under its own prefix, and
one check failing does not cause others to fail.

| ID            | Name               | What it verifies                                                                                                                                                                 |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `put`         | PutObject          | A 1 KiB PUT returns HTTP 200 and the object is stored with the right size.                                                                                                       |
| `get`         | GetObject          | GET returns HTTP 200, the correct `Content-Length` and byte-identical data.                                                                                                      |
| `head`        | HeadObject         | HEAD returns `Content-Length`, `Content-Type`, user metadata (`x-amz-meta-*`), `ETag` and `Last-Modified`.                                                                       |
| `delete`      | DeleteObject       | DELETE returns 204 (200 accepted), then GET returns `404 NoSuchKey` and HEAD returns 404; deleting a missing key succeeds.                                                       |
| `range`       | Range GET          | `bytes=0-99`, `bytes=100-199` and `bytes=-100` return 206, the correct `Content-Range`, `Content-Length` and data.                                                               |
| `list`        | ListObjectsV2      | `Prefix` filtering, `MaxKeys` pagination with continuation tokens (`MaxKeys` is treated as an upper bound), `KeyCount`, object sizes and `Delimiter` / `CommonPrefixes`.         |
| `multipart`   | Multipart Upload   | Create, upload 2 parts (5 MiB + ~1 MiB), complete, then verify size and SHA-256 of the downloaded object. The upload is aborted on failure.                                      |
| `etag`        | ETag               | PUT returns an ETag that HEAD and GET repeat; `If-Match` returns 200, `If-None-Match` returns 304, and a wrong `If-Match` returns 412. **The ETag is not assumed to be an MD5.** |
| `checksum`    | Checksum           | _Optional._ PUT with `x-amz-checksum-sha256` succeeds, the checksum read back with HEAD matches, and a mismatching checksum is rejected.                                         |
| `presigned`   | Presigned URL      | A presigned GET URL (60 s) fetched with plain `fetch`, without SDK or auth headers, returns the uploaded data.                                                                   |
| `nonexistent` | Nonexistent Object | GET of a missing key returns `404 NoSuchKey`; HEAD returns 404. Status and error code are reported separately.                                                                   |

### Result statuses

| Status        | Meaning                                                                                                                                 | Fails the run? |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `passed`      | Behavior matches S3.                                                                                                                    | no             |
| `failed`      | A request failed or a response differed from S3. The report has the operation, HTTP status, error code, and expected vs. actual values. | **yes**        |
| `unsupported` | An **optional** feature (currently only `checksum`) is not implemented. Required checks never report this; they fail instead.           | no             |
| `skipped`     | The check did not run, e.g. because the run was interrupted.                                                                            | no             |

`checksum` reports `unsupported` when the server either rejects the checksum
header (501, or 400 `NotImplemented` / `InvalidArgument` / `InvalidRequest`) or
silently ignores it: a mismatching checksum is accepted and no checksum is ever
returned (neither by PUT nor by HEAD). If the server returns a checksum that is
_wrong_, accepts a mismatching checksum after returning a checksum, or rejects the
mismatch with anything other than a checksum-specific HTTP 400 (`BadDigest`,
`InvalidDigest`, `XAmzContentChecksumMismatch` or `XAmzContentSHA256Mismatch`), the check
**fails**.

## JSON output

`--format json` prints one JSON document to stdout. Version 1.0 of the schema is
stable: fields may be added in minor releases, but are never removed or
renamed without bumping `schemaVersion`.

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

- `endpoint` is `null` when the default AWS endpoint is used.
- `checks[].error.kind` is one of `assertion`, `http`, `network`, `timeout`,
  `aborted`, `credentials`, `skipped`, `unknown`. For `assertion` errors,
  `expected` and `actual` describe the difference. For `unsupported` and
  `skipped` results, `error` carries the reason.
- `checks[].details` (optional) lists observations, for example the error codes
  returned or whether the ETag happens to be an MD5.
- `cleanup.status` is `completed` or `failed`; `remaining` lists keys that could
  not be removed.

If the run cannot start (invalid configuration, unreachable endpoint, bad
credentials), the JSON output is:

```json
{
  "schemaVersion": "1.0",
  "tool": "s3-compat-check",
  "toolVersion": "0.1.0",
  "ok": false,
  "error": { "type": "environment", "message": "Bucket \"test-bucket\" does not exist" }
}
```

`error.type` is `config` (exit 2), `environment` (exit 3) or `interrupted`
(exit 130/143).

## Exit codes

| Code  | Meaning                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------- |
| `0`   | Every check passed. `unsupported` optional features and `skipped` checks do not fail the run.  |
| `1`   | At least one check failed, or cleanup failed (test objects may remain).                        |
| `2`   | Invalid command-line arguments or configuration.                                               |
| `3`   | Fatal environment error: cannot connect, no credentials, access denied, bucket does not exist. |
| `130` | Interrupted by SIGINT (`143` for SIGTERM) after cleanup was attempted.                         |

Argument errors in `--format json` mode also print the fatal JSON document.

## CI integration

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

With `--output`, the JSON report goes to a file and a readable summary is printed
in the job log. The JSON report never contains credentials or presigned URLs, so
it is safe to keep as an artifact.

## Library API

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

- `runChecks(options)` resolves to a typed `RunReport` (the same structure as the JSON output).
  It never writes to stdout or stderr (AWS SDK diagnostics are discarded). Pass `logger` to receive
  redacted diagnostics. `logger` and `onCheckComplete` are not awaited; exceptions and promise
  rejections from them are ignored and never prevent cleanup.
- It throws `ConfigError` for invalid options, `EnvironmentError` when the endpoint or bucket cannot
  be used, and `RunAbortedError` when `signal` fires before any check starts.
- Options mirror the CLI: `endpoint`, `bucket`, `region`, `prefix`, `timeoutMs`, `cleanupTimeoutMs`,
  `concurrency`, `checks`, `skip`, `addressingStyle` (`"path"` / `"virtual-hosted"`), `allowInsecure`,
  plus `credentials` (an AWS SDK credentials object or provider), `signal` (an `AbortSignal`) and `onCheckComplete`.
- `listChecks()`, `formatText(report)` and `formatJson(report)` are also exported.

## Security considerations

The tool **writes to and deletes from** the bucket you point it at. It is designed to be safe for that:

- **Isolated namespace.** All objects are created under a unique per-run prefix,
  `<prefix><UTC timestamp>-<random id>/` (e.g.
  `s3-compat-check/20261116T000000Z-a1b2c3d4/`). Before writing, the tool checks
  that this prefix is empty, so existing objects are never overwritten.
- **Deletes only what it owns.** Cleanup deletes the keys it tracked, plus
  anything else under the unique run prefix (for example a write that timed out
  after the server stored it). Every delete is checked against the run prefix
  first. Nothing outside it is ever deleted.
- **Always cleans up.** Each check's objects are removed as soon as it finishes
  (after all of its in-flight requests have settled). A final sweep aborts
  incomplete multipart uploads and removes the object versions and delete
  markers under the run prefix, including `null` versions on
  versioning-suspended buckets. Cleanup has its own time budget
  (`--cleanup-timeout`). If cleanup fails or a listing is incomplete, the report
  lists the remaining keys and the run exits with code 1.
- **Signals.** On SIGINT/SIGTERM, running requests are aborted and cleanup still
  runs. A second signal exits immediately, and the tool gives up waiting after
  45 seconds.
- **No bucket management.** Buckets are never created, deleted or reconfigured.
- **No secrets in output.** Access keys, secret keys, session tokens,
  `Authorization` headers, `X-Amz-Signature`/`X-Amz-Credential` and presigned
  URLs are redacted from all output: text, JSON, verbose logs and error
  messages. SDK error objects and client configuration are never serialized.
- **Transport.** Plain HTTP is refused except for loopback addresses or with
  `--allow-insecure`. TLS verification is never disabled.
- **No retries.** The SDK is configured with a single attempt per request, so
  failures are reported as they happened, not hidden by retries.

### Required permissions

Use a dedicated test bucket, or at least a dedicated prefix. The minimum AWS IAM
policy, scoped to the default prefix:

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

The final sweep always tries `ListObjectVersions`. On unversioned buckets a
`403` or `501` there is tolerated. If a write timed out, however, the tool
cannot know whether it created a version. It then asks `GetBucketVersioning`
(`s3:GetBucketVersioning`, optional). Cleanup is reported as failed unless the
bucket was never versioned. On versioned or versioning-suspended buckets, also
grant `s3:ListBucketVersions` (bucket) and `s3:DeleteObjectVersion` (objects) so
that versions and delete markers can be removed. Permission to delete the
bucket is **not** needed.

Without `s3:ListBucket`, S3 returns `403` instead of `404` for missing keys, and
the `delete` and `nonexistent` checks will fail.

## Limitations

- This is a **smoke test, not a conformance suite**. It covers a small set of
  core operations, and only their common cases.
- Not covered: bucket operations, ACLs and policies, object lock, tagging,
  lifecycle, encryption (SSE-*), CopyObject, UploadPartCopy, DeleteObjects,
  ListObjects (v1), POST policies, CORS, website hosting, notifications,
  replication, object lambda, S3 Express and others.
- ETags are compared for consistency only. They are never assumed to be MD5
  hashes.
- Only SHA-256 is tested for checksums.
- The presigned URL check needs the endpoint hostname to resolve from the machine running the tool.
- Strongly consistent listing is assumed. Implementations with eventually
  consistent listings may see sporadic `list` failures.
- Multipart uploads use 5 MiB parts. On a slow link, increase `--timeout`.

## Development

```bash
npm ci
npm run lint        # ESLint + Prettier
npm run typecheck
npm test            # unit tests (Vitest)
npm run build       # tsup -> dist/

# End-to-end tests against a disposable MinIO (they create and delete their own buckets):
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=ACCESS_KEY_EXAMPLE -e MINIO_ROOT_PASSWORD=SECRET_KEY_EXAMPLE \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
AWS_ACCESS_KEY_ID=ACCESS_KEY_EXAMPLE AWS_SECRET_ACCESS_KEY=SECRET_KEY_EXAMPLE \
  S3CC_E2E_ENDPOINT=http://localhost:9000 npm run test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a check and for the release process.

## License

[Apache-2.0](LICENSE)
