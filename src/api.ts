import { DataStore } from './database.js';
import { buildAssertion, assertionToEvent } from './assertion.js';
import { computeCombinedReliabilityScore, calculateWeightedObservations, getConfidenceLevel, calculateOfflineReliability } from './scorer.js';
import { computeQualityScore } from './quality-scorer.js';
import { computeAccessibilityScore, getEyesAlliance } from './accessibility-scorer.js';
import { classifyPolicy } from './policy-classifier.js';
import { resolveOperator } from './operator-resolver.js';
import { DASHBOARD_HTML } from './dashboard-template.js';
import {
  computeScoreConfidenceInterval,
  computeUptimeConfidenceInterval,
  computeTrendAnalysis,
  detectAnomaly,
  computeAllRankings,
  formatTrend,
  type RelayScoreData,
} from './analytics.js';
import type { RelayAssertion, OperatorResolution, UnsignedEvent, ScoreSnapshot, TrendAnalysis, RelayRanking, ConfidenceInterval, AnomalyResult } from './types.js';

/**
 * Normalize supported_nips to always be an array of numbers.
 * Some relays return this as an object with numeric keys instead of an array.
 */
function normalizeNipArray(nips: unknown): number[] {
  if (!nips) return [];
  if (Array.isArray(nips)) {
    return nips.filter((n): n is number => typeof n === 'number');
  }
  if (typeof nips === 'object') {
    // Handle object with numeric keys like {0: 1, 1: 4, 2: 9, ...}
    return Object.values(nips).filter((n): n is number => typeof n === 'number');
  }
  return [];
}

/**
 * API Server configuration
 */
export interface ApiConfig {
  port: number;
  host: string;
  db: DataStore;
  // Optional: cors origins
  corsOrigins?: string[];
}

/**
 * API response wrapper
 */
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    timestamp: number;
    version: string;
  };
}

/**
 * Create JSON response
 */
function jsonResponse<T>(data: T, status = 200): Response {
  const response: ApiResponse<T> = {
    success: status < 400,
    data,
    meta: {
      timestamp: Math.floor(Date.now() / 1000),
      version: 'v1.0',
    },
  };
  return new Response(JSON.stringify(response, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/**
 * Sanitize error for client response - removes sensitive details
 */
function sanitizeError(err: unknown): string {
  // For known error types, return generic message
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Database errors
    if (msg.includes('database') || msg.includes('sqlite') || msg.includes('duckdb')) {
      return 'Database error';
    }
    // File system errors
    if (msg.includes('enoent') || msg.includes('permission') || msg.includes('access')) {
      return 'Internal server error';
    }
    // Network errors
    if (msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('socket')) {
      return 'Service temporarily unavailable';
    }
  }
  // Return generic message for unknown errors
  return 'An unexpected error occurred';
}

/**
 * Create error response
 */
function errorResponse(message: string, status = 400): Response {
  const response: ApiResponse = {
    success: false,
    error: message,
    meta: {
      timestamp: Math.floor(Date.now() / 1000),
      version: 'v1.0',
    },
  };
  return new Response(JSON.stringify(response, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Validate and normalize relay URL
 * Returns normalized URL or null if invalid
 */
function validateRelayUrl(urlParam: string | null): { valid: true; url: string } | { valid: false; error: string } {
  if (!urlParam) {
    return { valid: false, error: 'Missing url parameter' };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(urlParam);
  } catch {
    return { valid: false, error: 'Invalid URL encoding' };
  }

  // Must start with wss:// or ws://
  if (!decoded.startsWith('wss://') && !decoded.startsWith('ws://')) {
    return { valid: false, error: 'Invalid relay URL - must start with wss:// or ws://' };
  }

  // Basic URL structure validation
  try {
    const parsed = new URL(decoded);
    if (!parsed.hostname || parsed.hostname.length < 3) {
      return { valid: false, error: 'Invalid relay URL - missing or invalid hostname' };
    }
  } catch {
    return { valid: false, error: 'Invalid relay URL format' };
  }

  return { valid: true, url: decoded };
}

/**
 * Serve static files from public folder
 */
async function serveStaticFile(filename: string, contentType: string): Promise<Response> {
  try {
    const filePath = new URL(`../public/${filename}`, import.meta.url).pathname;
    const file = Bun.file(filePath);
    const content = await file.text();
    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/**
 * Serve the dashboard HTML page
 */
function serveDashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    },
  });
}

/**
 * Simple in-memory rate limiter with LRU eviction to prevent memory leaks
 */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxEntries: number;

  constructor(windowMs: number = 60000, maxRequests: number = 60, maxEntries: number = 10000) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.maxEntries = maxEntries;
    // Clean up old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  isAllowed(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get existing requests for this IP
    let timestamps = this.requests.get(ip) || [];

    // Filter to only requests within the window
    timestamps = timestamps.filter(t => t > windowStart);

    const remaining = Math.max(0, this.maxRequests - timestamps.length);
    const resetIn = timestamps.length > 0 ? Math.ceil((timestamps[0] + this.windowMs - now) / 1000) : 0;

    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetIn };
    }

    // Add this request
    timestamps.push(now);

    // Delete and re-add to maintain LRU order (most recent at end)
    this.requests.delete(ip);
    this.requests.set(ip, timestamps);

    // Evict oldest entries if we exceed max
    this.evictIfNeeded();

    return { allowed: true, remaining: remaining - 1, resetIn: Math.ceil(this.windowMs / 1000) };
  }

  private evictIfNeeded(): void {
    // Evict oldest entries (first in Map iteration order) if over limit
    while (this.requests.size > this.maxEntries) {
      const oldestKey = this.requests.keys().next().value;
      if (oldestKey) {
        this.requests.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const toDelete: string[] = [];

    // First pass: identify entries to delete or update
    for (const [ip, timestamps] of this.requests.entries()) {
      const valid = timestamps.filter(t => t > windowStart);
      if (valid.length === 0) {
        toDelete.push(ip);
      } else {
        this.requests.set(ip, valid);
      }
    }

    // Second pass: delete empty entries
    for (const ip of toDelete) {
      this.requests.delete(ip);
    }
  }
}

// Global rate limiter: 60 requests per minute per IP
const rateLimiter = new RateLimiter(60000, 60);

// Stricter rate limiter for expensive endpoints: 10 requests per minute
const expensiveRateLimiter = new RateLimiter(60000, 10);

/**
 * Simple in-memory cache with TTL and LRU eviction
 */
class ResponseCache {
  private cache: Map<string, { data: any; expires: number }> = new Map();
  private readonly maxEntries: number;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
    // Clean up expired entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }

    // Move to end for LRU (delete and re-add)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data as T;
  }

  set(key: string, data: any, ttlMs: number): void {
    // Delete first to update LRU order
    this.cache.delete(key);
    this.cache.set(key, { data, expires: Date.now() + ttlMs });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(key);
      }
    }
  }

  // For debugging/monitoring
  get size(): number {
    return this.cache.size;
  }
}

