import type { CheckContext } from "../core/context.js";

/**
 * A single, independent compatibility check.
 *
 * `run` resolves when the check passes. To report anything else, throw:
 * - `AssertionFailure` (or any error) -> "failed"
 * - `UnsupportedFeature`              -> "unsupported" (optional checks only)
 * - `SkipCheck`                       -> "skipped"
 *
 * Checks must create their own data (via `context.key()`), must not depend on
 * other checks, and do not need to clean up: the runner removes every tracked
 * key and multipart upload after the check finishes.
 */
export interface Check {
  id: string;
  name: string;
  description: string;
  /** Required checks fail instead of reporting "unsupported". */
  required: boolean;
  run(context: CheckContext): Promise<void>;
}
