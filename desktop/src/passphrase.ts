import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath, sealedPassphrasePath } from './config';

/**
 * The keyring passphrase that encrypts every stored credential.
 *
 * The user never sees or types it. It is 32 random bytes generated on first
 * run, sealed with Electron safeStorage (macOS Keychain / Windows DPAPI /
 * libsecret), and handed to the server over file descriptor 3 at each start.
 * It is never written in plaintext, never put in an environment variable, and
 * never logged.
 */
export class PassphraseError extends Error {}

export function loadOrCreatePassphrase(): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new PassphraseError(
      'The OS keychain is not available, so Sieve cannot store its encryption key safely.',
    );
  }
  const sealed = sealedPassphrasePath();
  if (existsSync(sealed)) {
    return Buffer.from(safeStorage.decryptString(readFileSync(sealed)), 'utf8');
  }
  if (existsSync(dbPath())) {
    // A database exists but its key is gone. Generating a new key would not
    // unlock it, and the server would refuse to start. Say so instead.
    throw new PassphraseError(
      'Sieve found existing data but not the key that encrypts it. ' +
        'Restore the key from a backup, or move the data folder aside to start fresh.',
    );
  }
  const pp = randomBytes(32).toString('base64url');
  mkdirSync(dirname(sealed), { recursive: true, mode: 0o700 });
  writeFileSync(sealed, safeStorage.encryptString(pp), { mode: 0o600 });
  return Buffer.from(pp, 'utf8');
}
