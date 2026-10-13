import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { certPath } from './config';

/**
 * Pinning for the admin UI's self-signed certificate.
 *
 * The server writes its own cert to <data>/tls/admin-cert.pem on start. The
 * app trusts exactly that certificate for the admin origin, and nothing else:
 * no global "ignore certificate errors", no trust-on-first-use.
 */
export function pinnedFingerprint(): string | null {
  try {
    return new X509Certificate(readFileSync(certPath())).fingerprint256;
  } catch {
    return null;
  }
}

export function pinnedPem(): string | null {
  try {
    return readFileSync(certPath(), 'utf8');
  } catch {
    return null;
  }
}

/** True when pem is the certificate the local server wrote. */
export function isPinned(pem: string): boolean {
  const want = pinnedFingerprint();
  if (!want) return false;
  try {
    return new X509Certificate(pem).fingerprint256 === want;
  } catch {
    return false;
  }
}
