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
- Library API: `runChecks`, `listChecks`, `formatText`, `formatJson`.
