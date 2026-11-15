import { createRequire } from "node:module";

export const TOOL_NAME = "s3-compat-check";
export const TOOL_VERSION: string =
  typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : "0.0.0-dev";

let cachedSdkVersion: string | undefined;

export function awsSdkVersion(): string {
  if (cachedSdkVersion === undefined) {
    try {
      const require = createRequire(import.meta.url);
      const pkg = require("@aws-sdk/client-s3/package.json") as { version?: unknown };
      cachedSdkVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      cachedSdkVersion = "unknown";
    }
  }
  return cachedSdkVersion;
}
