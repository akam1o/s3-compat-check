# Contributing

Thanks for your interest in improving `s3-compat-check`! Bug reports, new checks
and compatibility findings for specific implementations are all welcome.

## Ground rules

- **Never include private information** in issues, pull requests, code, tests or
  fixtures. That covers credentials, presigned URLs, `Authorization` headers,
  internal hostnames or URLs, real bucket names, IP addresses, and captured
  HTTP traffic from real systems. Use `storage.example.com`, `test-bucket`,
  `ACCESS_KEY_EXAMPLE` and `SECRET_KEY_EXAMPLE` instead.
- Test data must be generated (see `deterministicBytes` in `src/core/data.ts`).
- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Development setup

Requires Node.js 22.12+ and npm.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

End-to-end tests need a disposable MinIO server. They create and delete their
own buckets, so never point them at a server holding real data:

```bash
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=ACCESS_KEY_EXAMPLE -e MINIO_ROOT_PASSWORD=SECRET_KEY_EXAMPLE \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
npm run build
AWS_ACCESS_KEY_ID=ACCESS_KEY_EXAMPLE AWS_SECRET_ACCESS_KEY=SECRET_KEY_EXAMPLE \
  S3CC_E2E_ENDPOINT=http://localhost:9000 npm run test:e2e
```

## Project layout

```text
src/
  bin.ts              CLI executable (signal handling)
  index.ts            public library API
  cli/                argument parsing, output selection, exit codes
  core/               runner, context, config, cleanup, redaction, errors
  checks/             one file per check + registry (index.ts)
  reporters/          text and JSON reporters
test/
  unit/               Vitest unit tests (in-memory fake S3 in fake-s3.ts)
  e2e/                end-to-end tests against MinIO
```

## Adding a check

1. Create `src/checks/<id>.ts` exporting a `Check`:

   ```ts
   import { GetObjectCommand } from "@aws-sdk/client-s3";
   import { deterministicBytes } from "../core/data.js";
   import { assertEqual, putObject } from "./helpers.js";
   import type { Check } from "./types.js";

   export const exampleCheck: Check = {
     id: "example",
     name: "Example",
     description: "One line shown by --list-checks",
     required: true,
     async run(ctx) {
       const key = ctx.key("object.bin"); // tracked and cleaned up automatically
       await putObject(ctx, key, deterministicBytes(16, "example"));
       const res = await ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key }));
       assertEqual(res.ContentLength, 16, "Content-Length", "GetObject");
     },
   };
   ```

2. Register it in `src/checks/index.ts` (the order there is the display order).
3. Add unit tests using the fake in `test/unit/fake-s3.ts`, including at least
   one test where the server misbehaves.
4. Run the E2E suite against MinIO.
5. Document the check in `README.md` and `CHANGELOG.md`.

Guidelines for checks:

- A check passes by returning. To report anything else, throw:
  `AssertionFailure` (with `expected` / `actual`) for wrong behavior,
  `UnsupportedFeature` for a missing optional feature (`required: false`), or
  `SkipCheck`.
- Always create keys with `ctx.key()` (or `ctx.unusedKey()` for keys that are
  never written) and record writes with `putObject` / `ctx.recordWrite`, so
  cleanup works on versioned buckets too.
- Use `ctx.send` (timeouts, no retries), `ctx.readBody` / `ctx.consumeBody` and
  `ctx.fetch`. Do not create other clients.
- Never log or return presigned URLs, headers or raw SDK error objects.
- Do not relax assertions just to make one implementation pass. Record the
  observed behavior with `ctx.note()` and report the difference.
- Keep checks independent and fast (well under a second on a local server).

## Commit and pull request process

- Keep pull requests focused; add a `CHANGELOG.md` entry under "Unreleased".
- CI runs lint, typecheck, unit tests (Node.js 22 and 24), MinIO E2E,
  secret scanning (gitleaks) and dependency audits. All must pass.

## Releasing

Releases are published from GitHub Actions with
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), with
provenance. No long-lived npm token is stored anywhere.

One-time setup (maintainers):

1. Publish the package for the first time, or create it on npmjs.com. Then
   under **Settings → Trusted publishing**, add a GitHub Actions publisher with
   the repository and `.github/workflows/release.yml` as the workflow file, and
   `npm` as the environment.
2. In the GitHub repository, create an environment named `npm` (optionally with
   required reviewers).

Each release:

1. Update `CHANGELOG.md` and bump `version` in `package.json`
   (`npm version <patch|minor|major> --no-git-tag-version`).
2. Commit, then tag: `git tag v<version>` and `git push origin v<version>`.
3. The `Release` workflow verifies that the tag matches `package.json`, runs all
   checks, and runs `npm publish --provenance`.
