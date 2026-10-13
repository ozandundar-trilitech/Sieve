import { ElectronApplication, expect, Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { Harness, PASSWORD, portFree } from './helpers';

const h = new Harness(39816, 39817);
const WEB_PORT = h.webPort;
const API_PORT = h.apiPort;
const ADMIN = h.admin;
const userData = h.userData;
test.afterAll(() => { if (!process.env.KEEP_E2E_DATA) rmSync(userData, { recursive: true, force: true }); });

const launch = (env: Record<string, string> = {}): Promise<ElectronApplication> => h.launch(env);
const adminWindow = (app: ElectronApplication): Promise<Page> => h.adminWindow(app);
const sidecarPids = (): string[] => h.sidecarPids();

test.describe.serial('desktop shell (Phase 1)', () => {
  test('first run: server starts, cert is pinned, operator setup works', async () => {
    const app = await launch();
    const page = await adminWindow(app);

    // Fresh install: the loopback-only first-run page.
    await expect(page).toHaveURL(`${ADMIN}/setup`);
    await page.fill('input[name="display_name"]', 'Desktop Tester');
    await page.fill('input[name="credential"]', PASSWORD);
    await page.fill('input[name="confirm_credential"]', PASSWORD);
    await Promise.all([page.waitForNavigation(), page.locator('form button[type="submit"], form input[type="submit"]').first().click()]);
    await expect(page).toHaveURL(new RegExp(`^${ADMIN}/(connections|login)`));
    if (page.url().includes('/login')) {
      await page.fill('input[name="credential"]', PASSWORD);
      await Promise.all([page.waitForNavigation(), page.locator('form button[type="submit"]').first().click()]);
    }
    await expect(page).toHaveURL(`${ADMIN}/connections`);

    // The key is sealed by the OS keychain, never stored in plaintext.
    const sealed = join(userData, 'passphrase.sealed');
    expect(existsSync(sealed)).toBe(true);
    expect(statSync(sealed).mode & 0o777).toBe(0o600);
    expect(readFileSync(sealed).toString('utf8')).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    const db = join(userData, 'data', 'sieve.db');
    expect(statSync(db).mode & 0o777).toBe(0o600);

    // External links never open inside the app window.
    const opened = await page.evaluate(() => window.open('https://example.com') === null);
    expect(opened).toBe(true);
    expect(app.windows()).toHaveLength(1);

    // The admin page can see the bridge but not use status-page-only calls.
    const bridge = await page.evaluate(() => Object.keys((window as any).sieveDesktop ?? {}).sort());
    expect(bridge).toEqual(['connectClaude', 'isDesktop', 'restartServer', 'showLogs']);
    const pidsBefore = sidecarPids();
    await page.evaluate(() => (window as any).sieveDesktop.restartServer());
    expect(sidecarPids()).toEqual(pidsBefore);

    await app.close();
  });

  test('quit stops the server and frees both ports', async () => {
    expect(sidecarPids()).toEqual([]);
    expect(await portFree(WEB_PORT)).toBe(true);
    expect(await portFree(API_PORT)).toBe(true);
  });

  test('relaunch: same key unlocks the same data', async () => {
    const app = await launch();
    const page = await adminWindow(app);
    // Session cookies end with the app; the operator logs back in.
    await expect(page).toHaveURL(`${ADMIN}/login`);
    await page.fill('input[name="credential"]', PASSWORD);
    await Promise.all([page.waitForNavigation(), page.locator('form button[type="submit"]').first().click()]);
    await expect(page).toHaveURL(`${ADMIN}/connections`);
    const log = readFileSync(join(userData, 'logs', 'sieve.log'), 'utf8');
    expect(log.match(/keyring initialized/g)?.length).toBe(1); // created once, loaded after
    expect(log).not.toContain(readFileSync(join(userData, 'passphrase.sealed')).toString('base64'));
    await app.close();
  });

  test('a second launch focuses the first instead of starting another server', async () => {
    const first = await launch();
    await adminWindow(first);
    const second = await launch().catch(() => null);
    if (second) {
      // The second process exits on its own after handing off.
      await second.waitForEvent('close', { timeout: 10_000 }).catch(() => {});
    }
    expect(sidecarPids()).toHaveLength(1);
    await first.close();
  });

  test('server crash: app shows status, restarts it, and returns to the admin UI', async () => {
    const app = await launch();
    const page = await adminWindow(app);
    const [pid] = sidecarPids();
    expect(pid).toBeTruthy();
    process.kill(Number(pid), 'SIGKILL');
    await page.waitForURL(/status\.html\?state=crashed/, { timeout: 10_000 });
    await page.waitForURL((u) => u.href.startsWith(ADMIN), { timeout: 30_000 });
    const after = sidecarPids();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(pid);
    await app.close();
    expect(sidecarPids()).toEqual([]);
  });

  test('docs load inside the app, and Go → Back / Home recover from a dead end', async () => {
    const app = await launch();
    const page = await adminWindow(app);
    await h.login(page);
    await expect(page).toHaveURL(`${ADMIN}/connections`);

    // Documentation renders from the docs embedded in the server binary
    // (the server runs from the app's data folder, which has no docs/).
    await page.goto(`${ADMIN}/docs`);
    await expect(page.locator('body')).toContainText('Setting Up Connections');
    await page.goto(`${ADMIN}/docs/connections-guide`);
    await expect(page.locator('body')).toContainText('Connection');

    // A plain-text error page has no sidebar: the menu must get you out.
    await page.goto(`${ADMIN}/docs/no-such-page`);
    const clickGo = (label: string) => app.evaluate(({ Menu }, l) => {
      const go = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Go')!;
      go.submenu!.items.find((i) => i.label === l)!.click();
    }, label);
    await clickGo('Back');
    await expect(page).toHaveURL(`${ADMIN}/docs/connections-guide`);
    await clickGo('Home');
    await expect(page).toHaveURL(`${ADMIN}/connections`);
    await app.close();
  });

  test('cert pinning survives an Electron network-service restart', async () => {
    const app = await launch();
    const page = await adminWindow(app);
    const pid = app.process().pid!;
    // Find and kill the network service utility process (a child of the app).
    const netPid = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .find((m) => m && Number(m[2]) === pid && /network\.mojom\.NetworkService/.test(m[3]))?.[1];
    expect(netPid, 'network service process not found').toBeTruthy();
    process.kill(Number(netPid), 'SIGKILL');
    await page.waitForTimeout(1500); // Electron restarts the network service
    // Fresh navigation through the restarted network service. (The operator
    // exists from the first test, so this is the login page.)
    await page.goto(`${ADMIN}/login`);
    await expect(page).toHaveURL(`${ADMIN}/login`);
    await expect(page.locator('input[name="credential"]')).toBeVisible();
    // The notification stream's fetches go through the same session.
    const status = await app.evaluate(async ({ session }, origin) => {
      const r = await session.fromPartition('persist:sieve-admin').fetch(`${origin}/login`);
      return r.status;
    }, ADMIN);
    expect(status).toBe(200);
    await app.close();
  });

  test('port already taken: clear message, no crash loop', async () => {
    const blocker = net.createServer().listen(WEB_PORT, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    try {
      const app = await launch();
      const page = await app.firstWindow();
      await page.waitForURL(/status\.html/);
      await expect(page.locator('#title')).toHaveText('Sieve could not start');
      await expect(page.locator('#message')).toContainText(`Port ${WEB_PORT} is already in use`);
      expect(sidecarPids()).toEqual([]);
      await app.close();
    } finally {
      blocker.close();
    }
  });
});
