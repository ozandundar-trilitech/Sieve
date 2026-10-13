import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Fixed loopback ports: Claude's MCP config and the docs point at these, so
// the app never picks random ones. Overridable only for tests / side-by-side
// development (SIEVE_DESKTOP_WEB_PORT / SIEVE_DESKTOP_API_PORT).
export const WEB_PORT = Number(process.env.SIEVE_DESKTOP_WEB_PORT) || 19816;
export const API_PORT = Number(process.env.SIEVE_DESKTOP_API_PORT) || 19817;
export const HOST = '127.0.0.1';
export const ADMIN_ORIGIN = `https://${HOST}:${WEB_PORT}`;

/** Directory holding sieve.db, tls/, logs/, and the sealed passphrase. */
export function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}
export const dbPath = (): string => join(dataDir(), 'sieve.db');
export const certPath = (): string => join(dataDir(), 'tls', 'admin-cert.pem');
export const logPath = (): string => join(app.getPath('userData'), 'logs', 'sieve.log');
export const sealedPassphrasePath = (): string => join(app.getPath('userData'), 'passphrase.sealed');

/** Location of the bundled Go server binary. */
export function sidecarPath(): string {
  const exe = process.platform === 'win32' ? 'sieve.exe' : 'sieve';
  const override = process.env.SIEVE_DESKTOP_SIDECAR;
  if (override && !app.isPackaged) return override;
  const packaged = join(process.resourcesPath, 'bin', exe);
  if (app.isPackaged) return packaged;
  // Dev: desktop/resources/bin/sieve, built by `npm run build:sidecar`.
  const dev = join(app.getAppPath(), 'resources', 'bin', exe);
  return existsSync(dev) ? dev : packaged;
}

/** Hosts the in-app window may navigate to: the admin UI plus the OAuth
 *  consent pages the admin UI redirects to. Must stay in sync with the
 *  form-action CSP in internal/web/headers.go. */
export const OAUTH_HOSTS = new Set([
  'accounts.google.com',
  'slack.com',
  'github.com',
  'api.notion.com',
  'app.notion.com',
  'app.asana.com',
]);
