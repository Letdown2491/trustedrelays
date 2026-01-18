/**
 * Internet Freedom Scores by Country
 *
 * Based on Freedom House "Freedom on the Net" report
 * https://freedomhouse.org/report/freedom-net
 *
 * Scores: 0-100 (higher = more free)
 * Categories:
 *   - Free: 70-100
 *   - Partly Free: 40-69
 *   - Not Free: 0-39
 *
 * Last updated: 2024 report data
 */

export interface FreedomScore {
  score: number;
  category: 'free' | 'partly_free' | 'not_free';
}

/**
 * Freedom scores by ISO 3166-1 alpha-2 country code
 * Countries not in the Freedom House report are assumed to be unrated
 */
const FREEDOM_SCORES: Record<string, number> = {
  // Free (70-100)
  IS: 94,  // Iceland
  EE: 93,  // Estonia
  CA: 87,  // Canada
  CR: 86,  // Costa Rica
  TW: 79,  // Taiwan
  DE: 77,  // Germany
  FR: 76,  // France
  GB: 75,  // United Kingdom
  AU: 75,  // Australia
  JP: 74,  // Japan
  GE: 74,  // Georgia
  ZA: 73,  // South Africa
  AR: 72,  // Argentina
  IT: 72,  // Italy
  PH: 71,  // Philippines
  US: 76,  // United States
  NL: 77,  // Netherlands
  SE: 78,  // Sweden
  NO: 78,  // Norway
  FI: 88,  // Finland
  DK: 80,  // Denmark
  CH: 79,  // Switzerland
  AT: 77,  // Austria
  BE: 76,  // Belgium
  IE: 78,  // Ireland
  PT: 75,  // Portugal
  ES: 74,  // Spain
  NZ: 79,  // New Zealand
  KR: 67,  // South Korea (borderline)

  // Partly Free (40-69)
  CO: 65,  // Colombia
  KE: 64,  // Kenya
  HU: 64,  // Hungary
  MX: 62,  // Mexico
  NG: 61,  // Nigeria
  BD: 60,  // Bangladesh
  UA: 59,  // Ukraine
  SG: 55,  // Singapore
  BR: 54,  // Brazil
  IN: 50,  // India
  MY: 49,  // Malaysia
  ID: 48,  // Indonesia
  TH: 46,  // Thailand
  KH: 44,  // Cambodia
  TR: 42,  // Turkey
  AZ: 41,  // Azerbaijan
  PL: 65,  // Poland
  GR: 68,  // Greece
  CZ: 69,  // Czech Republic
  SK: 68,  // Slovakia
  RO: 66,  // Romania
  BG: 63,  // Bulgaria
  RS: 58,  // Serbia

  // Not Free (0-39)
  RU: 21,  // Russia
  BY: 18,  // Belarus
  VE: 28,  // Venezuela
  PK: 26,  // Pakistan
  EG: 24,  // Egypt
  AE: 29,  // United Arab Emirates
  SA: 24,  // Saudi Arabia
  VN: 22,  // Vietnam
  MM: 17,  // Myanmar
  IR: 11,  // Iran
  CN: 9,   // China
  CU: 22,  // Cuba
  ET: 25,  // Ethiopia
  UZ: 28,  // Uzbekistan
  KZ: 32,  // Kazakhstan
  QA: 35,  // Qatar
  BH: 31,  // Bahrain
  IQ: 36,  // Iraq
  LY: 32,  // Libya
  SY: 17,  // Syria
  SD: 20,  // Sudan
  KP: 3,   // North Korea (estimated)
};

/**
 * Default score for countries not in the Freedom House report
 * Assumed to be moderately free (benefit of the doubt)
 */
const DEFAULT_SCORE = 65;

/**
 * Get freedom score for a country
 */
export function getFreedomScore(countryCode: string | undefined | null): FreedomScore | null {
  if (!countryCode) return null;

  const code = countryCode.toUpperCase();
  const score = FREEDOM_SCORES[code] ?? DEFAULT_SCORE;

  let category: 'free' | 'partly_free' | 'not_free';
  if (score >= 70) {
    category = 'free';
  } else if (score >= 40) {
    category = 'partly_free';
  } else {
    category = 'not_free';
  }

  return { score, category };
}

/**
 * Check if a country is in our database
 */
export function hasCountryData(countryCode: string): boolean {
  return countryCode.toUpperCase() in FREEDOM_SCORES;
}

/**
 * Get all countries with their freedom scores
 */
export function getAllFreedomScores(): Array<{ countryCode: string; score: number; category: string }> {
  return Object.entries(FREEDOM_SCORES).map(([countryCode, score]) => ({
    countryCode,
    score,
    category: score >= 70 ? 'free' : score >= 40 ? 'partly_free' : 'not_free',
  }));
}

/**
 * Calculate openness penalty based on internet freedom score
 *
 * Returns a penalty value (0-20) to subtract from openness score:
 * - Free countries (70-100): 0 penalty
 * - Partly Free (40-69): 0-10 penalty (scaled)
 * - Not Free (0-39): 10-20 penalty (scaled)
 */
export function calculateFreedomPenalty(countryCode: string | undefined | null): number {
  const freedom = getFreedomScore(countryCode);
  if (!freedom) return 0;

  if (freedom.category === 'free') {
    return 0;
  } else if (freedom.category === 'partly_free') {
    // Scale from 0 (at 69) to 10 (at 40)
    const range = 69 - 40;
    const position = 69 - freedom.score;
    return Math.round((position / range) * 10);
  } else {
    // Not free: Scale from 10 (at 39) to 20 (at 0)
    const range = 39;
    const position = 39 - freedom.score;
    return 10 + Math.round((position / range) * 10);
  }
}

/**
 * Get a human-readable description of the freedom category
 */
export function describeFreedomCategory(countryCode: string | undefined | null): string {
  const freedom = getFreedomScore(countryCode);
  if (!freedom) return 'unknown';

  switch (freedom.category) {
    case 'free':
      return 'free';
    case 'partly_free':
      return 'partly free';
    case 'not_free':
      return 'not free';
  }
}
