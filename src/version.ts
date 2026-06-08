/**
 * Single source of truth for version numbers.
 *
 * ALGORITHM_VERSION is published in kind-30385 assertions, shown on the
 * dashboard, and documented in ALGORITHM.md. Bump it whenever the scoring math
 * changes in a way that shifts published scores, and keep ALGORITHM.md's
 * "Algorithm Version" header in sync.
 */
export const ALGORITHM_VERSION = 'v0.3.0';

export const ALGORITHM_URL =
  'https://github.com/Letdown2491/trustedrelays/blob/main/ALGORITHM.md';
