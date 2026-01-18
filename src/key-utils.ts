import { nip19 } from 'nostr-tools';

/**
 * Normalize a private key to hex format
 * Accepts both nsec (bech32) and hex formats
 */
export function normalizePrivateKey(key: string): string {
  // Already hex format (64 hex chars)
  if (/^[0-9a-f]{64}$/i.test(key)) {
    return key.toLowerCase();
  }

  // nsec format (bech32)
  if (key.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(key);
      if (decoded.type === 'nsec') {
        return bytesToHex(decoded.data as Uint8Array);
      }
    } catch (err) {
      throw new Error(`Invalid nsec key: ${err}`);
    }
  }

  throw new Error('Private key must be 64-char hex or nsec format');
}

/**
 * Normalize a public key to hex format
 * Accepts both npub (bech32) and hex formats
 */
export function normalizePublicKey(key: string): string {
  // Already hex format (64 hex chars)
  if (/^[0-9a-f]{64}$/i.test(key)) {
    return key.toLowerCase();
  }

  // npub format (bech32)
  if (key.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(key);
      if (decoded.type === 'npub') {
        return decoded.data as string;
      }
    } catch (err) {
      throw new Error(`Invalid npub key: ${err}`);
    }
  }

  throw new Error('Public key must be 64-char hex or npub format');
}

/**
 * Check if a string is a valid private key (hex or nsec)
 */
export function isValidPrivateKey(key: string): boolean {
  try {
    normalizePrivateKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
