import { nip19 } from 'nostr-tools';

// Order of the secp256k1 curve. A valid private key scalar must be in [1, n-1];
// values like all-zeros or all-Fs are well-formed hex but not valid keys.
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function isValidScalarHex(hex: string): boolean {
  const n = BigInt('0x' + hex);
  return n > 0n && n < SECP256K1_N;
}

/**
 * Normalize a private key to hex format
 * Accepts both nsec (bech32) and hex formats
 */
export function normalizePrivateKey(key: string): string {
  // Already hex format (64 hex chars)
  if (/^[0-9a-f]{64}$/i.test(key)) {
    const lower = key.toLowerCase();
    if (!isValidScalarHex(lower)) {
      throw new Error('Private key is not a valid secp256k1 scalar');
    }
    return lower;
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