// Global response cache
const responseCache = new ResponseCache(1000);

// Cache TTLs
const CACHE_TTL = {
  RELAY_LIST: 30000,    // 30 seconds
  RELAY_DETAIL: 30000,  // 30 seconds
  RELAY_SCORE: 30000,   // 30 seconds
  STATS: 60000,         // 60 seconds
  COUNTRIES: 60000,     // 60 seconds
};

/**
 * Get client IP from request (Cloudflare Workers)
 */
function getClientIp(req: Request): string {
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) {
    return cfIp;
  }
  // Fallback for local development
  return 'unknown';
}

/**
 * Serve API documentation
 */
function serveApiDocs(): Response {
  const docs = {
    name: 'Trusted Relays API',
    version: 'v1.0',
    description: 'API for querying Nostr relay trust scores',
    baseUrl: '/',
    rateLimit: {
      requests: 60,
      window: '1 minute',
      headers: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']
    },
    endpoints: [
      {
        path: '/api/score',
        method: 'GET',
        description: 'Get trust score for a relay (lightweight)',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Relay WebSocket URL (e.g., wss://relay.damus.io)' }
        ],
        example: '/api/score?url=wss://relay.damus.io',
        response: {
          score: 85,
          reliability: 90,
          quality: 82,
          accessibility: 78,
          confidence: 'high',
          status: 'evaluated'
        }
      },
      {
        path: '/api/relay',
        method: 'GET',
        description: 'Get detailed information for a relay',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Relay WebSocket URL' }
        ],
        example: '/api/relay?url=wss://relay.damus.io'
      },
      {
        path: '/api/relays',
        method: 'GET',
        description: 'List all relays with scores',
        parameters: [],
        example: '/api/relays'
      },
      {
        path: '/api/assertion',
        method: 'GET',
        description: 'Get kind 30385 Nostr event for a relay',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Relay WebSocket URL' }
        ],
        example: '/api/assertion?url=wss://relay.damus.io'
      },
      {
        path: '/api/history',
        method: 'GET',
        description: 'Get score history for a relay',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Relay WebSocket URL' },
          { name: 'days', type: 'number', required: false, description: 'Number of days (default: 30)' }
        ],
        example: '/api/history?url=wss://relay.damus.io&days=7'
      },
      {
        path: '/api/countries',
        method: 'GET',
        description: 'Get relay count by country',
        parameters: [],
        example: '/api/countries'
      },
      {
        path: '/api/stats',
        method: 'GET',
        description: 'Get database statistics',
        parameters: [],
        example: '/api/stats'
      },
      {
        path: '/api/track',
        method: 'GET',
        description: 'Add a relay to the tracking list (on-demand tracking)',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Relay WebSocket URL to track' }
        ],
        example: '/api/track?url=wss://relay.example.com',
        response: {
          message: 'Relay added to tracking list',
          url: 'wss://relay.example.com',
          note: 'Relay will be probed in the next cycle. If unreachable for 14+ days, it will be automatically removed.'
        }
      },
      {
        path: '/api/untrack',
        method: 'GET',
        description: 'Remove a relay from the tracking list',
        parameters: [
          { name: 'url', type: 'string', required: true, description: 'Relay WebSocket URL to stop tracking' }
        ],
        example: '/api/untrack?url=wss://relay.example.com'
      },
      {
        path: '/api/health',
        method: 'GET',
        description: 'Health check endpoint',
        parameters: [],
        example: '/api/health'
      }
    ]
  };

  return new Response(JSON.stringify(docs, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Start the API server
 */
export function startApiServer(config: ApiConfig): { stop: () => void } {
  const { port, host, db } = config;

  const server = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 30, // Seconds before idle connection times out

    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Handle CORS preflight - open CORS is intentional for this public read-only API
      // Only GET requests are allowed, no credentials, no sensitive data
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      // Rate limiting for API endpoints (skip for dashboard and health)
      if (path.startsWith('/api') && path !== '/api/health') {
        const clientIp = getClientIp(req);
        const rateCheck = rateLimiter.isAllowed(clientIp);

        if (!rateCheck.allowed) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Rate limit exceeded. Try again later.',
            meta: { resetIn: rateCheck.resetIn }
          }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'X-RateLimit-Limit': '60',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': rateCheck.resetIn.toString(),
              'Retry-After': rateCheck.resetIn.toString(),
            },
          });
        }

        // Add rate limit headers to successful responses
        const addRateLimitHeaders = (response: Response): Response => {
          const headers = new Headers(response.headers);
          headers.set('X-RateLimit-Limit', '60');
          headers.set('X-RateLimit-Remaining', rateCheck.remaining.toString());
          headers.set('X-RateLimit-Reset', rateCheck.resetIn.toString());
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        };

        // API documentation
        if (path === '/api') {
          return addRateLimitHeaders(serveApiDocs());
        }

        // Lightweight score endpoint
        if (path === '/api/score') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          try {
            // Check cache first
            const cacheKey = `score:${validation.url}`;
            let score = responseCache.get<object>(cacheKey);
            if (!score) {
              score = await getRelayScore(db, validation.url);
              if (score) {
                responseCache.set(cacheKey, score, CACHE_TTL.RELAY_SCORE);
              }
            }
            if (!score) {
              return addRateLimitHeaders(errorResponse('Relay not found', 404));
            }
            return addRateLimitHeaders(jsonResponse(score));
          } catch (err) {
            console.error('Failed to get score:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Health check (also accessible without rate limit above)
        if (path === '/api/health') {
          return addRateLimitHeaders(jsonResponse({ status: 'ok', timestamp: Date.now() }));
        }

        // List all relays with scores (expensive endpoint - stricter rate limit)
        if (path === '/api/relays') {
          const clientIp = getClientIp(req);
          const expensiveRateCheck = expensiveRateLimiter.isAllowed(clientIp);
          if (!expensiveRateCheck.allowed) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Rate limit exceeded for this endpoint. Try again later.',
              meta: { resetIn: expensiveRateCheck.resetIn }
            }), {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-RateLimit-Limit': '10',
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': expensiveRateCheck.resetIn.toString(),
                'Retry-After': expensiveRateCheck.resetIn.toString(),
              },
            });
          }

          try {
            // Check cache first
            const cacheKey = 'relays';
            let relays = responseCache.get<any[]>(cacheKey);
            if (!relays) {
              relays = await getRelayList(db);
              responseCache.set(cacheKey, relays, CACHE_TTL.RELAY_LIST);
            }
            return addRateLimitHeaders(jsonResponse(relays));
          } catch (err) {
            console.error('Failed to get relays:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get single relay details
        if (path === '/api/relay') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          try {
            // Check cache first
            const cacheKey = `relay:${validation.url}`;
            let relay = responseCache.get<object>(cacheKey);
            if (!relay) {
              relay = await getRelayDetails(db, validation.url);
              if (relay) {
                responseCache.set(cacheKey, relay, CACHE_TTL.RELAY_DETAIL);
              }
            }
            if (!relay) {
              return addRateLimitHeaders(errorResponse('Relay not found', 404));
            }
            return addRateLimitHeaders(jsonResponse(relay));
          } catch (err) {
            console.error('Failed to get relay:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get relay assertion (kind 30385 event)
        if (path === '/api/assertion') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          try {
            const event = await getRelayAssertion(db, validation.url);
            if (!event) {
              return addRateLimitHeaders(errorResponse('No assertion available', 404));
            }
            return addRateLimitHeaders(jsonResponse(event));
          } catch (err) {
            console.error('Failed to get assertion:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get countries summary
        if (path === '/api/countries') {
          try {
            // Check cache first
            const cacheKey = 'countries';
            let countries = responseCache.get<any[]>(cacheKey);
            if (!countries) {
              countries = await db.getJurisdictionStats();
              responseCache.set(cacheKey, countries, CACHE_TTL.COUNTRIES);
            }
            return addRateLimitHeaders(jsonResponse(countries));
          } catch (err) {
            console.error('Failed to get countries:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get score history for a relay
        if (path === '/api/history') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          // Validate days parameter with bounds (1-365)
          const daysParam = url.searchParams.get('days');
          let days = 30;
          if (daysParam) {
            const parsed = parseInt(daysParam, 10);
            if (isNaN(parsed) || parsed < 1 || parsed > 365) {
              return addRateLimitHeaders(errorResponse('Invalid days parameter - must be between 1 and 365'));
            }
            days = parsed;
          }

          try {
            const history = await db.getScoreHistory(validation.url, days);
            const trend = await db.getScoreTrend(validation.url, days);
            return addRateLimitHeaders(jsonResponse({ history, trend }));
          } catch (err) {
            console.error('Failed to get history:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get database stats
        if (path === '/api/stats') {
          try {
            // Check cache first
            const cacheKey = 'stats';
            let stats = responseCache.get<object>(cacheKey);
            if (!stats) {
              const relayUrls = await db.getRelayUrls();
              const monitors = await db.getTrustedMonitors();
              const requestedRelays = await db.getRequestedRelays();
              stats = {
                relayCount: relayUrls.length,
                monitorCount: monitors.length,
                requestedRelayCount: requestedRelays.length,
              };
              responseCache.set(cacheKey, stats, CACHE_TTL.STATS);
            }
            return addRateLimitHeaders(jsonResponse(stats));
          } catch (err) {
            console.error('Failed to get stats:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Track a relay (on-demand tracking)
        if (path === '/api/track') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          try {
            await db.addRequestedRelay(validation.url, getClientIp(req));
            return addRateLimitHeaders(jsonResponse({
              message: 'Relay added to tracking list',
              url: validation.url,
              note: 'Relay will be probed in the next cycle. If unreachable for 14+ days, it will be automatically removed.',
            }));
          } catch (err) {
            console.error('Failed to track relay:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Untrack a relay
        if (path === '/api/untrack') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          try {
            await db.removeRequestedRelay(validation.url);
            return addRateLimitHeaders(jsonResponse({
              message: 'Relay removed from tracking list',
              url: validation.url,
            }));
          } catch (err) {
            console.error('Failed to untrack relay:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get relay rankings (leaderboard)
        if (path === '/api/rankings') {
          const clientIp = getClientIp(req);
          const expensiveRateCheck = expensiveRateLimiter.isAllowed(clientIp);
          if (!expensiveRateCheck.allowed) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Rate limit exceeded for this endpoint. Try again later.',
              meta: { resetIn: expensiveRateCheck.resetIn }
            }), {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-RateLimit-Limit': '10',
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': expensiveRateCheck.resetIn.toString(),
                'Retry-After': expensiveRateCheck.resetIn.toString(),
              },
            });
          }

          try {
            // Check cache first
            const cacheKey = 'rankings';
            let rankings = responseCache.get<object>(cacheKey);
            if (!rankings) {
              rankings = await getRelayRankings(db);
              responseCache.set(cacheKey, rankings, CACHE_TTL.RELAY_LIST);
            }
            return addRateLimitHeaders(jsonResponse(rankings));
          } catch (err) {
            console.error('Failed to get rankings:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        // Get detailed analytics for a relay
        if (path === '/api/analytics') {
          const validation = validateRelayUrl(url.searchParams.get('url'));
          if (!validation.valid) {
            return addRateLimitHeaders(errorResponse(validation.error));
          }

          try {
            const analytics = await getRelayAnalytics(db, validation.url);
            if (!analytics) {
              return addRateLimitHeaders(errorResponse('Relay not found', 404));
            }
            return addRateLimitHeaders(jsonResponse(analytics));
          } catch (err) {
            console.error('Failed to get analytics:', err);
            return addRateLimitHeaders(errorResponse(sanitizeError(err), 500));
          }
        }

        return addRateLimitHeaders(errorResponse('Not found', 404));
      }

      // Dashboard
      if (path === '/' || path === '/dashboard') {
        return serveDashboard();
      }

      // Static assets
      if (path === '/og-image.svg') {
        return serveStaticFile('og-image.svg', 'image/svg+xml');
      }
      if (path === '/favicon.svg') {
        return serveStaticFile('favicon.svg', 'image/svg+xml');
      }
      if (path === '/styles.css') {
        return serveStaticFile('styles.css', 'text/css');
      }

      // Health check (no rate limit)
      if (path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }

      return errorResponse('Not found', 404);
    },
  });

  console.log(`API server running at http://${host}:${port}`);
  console.log(`Dashboard: http://${host}:${port}/dashboard`);

  // Pre-warm the relay list cache after server is ready
  setTimeout(async () => {
    try {
      const relays = await getRelayList(db);
      responseCache.set('relays', relays, CACHE_TTL.RELAY_LIST);
      console.log(`Cache pre-warmed with ${relays.length} relays`);
    } catch (err) {
      console.error('Failed to pre-warm cache:', err);
    }
  }, 2000);

  return {
    stop: () => server.stop(),
  };
}

/**
 * Get lightweight score for a single relay
 */
async function getRelayScore(db: DataStore, url: string): Promise<{
  url: string;
  score: number;
  reliability: number;
  quality: number;
  accessibility: number;
  confidence: 'low' | 'medium' | 'high';
  status: 'evaluated' | 'insufficient_data' | 'unreachable';
} | null> {
  const probes = await db.getProbes(url, 30);
  if (probes.length === 0) return null;

  const latestProbe = probes[probes.length - 1];
  const nip66Stats = await db.getNip66Stats(url, 365);
  const jurisdiction = await db.getJurisdiction(url);
  const operatorResolution = await db.getOperatorResolution(url);

  const reliabilityScore = computeCombinedReliabilityScore(probes, nip66Stats);
  const qualityScore = computeQualityScore(latestProbe.nip11, url, operatorResolution);
  const accessibilityScore = computeAccessibilityScore(latestProbe.nip11, jurisdiction?.countryCode);

  // Calculate weighted observations for confidence
  const nip66MetricCount = nip66Stats?.metricCount ?? 0;
  const monitorCount = nip66Stats?.monitorCount ?? 0;
  const observationPeriodDays = reliabilityScore.observationPeriodDays ?? 0;
  const weightedObs = calculateWeightedObservations(
    probes.length,
    nip66MetricCount,
    monitorCount,
    observationPeriodDays
  );

  // Determine status
  let status: 'evaluated' | 'insufficient_data' | 'unreachable' = 'evaluated';
  if (!reliabilityScore.reachable) {
    status = 'unreachable';
  } else if (weightedObs < 10) {
    status = 'insufficient_data';
  }

  const confidence = getConfidenceLevel(weightedObs);

  // Calculate historical uptime for offline penalty
  const reachableProbesList = probes.filter(p => p.reachable);
  const uptimePercent = probes.length > 0 ? Math.round((reachableProbesList.length / probes.length) * 100) : 0;

  // Find last online timestamp for offline decay
  const lastOnlineProbe = reachableProbesList.length > 0
    ? reachableProbesList.reduce((latest, p) => p.timestamp > latest.timestamp ? p : latest)
    : undefined;

  // Compute overall score with offline decay if needed
  const reliabilityVal = latestProbe.reachable
    ? reliabilityScore.overall
    : calculateOfflineReliability(uptimePercent, lastOnlineProbe?.timestamp);
  const overallScore = Math.round(
    reliabilityVal * 0.40 +
    qualityScore.overall * 0.35 +
    accessibilityScore.overall * 0.25
  );

  return {
    url,
    score: overallScore,
    reliability: reliabilityVal,
    quality: qualityScore.overall,
    accessibility: accessibilityScore.overall,
    confidence,
    status,
  };
}

/**
 * Get list of all relays with basic info
 * Uses bulk queries for performance (7 parallel queries instead of 5 per relay)
 */
async function getRelayList(db: DataStore): Promise<Array<{
  url: string;
  name: string | null;
  score: number | null;
  reliability: number | null;
  quality: number | null;
  accessibility: number | null;
  status: string;
  isOnline: boolean;
  accessLevel: string;
  policy: string | null;
  countryCode: string | null;
  region: string | null;
  observations: number;
  confidence: 'low' | 'medium' | 'high';
  trend: 'up' | 'down' | 'stable' | null;
  trendChange: number | null;
  trendPeriod: number | null;
  isSecure: boolean;
  lastSeen: number | null;
  supportedNips: number[];
}>> {
  // Fetch all data in parallel using bulk queries
  const [
    allProbes,
    nip66Stats,
    jurisdictions,
    operatorResolutions,
    scoreTrends,
  ] = await Promise.all([
    db.getAllProbes(30),
    db.getAllNip66Stats(365),
    db.getAllJurisdictions(),
    db.getAllOperatorResolutions(),
    db.getAllScoreTrends(7),
  ]);

  const results = [];

  // Iterate over all relays with probes
  for (const [url, probes] of allProbes) {
    if (probes.length === 0) continue;

    const latestProbe = probes[probes.length - 1];
    const nip66 = nip66Stats.get(url);
    const jurisdiction = jurisdictions.get(url);
    const operatorResolution = operatorResolutions.get(url);
    const trendData = scoreTrends.get(url);

    // Compute scores using the SAME algorithm as detail view
    const reliabilityScore = computeCombinedReliabilityScore(probes, nip66 ?? null);
    const qualityScore = computeQualityScore(latestProbe.nip11, url, operatorResolution);
    const accessibilityScore = computeAccessibilityScore(latestProbe.nip11, jurisdiction?.countryCode);

    // Calculate uptime for offline penalty
    const reachableProbesList = probes.filter(p => p.reachable);
    const uptimePercent = probes.length > 0 ? Math.round((reachableProbesList.length / probes.length) * 100) : 0;

    // Find last online timestamp for offline decay
    const lastOnlineProbe = reachableProbesList.length > 0
      ? reachableProbesList.reduce((latest, p) => p.timestamp > latest.timestamp ? p : latest)
      : undefined;

    // Use same logic as detail view for reliability value with offline decay
    const reliabilityVal = latestProbe.reachable
      ? reliabilityScore.overall
      : calculateOfflineReliability(uptimePercent, lastOnlineProbe?.timestamp);
    const qualityVal = qualityScore.overall;
    const accessibilityVal = accessibilityScore.overall;

    // Get policy - pass empty array for reports since we only have stats
    const policy = classifyPolicy(latestProbe.nip11, latestProbe.relayType, []);

    // Calculate weighted observations for confidence
    const nip66MetricCount = nip66?.metricCount ?? 0;
    const monitorCount = nip66?.monitorCount ?? 0;
    const observationPeriodDays = reliabilityScore.observationPeriodDays ?? 0;
    const weightedObs = calculateWeightedObservations(
      probes.length,
      nip66MetricCount,
      monitorCount,
      observationPeriodDays
    );

    // Determine status
    let status = 'evaluated';
    if (!latestProbe.reachable) {
      status = 'unreachable';
    } else if (weightedObs < 10) {
      status = 'insufficient_data';
    }

    // Determine confidence level
    const confidence = getConfidenceLevel(weightedObs);

    // Get trend
    let trend: 'up' | 'down' | 'stable' | null = null;
    if (trendData && typeof trendData.change === 'number') {
      if (trendData.change > 3) trend = 'up';
      else if (trendData.change < -3) trend = 'down';
      else trend = 'stable';
    }

    // Check if secure (wss://)
    const isSecure = url.toLowerCase().startsWith('wss://');

    // Get relay name from NIP-11
    const name = latestProbe.nip11?.name || null;

    // Compute overall score using the same formula as detail view
    const overallScore = Math.round(
      reliabilityVal * 0.40 +
      qualityVal * 0.35 +
      accessibilityVal * 0.25
    );

    results.push({
      url,
      name,
      score: overallScore,
      reliability: reliabilityVal,
      quality: qualityVal,
      accessibility: accessibilityVal,
      status,
      isOnline: latestProbe.reachable,
      accessLevel: latestProbe.accessLevel ?? 'unknown',
      policy: policy.policy,
      countryCode: jurisdiction?.countryCode ?? null,
      region: jurisdiction?.region ?? null,
      observations: weightedObs,
      confidence,
      trend,
      trendChange: trendData?.change ?? null,
      trendPeriod: trendData?.periodDays ?? null,
      isSecure,
      lastSeen: latestProbe.timestamp ?? null,
      supportedNips: normalizeNipArray(latestProbe.nip11?.supported_nips),
    });
  }

  // Sort by score descending
  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  return results;
}

/**
 * Get detailed info for a single relay
 * Uses parallel queries for performance
 */
async function getRelayDetails(db: DataStore, url: string): Promise<object | null> {
  // Fetch all data in parallel
  const [probes, nip66Stats, reports, jurisdiction, history, trend, operatorResolutionCached] = await Promise.all([
    db.getProbes(url, 30),
    db.getNip66Stats(url, 365),
    db.getReports(url, 90),
    db.getJurisdiction(url),
    db.getScoreHistory(url, 30),
    db.getScoreTrend(url, 30),
    db.getOperatorResolution(url),
  ]);

  if (probes.length === 0) return null;

  const latestProbe = probes[probes.length - 1];

  // Get operator resolution from cache, or resolve on-demand if not cached
  // WoT scores are refreshed daily by the service, so we just use cached data
  let operatorResolution: OperatorResolution | null = operatorResolutionCached;
  if (!operatorResolution && latestProbe.nip11?.pubkey) {
    // Resolve operator on-demand with WoT lookup and cache it
    try {
      operatorResolution = await resolveOperator(url, latestProbe.nip11, {
        fetchTrustScore: true,
        nip85Timeout: 10000,
      });
      if (operatorResolution.operatorPubkey) {
        await db.storeOperatorResolution(operatorResolution);
      }
    } catch {
      // Resolution failed, continue with null
    }
  }
  // Note: WoT scores for cached operators are refreshed daily by the service

  const score = computeCombinedReliabilityScore(probes, nip66Stats);
  const qualityScore = computeQualityScore(latestProbe.nip11, url, operatorResolution);
  const accessibilityScore = computeAccessibilityScore(latestProbe.nip11, jurisdiction?.countryCode);
  const policy = classifyPolicy(latestProbe.nip11, latestProbe.relayType, reports);

  // Calculate uptime from probe history
  const reachableProbesList = probes.filter(p => p.reachable);
  const uptimePercent = probes.length > 0 ? Math.round((reachableProbesList.length / probes.length) * 100) : 0;

  // Find last online timestamp for offline decay
  const lastOnlineProbe = reachableProbesList.length > 0
    ? reachableProbesList.reduce((latest, p) => p.timestamp > latest.timestamp ? p : latest)
    : undefined;

  // Compute overall score as weighted average: Reliability 40%, Quality 35%, Accessibility 25%
  // If currently offline: use decayed score based on how long offline
  const reliabilityVal = latestProbe.reachable
    ? score.overall
    : calculateOfflineReliability(uptimePercent, lastOnlineProbe?.timestamp);
  const overallScore = Math.round(
    reliabilityVal * 0.40 +
    qualityScore.overall * 0.35 +
    accessibilityScore.overall * 0.25
  );

  return {
    url,
    relayType: latestProbe.relayType,
    reachable: latestProbe.reachable,
    accessLevel: latestProbe.accessLevel ?? 'unknown',
    closedReason: latestProbe.closedReason ?? null,
    nip11: latestProbe.nip11,
    scores: {
      overall: overallScore,
      reliability: reliabilityVal,
      quality: qualityScore.overall,
      accessibility: accessibilityScore.overall,
      components: {
        // Reliability components (40% uptime, 20% recovery, 20% consistency, 20% latency)
        uptimeScore: score.uptimeScore,
        recoveryScore: score.recoveryScore,
        consistencyScore: score.consistencyScore,
        latencyScore: score.latencyScore,
        // Quality components
        policyScore: qualityScore.policyScore,
        securityScore: qualityScore.securityScore,
        operatorScore: qualityScore.operatorScore,
        // Accessibility components
        barrierScore: accessibilityScore.barrierScore,
        limitScore: accessibilityScore.limitScore,
        jurisdictionScore: accessibilityScore.jurisdictionScore,
        surveillanceScore: accessibilityScore.surveillanceScore,
      },
      latency: {
        connectMs: latestProbe.connectTime ?? null,
        readMs: latestProbe.readTime ?? null,
      },
      uptimePercent,
    },
    policy: {
      classification: policy.policy,
      confidence: policy.confidence,
      reasons: policy.reasons,
      indicators: policy.indicators,
    },
    operator: operatorResolution ? {
      pubkey: operatorResolution.operatorPubkey,
      verificationMethod: operatorResolution.verificationMethod,
      confidence: operatorResolution.confidence,
      trustScore: operatorResolution.trustScore,
      trustConfidence: operatorResolution.trustConfidence,
      trustProviderCount: operatorResolution.trustProviderCount,
    } : null,
    jurisdiction: jurisdiction ? {
      countryCode: jurisdiction.countryCode,
      countryName: jurisdiction.countryName,
      region: jurisdiction.region,
      city: jurisdiction.city,
      isp: jurisdiction.isp,
      isHosting: jurisdiction.isHosting,
      eyesAlliance: getEyesAlliance(jurisdiction.countryCode),
    } : null,
    observations: {
      probeCount: probes.length,
      nip66MetricCount: nip66Stats?.metricCount ?? 0,
      reportCount: reports.length,
      firstSeen: probes[0]?.timestamp,
      lastSeen: latestProbe.timestamp,
    },
    history: history.slice(-10),
    trend,
  };
}

/**
 * Get assertion event for a relay
 * Uses parallel queries for performance
 */
async function getRelayAssertion(db: DataStore, url: string): Promise<UnsignedEvent | null> {
  // Fetch all data in parallel
  const [probes, nip66Stats, reports, jurisdiction, operatorResolutionCached] = await Promise.all([
    db.getProbes(url, 30),
    db.getNip66Stats(url, 365),
    db.getReports(url, 90),
    db.getJurisdiction(url),
    db.getOperatorResolution(url),
  ]);

  if (probes.length === 0) return null;

  const latestProbe = probes[probes.length - 1];

  // Get operator resolution from cache, or resolve on-demand if not cached
  let operatorResolution: OperatorResolution | null = operatorResolutionCached;
  if (!operatorResolution && latestProbe.nip11?.pubkey) {
    try {
      operatorResolution = await resolveOperator(url, latestProbe.nip11);
      if (operatorResolution.operatorPubkey) {
        await db.storeOperatorResolution(operatorResolution);
      }
    } catch {
      // Resolution failed, continue with null
    }
  }

  const score = computeCombinedReliabilityScore(probes, nip66Stats);
  const qualityScore = computeQualityScore(latestProbe.nip11, url, operatorResolution);
  const accessibilityScore = computeAccessibilityScore(latestProbe.nip11, jurisdiction?.countryCode);

  const assertion: RelayAssertion = buildAssertion(
    url,
    probes,
    score,
    operatorResolution ?? undefined,
    qualityScore,
    accessibilityScore,
    { reports, jurisdiction: jurisdiction ?? undefined }
  );

  return assertionToEvent(assertion);
}

/**
 * Get relay rankings (leaderboard)
 * Computes rankings for all relays with efficient bulk queries
 */
async function getRelayRankings(db: DataStore): Promise<{
  rankings: Array<{
    rank: number;
    url: string;
    name: string | null;
    score: number;
    reliability: number;
    quality: number;
    accessibility: number;
    percentile: number;
    reliabilityRank: number;
    qualityRank: number;
    accessibilityRank: number;
    trend: 'improving' | 'stable' | 'degrading' | null;
    rankChange: number | null;
  }>;
  totalRelays: number;
  generatedAt: number;
}> {
  // Fetch all necessary data in parallel
  const [relayScores, previousRankings, trendData, latestProbes] = await Promise.all([
    db.getAllRelayScoresForRanking(),
    db.getPreviousRankings(7),
    db.getAllTrendData(30),
    db.getAllLatestProbes(),
  ]);

  // Build relay score data for ranking calculation
  const scoreData: RelayScoreData[] = relayScores.map((r) => ({
    url: r.url,
    score: r.score,
    reliability: r.reliability,
    quality: r.quality,
    accessibility: r.accessibility,
  }));

  // Compute rankings
  const rankingsMap = computeAllRankings(scoreData, previousRankings);

  // Build response
  const rankings = relayScores
    .filter((r) => r.score !== null)
    .map((r) => {
      const ranking = rankingsMap.get(r.url);
      const trend = trendData.get(r.url);
      const probe = latestProbes.get(r.url);

      // Determine trend direction
      let trendDirection: 'improving' | 'stable' | 'degrading' | null = null;
      if (trend && trend.dataPoints >= 2) {
        const change = (trend.lastScore ?? 0) - (trend.firstScore ?? 0);
        if (change > 3) trendDirection = 'improving';
        else if (change < -3) trendDirection = 'degrading';
        else trendDirection = 'stable';
      }

      return {
        rank: ranking?.rank ?? 0,
        url: r.url,
        name: probe?.nip11?.name ?? null,
        score: r.score!,
        reliability: r.reliability ?? 0,
        quality: r.quality ?? 0,
        accessibility: r.accessibility ?? 0,
        percentile: ranking?.percentile ?? 0,
        reliabilityRank: ranking?.reliabilityRank ?? 0,
        qualityRank: ranking?.qualityRank ?? 0,
        accessibilityRank: ranking?.accessibilityRank ?? 0,
        trend: trendDirection,
        rankChange: ranking?.rankChange ?? null,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  return {
    rankings,
    totalRelays: rankings.length,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get detailed analytics for a single relay
 * Includes confidence intervals, trend analysis, and ranking
 */
async function getRelayAnalytics(db: DataStore, url: string): Promise<{
  url: string;
  score: {
    value: number;
    confidence: ConfidenceInterval;
  };
  reliability: {
    value: number;
    confidence: ConfidenceInterval;
  };
  uptime: {
    value: number;
    confidence: ConfidenceInterval;
  };
  trend: TrendAnalysis;
  anomaly: AnomalyResult;
  ranking: RelayRanking | null;
  history: {
    scores: Array<{ timestamp: number; score: number | null }>;
    rolling7d: number | null;
    rolling30d: number | null;
    rolling90d: number | null;
  };
} | null> {
  // Fetch all data in parallel
  const [
    scoreHistory,
    uptimeStats,
    relayScores,
    previousRankings,
    rollingAverages,
  ] = await Promise.all([
    db.getFullScoreHistory(url, 90),
    db.getUptimeStats(url, 30),
    db.getAllRelayScoresForRanking(),
    db.getPreviousRankings(7),
    db.getAllRollingAverages(),
  ]);

  if (scoreHistory.length === 0) return null;

  // Get the latest score
  const latestScore = scoreHistory[scoreHistory.length - 1];

  // Convert to ScoreSnapshot format for analytics functions
  const snapshots: ScoreSnapshot[] = scoreHistory.map((h) => ({
    relayUrl: url,
    timestamp: h.timestamp,
    score: h.score,
    reliability: h.reliability,
    quality: h.quality,
    accessibility: h.accessibility,
    observations: h.observations,
    confidence: h.confidence as 'low' | 'medium' | 'high',
  }));

  // Compute confidence intervals
  const scoreConfidence = computeScoreConfidenceInterval(
    latestScore.score ?? 0,
    latestScore.observations
  );

  const reliabilityConfidence = computeScoreConfidenceInterval(
    latestScore.reliability ?? 0,
    latestScore.observations
  );

  const uptimeConfidence = computeUptimeConfidenceInterval(
    uptimeStats.reachableProbes,
    uptimeStats.totalProbes
  );

  // Compute trend analysis
  const trend = computeTrendAnalysis(snapshots, 30);

  // Detect anomalies
  const anomaly = detectAnomaly(snapshots, 30);

  // Compute ranking
  const scoreData: RelayScoreData[] = relayScores.map((r) => ({
    url: r.url,
    score: r.score,
    reliability: r.reliability,
    quality: r.quality,
    accessibility: r.accessibility,
  }));
  const rankingsMap = computeAllRankings(scoreData, previousRankings);
  const ranking = rankingsMap.get(url) ?? null;

  // Get rolling averages
  const rolling = rollingAverages.get(url);

  return {
    url,
    score: {
      value: latestScore.score ?? 0,
      confidence: scoreConfidence,
    },
    reliability: {
      value: latestScore.reliability ?? 0,
      confidence: reliabilityConfidence,
    },
    uptime: {
      value: uptimeStats.uptimePercent,
      confidence: uptimeConfidence,
    },
    trend,
    anomaly,
    ranking,
    history: {
      scores: scoreHistory.map((h) => ({
        timestamp: h.timestamp,
        score: h.score,
      })),
      rolling7d: rolling?.rolling7d ?? null,
      rolling30d: rolling?.rolling30d ?? null,
      rolling90d: rolling?.rolling90d ?? null,
    },
  };
}
