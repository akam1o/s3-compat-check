/**
 * Map `items` through `fn` with at most `concurrency` calls in flight.
 * Results keep the order of `items` regardless of completion order.
 *
 * If a call fails, no new items are started, but calls already in flight are
 * awaited before the first error is rethrown. Callers (e.g. cleanup) can then
 * rely on no work still running in the background.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await fn(items[index] as T, index);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    })(),
  );
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
