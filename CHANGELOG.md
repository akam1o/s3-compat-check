# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

### Added

- Initial release.
- Checks: `put`, `get`, `head`, `delete`, `range`, `list`, `multipart`, `etag`,
  `checksum` (optional), `presigned`, `nonexistent`.
- Text and JSON (schema 1.0) reporters, `--output`, exit codes 0/1/2/3.
- Per-run isolated prefix, tracked cleanup with prefix sweep, multipart abort,
  versioned-bucket cleanup, SIGINT/SIGTERM handling.
- Per-operation timeouts, no SDK retries, bounded concurrency with stable ordering.
- Redaction of credentials, signatures and presigned URLs from all output.
- Library API: `runChecks`, `listChecks`, `formatText`, `formatJson`, `RunAbortedError`.

### Fixed (pre-release cross-model review)

- Cleanup no longer races with in-flight writes when a check fails mid-way, and
  always runs even if `logger` / `onCheckComplete` throw.
- `null` versions and delete markers (versioning-suspended buckets) are removed;
  version listing is always probed; truncated listings without a continuation
  token fail cleanup instead of reporting it as complete.
- Credential resolution and URL presigning are bounded by `--timeout`; an abort
  during preflight is reported as an interruption.
- Stalled response bodies are reported as timeouts, not connection resets.
- Redaction now covers header/JSON-style signing values and command-line
  parser diagnostics; argument errors produce fatal JSON in `--format json` mode;
  AWS SDK warnings are never printed.
- Async `logger` / `onCheckComplete` rejections are swallowed; cleanup after a
  timed-out write is only reported complete if versions could be verified (or
  the bucket was never versioned); the final cleanup and its verification stay
  within `--cleanup-timeout`; fatal JSON uses `error.type: "interrupted"` for
  interruptions.
- `checksum` requires a checksum-specific HTTP 400 for a mismatching checksum and fails if a server
  that returns checksums accepts a mismatch; `list` accepts pages smaller than
  `MaxKeys`; `nonexistent` explains a HEAD 403; `--skip all` is rejected.
