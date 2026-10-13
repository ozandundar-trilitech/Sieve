import { ElectronApplication, expect, Page, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { adminPost, Harness } from './helpers';

// Phase 2 acceptance: an agent's request blocks on approval, the app raises
// a notification, and pressing its button unblocks the agent.
const h = new Harness(39826, 39827);
let app: ElectronApplication;
let page: Page;
let agentToken = '';

interface Notice { key: string; title: string; body: string; actions?: string[] }

const notices = (): Promise<Notice[]> =>
  app.evaluate(() => ((globalThis as any).__sieveTest.notifier.shown as Notice[])
    .map(({ key, title, body, actions }) => ({ key, title, body, actions })));
const closed = (): Promise<string[]> => app.evaluate(() => [...(globalThis as any).__sieveTest.notifier.closed]);
const press = (key: string, index: number): Promise<boolean> =>
  app.evaluate((_e, a) => (globalThis as any).__sieveTest.notifier.press(a.key, a.index), { key, index });

async function waitForNotice(pred: (n: Notice) => boolean): Promise<Notice> {
  let found: Notice | undefined;
  await expect.poll(async () => (found = (await notices()).find(pred)), { timeout: 15_000 }).toBeTruthy();
  return found!;
}

function agentCall(conn: string, op: string, body: unknown): Promise<{ status: number; text: string }> {
  return fetch(`${h.api}/api/v1/connections/${conn}/ops/${op}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

test.describe.serial('desktop notifications (Phase 2)', () => {
  test.beforeAll(async () => {
    app = await h.launch({ SIEVE_DESKTOP_TEST_HOOKS: '1' });
    page = await h.adminWindow(app);
    await h.setupOperator(page);

    // An HTTP-proxy connection (no external account needed), a role, a rule
    // that makes every call on it require approval, and an agent token.
    let r = await adminPost(page, '/connections/add', {
      id: 'proxy', connector_type: 'http_proxy', display_name: 'Test Proxy',
      target_url: 'https://example.invalid', auth_header: 'x-api-key', auth_value: 'not-a-real-key',
    });
    expect(r.status).toBe(200);
    r = await adminPost(page, '/iam/roles', { name: 'agents' });
    expect(r.status).toBe(200);
    await page.goto(`${h.admin}/tokens`);
    const roleId = await page.locator('input[name="role_id"]').first().getAttribute('value');
    expect(roleId).toBeTruthy();
    r = await adminPost(page, '/iam/policies', {
      name: 'everything needs approval', role_id: roleId!, effect: 'require_approval',
      connector_type: 'http_proxy', op_scope: 'all', conn_scope: 'all',
    });
    expect(r.status).toBe(200);
    r = await adminPost(page, '/tokens/create', { name: 'claude-desktop', role_id: roleId! });
    agentToken = r.text.match(/sieve_tok_[0-9a-f]{64}/)?.[0] ?? '';
    expect(agentToken).not.toBe('');
    // The IAM page must now list the rule (the form re-renders on error).
    await page.goto(`${h.admin}/iam`);
    await expect(page.locator('body')).toContainText('everything needs approval');
  });

  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      console.log('event client debug:', await app.evaluate(() => (globalThis as any).__sieveTest.debugLog));
    }
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(h.userData, { recursive: true, force: true });
  });

  test('Reject from the notification unblocks the agent with a 403', async () => {
    const call = agentCall('proxy', 'proxy_request', { method: 'GET', path: '/v1/send', body: 'TOP SECRET' });
    const n = await waitForNotice((x) => x.key.startsWith('approval:'));
    expect(n.title).toBe('claude-desktop needs approval');
    expect(n.body).toContain('proxy_request on proxy');
    expect(n.actions).toEqual(['Approve', 'Reject']);
    expect(JSON.stringify(n)).not.toContain('TOP SECRET');

    expect(await press(n.key, 1)).toBe(true);
    const res = await call;
    expect(res.status).toBe(403);
    expect(res.text).toContain('rejected');
    // approval.resolved closes the stale notification.
    await expect.poll(closed).toContain(n.key);
  });

  test('Approve from the notification lets the request through', async () => {
    const seen = new Set((await notices()).map((x) => x.key));
    const call = agentCall('proxy', 'proxy_request', { method: 'GET', path: '/v1/models' });
    const n = await waitForNotice((x) => x.key.startsWith('approval:') && !seen.has(x.key));
    expect(await press(n.key, 0)).toBe(true);
    const res = await call;
    // Approved, so it executed: the upstream host doesn't exist and the proxy
    // reports that. A rejection would be 403, a timeout 504.
    expect([403, 504]).not.toContain(res.status);
    expect(res.text).not.toContain('rejected');
    await expect.poll(closed).toContain(n.key);
    // The audit log records it as executed, not rejected.
    await page.goto(`${h.admin}/audit`);
    await expect(page.locator('body')).toContainText('proxy_request');
  });

  test('a blocked request raises one notification per burst', async () => {
    const before = (await notices()).filter((x) => x.key.startsWith('denied:')).length;
    for (let i = 0; i < 4; i++) {
      expect((await agentCall('payroll', 'send_email', {})).status).toBe(403);
    }
    const n = await waitForNotice((x) => x.key.startsWith('denied:') && x.body.includes('payroll'));
    expect(n.title).toBe('Blocked: claude-desktop');
    await page.waitForTimeout(500);
    const after = (await notices()).filter((x) => x.key.startsWith('denied:')).length;
    expect(after - before).toBe(1);
  });

  test('an approval requested before the app connects is still notified', async () => {
    // Close the app's stream by logging out, request approval while no one
    // is listening, then log back in: the catch-up must surface it once.
    await page.evaluate(async () => {
      await fetch('/logout', { method: 'POST', body: new URLSearchParams({ csrf_token: (window as any).SIEVE_CSRF }) });
    });
    await page.goto(`${h.admin}/connections`); // → /login: the app drops the stream
    await expect(page).toHaveURL(`${h.admin}/login`);
    const before = (await notices()).length;
    const call = agentCall('proxy', 'proxy_request', { method: 'GET', path: '/missed' });
    await page.waitForTimeout(500);
    expect((await notices()).length).toBe(before); // nobody listening while logged out
    await h.login(page);
    await expect.poll(async () => (await notices()).length, { timeout: 20_000 }).toBe(before + 1);
    const latest = (await notices()).at(-1)!;
    expect(latest.title).toBe('claude-desktop needs approval');
    expect(await press(latest.key, 1)).toBe(true);
    expect((await call).status).toBe(403);
    await page.waitForTimeout(500);
    expect((await notices()).length).toBe(before + 1); // not repeated
  });

  test('the notification stream survives a re-login', async () => {
    await page.evaluate(async () => {
      const body = new URLSearchParams({ csrf_token: (window as any).SIEVE_CSRF });
      await fetch('/logout', { method: 'POST', body });
    });
    await page.goto(`${h.admin}/connections`);
    await h.login(page);
    const before = (await notices()).length;
    const call = agentCall('proxy', 'proxy_request', { method: 'GET', path: '/again' });
    await expect.poll(async () => (await notices()).length, { timeout: 20_000 }).toBeGreaterThan(before);
    const latest = (await notices()).at(-1)!;
    expect(latest.key).toMatch(/^approval:/);
    expect(await press(latest.key, 1)).toBe(true);
    expect((await call).status).toBe(403);
  });
});
