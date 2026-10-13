import { _electron as electron, ElectronApplication, expect, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PASSWORD = 'desktop-e2e-password';

/** One isolated app instance: its own userData dir and ports. */
export class Harness {
  readonly admin: string;
  readonly api: string;
  // A path with spaces, like ~/Library/Application Support on macOS.
  readonly userData = mkdtempSync(join(tmpdir(), 'sieve desktop e2e '));

  constructor(readonly webPort: number, readonly apiPort: number) {
    this.admin = `https://127.0.0.1:${webPort}`;
    this.api = `http://127.0.0.1:${apiPort}`;
  }

  launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
    return electron.launch({
      args: ['.'],
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        SIEVE_DESKTOP_USER_DATA: this.userData,
        SIEVE_DESKTOP_WEB_PORT: String(this.webPort),
        SIEVE_DESKTOP_API_PORT: String(this.apiPort),
        ...extraEnv,
      } as Record<string, string>,
    });
  }

  /** The admin window, once it is showing an admin page. */
  async adminWindow(app: ElectronApplication): Promise<Page> {
    const page = await app.firstWindow();
    await page.waitForURL((u) => u.href.startsWith(this.admin), { timeout: 30_000 });
    return page;
  }

  /** Completes first-run operator setup (and login, if the server asks). */
  async setupOperator(page: Page): Promise<void> {
    await expect(page).toHaveURL(`${this.admin}/setup`);
    await page.fill('input[name="display_name"]', 'Desktop Tester');
    await page.fill('input[name="credential"]', PASSWORD);
    await page.fill('input[name="confirm_credential"]', PASSWORD);
    await Promise.all([page.waitForNavigation(), page.locator('form button[type="submit"], form input[type="submit"]').first().click()]);
    if (page.url().includes('/login')) await this.login(page);
    await expect(page).toHaveURL(`${this.admin}/connections`);
  }

  async login(page: Page): Promise<void> {
    await expect(page).toHaveURL(`${this.admin}/login`);
    await page.fill('input[name="credential"]', PASSWORD);
    await Promise.all([page.waitForNavigation(), page.locator('form button[type="submit"]').first().click()]);
  }

  /** PIDs of this harness's Go server processes. */
  sidecarPids(): string[] {
    try {
      return execFileSync('pgrep', ['-f', `init-if-needed.*127\\.0\\.0\\.1:${this.webPort}`])
        .toString().trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** POSTs an admin form from inside the page, with the page's CSRF token. */
export async function adminPost(page: Page, path: string, fields: Record<string, string>): Promise<{ status: number; url: string; text: string }> {
  return page.evaluate(async ({ path, fields }) => {
    const body = new URLSearchParams(fields);
    body.set('csrf_token', (window as unknown as { SIEVE_CSRF: string }).SIEVE_CSRF);
    const r = await fetch(path, { method: 'POST', body });
    return { status: r.status, url: r.url, text: await r.text() };
  }, { path, fields });
}
