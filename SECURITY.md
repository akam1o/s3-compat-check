# Security Policy

## Supported versions

Security fixes are released for the latest minor version.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/akam1o/s3-compat-check/security/advisories/new).
Include a description, the affected version and steps to reproduce.

When reporting, **do not include real credentials, presigned URLs, internal
hostnames or data from production systems**. Use placeholders instead.

You can expect an initial response within 7 days. Once a fix is available, we
will publish an advisory and credit you, unless you prefer to remain anonymous.

## Scope

Issues that are in scope include, for example:

- credentials, session tokens, signatures or presigned URLs appearing in any
  output (stdout, stderr, JSON reports, error messages)
- deleting or overwriting objects outside the tool's per-run prefix
- connecting over plain HTTP without `--allow-insecure` (except loopback hosts)
- vulnerabilities in the published npm package or its build/release pipeline

## Safe usage

- Run the tool against a dedicated test bucket or prefix, with credentials
  limited to the permissions listed in the README.
- Pass credentials through the AWS credential provider chain (environment,
  profile, role), never on the command line.
