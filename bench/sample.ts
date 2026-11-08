/**
 * Deterministic sampling and metrics helpers for benchmark harness.
 */

export interface SetMetrics {
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Mulberry32 32-bit seeded pseudo-random number generator.
 * Produces deterministic floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically samples `count` items from an array.
 * Inputs are sorted by keyFn first to guarantee determinism regardless of input order.
 */
export function deterministicSample<T>(
  items: T[],
  count: number,
  keyFn: (item: T) => string = (item: T) => String(item),
  seed = 20261108
): T[] {
  const sorted = [...items].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
  if (sorted.length <= count) {
    return sorted;
  }
  const rng = mulberry32(seed);
  const pool = [...sorted];
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  // Return the top `count` items sorted by keyFn for reproducibility
  return pool.slice(0, count).sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

/**
 * Calculates precision, recall, and F1 score over two string sets.
 */
export function computeMetrics(
  predicted: Iterable<string>,
  groundTruth: Iterable<string>
): SetMetrics {
  const pSet = new Set(predicted);
  const gSet = new Set(groundTruth);

  if (gSet.size === 0 && pSet.size === 0) {
    return { precision: 1.0, recall: 1.0, f1: 1.0 };
  }
  if (pSet.size === 0 || gSet.size === 0) {
    return { precision: 0.0, recall: 0.0, f1: 0.0 };
  }

  let tp = 0;
  for (const item of pSet) {
    if (gSet.has(item)) {
      tp++;
    }
  }

  const precision = tp / pSet.size;
  const recall = tp / gSet.size;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0.0;

  return { precision, recall, f1 };
}

/**
 * Computes the p-th percentile (e.g. 50 or 95) from an array of numbers.
 * Uses linear interpolation between closest ranks.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const val = sorted[lower] * (1 - weight) + sorted[upper] * weight;
  return Math.round(val * 100) / 100;
}
