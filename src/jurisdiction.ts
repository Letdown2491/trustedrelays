import { promises as dns } from 'dns';
import { normalizeRelayUrl } from './prober.js';

/**
 * Simple rate limiter for ip-api.com (45 requests per minute)
 */
class RateLimiter {
  private requestTimes: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 45, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Wait if necessary to respect rate limit, then record this request
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    // Remove requests outside the window
    this.requestTimes = this.requestTimes.filter(t => now - t < this.windowMs);

    if (this.requestTimes.length >= this.maxRequests) {
      // Wait until the oldest request expires from the window
      const oldestRequest = this.requestTimes[0];
      const waitTime = this.windowMs - (now - oldestRequest) + 100; // +100ms buffer
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      // Clean up again after waiting
      const nowAfterWait = Date.now();
      this.requestTimes = this.requestTimes.filter(t => nowAfterWait - t < this.windowMs);
    }

    this.requestTimes.push(Date.now());
  }
}

// Singleton rate limiter for ip-api.com
const ipApiRateLimiter = new RateLimiter(45, 60000);

/**
 * Jurisdiction information for a relay
 */
export interface JurisdictionInfo {
  relayUrl: string;
  ip?: string;
  countryCode?: string;  // ISO 3166-1 alpha-2 (e.g., "US", "DE")
  countryName?: string;
  region?: string;       // State/province
  city?: string;
  isp?: string;
  asn?: string;          // Autonomous System Number
  asOrg?: string;        // AS Organization name
  isHosting?: boolean;   // Likely a hosting provider
  isTor?: boolean;       // Tor exit node
  resolvedAt: number;
  error?: string;
}

/**
 * Extract hostname from relay URL
 */
function extractHostname(relayUrl: string): string {
  const url = new URL(normalizeRelayUrl(relayUrl));
  return url.hostname;
}

/**
 * Check if relay is on a privacy network
 */
function isPrivacyNetwork(hostname: string): { isTor: boolean; isI2P: boolean } {
  const lower = hostname.toLowerCase();
  return {
    isTor: lower.endsWith('.onion'),
    isI2P: lower.endsWith('.i2p'),
  };
}

/**
 * Resolve hostname to IP address
 */
async function resolveHostname(hostname: string): Promise<string | null> {
  try {
    const addresses = await dns.resolve4(hostname);
    return addresses[0] || null;
  } catch (err: any) {
    // Try IPv6 if IPv4 fails
    try {
      const addresses = await dns.resolve6(hostname);
      return addresses[0] || null;
    } catch {
      return null;
    }
  }
}

/**
 * Query IP geolocation using ip-api.com (free, no API key required)
 * Rate limit: 45 requests per minute (enforced by rate limiter)
 */
async function queryGeoIP(ip: string): Promise<{
  countryCode?: string;
  countryName?: string;
  region?: string;
  city?: string;
  isp?: string;
  asn?: string;
  asOrg?: string;
  isHosting?: boolean;
} | null> {
  try {
    // Respect rate limit before making request
    await ipApiRateLimiter.acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    // Use ip-api.com with specific fields
    const fields = 'status,countryCode,country,regionName,city,isp,as,org,hosting';
    const response = await fetch(
      `http://ip-api.com/json/${ip}?fields=${fields}`,
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (data.status !== 'success') {
      return null;
    }

    // Parse AS number from "AS12345 Organization Name" format
    let asn: string | undefined;
    let asOrg: string | undefined;
    if (data.as) {
      const asMatch = data.as.match(/^(AS\d+)\s*(.*)$/);
      if (asMatch) {
        asn = asMatch[1];
        asOrg = asMatch[2] || data.org;
      }
    }

    return {
      countryCode: data.countryCode,
      countryName: data.country,
      region: data.regionName,
      city: data.city,
      isp: data.isp,
      asn,
      asOrg: asOrg || data.org,
      isHosting: data.hosting,
    };
  } catch (err: any) {
    return null;
  }
}

/**
 * Resolve jurisdiction for a relay
 */
export async function resolveJurisdiction(relayUrl: string): Promise<JurisdictionInfo> {
  const now = Math.floor(Date.now() / 1000);
  const hostname = extractHostname(relayUrl);

  const result: JurisdictionInfo = {
    relayUrl: normalizeRelayUrl(relayUrl),
    resolvedAt: now,
  };

  // Check for privacy networks
  const privacyCheck = isPrivacyNetwork(hostname);
  if (privacyCheck.isTor) {
    result.isTor = true;
    result.countryCode = 'XX'; // Unknown/Anonymous
    result.countryName = 'Tor Network';
    return result;
  }
  if (privacyCheck.isI2P) {
    result.countryCode = 'XX';
    result.countryName = 'I2P Network';
    return result;
  }

  // Resolve hostname to IP
  const ip = await resolveHostname(hostname);
  if (!ip) {
    result.error = 'Failed to resolve hostname';
    return result;
  }
  result.ip = ip;

  // Query geolocation
  const geoData = await queryGeoIP(ip);
  if (!geoData) {
    result.error = 'Failed to query geolocation';
    return result;
  }

  result.countryCode = geoData.countryCode;
  result.countryName = geoData.countryName;
  result.region = geoData.region;
  result.city = geoData.city;
  result.isp = geoData.isp;
  result.asn = geoData.asn;
  result.asOrg = geoData.asOrg;
  result.isHosting = geoData.isHosting;

  return result;
}

/**
 * Resolve jurisdiction for multiple relays with rate limiting
 */
export async function resolveJurisdictions(
  relayUrls: string[],
  delayMs: number = 1500  // ip-api.com allows 45/min, so ~1.3s between requests
): Promise<Map<string, JurisdictionInfo>> {
  const results = new Map<string, JurisdictionInfo>();

  for (let i = 0; i < relayUrls.length; i++) {
    const url = relayUrls[i];
    const result = await resolveJurisdiction(url);
    results.set(result.relayUrl, result);

    // Rate limit (skip delay for last item)
    if (i < relayUrls.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Format jurisdiction info for display
 */
export function formatJurisdiction(info: JurisdictionInfo): string {
  const lines: string[] = [
    `Relay: ${info.relayUrl}`,
  ];

  if (info.error) {
    lines.push(`Error: ${info.error}`);
    return lines.join('\n');
  }

  if (info.isTor) {
    lines.push('Network: Tor (anonymous)');
    return lines.join('\n');
  }

  if (info.ip) {
    lines.push(`IP: ${info.ip}`);
  }

  if (info.countryName) {
    let location = info.countryName;
    if (info.countryCode) {
      location += ` (${info.countryCode})`;
    }
    if (info.region) {
      location = `${info.region}, ${location}`;
    }
    if (info.city) {
      location = `${info.city}, ${location}`;
    }
    lines.push(`Location: ${location}`);
  }

  if (info.isp) {
    lines.push(`ISP: ${info.isp}`);
  }

  if (info.asn && info.asOrg) {
    lines.push(`AS: ${info.asn} (${info.asOrg})`);
  }

  if (info.isHosting) {
    lines.push('Type: Hosting/Datacenter');
  }

  return lines.join('\n');
}

/**
 * Get country emoji flag from country code
 */
export function getCountryFlag(countryCode?: string): string {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  if (countryCode === 'XX') return '🔒'; // Anonymous/Unknown

  // Convert country code to regional indicator symbols
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));

  return String.fromCodePoint(...codePoints);
}
