import { checksumCheck } from "./checksum.js";
import { deleteCheck } from "./delete.js";
import { etagCheck } from "./etag.js";
import { getCheck } from "./get.js";
import { headCheck } from "./head.js";
import { listCheck } from "./list.js";
import { multipartCheck } from "./multipart.js";
import { nonexistentCheck } from "./nonexistent.js";
import { presignedCheck } from "./presigned.js";
import { putCheck } from "./put.js";
import { rangeCheck } from "./range.js";
import type { Check } from "./types.js";

/** All checks, in display order. */
export const ALL_CHECKS: readonly Check[] = [
  putCheck,
  getCheck,
  headCheck,
  deleteCheck,
  rangeCheck,
  listCheck,
  multipartCheck,
  etagCheck,
  checksumCheck,
  presignedCheck,
  nonexistentCheck,
];

export const CHECK_IDS: readonly string[] = ALL_CHECKS.map((c) => c.id);

export type { Check } from "./types.js";
