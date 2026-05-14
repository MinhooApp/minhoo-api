/**
 * Single-flight / cache stampede protection
 *
 * If multiple callers request the same key concurrently, only the first
 * call actually runs `producer`. All others wait and receive the same
 * resolved value (or throw the same error).
 *
 * Usage:
 *   const value = await singleFlight("my-key", () => expensiveOp());
 */

const inFlight = new Map<string, Promise<any>>();

export async function singleFlight<T>(
  key: string,
  producer: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = producer().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}
